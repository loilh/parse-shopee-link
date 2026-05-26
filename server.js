const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const ALLOWED_ORIGINS = [
    'https://loilh.github.io'
];

const FACEBOOK_PAGE_ID = process.env.FACEBOOK_PAGE_ID || '';
const FACEBOOK_APP_TOKEN = process.env.FACEBOOK_APP_TOKEN || '';

// Cache 1 giờ
const linkCache = new Map();
const CACHE_TIME = 1000 * 60 * 60;

// Daily post — lưu file để không mất khi restart
const STATE_FILE = path.join(__dirname, '.daily-post.json');

function loadDailyPost() {
    try {
        if (fs.existsSync(STATE_FILE))
            return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
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

        // 1️⃣ Thử direct OG fetch trước (nhanh ~200-400ms)
        let productInfo = await fetchOgDirect(url);
        let postId = null;

        // 2️⃣ Fallback: Facebook comment nếu direct thất bại
        if (!productInfo && FACEBOOK_APP_TOKEN) {
            console.log('↩️  Fallback → Facebook...');
            ({ postId, productInfo } = await commentAndGetInfo(url));
        }

        const result = { url, productInfo, facebookPostId: postId, cached: false };
        linkCache.set(url, { data: result, timestamp: Date.now() });

        console.log('✨ Done');
        res.json(result);

    } catch (error) {
        console.error('❌', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ==================== DIRECT OG FETCH ====================

// Decode các HTML entities thường gặp trong og:title
function decodeHtmlEntities(str) {
    return str
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

function parseOgTag(html, property) {
    // Hỗ trợ cả 2 thứ tự thuộc tính: property trước hoặc content trước
    const patterns = [
        new RegExp(`<meta[^>]*property=["']${property}["'][^>]*content=["']([^"']+)["']`, 'i'),
        new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*property=["']${property}["']`, 'i'),
    ];
    for (const re of patterns) {
        const m = html.match(re);
        if (m) return decodeHtmlEntities(m[1]);
    }
    return '';
}

async function fetchOgDirect(shortUrl) {
    try {
        console.log('🌐 Direct OG fetch...');
        const response = await axios.get(shortUrl, {
            maxRedirects: 10,
            timeout: 7000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
                'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8',
            },
            // Chỉ cần phần <head> — tránh download toàn bộ trang
            transformResponse: [(data) => {
                if (typeof data !== 'string') return data;
                const headEnd = data.indexOf('</head>');
                return headEnd !== -1 ? data.slice(0, headEnd + 7) : data.slice(0, 8000);
            }],
        });

        const html = typeof response.data === 'string' ? response.data : '';
        const title = parseOgTag(html, 'og:title');
        const image = parseOgTag(html, 'og:image');

        if (!title || title.toLowerCase().startsWith('shopee việt nam')) {
            console.log('⚠️ OG title không hợp lệ');
            return null;
        }

        const productInfo = {
            name: title.replace(/\s*\|\s*Shopee.*$/i, '').trim().substring(0, 200),
            image: image.startsWith('http') ? image : '',
        };
        console.log(`✅ Direct: ${productInfo.name.substring(0, 60)}`);
        return productInfo;

    } catch (e) {
        console.log(`⚠️ Direct fetch lỗi: ${e.message}`);
        return null;
    }
}

// ==================== FACEBOOK ====================

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

async function commentAndGetInfo(shortUrl) {
    try {
        const postId = await getOrCreateDailyPost();

        // Comment short URL → FB crawl và đính attachment
        console.log('💬 Commenting...');
        const commentRes = await axios.post(
            `https://graph.facebook.com/v22.0/${postId}/comments`,
            { message: shortUrl, access_token: FACEBOOK_APP_TOKEN }
        );
        const commentId = commentRes.data.id;

        // Poll thay vì chờ cố định — kiểm tra mỗi 400ms, tối đa 5 lần (2s)
        let att = {};
        for (let i = 0; i < 5; i++) {
            await new Promise(r => setTimeout(r, 400));
            const readRes = await axios.get(
                `https://graph.facebook.com/v22.0/${commentId}`,
                {
                    params: {
                        fields: 'attachment{title,media,url,type}',
                        access_token: FACEBOOK_APP_TOKEN
                    }
                }
            );
            att = readRes.data?.attachment || {};
            if (att.title) {
                console.log(`⏱️  FB crawl xong sau ${(i + 1) * 400}ms`);
                break;
            }
        }

        const title = att.title || '';
        const imageUrl = att.media?.image?.src || '';

        let productInfo = null;
        if (title && !title.toLowerCase().startsWith('shopee việt nam')) {
            productInfo = {
                name: title.replace(/\s*\|\s*Shopee.*$/i, '').trim().substring(0, 200),
                image: imageUrl.startsWith('http') ? imageUrl : ''
            };
            console.log(`✅ FB: ${productInfo.name.substring(0, 60)}`);
        } else {
            console.log('⚠️ Không lấy được product info qua FB');
        }

        return { postId, productInfo };

    } catch (e) {
        console.log(`⚠️ Lỗi FB: ${e.message}`);
        if (e.response) console.log('  ', JSON.stringify(e.response.data));
        return { postId: null, productInfo: null };
    }
}

// ==================== START ====================

app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════╗
║  Shopee Affiliate Backend            ║
║  Port: ${PORT}                         ║
║  GET /api/health                     ║
║  GET /api/resolve-link?url=...       ║
╚══════════════════════════════════════╝
    `);
});
