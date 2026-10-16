const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');
const { startDailyJob } = require('./dailyJob');
const { getCurrentCycleStart } = require('./billingCycle');
const { calculateMonthlyCost, calculateIncrementalCost, DEFAULT_FT_RATE, DEFAULT_TARIFF_TYPE } = require('./tariff');

// อ่านค่า Ft และประเภทอัตราค่าไฟที่ผู้ใช้ตั้งไว้ (ไม่มี = ใช้ค่า default)
function getTariffSettings() {
  const ft = db.prepare(`SELECT value FROM settings WHERE key = 'ft_rate'`).get();
  const tp = db.prepare(`SELECT value FROM settings WHERE key = 'tariff_type'`).get();
  return {
    ftRate: ft ? parseFloat(ft.value) : DEFAULT_FT_RATE,
    tariffType: tp ? tp.value : DEFAULT_TARIFF_TYPE,
  };
}

// รวมข้อมูลดิบของวันนี้เป็นช่วงละ 15 นาที (ใช้ร่วมกันทั้ง /today-15min และ /summary/today)
function getToday15min() {
  const today = new Date().toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT * FROM readings
    WHERE timestamp LIKE ? || '%'
    ORDER BY timestamp ASC
  `).all(today);
  if (rows.length === 0) return [];

  const buckets = new Map();
  for (const row of rows) {
    const d = new Date(row.timestamp);
    const bucketMinute = Math.floor(d.getUTCMinutes() / 15) * 15;
    const key = new Date(Date.UTC(
      d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
      d.getUTCHours(), bucketMinute, 0
    )).toISOString();
    if (!buckets.has(key)) buckets.set(key, { powerSum: 0, powerCount: 0, lastRow: row });
    const b = buckets.get(key);
    b.powerSum += row.power || 0;
    b.powerCount += 1;
    b.lastRow = row;
  }
  return Array.from(buckets.entries()).map(([bucketStart, b]) => ({
    timestamp: bucketStart,
    power: b.powerSum / b.powerCount,
    energy: b.lastRow.energy,
    voltage: b.lastRow.voltage,
    current: b.lastRow.current,
    power_factor: b.lastRow.power_factor,
    frequency: b.lastRow.frequency,
  }));
}

const app = express();
const PORT = process.env.PORT || 3000; // Railway กำหนด PORT ให้เองผ่าน environment variable

app.use(cors());          // อนุญาตให้ dashboard (คนละ origin) เรียก API ได้
app.use(express.json());  // อ่าน JSON body
app.use(express.static(path.join(__dirname, 'public'))); // เสิร์ฟหน้า dashboard (public/index.html)

// ---------------------------------------------------
// POST /api/reading  <-- ESP32 ยิงข้อมูลมาที่นี่
// Body ตัวอย่าง:
// { "voltage": 229.8, "current": 2.834, "power": 581.9,
//   "energy": 146.276, "frequency": 50.0, "power_factor": 0.89 }
// ---------------------------------------------------
app.post('/api/reading', (req, res) => {
  const { voltage, current, power, energy, frequency, power_factor } = req.body;

  // ตรวจสอบข้อมูลเบื้องต้น
  if (energy === undefined || power === undefined) {
    return res.status(400).json({ error: 'ข้อมูลไม่ครบ ต้องมีอย่างน้อย power และ energy' });
  }

  const timestamp = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO readings (timestamp, voltage, current, power, energy, frequency, power_factor)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(timestamp, voltage, current, power, energy, frequency, power_factor);

  console.log(`[${timestamp}] รับข้อมูล: ${power}W, สะสม ${energy}kWh`);
  res.json({ status: 'ok', timestamp });
});

// ---------------------------------------------------
// GET /api/readings/latest  <-- ดึงค่าล่าสุด (สำหรับ live card บน dashboard)
// ---------------------------------------------------
app.get('/api/readings/latest', (req, res) => {
  const row = db.prepare(`SELECT * FROM readings ORDER BY timestamp DESC LIMIT 1`).get();
  if (!row) return res.status(404).json({ error: 'ยังไม่มีข้อมูล' });
  res.json(row);
});

// ---------------------------------------------------
// GET /api/readings/today  <-- ดึงข้อมูลทั้งหมดของวันนี้ (สำหรับกราฟ load curve)
// ---------------------------------------------------
app.get('/api/readings/today', (req, res) => {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const rows = db.prepare(`
    SELECT * FROM readings
    WHERE timestamp LIKE ? || '%'
    ORDER BY timestamp ASC
  `).all(today);
  res.json(rows);
});

// ---------------------------------------------------
// GET /api/readings/today-15min  <-- ข้อมูลวันนี้ รวมเป็นช่วงละ 15 นาที สำหรับแสดงบน dashboard
// ใช้แทน /api/readings/today ตอนแสดงกราฟ เพราะ ESP32 อาจส่งข้อมูลถี่กว่า 15 นาที (เช่น ทุก 1 นาที
// เพื่อให้เห็นค่าใกล้เรียลไทม์เวลาดู log ใน Railway โดยตรง) แต่ dashboard ยังต้องการความละเอียดแค่ 15 นาทีตามสเปค
// ---------------------------------------------------
app.get('/api/readings/today-15min', (req, res) => {
  res.json(getToday15min());
});

// ---------------------------------------------------
// GET /api/summary/daily?days=30  <-- ข้อมูลรายวันย้อนหลัง N วัน (สำหรับกราฟเทรนด์)
// ---------------------------------------------------
app.get('/api/summary/daily', (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const rows = db.prepare(`
    SELECT * FROM daily_summary ORDER BY date DESC LIMIT ?
  `).all(days);
  res.json(rows.reverse()); // เรียงจากเก่าไปใหม่ ให้กราฟอ่านง่าย
});

// ---------------------------------------------------
// GET /api/summary/monthly?year=2026  <-- รวมยอดค่าไฟแต่ละเดือนของปีนั้น (จากข้อมูลเซนเซอร์จริง)
// ---------------------------------------------------
app.get('/api/summary/monthly', (req, res) => {
  const year = req.query.year || new Date().getFullYear();
  const rows = db.prepare(`
    SELECT strftime('%m', date) as month, SUM(kwh_used) as kwh_used, SUM(cost) as cost
    FROM daily_summary
    WHERE strftime('%Y', date) = ?
    GROUP BY month
    ORDER BY month
  `).all(String(year));
  res.json(rows);
});

// ---------------------------------------------------
// GET /api/summary/month?year=2025&month=9  <-- ดึงยอดรวมของเดือน/ปีใดก็ได้ตามที่ระบุ
// ใช้เป็น building block ให้ dashboard เลือกเทียบเดือนไหนกับเดือนไหนก็ได้อิสระ (รวมข้ามปี)
// ---------------------------------------------------
app.get('/api/summary/month', (req, res) => {
  const year = parseInt(req.query.year);
  const month = parseInt(req.query.month);
  if (!year || !month) {
    return res.status(400).json({ error: 'ต้องระบุ year และ month' });
  }
  const row = db.prepare(`
    SELECT SUM(kwh_used) as kwh_used, SUM(cost) as cost
    FROM daily_summary
    WHERE strftime('%Y', date) = ? AND strftime('%m', date) = ?
  `).get(String(year), String(month).padStart(2, '0'));

  res.json({ year, month, kwh_used: row?.kwh_used || 0, cost: row?.cost || 0 });
});

// ---------------------------------------------------
// GET /api/summary/compare-mom?year=2026&month=9
// เทียบเดือนนี้กับเดือนก่อนหน้าติดกัน (รองรับข้ามปี เช่น ม.ค. เทียบกับ ธ.ค. ปีก่อน)
// ---------------------------------------------------
app.get('/api/summary/compare-mom', (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const month = parseInt(req.query.month) || new Date().getMonth() + 1;

  // หาเดือนก่อนหน้า (ถ้าเป็น ม.ค. ให้ย้อนไป ธ.ค. ปีก่อน)
  let prevMonth = month - 1;
  let prevYear = year;
  if (prevMonth < 1) {
    prevMonth = 12;
    prevYear = year - 1;
  }

  const getMonthTotal = (y, m) => db.prepare(`
    SELECT SUM(kwh_used) as kwh_used, SUM(cost) as cost
    FROM daily_summary
    WHERE strftime('%Y', date) = ? AND strftime('%m', date) = ?
  `).get(String(y), String(m).padStart(2, '0'));

  const current = getMonthTotal(year, month);
  const previous = getMonthTotal(prevYear, prevMonth);

  const currentKwh = current?.kwh_used || 0;
  const currentCost = current?.cost || 0;
  const prevKwh = previous?.kwh_used || 0;
  const prevCost = previous?.cost || 0;

  // คำนวณ % เปลี่ยนแปลง (null ถ้าเดือนก่อนไม่มีข้อมูลเลย หารไม่ได้)
  const percentChangeKwh = prevKwh > 0 ? ((currentKwh - prevKwh) / prevKwh) * 100 : null;
  const percentChangeCost = prevCost > 0 ? ((currentCost - prevCost) / prevCost) * 100 : null;

  res.json({
    current: { year, month, kwh_used: currentKwh, cost: currentCost },
    previous: { year: prevYear, month: prevMonth, kwh_used: prevKwh, cost: prevCost },
    percentChangeKwh,
    percentChangeCost,
  });
});
// เทียบเดือนนี้กับเดือนเดียวกันของปีก่อน โดยดึงจากข้อมูลเซนเซอร์จริง (daily_summary) ทั้งคู่
// ถ้าโปรเจครันยังไม่ถึง 1 ปี lastYear จะเป็น null ไปก่อน แล้วจะมีข้อมูลจริงอัตโนมัติเมื่อเก็บครบปี
// ---------------------------------------------------
app.get('/api/summary/compare-yoy', (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const month = parseInt(req.query.month) || new Date().getMonth() + 1;
  const monthStr = String(month).padStart(2, '0');

  const getMonthTotal = (y) => db.prepare(`
    SELECT SUM(kwh_used) as kwh_used, SUM(cost) as cost
    FROM daily_summary
    WHERE strftime('%Y', date) = ? AND strftime('%m', date) = ?
  `).get(String(y), monthStr);

  const thisYear = getMonthTotal(year);
  const lastYearRaw = getMonthTotal(year - 1);
  const hasLastYearData = lastYearRaw?.kwh_used !== null && lastYearRaw?.kwh_used !== undefined;

  res.json({
    month,
    thisYear: { year, kwh_used: thisYear?.kwh_used || 0, cost: thisYear?.cost || 0 },
    lastYear: hasLastYearData
      ? { year: year - 1, kwh_used: lastYearRaw.kwh_used, cost: lastYearRaw.cost }
      : null, // null = ยังไม่มีข้อมูลของปีก่อน (รันยังไม่ถึง 1 ปี) - จะมีให้อัตโนมัติเมื่อข้อมูลสะสมพอ
  });
});

// ---------------------------------------------------
// GET /api/summary/cycle  <-- ยอดสะสมของรอบบิลปัจจุบัน (26 ของเดือนก่อน ถึง 25 ของเดือนนี้)
// ใช้แทน /api/summary/month สำหรับคำนวณงบประมาณ เพราะการไฟฟ้าจดมิเตอร์วันที่ 25 ไม่ใช่สิ้นเดือน
// ---------------------------------------------------
app.get('/api/summary/cycle', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const cycleStart = getCurrentCycleStart();
  const row = db.prepare(`
    SELECT SUM(kwh_used) as kwh_used
    FROM daily_summary
    WHERE date >= ? AND date <= ?
  `).get(cycleStart, today);

  // ยอดรวมของรอบบิล = ขั้นบันไดตามหน่วยสะสม + Ft + ค่าบริการรายเดือน + VAT 7% (เทียบกับบิลจริงได้)
  const kwh = row?.kwh_used || 0;
  const { ftRate, tariffType } = getTariffSettings();
  const cost = kwh > 0 ? calculateMonthlyCost(kwh, ftRate, tariffType) : 0;

  res.json({ cycle_start: cycleStart, cycle_end: today, kwh_used: kwh, cost });
});

// ---------------------------------------------------
// GET /api/summary/today  <-- หน่วยและค่าไฟ "ส่วนเพิ่มของวันนี้" (ขั้นบันไดคิดจากหน่วยสะสมของรอบบิล)
// ส่งกลับทั้งยอดรวมวันนี้ และจุดสะสมรายช่วง 15 นาที สำหรับกราฟขั้นบันไดบนแดชบอร์ด
// ---------------------------------------------------
app.get('/api/summary/today', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const cycleStart = getCurrentCycleStart();
  const prevRow = db.prepare(`
    SELECT SUM(kwh_used) as kwh FROM daily_summary
    WHERE date >= ? AND date < ?
  `).get(cycleStart, today);
  const prevCumKwh = prevRow?.kwh || 0;
  const { ftRate, tariffType } = getTariffSettings();

  const buckets = getToday15min();
  if (buckets.length === 0) return res.json({ kwh: 0, cost: 0, points: [] });

  const baseline = buckets[0].energy;
  const points = buckets.map((b) => {
    const cumKwh = Math.max(0, b.energy - baseline);
    return {
      timestamp: b.timestamp,
      cum_kwh: cumKwh,
      cum_cost: calculateIncrementalCost(prevCumKwh, cumKwh, ftRate, tariffType),
    };
  });
  const last = points[points.length - 1];
  res.json({ kwh: last.cum_kwh, cost: last.cum_cost, points });
});

// ---------------------------------------------------
// GET /api/settings/ft-rate  <-- ดึงค่า Ft ที่ตั้งไว้
// ---------------------------------------------------
app.get('/api/settings/ft-rate', (req, res) => {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'ft_rate'`).get();
  res.json({ ft_rate: row ? parseFloat(row.value) : require('./tariff').DEFAULT_FT_RATE });
});

// ---------------------------------------------------
// POST /api/settings/ft-rate  <-- ตั้งค่า Ft (ผู้ใช้กรอกจาก dashboard เมื่อ กกพ. ประกาศค่าใหม่)
// Body: { "ft_rate": 0.1623 }
// ---------------------------------------------------
app.post('/api/settings/ft-rate', (req, res) => {
  const { ft_rate } = req.body;
  if (ft_rate === undefined || isNaN(ft_rate)) {
    return res.status(400).json({ error: 'ต้องระบุ ft_rate เป็นตัวเลข' });
  }
  db.prepare(`
    INSERT INTO settings (key, value) VALUES ('ft_rate', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(ft_rate));
  res.json({ status: 'ok', ft_rate });
});

// ---------------------------------------------------
// GET /api/settings/tariff-type  <-- ดึงประเภทอัตราค่าไฟที่ตั้งไว้ (1.1.1 หรือ 1.1.2)
// ---------------------------------------------------
app.get('/api/settings/tariff-type', (req, res) => {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'tariff_type'`).get();
  res.json({ tariff_type: row ? row.value : require('./tariff').DEFAULT_TARIFF_TYPE });
});

// ---------------------------------------------------
// POST /api/settings/tariff-type  <-- ตั้งประเภทอัตราค่าไฟ
// Body: { "tariff_type": "1.1.1" }  หรือ "1.1.2"
// ---------------------------------------------------
app.post('/api/settings/tariff-type', (req, res) => {
  const { tariff_type } = req.body;
  if (tariff_type !== '1.1.1' && tariff_type !== '1.1.2') {
    return res.status(400).json({ error: 'tariff_type ต้องเป็น "1.1.1" หรือ "1.1.2" เท่านั้น' });
  }
  db.prepare(`
    INSERT INTO settings (key, value) VALUES ('tariff_type', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(tariff_type);
  res.json({ status: 'ok', tariff_type });
});

// ---------------------------------------------------
// GET /api/settings/budget  <-- ดึงค่างบประมาณรายเดือนที่ตั้งไว้
// ---------------------------------------------------
app.get('/api/settings/budget', (req, res) => {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'monthly_budget'`).get();
  res.json({ budget: row ? parseFloat(row.value) : null });
});

// ---------------------------------------------------
// POST /api/settings/budget  <-- ตั้งค่างบประมาณรายเดือน (ผู้ใช้กรอกจาก dashboard)
// Body: { "budget": 1000 }
// ---------------------------------------------------
app.post('/api/settings/budget', (req, res) => {
  const { budget } = req.body;
  if (budget === undefined || isNaN(budget) || budget < 0) {
    return res.status(400).json({ error: 'ต้องระบุ budget เป็นตัวเลขไม่ติดลบ' });
  }
  db.prepare(`
    INSERT INTO settings (key, value) VALUES ('monthly_budget', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(budget));
  res.json({ status: 'ok', budget });
});

// ---------------------------------------------------
// GET /api/health  <-- เช็คว่า server ยังรันอยู่
// ---------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({ status: 'running', time: new Date().toISOString() });
});

startDailyJob(); // เริ่มระบบแจ้งเตือนรายวันอัตโนมัติ

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Backend รันอยู่ที่ http://0.0.0.0:${PORT}`);
  console.log(`   ทดสอบผ่านคอมตัวเอง: http://localhost:${PORT}/api/health`);
  console.log(`   ESP32 ต้องยิงมาที่ IP เครื่องนี้ในวง LAN (ดูวิธีหา IP ในคำแนะนำ)`);
});
