// server.js - Resolve short URL → Comment FB (1 post/ngày) → Lấy OG từ short URL
const express = require('express');
const axios = require('axios');
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

// 1 post mỗi ngày trên Page
let dailyPost = { id: null, date: null };

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

        // Lấy product info + comment FB song song
        let productInfo = null;
        let facebookPostId = null;
        if (FACEBOOK_APP_TOKEN) {
            // Post tạm với link → FB dùng full crawler (giống Messenger) → đọc lại → xóa post
            productInfo = await getProductInfoViaFbPost(url);  // short URL gốc
            // Comment short URL vào post ngày hôm nay (giữ affiliate tracking)
            facebookPostId = await commentToFacebook(url, productInfo);
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
 * Lấy product info bằng cách POST link lên FB feed (private) rồi đọc lại link preview
 *
 * Khi POST với `link` param, Facebook dùng FULL crawler (giống Messenger)
 * → crawl JS, lấy đúng product OG → ta đọc fields name/description/picture → xóa post
 */
async function getProductInfoViaFbPost(shortUrl) {
    let tempPostId = null;
    try {
        console.log('🕷️  Post tạm lên FB để lấy link preview...');

        // Post PRIVATE (chỉ mình xem) với `link` param để FB crawl đúng
        const postRes = await axios.post(
            `https://graph.facebook.com/v22.0/${FACEBOOK_PAGE_ID}/feed`,
            {
                message: '.',
                link: shortUrl,
                published: false,          // không publish ra ngoài
                access_token: FACEBOOK_APP_TOKEN
            }
        );
        tempPostId = postRes.data.id;
        console.log(`   Post tạm: ${tempPostId}`);

        // Đọc lại link preview FB vừa crawl
        // (v3.3+ dùng `attachments` thay vì name/description/picture đã deprecated)
        const readRes = await axios.get(
            `https://graph.facebook.com/v22.0/${tempPostId}`,
            {
                params: {
                    fields: 'attachments{title,description,media,url,type}',
                    access_token: FACEBOOK_APP_TOKEN
                }
            }
        );

        const attachment = readRes.data?.attachments?.data?.[0] || {};
        const title = attachment.title || '';
        const description = attachment.description || '';
        const imageUrl = attachment.media?.image?.src || '';

        if (!title || title.toLowerCase().includes('shopee việt nam')) {
            console.log('⚠️ FB link preview: vẫn chỉ có homepage title');
            return null;
        }

        // Parse price/rating/sales từ description
        let price = 0, rating = 0, sales = 0;
        const priceMatch = description.match(/₫\s*([0-9,.]+)/);
        if (priceMatch) price = parseFloat(priceMatch[1].replace(/[,.]/g, '')) / 100000;

        const ratingMatch = description.match(/(\d+(?:\.\d+)?)\s*\/\s*5/);
        if (ratingMatch) rating = parseFloat(ratingMatch[1]);

        const salesMatch = description.match(/(\d+(?:\.\d+)?k?)\s*(?:đã bán|sold)/i);
        if (salesMatch) sales = parseFloat(salesMatch[1]) * (salesMatch[1].endsWith('k') ? 1000 : 1);

        const productInfo = {
            name: title.replace(/\s*\|\s*Shopee.*$/i, '').trim().substring(0, 200),
            image: imageUrl.startsWith('http') ? imageUrl : '',
            price,
            rating,
            sales
        };

        console.log(`✅ Product: ${productInfo.name.substring(0, 60)}`);
        if (price > 0)  console.log(`   💰 ${price}k`);
        if (rating > 0) console.log(`   ⭐ ${rating}/5`);
        return productInfo;

    } catch (e) {
        console.log(`⚠️ FB post tạm lỗi: ${e.message}`);
        if (e.response) console.log('   ', JSON.stringify(e.response.data));
        return null;
    } finally {
        // Xóa post tạm dù thành công hay lỗi
        if (tempPostId) {
            try {
                await axios.delete(`https://graph.facebook.com/v22.0/${tempPostId}`, {
                    params: { access_token: FACEBOOK_APP_TOKEN }
                });
                console.log(`🗑️  Đã xóa post tạm`);
            } catch (_) {}
        }
    }
}

/**
 * Tạo post mới mỗi ngày, link mới → comment vào post đó
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
    console.log(`✅ Post: ${dailyPost.id}`);
    return dailyPost.id;
}

async function commentToFacebook(shopeeLink, productInfo) {
    try {
        const postId = await getOrCreateDailyPost();

        const text = productInfo?.name
            ? `${productInfo.name.substring(0, 80)}${productInfo.price > 0 ? `\n💰 ${productInfo.price}k` : ''}${productInfo.rating > 0 ? `  ⭐ ${productInfo.rating}/5` : ''}\n${shopeeLink}`
            : shopeeLink;

        await axios.post(
            `https://graph.facebook.com/v22.0/${postId}/comments`,
            { message: text, access_token: FACEBOOK_APP_TOKEN }
        );
        console.log(`💬 Comment → post ${postId}`);
        return postId;

    } catch (e) {
        console.log(`⚠️ Comment lỗi: ${e.message}`);
        if (e.response) console.log('   ', JSON.stringify(e.response.data));
        return null;
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
