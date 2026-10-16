/*
 * คำนวณค่าไฟฟ้าตามโครงสร้างอัตราก้าวหน้า ประเภทบ้านอยู่อาศัย
 * อ้างอิง: การไฟฟ้าส่วนภูมิภาค, อัตราค่าไฟฟ้า (มีผลตั้งแต่พฤษภาคม 2566)
 * https://www.pea.co.th/sites/default/files/documents/tariff/Electricity_Tariff_MAY_2023.pdf
 *
 * วิธีดูว่าบ้านเป็นประเภทไหน: ดูเลข 3 ตัวแรกในช่อง "ประเภท (Type)" บนบิลค่าไฟ
 *   ขึ้นต้นด้วย 111 = ประเภท 1.1.1 (ใช้ไฟไม่เกิน 150 หน่วย/เดือน)
 *   ขึ้นต้นด้วย 112 = ประเภท 1.1.2 (ใช้ไฟเกิน 150 หน่วย/เดือน)
 */

// ---------- ประเภท 1.1.1: ใช้ไฟฟ้าไม่เกิน 150 หน่วย/เดือน (อัตราก้าวหน้าแบบละเอียด 6 ขั้น) ----------
const TARIFF_TIERS_1_1_1 = [
  { upTo: 15, rate: 2.3488 },
  { upTo: 25, rate: 2.9882 },
  { upTo: 35, rate: 3.2405 },
  { upTo: 100, rate: 3.6237 },
  { upTo: 150, rate: 3.7171 },
  { upTo: 400, rate: 4.2218 },
  { upTo: Infinity, rate: 4.4217 },
];
const SERVICE_CHARGE_1_1_1 = 8.19;

// ---------- ประเภท 1.1.2: ใช้ไฟฟ้าเกิน 150 หน่วย/เดือน (อัตราก้าวหน้า 3 ขั้น) ----------
const TARIFF_TIERS_1_1_2 = [
  { upTo: 150, rate: 3.2484 },
  { upTo: 400, rate: 4.2218 },
  { upTo: Infinity, rate: 4.4217 },
];
const SERVICE_CHARGE_1_1_2 = 24.62;

// ค่า Ft (ค่าไฟฟ้าผันแปร) default - ปรับได้จาก dashboard
const DEFAULT_FT_RATE = 0.1623;
const DEFAULT_TARIFF_TYPE = '1.1.2';

function getTiers(tariffType) {
  return tariffType === '1.1.1' ? TARIFF_TIERS_1_1_1 : TARIFF_TIERS_1_1_2;
}

function getServiceCharge(tariffType) {
  return tariffType === '1.1.1' ? SERVICE_CHARGE_1_1_1 : SERVICE_CHARGE_1_1_2;
}

/**
 * คำนวณค่าไฟฟ้าฐาน (ไม่รวม Ft และค่าบริการ) ตามอัตราก้าวหน้าของประเภทที่เลือก
 * @param {number} kwh - หน่วยไฟฟ้าที่ใช้ทั้งหมด (kWh)
 * @param {string} tariffType - '1.1.1' หรือ '1.1.2' (default '1.1.2')
 * @returns {number} ค่าไฟฟ้าฐาน (บาท)
 */
function calculateBaseCost(kwh, tariffType = DEFAULT_TARIFF_TYPE) {
  const tiers = getTiers(tariffType);
  let remaining = kwh;
  let prevLimit = 0;
  let total = 0;

  for (const tier of tiers) {
    const tierSize = tier.upTo - prevLimit;
    const usedInTier = Math.min(remaining, tierSize);

    if (usedInTier <= 0) break;

    total += usedInTier * tier.rate;
    remaining -= usedInTier;
    prevLimit = tier.upTo;

    if (remaining <= 0) break;
  }

  return total;
}

/**
 * คำนวณค่าไฟฟ้ารวม (ฐาน + Ft) ไม่รวม VAT - ใช้สำหรับค่าไฟรายวัน/เรียลไทม์
 */
function calculateDailyCost(kwh, ftRate = DEFAULT_FT_RATE, tariffType = DEFAULT_TARIFF_TYPE) {
  const base = calculateBaseCost(kwh, tariffType);
  const ft = kwh * ftRate;
  return base + ft;
}

/**
 * คำนวณค่าไฟฟ้ารวมทั้งเดือน (รวมค่าบริการ + VAT 7%) แบบเดียวกับบิลจริง
 */
function calculateMonthlyCost(kwh, ftRate = DEFAULT_FT_RATE, tariffType = DEFAULT_TARIFF_TYPE) {
  const base = calculateBaseCost(kwh, tariffType);
  const ft = kwh * ftRate;
  const serviceCharge = getServiceCharge(tariffType);
  const subtotal = base + ft + serviceCharge;
  const vat = subtotal * 0.07;
  return subtotal + vat;
}

const VAT_RATE = 0.07;

/**
 * ค่าไฟ "ส่วนเพิ่ม" ของวัน (รวม Ft และ VAT 7% แต่ยังไม่รวมค่าบริการรายเดือน)
 * ใช้ขั้นบันไดกับ "หน่วยสะสมของรอบบิล" ไม่ใช่หน่วยของวันเดียว
 *   เช่น สะสมมาแล้ว 150 หน่วย วันนี้ใช้เพิ่ม 10 หน่วย → 10 หน่วยนั้นคิดเรทขั้นที่ 2
 * @param {number} prevCumKwh - หน่วยสะสมของรอบบิลก่อนหน้าวันนี้
 * @param {number} addKwh - หน่วยที่ใช้เพิ่มในวันนี้
 */
function calculateIncrementalCost(prevCumKwh, addKwh, ftRate = DEFAULT_FT_RATE, tariffType = DEFAULT_TARIFF_TYPE) {
  const energyCost = (k) => calculateBaseCost(k, tariffType) + k * ftRate;
  const diff = energyCost(prevCumKwh + addKwh) - energyCost(prevCumKwh);
  return diff * (1 + VAT_RATE);
}

/**
 * ค่าบริการรายเดือน + VAT 7% (บวกครั้งเดียวต่อรอบบิล ตอนแสดงยอดรวมของรอบบิล)
 */
function getServiceChargeWithVat(tariffType = DEFAULT_TARIFF_TYPE) {
  return getServiceCharge(tariffType) * (1 + VAT_RATE);
}

module.exports = {
  calculateBaseCost,
  calculateDailyCost,
  calculateMonthlyCost,
  calculateIncrementalCost,
  getServiceChargeWithVat,
  VAT_RATE,
  TARIFF_TIERS_1_1_1,
  TARIFF_TIERS_1_1_2,
  SERVICE_CHARGE_1_1_1,
  SERVICE_CHARGE_1_1_2,
  DEFAULT_FT_RATE,
  DEFAULT_TARIFF_TYPE,
};
