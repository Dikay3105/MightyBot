const cron = require('node-cron');
const { dailyCheckIn } = require('./mihoyo');
const fs = require('fs');

const USERS = JSON.parse(fs.readFileSync('./storage.json', 'utf-8'));

// Chạy vào 23h giờ Việt Nam mỗi ngày (UTC+7 = 16h UTC)
cron.schedule('0 16 * * *', async () => {
    console.log('🔄 Đang điểm danh hàng ngày...');
    for (const user of USERS) {
        try {
            const result = await dailyCheckIn(user.cookie, user.gameId);
            console.log(`✅ ${user.username}: ${result.message}`);
        } catch (err) {
            console.error(`❌ Lỗi khi điểm danh cho ${user.username}:`, err.message);
        }
    }
});
