/*
 * ESP32 + PZEM-004T ส่งข้อมูลเข้า Backend บน Railway ผ่าน HTTPS
 * ----------------------------------------------------
 * ไม่ต้องติดตั้งเพิ่ม WiFi.h, HTTPClient.h, WiFiClientSecure.h มากับ ESP32 board package อยู่แล้ว
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <PZEM004Tv30.h>
#include <esp_task_wdt.h>

// เวลา (วินาที) ที่ยอมให้ loop() ไม่ตอบสนอง ก่อนจะสั่งรีสตาร์ทเครื่องอัตโนมัติ
// ป้องกันกรณีเครื่องค้างทั้งหมด (ไม่ใช่แค่ WiFi หลุด) ซึ่งต้องกดปุ่ม reset เองถ้าไม่มีตัวนี้
const int WDT_TIMEOUT_SECONDS = 120;

// ---------- แก้ตรงนี้ ----------
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* SERVER_HOST   = "your-app.up.railway.app"; // โดเมนจาก Railway ไม่ต้องมี https://
const char* SERVER_PATH   = "/api/reading";
// --------------------------------

// ช่วงเวลาส่งข้อมูล (มิลลิวินาที) - เปลี่ยนเป็นส่งทุก 1 นาที เพื่อให้เห็นค่าใกล้เรียลไทม์เวลาดู log ใน Railway
// ฝั่ง dashboard จะรวมข้อมูลเป็นช่วงละ 15 นาทีให้เองอัตโนมัติ (ผ่าน /api/readings/today-15min) ไม่ต้องกังวลเรื่องสเปค 15 นาทีเดิม
const unsigned long SEND_INTERVAL = 60UL * 1000UL; // 1 นาที
// const unsigned long SEND_INTERVAL = 15UL * 60UL * 1000UL; // <- ย้อนกลับเป็น 15 นาทีได้ถ้าต้องการลดปริมาณข้อมูล

PZEM004Tv30 pzem(Serial2, 16, 17);

unsigned long lastSendTime = 0;
unsigned long wifiDownSince = 0; // เวลาที่ WiFi เริ่มหลุด (0 = ยังไม่หลุด)
const unsigned long WIFI_TIMEOUT_RESTART = 5UL * 60UL * 1000UL; // ถ้า WiFi หลุดเกิน 5 นาที ให้รีสตาร์ทเครื่องเอง

void connectWiFi() {
  Serial.print("กำลังเชื่อมต่อ WiFi");
  WiFi.disconnect(true);  // เคลียร์สถานะเก่าก่อนเชื่อมใหม่ ป้องกันค้างจากการหลุดครั้งก่อน
  delay(200);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nเชื่อมต่อ WiFi สำเร็จ!");
    Serial.print("IP ของ ESP32: ");
    Serial.println(WiFi.localIP());
    wifiDownSince = 0; // รีเซ็ตตัวจับเวลา เพราะเชื่อมต่อกลับมาแล้ว
  } else {
    Serial.println("\nเชื่อมต่อ WiFi ไม่สำเร็จ จะลองใหม่ในลูปถัดไป");
    if (wifiDownSince == 0) wifiDownSince = millis(); // เริ่มจับเวลาตอนหลุดครั้งแรก
  }
}

void sendReading() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi หลุด กำลังเชื่อมต่อใหม่...");
    connectWiFi();
    return;
  }

  float voltage    = pzem.voltage();
  float current    = pzem.current();
  float power      = pzem.power();
  float energy     = pzem.energy();
  float frequency  = pzem.frequency();
  float pf         = pzem.pf();

  if (isnan(voltage)) {
    Serial.println("อ่านค่าจาก PZEM ไม่ได้ ข้ามรอบนี้ไป");
    return;
  }

  // สร้าง JSON payload ส่งไป backend
  String payload = "{";
  payload += "\"voltage\":" + String(voltage, 1) + ",";
  payload += "\"current\":" + String(current, 3) + ",";
  payload += "\"power\":" + String(power, 1) + ",";
  payload += "\"energy\":" + String(energy, 3) + ",";
  payload += "\"frequency\":" + String(frequency, 1) + ",";
  payload += "\"power_factor\":" + String(pf, 2);
  payload += "}";

  // ใช้ WiFiClientSecure สำหรับ HTTPS (Railway บังคับ HTTPS เท่านั้น)
  WiFiClientSecure client;
  client.setInsecure(); // ข้ามการตรวจสอบ certificate แบบเข้มงวด (พอสำหรับโปรเจคเรียน ไม่ใช่ production จริงจัง)

  HTTPClient http;
  String fullUrl = String("https://") + SERVER_HOST + SERVER_PATH;
  http.begin(client, fullUrl);
  http.addHeader("Content-Type", "application/json");

  int httpCode = http.POST(payload);

  if (httpCode > 0) {
    Serial.printf("ส่งข้อมูลสำเร็จ [%d]: %s\n", httpCode, payload.c_str());
  } else {
    Serial.printf("ส่งข้อมูลไม่สำเร็จ: %s\n", http.errorToString(httpCode).c_str());
  }

  http.end();
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  WiFi.setSleep(false); // ปิด power-saving mode ของ WiFi กันหลุดง่ายตอนรันนานๆ

  // เริ่มระบบ watchdog: ถ้า loop() ไม่ตอบสนองเกิน WDT_TIMEOUT_SECONDS จะรีสตาร์ทเครื่องอัตโนมัติ
  // (ใช้ config แบบ struct เพราะ ESP32 core เวอร์ชันใหม่ 3.x เปลี่ยนรูปแบบ API จากเดิม)
  esp_task_wdt_config_t twdt_config = {
    .timeout_ms = (uint32_t)WDT_TIMEOUT_SECONDS * 1000,
    .idle_core_mask = 0,
    .trigger_panic = true,
  };
  esp_task_wdt_init(&twdt_config);
  esp_task_wdt_add(NULL);

  connectWiFi();
}

void loop() {
  esp_task_wdt_reset(); // "ป้อนอาหาร" watchdog ทุกรอบ บอกว่าโปรแกรมยังทำงานปกติอยู่

  unsigned long now = millis();

  if (lastSendTime == 0 || now - lastSendTime >= SEND_INTERVAL) {
    if (WiFi.status() == WL_CONNECTED) {
      sendReading();
      lastSendTime = now; // อัพเดตเฉพาะตอน WiFi เชื่อมต่ออยู่ตอนพยายามส่ง
    } else {
      // WiFi หลุดอยู่ตอนถึงรอบส่ง - ไม่อัพเดต lastSendTime
      // จะได้ลองส่งใหม่เร็วขึ้น (ทุก 1 วินาทีตาม loop) ทันทีที่ WiFi กลับมา
      // แทนที่จะรอเต็มรอบ 15 นาทีถัดไป
      Serial.println("WiFi หลุดตอนถึงรอบส่ง กำลังเชื่อมต่อใหม่...");
      connectWiFi();
    }
  }

  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
  }

  // ถ้า WiFi หลุดต่อเนื่องเกิน 5 นาที ให้รีสตาร์ทเครื่องเอง (แก้ปัญหา WiFi module ค้างของ ESP32)
  if (wifiDownSince != 0 && (millis() - wifiDownSince) > WIFI_TIMEOUT_RESTART) {
    Serial.println("WiFi หลุดนานเกินไป กำลังรีสตาร์ทเครื่อง...");
    delay(500);
    ESP.restart();
  }

  delay(1000);
}
