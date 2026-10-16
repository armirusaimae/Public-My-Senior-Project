const cron = require('node-cron');
const db = require('./db');
const { calculateIncrementalCost, calculateMonthlyCost, DEFAULT_FT_RATE, DEFAULT_TARIFF_TYPE } = require('./tariff');
const { sendTelegramMessage } = require('./telegram');
const { getCurrentCycleStart } = require('./billingCycle');

/**
 * คำนวณหน่วยไฟฟ้าที่ใช้ไปในวันที่กำหนด
 * โดยหาผลต่างระหว่างค่า energy (kWh สะสม) ตัวแรกกับตัวสุดท้ายของวันนั้น
 * @param {string} dateStr - รูปแบบ YYYY-MM-DD
 * @returns {number|null} หน่วยที่ใช้ (kWh) หรือ null ถ้าไม่มีข้อมูล
 */
function calculateDayUsage(dateStr) {
  const rows = db.prepare(`
    SELECT energy FROM readings
    WHERE timestamp LIKE ? || '%'
    ORDER BY timestamp ASC
  `).all(dateStr);

  if (rows.length < 2) return null; // ข้อมูลไม่พอคำนวณ

  const first = rows[0].energy;
  const last = rows[rows.length - 1].energy;
  return Math.max(0, last - first); // กันกรณี energy รีเซ็ต (ไฟดับ/รีเซ็ตเซนเซอร์)
}

/**
 * รันสรุปผลของ "เมื่อวาน" คำนวณค่าไฟ บันทึกลง DB และส่ง Telegram
 */
async function runDailySummary() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toISOString().slice(0, 10); // YYYY-MM-DD

  const kwhUsed = calculateDayUsage(dateStr);

  if (kwhUsed === null) {
    console.log(`[dailyJob] ไม่มีข้อมูลเพียงพอสำหรับวันที่ ${dateStr}`);
    return;
  }

  // ดึงค่า Ft และประเภทอัตราค่าไฟที่ตั้งไว้ (ถ้าไม่มีจะใช้ค่า default ใน tariff.js)
  const ftRow = db.prepare(`SELECT value FROM settings WHERE key = 'ft_rate'`).get();
  const ftRate = ftRow ? parseFloat(ftRow.value) : undefined;

  const tariffRow = db.prepare(`SELECT value FROM settings WHERE key = 'tariff_type'`).get();
  const tariffType = tariffRow ? tariffRow.value : undefined;

  // หน่วยสะสมของรอบบิล "ก่อนวันนี้" (ขั้นบันไดต้องคิดจากหน่วยสะสมทั้งรอบ ไม่ใช่หน่วยของวันเดียว)
  const cycleStart = getCurrentCycleStart(yesterday);
  const prevRow = db.prepare(`
    SELECT SUM(kwh_used) as kwh FROM daily_summary
    WHERE date >= ? AND date < ?
  `).get(cycleStart, dateStr);
  const prevCumKwh = prevRow?.kwh || 0;

  // ค่าไฟส่วนเพิ่มของวัน = ขั้นบันไดตามหน่วยสะสม + Ft + VAT (ค่าบริการรายเดือนบวกตอนสรุปรอบบิล)
  const cost = calculateIncrementalCost(prevCumKwh, kwhUsed, ftRate, tariffType);

  // บันทึกลงตาราง daily_summary (แทนที่ถ้ามีอยู่แล้ว)
  db.prepare(`
    INSERT INTO daily_summary (date, kwh_used, cost, notified)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(date) DO UPDATE SET kwh_used = excluded.kwh_used, cost = excluded.cost, notified = 1
  `).run(dateStr, kwhUsed, cost);

  // คำนวณยอดสะสมของ "รอบบิลปัจจุบัน" (ไม่ใช่เดือนปฏิทิน เพราะการไฟฟ้าจดมิเตอร์วันที่ 25)
  const monthTotal = db.prepare(`
    SELECT SUM(kwh_used) as kwh_used, SUM(cost) as cost
    FROM daily_summary
    WHERE date >= ? AND date <= ?
  `).get(cycleStart, dateStr);

  const monthKwh = monthTotal?.kwh_used || 0;
  // ยอดรวมของรอบบิลจนถึงวันนี้ = ค่าไฟตามขั้นบันไดของหน่วยสะสม + Ft + ค่าบริการรายเดือน + VAT (เทียบกับบิลจริงได้)
  const monthCost = monthKwh > 0
    ? calculateMonthlyCost(monthKwh, ftRate ?? DEFAULT_FT_RATE, tariffType ?? DEFAULT_TARIFF_TYPE)
    : 0;

  // ดึงค่างบประมาณที่ผู้ใช้ตั้งไว้ (ถ้ามี)
  const budgetRow = db.prepare(`SELECT value FROM settings WHERE key = 'monthly_budget'`).get();
  const budget = budgetRow ? parseFloat(budgetRow.value) : null;

  // เทียบกับค่าเฉลี่ย 7 วันล่าสุด (ไม่รวมวันนี้) เพื่อให้ข้อความมีบริบท
  const avgRow = db.prepare(`
    SELECT AVG(kwh_used) as avg_kwh FROM daily_summary
    WHERE date < ? ORDER BY date DESC LIMIT 7
  `).get(dateStr);

  const avgKwh = avgRow?.avg_kwh;
  let comparisonText = '';
  if (avgKwh) {
    const diffPercent = ((kwhUsed - avgKwh) / avgKwh) * 100;
    const trend = diffPercent > 0 ? `สูงกว่า` : `ต่ำกว่า`;
    comparisonText = `\n${trend}ค่าเฉลี่ย 7 วันล่าสุด ${Math.abs(diffPercent).toFixed(1)}%`;
  }

  // สร้างข้อความแบบมีงบประมาณ (ถ้าผู้ใช้ตั้งไว้) หรือแบบไม่มีงบ (ถ้ายังไม่ได้ตั้ง)
  let message;
  if (budget !== null && budget > 0) {
    const remaining = budget - monthCost;
    const remainingText = remaining >= 0
      ? `คงเหลือ: ${remaining.toFixed(2)} บาท`
      : `⚠️ เกินงบไปแล้ว: ${Math.abs(remaining).toFixed(2)} บาท`;

    message =
      `⚡ *สรุปค่าไฟวันที่ ${dateStr}*\n\n` +
      `ใช้ไปแล้ว: ${monthCost.toFixed(2)} บาท (${monthKwh.toFixed(2)} หน่วย)\n` +
      `งบที่ตั้งไว้: ${budget.toFixed(0)} บาท\n` +
      `${remainingText}\n\n` +
      `วันนี้ใช้: ${kwhUsed.toFixed(2)} หน่วย (${cost.toFixed(2)} บาท)` +
      comparisonText;
  } else {
    message =
      `⚡ *สรุปค่าไฟวันที่ ${dateStr}*\n\n` +
      `หน่วยที่ใช้: ${kwhUsed.toFixed(2)} kWh\n` +
      `ค่าไฟวันนี้: ${cost.toFixed(2)} บาท` +
      comparisonText +
      `\n\n💡 ตั้งงบประมาณรายเดือนได้ที่หน้า Dashboard เพื่อดูยอดคงเหลือ`;
  }

  try {
    await sendTelegramMessage(message);
    console.log(`[dailyJob] ส่งแจ้งเตือนสำเร็จ: ${dateStr}`);
  } catch (err) {
    console.error(`[dailyJob] ส่ง Telegram ไม่สำเร็จ:`, err.message);
  }
}

/**
 * เริ่มตั้ง schedule ให้รันทุกวันเวลา 00:05 น. (สรุปผลของเมื่อวาน)
 */
function startDailyJob() {
  cron.schedule('5 0 * * *', () => {
    console.log('[dailyJob] เริ่มรันสรุปค่าไฟรายวัน...');
    runDailySummary();
  });
  console.log('[dailyJob] ตั้ง schedule แจ้งเตือนรายวันเรียบร้อย (ทุกวัน 00:05 น.)');
}

module.exports = { startDailyJob, runDailySummary };
