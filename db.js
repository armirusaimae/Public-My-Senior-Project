const Database = require('better-sqlite3');
const path = require('path');

// เก็บไฟล์ database ไว้ใน Volume ถ้ามี (สำคัญมากตอน deploy บน Railway ไม่งั้นข้อมูลหายทุกครั้งที่ redeploy)
// Railway จะกำหนด environment variable RAILWAY_VOLUME_MOUNT_PATH ให้อัตโนมัติเมื่อแนบ Volume แล้ว
// ถ้ารันในเครื่องตัวเอง (ไม่มี volume) จะเก็บไว้ในโฟลเดอร์เดียวกับไฟล์นี้ตามปกติ
const DB_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const db = new Database(path.join(DB_DIR, 'electricity.db'));

// สร้างตารางถ้ายังไม่มี (รันครั้งแรกครั้งเดียว หลังจากนั้นข้ามไป)
db.exec(`
  CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,       -- ISO 8601 เช่น 2026-09-10T15:00:00
    voltage REAL,
    current REAL,
    power REAL,                    -- วัตต์ (W) ณ ขณะนั้น
    energy REAL,                   -- kWh สะสม (ค่าจาก PZEM ที่นับสะสมไปเรื่อยๆ)
    frequency REAL,
    power_factor REAL
  );

  CREATE INDEX IF NOT EXISTS idx_readings_timestamp ON readings(timestamp);

  CREATE TABLE IF NOT EXISTS daily_summary (
    date TEXT PRIMARY KEY,         -- เช่น 2026-09-10
    kwh_used REAL,
    cost REAL,
    notified INTEGER DEFAULT 0     -- กันไม่ให้ยิงแจ้งเตือนซ้ำ
  );

  -- เก็บค่าตั้งค่าทั่วไป เช่น งบประมาณรายเดือนที่ผู้ใช้กรอกเอง
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  -- หมายเหตุ: ไม่ต้องมีตารางกรอกข้อมูลย้อนหลังด้วยมือ
  -- เพราะระบบจะรันต่อเนื่องยาว การเทียบปีต่อปี (compare-yoy) จะใช้ข้อมูลจาก
  -- daily_summary ล้วนๆ เมื่อสะสมข้อมูลได้เกิน 1 ปีจะเทียบได้เองอัตโนมัติ
`);

module.exports = db;
