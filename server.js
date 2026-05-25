// server.js - Resolve short URL → Comment FB (1 post/ngày) → Lấy OG từ short URL
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// CONFIG
const ALLOWED_ORIGINS = [
    'https://loilh.github.io',
    'http://localhost:3000',
    'http://localhost:5000'
];

const FACEBOOK_PAGE_ID = process.env.FACEBOOK_PAGE_ID || '';
const FACEBOOK_APP_TOKEN = process.env.FACEBOOK_APP_TOKEN || '';

// Cache (1 giờ)
const linkCache = new Map();
const CACHE_TIME = 1000 * 60 * 60;

// Daily post — persist ra file để không mất khi restart
const STATE_FILE = path.join(__dirname, '.daily-post.json');

function loadDailyPost() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        }
    } catch (_) {}
    return { id: null, date: null };
}

function saveDailyPost(data) {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(data)); } catch (_) {}
}

let dailyPost = loadDailyPost();

// ==================== MIDDLEWARE ====================

app.use((req, res, next) => {
    const origin = req.get('origin');
    if (!origin) return res.status(403).json({ error: 'Origin header required' });

    if (ALLOWED_ORIGINS.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
        res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type');
        next();
    } else {
        console.log(`❌ Denied: ${origin}`);
        return res.status(403).json({ error: 'Origin not allowed' });
    }
});

app.use(express.json());

// ==================== ROUTES ====================

app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/resolve-link', async (req, res) => {
    try {
        const { url } = req.query;
        if (!url) return res.status(400).json({ error: 'URL parameter required' });

        console.log(`\n🔄 ${url}`);

        // Cache
        if (linkCache.has(url)) {
            const cached = linkCache.get(url);
            if (Date.now() - cached.timestamp < CACHE_TIME) {
                console.log('✅ Cache hit');
                return res.json({ ...cached.data, cached: true });
            }
            linkCache.delete(url);
        }

        // Resolve short URL → lấy resolvedUrl
        let resolvedUrl = url;
        const originLinkMatch = url.match(/origin_link=([^&]+)/);

        if (originLinkMatch) {
            try {
                resolvedUrl = decodeURIComponent(originLinkMatch[1]);
            } catch (_) {}
        } else {
            try {
                const r = await axios.get(url, {
                    maxRedirects: 5,
                    timeout: 8000,
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
                });
                resolvedUrl = r.request.res.responseUrl || r.config.url;
            } catch (e) {
                if (e.response?.status === 301 || e.response?.status === 302) {
                    resolvedUrl = e.response.headers.location || url;
                }
            }
        }

        // URL sạch (bỏ query params) dùng để hiển thị
        const cleanUrl = resolvedUrl.split('?')[0];
        console.log(`✅ Resolved: ${cleanUrl}`);

        // Extract shopId & itemId
        let shopId, itemId;
        const m1 = resolvedUrl.match(/\/([^\/]+)\/(\d+)\/(\d+)/);
        if (m1) { shopId = m1[2]; itemId = m1[3]; }
        else {
            const m2 = resolvedUrl.match(/-i\.(\d+)\.(\d+)/);
            if (m2) { shopId = m2[1]; itemId = m2[2]; }
        }

        if (!shopId || !itemId) {
            return res.json({ originalUrl: url, resolvedUrl: cleanUrl, productInfo: null, cached: false });
        }

        console.log(`📝 shop=${shopId}, item=${itemId}`);

        // Comment short URL → FB crawl → đọc lại attachment từ comment
        let productInfo = null;
        let facebookPostId = null;
        if (FACEBOOK_APP_TOKEN) {
            const { postId, productInfo: info } = await commentAndGetInfo(url);
            productInfo = info;
            facebookPostId = postId;
        }

        const result = { originalUrl: url, resolvedUrl: cleanUrl, productInfo, facebookPostId, cached: false };
        linkCache.set(url, { data: result, timestamp: Date.now() });

        console.log('✨ Done');
        res.json(result);

    } catch (error) {
        console.error('❌', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ==================== FACEBOOK ====================

/**
 * Lấy daily post (tạo mới nếu chưa có hôm nay)
 */
async function getOrCreateDailyPost() {
    const today = new Date().toISOString().split('T')[0];

    if (dailyPost.id && dailyPost.date === today) {
        console.log(`📌 Post hôm nay: ${dailyPost.id}`);
        return dailyPost.id;
    }

    console.log(`📝 Tạo post mới ngày ${today}...`);
    const r = await axios.post(
        `https://graph.facebook.com/v22.0/${FACEBOOK_PAGE_ID}/feed`,
        {
            message: `🛍️ Shopee hay ngày ${today}\n\nCác link sản phẩm bên dưới 👇`,
            access_token: FACEBOOK_APP_TOKEN
        }
    );

    dailyPost = { id: r.data.id, date: today };
    saveDailyPost(dailyPost);
    console.log(`✅ Post: ${dailyPost.id}`);
    return dailyPost.id;
}

/**
 * Comment short URL vào daily post → FB crawl link → đọc attachment từ comment
 * Không cần post tạm, không cần xóa — gọn hơn, nhanh hơn
 */
async function commentAndGetInfo(shortUrl) {
    try {
        const postId = await getOrCreateDailyPost();

        // Comment short URL — FB sẽ crawl và đính attachment
        console.log('💬 Commenting...');
        const commentRes = await axios.post(
            `https://graph.facebook.com/v22.0/${postId}/comments`,
            { message: shortUrl, access_token: FACEBOOK_APP_TOKEN }
        );
        const commentId = commentRes.data.id;
        console.log(`   Comment ID: ${commentId}`);

        // Chờ FB crawl link trong comment
        await new Promise(r => setTimeout(r, 1500));

        // Đọc attachment từ comment
        const readRes = await axios.get(
            `https://graph.facebook.com/v22.0/${commentId}`,
            {
                params: {
                    fields: 'attachment{title,media,url,type}',
                    access_token: FACEBOOK_APP_TOKEN
                }
            }
        );

        const att = readRes.data?.attachment || {};
        const title = att.title || '';
        const imageUrl = att.media?.image?.src || '';

        console.log(`   Attachment: "${title.substring(0, 60)}"`);

        let productInfo = null;
        if (title && !title.toLowerCase().startsWith('shopee việt nam')) {
            productInfo = {
                name: title.replace(/\s*\|\s*Shopee.*$/i, '').trim().substring(0, 200),
                image: imageUrl.startsWith('http') ? imageUrl : '',
                price: 0,
                rating: 0,
                sales: 0
            };
            console.log(`✅ Product: ${productInfo.name.substring(0, 60)}`);
            console.log(`   🖼️  Image: ${productInfo.image ? 'có' : 'không'}`);
        } else {
            console.log('⚠️ Không lấy được product info từ comment attachment');
        }

        return { postId, productInfo };

    } catch (e) {
        console.log(`⚠️ Comment lỗi: ${e.message}`);
        if (e.response) console.log('   ', JSON.stringify(e.response.data));
        return { postId: null, productInfo: null };
    }
}

// ==================== START ====================

app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════╗
║  Shopee Affiliate Backend                    ║
║  Port: ${PORT}                                 ║
║  GET /api/health                             ║
║  GET /api/resolve-link?url=...               ║
╚══════════════════════════════════════════════╝
    `);
});
