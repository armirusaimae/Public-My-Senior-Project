/*
 * คำนวณรอบบิลค่าไฟ (Billing Cycle)
 * ----------------------------------------
 * การไฟฟ้าจดมิเตอร์ทุกวันที่ 25 ของเดือน แปลว่า "เดือนบิล" ไม่ตรงกับเดือนปฏิทิน
 * รอบบิลจะเริ่มวันที่ 26 ของเดือนก่อนหน้า ไปจนถึงวันที่ 25 ของเดือนนี้
 *
 * ตัวอย่าง: วันนี้คือ 15 ก.ย. 2026 → รอบบิลปัจจุบันเริ่ม 26 ส.ค. 2026 ถึง 25 ก.ย. 2026
 *          วันนี้คือ 27 ก.ย. 2026 → รอบบิลปัจจุบันเริ่ม 26 ก.ย. 2026 ถึง 25 ต.ค. 2026
 *
 * ถ้าวันที่การไฟฟ้าจดมิเตอร์บ้านคุณไม่ใช่วันที่ 25 ให้แก้เลข METER_READING_DAY ตรงนี้
 */

const METER_READING_DAY = 25;

/**
 * หาวันที่เริ่มต้นของรอบบิลปัจจุบัน (เป็น string รูปแบบ YYYY-MM-DD)
 * @param {Date} referenceDate - วันที่อ้างอิง (default = วันนี้)
 * @returns {string} วันที่เริ่มรอบบิล เช่น "2026-08-26"
 */
function getCurrentCycleStart(referenceDate = new Date()) {
  const day = referenceDate.getDate();
  let year = referenceDate.getFullYear();
  let month = referenceDate.getMonth(); // 0-11

  if (day > METER_READING_DAY) {
    // วันนี้เลยวันจดมิเตอร์ของเดือนนี้ไปแล้ว → รอบบิลเริ่มวันที่ 26 ของเดือนนี้
    // month คงเดิม (0-indexed) ใช้ตรงๆ ได้เลย
  } else {
    // วันนี้ยังไม่ถึงวันจดมิเตอร์ → รอบบิลเริ่มวันที่ 26 ของเดือนก่อนหน้า
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
  }

  const mm = String(month + 1).padStart(2, '0');
  const dd = String(METER_READING_DAY + 1).padStart(2, '0'); // วันที่ 26
  return `${year}-${mm}-${dd}`;
}

module.exports = { getCurrentCycleStart, METER_READING_DAY };
