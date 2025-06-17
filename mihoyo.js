const axios = require('axios');

// Hàm kiểm tra tài khoản game
async function getGameRoles(cookie) {
    const response = await axios.get('https://api-account-os.hoyolab.com/game_record/account/info', {
        headers: {
            'Cookie': cookie,
        },
    });
    return response.data;
}

// Hàm điểm danh
async function dailyCheckIn(cookie, gameId) {
    const response = await axios.post(
        `https://sg-hk4e-api.hoyolab.com/event/sol/sign`,
        {
            act_id: "e202102251931481", // act_id for Genshin, thay bằng act_id khác nếu Honkai
        },
        {
            headers: {
                'Cookie': cookie,
                'x-rpc-client_type': 5,
                'x-rpc-app_version': '1.5.0',
                'x-rpc-language': 'en-us',
            },
        }
    );
    return response.data;
}

module.exports = { getGameRoles, dailyCheckIn };
