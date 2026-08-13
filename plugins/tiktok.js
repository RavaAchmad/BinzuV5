import fetch from 'node-fetch';
import axios from 'axios';
import cheerio from 'cheerio';
import moment from 'moment-timezone';
import FormData from "form-data";

export default {
    command: 'tiktok',
    aliases: ['tt', 'ttdl', 'tiktokdl'],
    category: 'download',
    description: 'Download TikTok video without watermark',
    usage: '.tiktok <URL>',
    async handler(sock, message, args, context) {
        const { chatId, rawText } = context;
        const text = args.join(' ');
        if (!text) return await sock.sendMessage(chatId, { text: '✳️ Contoh :\n.tiktok https://www.tiktok.com/xxxxx' }, { quoted: message });
        
        await sock.sendMessage(chatId, { react: { text: "⚡", key: message.key }});
        
        try {
            let res, images = [];
            const dataV1 = await tiktokV1(text);
            if (dataV1?.data) {
                const d = dataV1.data;
                images = d.images || d.image_post || [];
                res = {
                    title: d.title, region: d.region, duration: d.duration,
                    create_time: d.create_time, play_count: d.play_count,
                    digg_count: d.digg_count, comment_count: d.comment_count,
                    share_count: d.share_count, download_count: d.download_count,
                    author: { unique_id: d.author?.unique_id, nickname: d.author?.nickname },
                    cover: d.cover, play: d.play, hdplay: d.hdplay, wmplay: d.wmplay
                };
            }

            const dataV2 = await tiktokV2(text);
            if ((!res?.play && images.length === 0) && dataV2.video_url) res = res || { play: dataV2.video_url };
            if (dataV2.slide_images?.length > 0) images = dataV2.slide_images;

            if (images.length > 0) {
                await sock.sendMessage(chatId, { text: `terdeteksi gambar ${images.length} wett` }, { quoted: message });
                for (const img of images) await sock.sendMessage(chatId, { image: { url: img }, caption: res?.title || '' }, { quoted: message });
                return;
            }

            const time = res?.create_time ? moment.unix(res.create_time).tz('Asia/Jakarta').format('dddd, D MMMM YYYY [pukul] HH:mm:ss') : '-';
            const caption = `🎬 *Video TikTok Info*  
✨ *Judul* : ${res?.title || '-'}  
🌍 *Region* : ${res?.region || 'N/A'}  
⏳ *Durasi* : ${res?.duration || '-'} detik  
📅 *Upload* : ${time}  
📊 *Statistik* : ${formatK(res?.play_count || 0)} views, ${formatK(res?.digg_count || 0)} likes`;

            const videoUrl = res?.play || res?.hdplay || res?.wmplay;
            if (videoUrl) await sock.sendMessage(chatId, { video: { url: videoUrl }, caption }, { quoted: message });
            else if (res?.cover) await sock.sendMessage(chatId, { image: { url: res.cover }, caption: '🎨 Cover Video' }, { quoted: message });
        } catch (e) {
                await sock.sendMessage(chatId, { text: '❌ Error: Failed to process TikTok download' }, { quoted: message });
        }
    }
};

function formatK(num) {
    return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(num);
}

async function tiktokV1(query) {
    try {
        const params = new URLSearchParams({ url: query, hd: '1' });
        const { data } = await axios.post('https://tikwm.com/api/', params);
        return data;
    } catch { return { data: null }; }
}

async function tiktokV2(query) {
    try {
        const form = new FormData();
        form.append('q', query);
        const { data } = await axios.post('https://savetik.co/api/ajaxSearch', form, { headers: form.getHeaders() });
        const $ = cheerio.load(data.data);
        return { 
            video_url: $('video#vid').attr('data-src'),
            slide_images: $('.photo-list .download-box li').map((_, el) => $(el).find('img').attr('src')).get()
        };
    } catch { return { video_url: '', slide_images: [] }; }
}