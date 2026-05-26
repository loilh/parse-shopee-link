const express = require('express');
const axios = require('axios');
const https = require('https');
const http = require('http');
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

        // 1️⃣ Resolve short URL nếu cần (s.shopee.vn → URL đầy đủ)
        let resolvedUrl = url;
        if (!extractNameFromUrl(url)) {
            console.log('🔗 Resolving redirect...');
            resolvedUrl = await resolveRedirects(url);
            console.log(`   → ${resolvedUrl.substring(0, 90)}`);
        }

        // 2️⃣ Lấy tên từ URL path ngay lập tức (0ms)
        const urlName = extractNameFromUrl(resolvedUrl);
        if (urlName) console.log(`📝 URL name: ${urlName.substring(0, 60)}`);

        // 3️⃣ FB để lấy image (và tên chính xác hơn nếu có)
        let productInfo = null;
        let postId = null;
        if (FACEBOOK_APP_TOKEN) {
            ({ postId, productInfo } = await commentAndGetInfo(resolvedUrl));
        }

        // 4️⃣ Nếu FB fail → dùng tên từ URL (không có image)
        if (!productInfo && urlName) {
            console.log('📌 Dùng tên từ URL (không có image)');
            productInfo = { name: urlName, image: '' };
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

// ==================== URL NAME EXTRACTION ====================

// Extract tên sản phẩm từ URL path Shopee
// URL dạng: /Tên-Sản-Phẩm-i.SHOPID.ITEMID hoặc /shop/Tên-i.SHOPID.ITEMID
function extractNameFromUrl(url) {
    try {
        const pathname = new URL(url).pathname;

        // Dạng chuẩn: /Tên-SP-i.SHOPID.ITEMID
        const match = pathname.match(/^\/(.+?)-i\.\d+\.\d+/);
        if (!match) return null;

        const name = match[1]
            .replace(/-/g, ' ')
            .trim()
            .substring(0, 200);

        // Bỏ qua nếu tên quá ngắn (có thể là path khác)
        return name.length >= 5 ? name : null;
    } catch (_) {
        return null;
    }
}

// ==================== REDIRECT RESOLVER ====================

// Follow HTTP redirects bằng Node native — đáng tin hơn axios
// Chỉ đọc response headers, không download body
function resolveRedirects(url, maxHops = 10) {
    return new Promise((resolve) => {
        if (maxHops <= 0) return resolve(url);

        const mod = url.startsWith('https') ? https : http;
        const req = mod.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            },
        }, (res) => {
            res.destroy(); // không cần body
            const loc = res.headers['location'];
            if (loc && [301, 302, 303, 307, 308].includes(res.statusCode)) {
                const next = loc.startsWith('http') ? loc : new URL(loc, url).href;
                resolveRedirects(next, maxHops - 1).then(resolve);
            } else {
                resolve(url);
            }
        });
        req.on('error', () => resolve(url));
        req.setTimeout(5000, () => { req.destroy(); resolve(url); });
    });
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

async function commentAndGetInfo(url) {
    try {
        const postId = await getOrCreateDailyPost();

        // Comment URL → FB crawl và đính attachment
        console.log('💬 Commenting...');
        const commentRes = await axios.post(
            `https://graph.facebook.com/v22.0/${postId}/comments`,
            { message: url, access_token: FACEBOOK_APP_TOKEN }
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
            console.log('⚠️ FB không lấy được title');
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
