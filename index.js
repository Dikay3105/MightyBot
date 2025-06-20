require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const { generateFileFromResponse } = require('./fileGenerator');
const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    PermissionsBitField,
} = require('discord.js');
const axios = require('axios');
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    StreamType,
} = require('@discordjs/voice');
const { execSync, spawn } = require('child_process');
const SpotifyWebApi = require('spotify-web-api-node');
const stringSimilarity = require('string-similarity');
const gTTS = require('gtts');

// Khởi tạo Spotify API
const spotifyApi = new SpotifyWebApi({
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
    redirectUri: process.env.SPOTIFY_REDIRECT_URI,
});

// Biến để lưu token và thời gian hết hạn
let spotifyAccessToken = null;
let spotifyTokenExpiresAt = 0;

// Hàm làm mới token Spotify
async function refreshSpotifyToken() {
    try {
        console.log('🔄 Làm mới token Spotify...');
        const data = await spotifyApi.clientCredentialsGrant();
        spotifyAccessToken = data.body['access_token'];
        spotifyTokenExpiresAt = Date.now() + data.body['expires_in'] * 1000;
        spotifyApi.setAccessToken(spotifyAccessToken);
        console.log('✅ Token Spotify đã được làm mới, hết hạn lúc:', new Date(spotifyTokenExpiresAt));
    } catch (error) {
        console.error('❌ Lỗi khi làm mới token Spotify:', error.message);
        throw error;
    }
}

// Hàm kiểm tra và làm mới token nếu cần
async function ensureSpotifyToken() {
    if (!spotifyAccessToken || Date.now() >= spotifyTokenExpiresAt - 10000) {
        await refreshSpotifyToken();
    }
}

// Slash commands
const commands = [
    new SlashCommandBuilder()
        .setName('ai')
        .setDescription('Trò chuyện với AI và nhận file nếu cần')
        .addStringOption((option) =>
            option
                .setName('prompt')
                .setDescription('Bạn muốn hỏi gì?')
                .setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName('play')
        .setDescription('Phát nhạc từ YouTube, Spotify hoặc link Spotify/YouTube')
        .addStringOption((option) =>
            option
                .setName('query')
                .setDescription('Link YouTube/Spotify hoặc tên bài hát')
                .setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName('skip')
        .setDescription('Bỏ qua bài hát hiện tại'),
    new SlashCommandBuilder()
        .setName('pause')
        .setDescription('Tạm dừng bài hát hiện tại'),
    new SlashCommandBuilder()
        .setName('resume')
        .setDescription('Tiếp tục phát bài hát đã tạm dừng'),
    new SlashCommandBuilder()
        .setName('queue')
        .setDescription('Xem danh sách phát'),
    new SlashCommandBuilder()
        .setName('tts')
        .setDescription('Đọc văn bản trong voice channel')
        .addStringOption((option) =>
            option
                .setName('text')
                .setDescription('Văn bản cần đọc')
                .setRequired(true)
        ),
].map((cmd) => cmd.toJSON());

// Đăng ký slash commands
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
(async () => {
    try {
        console.log('🚀 Đang đăng ký slash commands...');
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {
            body: commands,
        });
        console.log('✅ Slash commands đã được đăng ký.');
    } catch (error) {
        console.error('❌ Lỗi khi đăng ký commands:', error.message);
    }
})();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
    ],
});

// Hàng đợi phát nhạc cho mỗi server
const queues = new Map();

client.once('ready', async () => {
    console.log(`🤖 Bot đã sẵn sàng: ${client.user.tag}`);
    // Xác thực Spotify
    try {
        await refreshSpotifyToken();
    } catch (error) {
        console.error('❌ Lỗi xác thực Spotify:', error.message);
    }
});

// Hàm tính độ tương đồng chuỗi
function getBestMatch(query, results) {
    let bestMatch = null;
    let highestSimilarity = 0;

    results.forEach((result) => {
        const similarity = stringSimilarity.compareTwoStrings(query.toLowerCase(), result.title.toLowerCase());
        if (similarity > highestSimilarity) {
            highestSimilarity = similarity;
            bestMatch = result;
        }
    });

    return bestMatch;
}

// Hàm kiểm tra và trích xuất ID từ link Spotify hoặc YouTube
function extractMediaId(url) {
    const spotifyTrackRegex = /https?:\/\/open\.spotify\.com\/track\/([a-zA-Z0-9]+)(\?.*)?$/;
    const spotifyPlaylistRegex = /https?:\/\/open\.spotify\.com\/playlist\/([a-zA-Z0-9]+)(\?.*)?$/;
    const youtubePlaylistRegex = /list=([a-zA-Z0-9_-]+)/;

    const spotifyTrackMatch = url.match(spotifyTrackRegex);
    const spotifyPlaylistMatch = url.match(spotifyPlaylistRegex);
    const youtubePlaylistMatch = url.match(youtubePlaylistRegex);

    if (spotifyTrackMatch) return { type: 'spotify_track', id: spotifyTrackMatch[1] };
    if (spotifyPlaylistMatch) return { type: 'spotify_playlist', id: spotifyPlaylistMatch[1] };
    if (youtubePlaylistMatch) return { type: 'youtube_playlist', id: youtubePlaylistMatch[1] };
    return null;
}

// Hàm tìm video YouTube
async function findYouTubeVideo(title) {
    try {
        const ytSearchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(title + ' official audio')}&type=video&key=${process.env.YOUTUBE_API_KEY}&maxResults=5`;
        const ytResponse = await axios.get(ytSearchUrl);
        const ytResults = ytResponse.data.items;
        if (!ytResults || ytResults.length === 0) {
            console.log('⚠️ Không tìm thấy video YouTube cho:', title);
            return null;
        }
        // Chọn video có lượt xem cao nhất
        const bestVideo = ytResults.reduce((best, current) => {
            const bestViews = best.snippet?.viewCount || 0;
            const currentViews = current.snippet?.viewCount || 0;
            return currentViews > bestViews ? current : best;
        });
        return {
            url: `https://www.youtube.com/watch?v=${bestVideo.id.videoId}`,
            title: bestVideo.snippet.title,
        };
    } catch (error) {
        console.error('❌ Lỗi tìm kiếm YouTube:', error.message);
        return null;
    }
}

// Hàm lấy danh sách video từ YouTube playlist
async function fetchYouTubePlaylist(playlistId) {
    try {
        const ytPlaylistUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${playlistId}&key=${process.env.YOUTUBE_API_KEY}`;
        const response = await axios.get(ytPlaylistUrl);
        const items = response.data.items;
        if (!items || items.length === 0) {
            console.log('⚠️ Playlist YouTube trống:', playlistId);
            return [];
        }
        return items.map((item) => ({
            url: `https://www.youtube.com/watch?v=${item.snippet.resourceId.videoId}`,
            title: item.snippet.title,
            source: 'youtube',
        }));
    } catch (error) {
        console.error('❌ Lỗi lấy playlist YouTube:', error.message);
        return [];
    }
}

// Hàm tạo file TTS
async function createTTSFile(text, guildId) {
    return new Promise((resolve, reject) => {
        const filePath = path.join(__dirname, `tts_${guildId}_${Date.now()}.mp3`);
        const tts = new gTTS(text, 'vi'); // Ngôn ngữ tiếng Việt
        tts.save(filePath, (err) => {
            if (err) {
                console.error('❌ Lỗi tạo file TTS:', err.message);
                reject(err);
            } else {
                console.log('✅ Đã tạo file TTS:', filePath);
                resolve(filePath);
            }
        });
    });
}

// Hàm rời kênh voice sau 3 phút nếu queue rỗng
function scheduleLeave(guildId, interaction) {
    const queue = queues.get(guildId);
    if (!queue) {
        console.log('⚠️ Không tìm thấy queue cho guild:', guildId);
        return;
    }

    if (queue.leaveTimeout) {
        console.log('🔄 Hủy timeout rời kênh trước đó:', guildId);
        clearTimeout(queue.leaveTimeout);
    }

    queue.leaveTimeout = setTimeout(() => {
        if (queue.songs.length === 0 && queue.connection) {
            console.log('🏃 Bot rời kênh voice sau 3 phút, guild:', guildId);
            queue.connection.destroy();
            queues.delete(guildId);
            interaction.followUp('🎶 Hàng đợi trống, bot đã rời kênh voice sau 3 phút.');
        }
    }, 180000); // 3 phút
}

// Hàm phát bài hát hoặc TTS
async function playSong(interaction, queue) {
    if (queue.leaveTimeout) {
        console.log('🔄 Hủy timeout rời kênh vì có bài mới:', interaction.guild.id);
        clearTimeout(queue.leaveTimeout);
        queue.leaveTimeout = null;
    }

    if (!queue.songs.length) {
        console.log('📭 Queue rỗng, lên lịch rời kênh:', interaction.guild.id);
        queue.player.stop();
        scheduleLeave(interaction.guild.id, interaction);
        return;
    }

    const song = queue.songs[0];
    let resource;
    let ytdlpProcess = null;
    try {
        if (song.source === 'tts') {
            resource = createAudioResource(song.url, {
                inputType: StreamType.Raw,
            });
        } else {
            // Kiểm tra yt-dlp
            try {
                execSync('yt-dlp --version', { stdio: 'ignore' });
                console.log('✅ yt-dlp được tìm thấy trên hệ thống');
            } catch (error) {
                console.error('❌ yt-dlp không được cài đặt hoặc không tìm thấy trong PATH');
                await interaction.followUp('❌ Lỗi: yt-dlp không được cài đặt trên server.');
                return;
            }

            // Kiểm tra FFmpeg
            try {
                execSync('ffmpeg -version', { stdio: 'ignore' });
                console.log('✅ FFmpeg được tìm thấy trên hệ thống');
            } catch (error) {
                console.error('❌ FFmpeg không được cài đặt hoặc không tìm thấy trong PATH');
                await interaction.followUp('❌ Lỗi: FFmpeg không được cài đặt trên server.');
                return;
            }

            // Kiểm tra file cookies
            const cookiesFilePath = path.join(__dirname, 'youtube_cookies.txt');
            if (!fs.existsSync(cookiesFilePath)) {
                console.error('❌ File cookies không tồn tại:', cookiesFilePath);
                await interaction.followUp('❌ Lỗi: File cookies YouTube không tồn tại. Vui lòng cập nhật file cookies.');
                return;
            }

            // Kiểm tra định dạng cookies
            const cookiesContent = fs.readFileSync(cookiesFilePath, 'utf8');
            if (!cookiesContent.startsWith('# Netscape HTTP Cookie File')) {
                console.error('❌ Định dạng cookies không hợp lệ:', cookiesFilePath);
                await interaction.followUp('❌ Lỗi: File cookies YouTube không đúng định dạng Netscape.');
                return;
            }

            // Sử dụng spawn để stream từ yt-dlp với cookies
            const ytdlpCommand = ['--cookies', cookiesFilePath, '-o', '-', song.url, '-f', 'bestaudio', '--no-playlist'];
            console.log('🔍 Chạy lệnh yt-dlp:', `yt-dlp ${ytdlpCommand.join(' ')}`);
            ytdlpProcess = spawn('yt-dlp', ytdlpCommand, {
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            // Ghi log lỗi từ stderr
            let errorOutput = '';
            ytdlpProcess.stderr.on('data', (data) => {
                errorOutput += data.toString();
            });

            ytdlpProcess.on('error', (error) => {
                console.error('❌ Lỗi khi chạy yt-dlp:', error.message);
                console.error('❌ stderr:', errorOutput);
                throw new Error(`yt-dlp error: ${error.message}\n${errorOutput}`);
            });

            ytdlpProcess.on('close', (code) => {
                if (code !== 0) {
                    if (errorOutput.includes('[Errno 32] Broken pipe')) {
                        console.log('⚠️ Bỏ qua lỗi Broken pipe từ yt-dlp do skip bài');
                        return;
                    }
                    if (code === null) {
                        console.log('⚠️ Bỏ qua lỗi code null từ yt-dlp do process bị dừng');
                        return;
                    }
                    if (errorOutput.includes('Sign in to confirm you’re not a bot') || errorOutput.includes('The provided YouTube account cookies are no longer valid')) {
                        console.error('❌ Cookies YouTube không hợp lệ:', errorOutput);
                        interaction.followUp('❌ Lỗi: Cookies YouTube không hợp lệ hoặc đã hết hạn. Vui lòng cập nhật file youtube_cookies.txt.');
                        queue.songs.shift();
                        if (ytdlpProcess) {
                            ytdlpProcess.kill('SIGTERM');
                            console.log('🛑 Đã dừng yt-dlp process do cookies không hợp lệ');
                            delete queue.currentYtdlpProcess;
                        }
                        playSong(interaction, queue);
                        return;
                    }
                    console.error(`❌ yt-dlp exited với code ${code}:`, errorOutput);
                    throw new Error(`yt-dlp exited with code ${code}: ${errorOutput}`);
                }
            });

            resource = createAudioResource(ytdlpProcess.stdout, {
                inputType: StreamType.WebmOpus,
            });

            // Lưu process để dừng khi skip
            queue.currentYtdlpProcess = ytdlpProcess;
        }

        queue.player.play(resource);
        queue.connection.subscribe(queue.player);
        console.log(`🎶 Đang phát: ${song.title} (Nguồn: ${song.source})`);
        await interaction.followUp(`🎶 Đang phát: **${song.title}** (Nguồn: ${song.source})`);
    } catch (error) {
        console.error('❌ Lỗi khi phát:', error.message);
        await interaction.followUp(`❌ Lỗi khi phát bài hát: ${error.message}`);
        if (song.source === 'tts' && song.url) {
            try { fs.unlinkSync(song.url); } catch (e) { }
            console.log('🗑 Đã xóa file TTS do lỗi:', song.url);
        }
        queue.songs.shift();
        if (ytdlpProcess) {
            ytdlpProcess.kill('SIGTERM');
            console.log('🛑 Đã dừng yt-dlp process do lỗi');
        }
        delete queue.currentYtdlpProcess;
        playSong(interaction, queue);
    }
}

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    console.log(`📩 Nhận lệnh: ${interaction.commandName} từ user ${interaction.user.tag} trong guild ${interaction.guild?.id}`);

    const { commandName } = interaction;

    if (commandName === 'ai') {
        const prompt = interaction.options.getString('prompt');
        await interaction.deferReply();
        try {
            const response = await axios.post(
                'https://openrouter.ai/api/v1/chat/completions',
                {
                    model: 'qwen/qwen3-32b:free',
                    messages: [{ role: 'user', content: prompt }],
                },
                {
                    headers: {
                        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
                        'Content-Type': 'application/json',
                    },
                }
            );

            const reply = response.data.choices[0].message.content;
            const file = await generateFileFromResponse(prompt, reply);

            if (file) {
                await interaction.editReply({
                    content: '📝 Đây là file bạn yêu cầu:',
                    files: [file],
                });
            } else {
                const chunks = reply.match(/[\s\S]{1,2000}/g);
                await interaction.editReply(chunks[0]);
                for (let i = 1; i < chunks.length; i++) {
                    await interaction.followUp(chunks[i]);
                }
            }
        } catch (error) {
            console.error('❌ Lỗi AI:', error.message);
            await interaction.editReply('❌ Có lỗi xảy ra khi gọi OpenRouter.');
        }
    } else if (commandName === 'play') {
        const query = interaction.options.getString('query');
        const member = interaction.member;
        const voiceChannel = member?.voice?.channel;
        const guild = interaction.guild;

        // Kiểm tra điều kiện cần thiết
        if (!guild) {
            console.log('⚠️ Lệnh play trong non-guild context');
            return interaction.reply('❌ Lệnh này chỉ hoạt động trong server.');
        }
        if (!voiceChannel) {
            console.log('⚠️ User không ở voice channel');
            return interaction.reply('❌ Bạn cần tham gia voice channel trước!');
        }
        if (
            !voiceChannel.permissionsFor(guild.members.me).has([
                PermissionsBitField.Flags.Connect,
                PermissionsBitField.Flags.Speak,
            ])
        ) {
            console.log('⚠️ Bot thiếu quyền Connect/Speak');
            return interaction.reply(
                '❌ Bot không có quyền tham gia hoặc phát âm thanh trong voice channel!'
            );
        }

        await interaction.deferReply();

        try {
            await ensureSpotifyToken();

            // Khởi tạo queue nếu chưa có
            let queue = queues.get(guild.id);
            if (!queue) {
                console.log('🆕 Tạo queue mới cho guild:', guild.id);
                queue = {
                    songs: [],
                    connection: null,
                    player: createAudioPlayer(),
                    voiceChannelId: voiceChannel.id,
                    leaveTimeout: null,
                    currentYtdlpProcess: null,
                };
                queues.set(guild.id, queue);
            }

            // Kết nối voice channel nếu cần
            if (
                !queue.connection ||
                queue.connection.state.status === VoiceConnectionStatus.Disconnected ||
                queue.connection.state.status === VoiceConnectionStatus.Destroyed
            ) {
                console.log('🔌 Tạo hoặc tái tạo kết nối voice:', voiceChannel.id, ', trạng thái trước:', queue.connection?.state?.status || 'null');
                if (queue.connection) {
                    queue.connection.destroy();
                    console.log('🗑 Đã hủy kết nối voice cũ:', guild.id);
                }
                queue.connection = joinVoiceChannel({
                    channelId: voiceChannel.id,
                    guildId: guild.id,
                    adapterCreator: guild.voiceAdapterCreator,
                });

                queue.connection.on(VoiceConnectionStatus.Disconnected, async () => {
                    console.log('🔴 Bot bị ngắt kết nối khỏi voice channel:', guild.id);
                    queue.songs = [];
                    queue.player.stop();
                    if (queue.currentYtdlpProcess) {
                        queue.currentYtdlpProcess.kill('SIGTERM');
                        console.log('🛑 Đã dừng yt-dlp process do ngắt kết nối');
                        delete queue.currentYtdlpProcess;
                    }
                    if (queue.connection) {
                        queue.connection.destroy();
                        queue.connection = null;
                    }
                    queues.delete(guild.id);
                });

                queue.player.on(AudioPlayerStatus.Idle, () => {
                    console.log('⏹ Player idle, chuyển bài tiếp theo:', guild.id);
                    const currentSong = queue.songs[0];
                    if (currentSong && currentSong.source === 'tts' && currentSong.url) {
                        try { fs.unlinkSync(currentSong.url); } catch (e) { }
                        console.log('🗑 Đã xóa file TTS:', currentSong.url);
                    }
                    queue.songs.shift();
                    if (queue.currentYtdlpProcess) {
                        queue.currentYtdlpProcess.kill('SIGTERM');
                        console.log('🛑 Đã dừng yt-dlp process sau khi phát xong');
                        delete queue.currentYtdlpProcess;
                    }
                    playSong(interaction, queue);
                });

                queue.player.on('error', (error) => {
                    console.error('❌ Lỗi AudioPlayer:', error.message);
                    const currentSong = queue.songs[0];
                    if (currentSong && currentSong.source === 'tts' && currentSong.url) {
                        try { fs.unlinkSync(currentSong.url); } catch (e) { }
                        console.log('🗑 Đã xóa file TTS do lỗi:', currentSong.url);
                    }
                    interaction.followUp('❌ Có lỗi khi phát.');
                    queue.songs.shift();
                    if (queue.currentYtdlpProcess) {
                        queue.currentYtdlpProcess.kill('SIGTERM');
                        console.log('🛑 Đã dừng yt-dlp process do lỗi AudioPlayer');
                        delete queue.currentYtdlpProcess;
                    }
                    playSong(interaction, queue);
                });
            }

            // Xử lý query
            const mediaId = extractMediaId(query);
            if (mediaId) {
                console.log('🔍 Xử lý media:', mediaId);
                if (mediaId.type === 'spotify_track') {
                    await ensureSpotifyToken();
                    const trackResponse = await spotifyApi.getTrack(mediaId.id);
                    const track = trackResponse.body;
                    if (!track) {
                        console.log('⚠️ Không tìm thấy track Spotify:', mediaId.id);
                        return interaction.editReply('❌ Không tìm thấy bài hát từ link Spotify.');
                    }
                    const title = `${track.name} - ${track.artists[0].name}`;
                    const ytVideo = await findYouTubeVideo(title);
                    if (!ytVideo) {
                        console.log('⚠️ Không tìm thấy video YouTube cho track:', title);
                        return interaction.editReply('❌ Không tìm thấy video YouTube tương ứng.');
                    }
                    queue.songs.push({
                        url: ytVideo.url,
                        title: ytVideo.title,
                        source: 'spotify',
                    });
                    console.log('🎵 Spotify Track:', JSON.stringify(queue.songs[queue.songs.length - 1], null, 2));
                } else if (mediaId.type === 'spotify_playlist') {
                    await ensureSpotifyToken();
                    const playlistResponse = await spotifyApi.getPlaylist(mediaId.id);
                    const playlist = playlistResponse.body;
                    if (!playlist || !playlist.tracks.items) {
                        console.log('⚠️ Không tìm thấy playlist Spotify:', mediaId.id);
                        return interaction.editReply('❌ Không tìm thấy playlist từ link Spotify.');
                    }
                    for (const item of playlist.tracks.items) {
                        const track = item.track;
                        const title = `${track.name} - ${track.artists[0].name}`;
                        const ytVideo = await findYouTubeVideo(title);
                        if (ytVideo) {
                            queue.songs.push({
                                url: ytVideo.url,
                                title: ytVideo.title,
                                source: 'spotify',
                            });
                            console.log('🎵 Spotify Playlist Track:', JSON.stringify(queue.songs[queue.songs.length - 1], null, 2));
                        }
                    }
                } else if (mediaId.type === 'youtube_playlist') {
                    const videos = await fetchYouTubePlaylist(mediaId.id);
                    if (videos.length === 0) {
                        console.log('⚠️ Không tìm thấy video trong playlist YouTube:', mediaId.id);
                        return interaction.editReply('❌ Không tìm thấy video trong playlist YouTube.');
                    }
                    queue.songs.push(...videos);
                    console.log(`🎵 Đã thêm ${videos.length} video từ playlist YouTube`);
                }
            } else {
                console.log('🔍 Tìm kiếm query:', query);
                const [spotifyResult, youtubeResult] = await Promise.allSettled([
                    (async () => {
                        try {
                            await ensureSpotifyToken();
                            const searchResults = await spotifyApi.searchTracks(query, { limit: 1 });
                            const tracks = searchResults.body.tracks.items;
                            if (!tracks || !tracks.length) {
                                throw new Error('No Spotify results');
                            }
                            const track = tracks[0];
                            const title = `${track.name} - ${track.artists[0].name}`;
                            const ytVideo = await findYouTubeVideo(title);
                            if (!ytVideo) {
                                throw new Error('No YouTube match for Spotify track');
                            }
                            return {
                                source: 'spotify',
                                title: ytVideo.title,
                                url: ytVideo.url,
                            };
                        } catch (error) {
                            if (error.message.includes('access token expired')) {
                                console.log('🔄 Thử làm mới token Spotify do lỗi hết hạn');
                                await refreshSpotifyToken();
                                const searchResults = await spotifyApi.searchTracks(query, { limit: 1 });
                                const tracks = searchResults.body.tracks.items;
                                if (!tracks || !tracks.length) {
                                    throw new Error('No Spotify results');
                                }
                                const track = tracks[0];
                                const title = `${track.name} - ${track.artists[0].name}`;
                                const ytVideo = await findYouTubeVideo(title);
                                if (!ytVideo) {
                                    throw new Error('No YouTube match for Spotify track');
                                }
                                return {
                                    source: 'spotify',
                                    title: ytVideo.title,
                                    url: ytVideo.url,
                                };
                            }
                            throw error;
                        }
                    })(),
                    (async () => {
                        const ytVideo = await findYouTubeVideo(query);
                        if (!ytVideo) {
                            throw new Error('No YouTube results');
                        }
                        return {
                            source: 'youtube',
                            title: ytVideo.title,
                            url: ytVideo.url,
                        };
                    })(),
                ]);

                const validResults = [];
                if (spotifyResult.status === 'fulfilled') {
                    validResults.push(spotifyResult.value);
                    console.log('🔍 Spotify Result:', JSON.stringify(spotifyResult.value, null, 2));
                } else {
                    console.log('⚠️ Spotify Error:', spotifyResult.reason.message);
                }
                if (youtubeResult.status === 'fulfilled') {
                    validResults.push(youtubeResult.value);
                    console.log('🔍 YouTube Result:', JSON.stringify(youtubeResult.value, null, 2));
                } else {
                    console.log('⚠️ YouTube Error:', youtubeResult.reason.message);
                }

                if (validResults.length === 0) {
                    console.log('⚠️ Không tìm thấy bài hát nào');
                    return interaction.editReply('❌ Không tìm thấy bài hát nào trên Spotify hoặc YouTube.');
                }

                const bestMatch = getBestMatch(query, validResults);
                if (!bestMatch) {
                    console.log('⚠️ Không tìm thấy bài hát phù hợp');
                    return interaction.editReply('❌ Không tìm thấy bài hát phù hợp.');
                }

                queue.songs.push({
                    url: bestMatch.url,
                    title: bestMatch.title,
                    source: bestMatch.source,
                });
            }

            if (queue.songs.length === 1) {
                console.log('🎵 Phát bài đầu tiên:', queue.songs[0].title);
                await interaction.editReply(`🎶 Đã thêm: **${queue.songs[0].title}** (Nguồn: ${queue.songs[0].source})`);
                playSong(interaction, queue);
            } else {
                const addedCount = mediaId && mediaId.type === 'youtube_playlist' ? queue.songs.length : 1;
                console.log('🎵 Thêm vào queue:', queue.songs[queue.songs.length - 1].title);
                await interaction.editReply(`🎶 Đã thêm ${addedCount} bài vào hàng đợi. Bài đầu tiên: **${queue.songs[0].title}** (Nguồn: ${queue.songs[0].source})`);
            }
        } catch (err) {
            console.error('❌ Lỗi khi phát nhạc:', err.message);
            await interaction.editReply(
                `❌ Không thể phát nhạc: ${err.message || 'Lỗi không xác định.'}`
            );
        }
    } else if (commandName === 'tts') {
        const text = interaction.options.getString('text');
        const member = interaction.member;
        const voiceChannel = member?.voice?.channel;
        const guild = interaction.guild;

        if (!guild) {
            console.log('⚠️ Lệnh tts trong non-guild context');
            return interaction.reply('❌ Lệnh này chỉ hoạt động trong server.');
        }
        if (!voiceChannel) {
            console.log('⚠️ User không ở voice channel');
            return interaction.reply('❌ Bạn cần tham gia voice channel trước!');
        }
        if (
            !voiceChannel.permissionsFor(guild.members.me).has([
                PermissionsBitField.Flags.Connect,
                PermissionsBitField.Flags.Speak,
            ])
        ) {
            console.log('⚠️ Bot thiếu quyền Connect/Speak');
            return interaction.reply(
                '❌ Bot không có quyền tham gia hoặc phát âm thanh trong voice channel!'
            );
        }
        if (text.length > 5000) {
            console.log('⚠️ Text TTS quá dài:', text.length);
            return interaction.reply('❌ Văn bản quá dài (tối đa 5000 ký tự).');
        }

        await interaction.deferReply();

        try {
            let queue = queues.get(guild.id);
            if (!queue) {
                console.log('🆕 Tạo queue mới cho guild:', guild.id);
                queue = {
                    songs: [],
                    connection: null,
                    player: createAudioPlayer(),
                    voiceChannelId: voiceChannel.id,
                    leaveTimeout: null,
                    currentYtdlpProcess: null,
                };
                queues.set(guild.id, queue);
            }

            if (
                !queue.connection ||
                queue.connection.state.status === VoiceConnectionStatus.Disconnected ||
                queue.connection.state.status === VoiceConnectionStatus.Destroyed
            ) {
                console.log('🔌 Tạo hoặc tái tạo kết nối voice:', voiceChannel.id, ', trạng thái trước:', queue.connection?.state?.status || 'null');
                if (queue.connection) {
                    queue.connection.destroy();
                    console.log('🗑 Đã hủy kết nối voice cũ:', guild.id);
                }
                queue.connection = joinVoiceChannel({
                    channelId: voiceChannel.id,
                    guildId: guild.id,
                    adapterCreator: guild.voiceAdapterCreator,
                });

                queue.connection.on(VoiceConnectionStatus.Disconnected, async () => {
                    console.log('🔴 Bot bị ngắt kết nối khỏi voice channel:', guild.id);
                    queue.songs = [];
                    queue.player.stop();
                    if (queue.currentYtdlpProcess) {
                        queue.currentYtdlpProcess.kill('SIGTERM');
                        console.log('🛑 Đã dừng yt-dlp process do ngắt kết nối');
                        delete queue.currentYtdlpProcess;
                    }
                    if (queue.connection) {
                        queue.connection.destroy();
                        queue.connection = null;
                    }
                    queues.delete(guild.id);
                });

                queue.player.on(AudioPlayerStatus.Idle, () => {
                    console.log('⏹ Player idle, chuyển bài tiếp theo:', guild.id);
                    const currentSong = queue.songs[0];
                    if (currentSong && currentSong.source === 'tts' && currentSong.url) {
                        try { fs.unlinkSync(currentSong.url); } catch (e) { }
                        console.log('🗑 Đã xóa file TTS:', currentSong.url);
                    }
                    queue.songs.shift();
                    if (queue.currentYtdlpProcess) {
                        queue.currentYtdlpProcess.kill('SIGTERM');
                        console.log('🛑 Đã dừng yt-dlp process sau khi phát xong');
                        delete queue.currentYtdlpProcess;
                    }
                    playSong(interaction, queue);
                });

                queue.player.on('error', (error) => {
                    console.error('❌ Lỗi AudioPlayer:', error.message);
                    const currentSong = queue.songs[0];
                    if (currentSong && currentSong.source === 'tts' && currentSong.url) {
                        try { fs.unlinkSync(currentSong.url); } catch (e) { }
                        console.log('🗑 Đã xóa file TTS do lỗi:', currentSong.url);
                    }
                    interaction.followUp('❌ Có lỗi khi phát.');
                    queue.songs.shift();
                    if (queue.currentYtdlpProcess) {
                        queue.currentYtdlpProcess.kill('SIGTERM');
                        console.log('🛑 Đã dừng yt-dlp process do lỗi AudioPlayer');
                        delete queue.currentYtdlpProcess;
                    }
                    playSong(interaction, queue);
                });
            }

            const ttsFilePath = await createTTSFile(text, guild.id);
            queue.songs.push({
                url: ttsFilePath,
                title: `TTS: ${text.slice(0, 50)}${text.length > 50 ? '...' : ''}`,
                source: 'tts',
            });

            if (queue.songs.length === 1) {
                console.log('🎙 Phát TTS:', text.slice(0, 50));
                await interaction.editReply(`🎙 Đang đọc: **${text.slice(0, 50)}${text.length > 50 ? '...' : ''}**`);
                playSong(interaction, queue);
            } else {
                console.log('🎙 Thêm TTS vào queue:', text.slice(0, 50));
                await interaction.editReply(`🎙 Đã thêm vào hàng đợi: **${text.slice(0, 50)}${text.length > 50 ? '...' : ''}**`);
            }
        } catch (err) {
            console.error('❌ Lỗi khi xử lý TTS:', err.message);
            await interaction.editReply(`❌ Không thể đọc văn bản: ${err.message || 'Lỗi không xác định.'}`);
        }
    } else if (commandName === 'skip') {
        const guild = interaction.guild;
        const queue = queues.get(guild.id);
        if (!queue || !queue.songs.length) {
            console.log('⚠️ Skip: Không có bài hát trong queue');
            return interaction.reply('❌ Không có bài hát nào trong hàng đợi.');
        }

        // Dừng yt-dlp process hiện tại nếu có
        if (queue.currentYtdlpProcess) {
            queue.currentYtdlpProcess.kill('SIGTERM');
            console.log('🛑 Đã dừng yt-dlp process trước khi skip:', guild.id);
            delete queue.currentYtdlpProcess;
        }

        queue.player.stop();
        console.log('⏹ Dừng player trước khi skip:', guild.id);

        const currentSong = queue.songs[0];
        if (currentSong && currentSong.source === 'tts' && currentSong.url) {
            try { fs.unlinkSync(currentSong.url); } catch (e) { }
            console.log('🗑 Đã xóa file TTS khi skip:', currentSong.url);
        }

        queue.songs.shift();
        console.log('⏭ Skip bài hát, queue còn:', queue.songs.length);

        await interaction.reply('⏭ Đã bỏ qua bài hát.');
        playSong(interaction, queue);
    } else if (commandName === 'pause') {
        const guild = interaction.guild;
        const queue = queues.get(guild.id);
        if (!queue || !queue.songs.length) {
            console.log('⚠️ Pause: Không có bài hát đang phát');
            return interaction.reply('❌ Không có bài hát nào đang phát.');
        }
        if (queue.player.state.status === AudioPlayerStatus.Playing) {
            queue.player.pause();
            console.log('⏸ Đã tạm dừng nhạc');
            await interaction.reply('⏸ Đã tạm dừng nhạc.');
        } else {
            console.log('⚠️ Pause: Nhạc không ở trạng thái playing');
            await interaction.reply('❌ Nhạc đã được tạm dừng hoặc không phát.');
        }
    } else if (commandName === 'resume') {
        const guild = interaction.guild;
        const queue = queues.get(guild.id);
        if (!queue || !queue.songs.length) {
            console.log('⚠️ Resume: Không có bài hát trong queue');
            return interaction.reply('❌ Không có bài hát nào trong hàng đợi.');
        }
        if (queue.player.state.status === AudioPlayerStatus.Paused) {
            queue.player.unpause();
            console.log('▶️ Đã tiếp tục phát nhạc');
            await interaction.reply('▶️ Đã tiếp tục phát nhạc.');
        } else {
            console.log('⚠️ Resume: Nhạc không ở trạng thái paused');
            await interaction.reply('❌ Nhạc không được tạm dừng để tiếp tục.');
        }
    } else if (commandName === 'queue') {
        const guild = interaction.guild;
        const queue = queues.get(guild.id);
        if (!queue || !queue.songs.length) {
            console.log('⚠️ Queue: Hàng đợi rỗng');
            return interaction.reply('❌ Hàng đợi trống.');
        }
        const queueList = queue.songs.map((song, index) => `${index + 1}. **${song.title}** (${song.source})`).join('\n');
        console.log('📜 Hiển thị queue:', queue.songs.length, 'bài');
        await interaction.reply(`📜 **Danh sách phát**:\n${queueList}`);
    }
});

client.login(process.env.DISCORD_TOKEN).catch((error) => {
    console.error('❌ Lỗi đăng nhập bot:', error.message);
});

const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// Route kiểm tra bot hoạt động
app.get('/', (req, res) => {
    res.send('Bot is running!');
});

// Khởi động HTTP server
app.listen(PORT, () => {
    console.log(`🌐 HTTP server đang chạy tại cổng ${PORT}`);
});
