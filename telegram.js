const https = require('https');

// ตั้งค่า 2 ตัวนี้จาก @BotFather และ getUpdates (ดูวิธีในคำแนะนำก่อนหน้า)
// แนะนำให้เก็บเป็น environment variable ไม่ hardcode ในโค้ดจริงตอน deploy
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'ใส่_BOT_TOKEN_ตรงนี้';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || 'ใส่_CHAT_ID_ตรงนี้';

/**
 * ส่งข้อความไปยัง Telegram ผ่าน Bot API
 * @param {string} message - ข้อความที่จะส่ง (รองรับ Markdown)
 */
function sendTelegramMessage(message) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      chat_id: CHAT_ID,
      text: message,
      parse_mode: 'Markdown',
    });

    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`Telegram API error: ${res.statusCode} - ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = { sendTelegramMessage };
