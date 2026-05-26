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

        // 1️⃣ Shopee API (nhanh ~300-500ms, không cần FB token)
        let productInfo = await fetchShopeeApi(url);
        let postId = null;

        // 2️⃣ Fallback: Facebook comment nếu Shopee API thất bại
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

// ==================== SHOPEE API FETCH ====================

// Lấy shopid + itemid từ URL Shopee
// Hỗ trợ dạng: /i.SHOPID.ITEMID, ?shopid=&itemid=, shop.shopee.vn/product/SHOPID/ITEMID
function parseShopeeIds(url) {
    try {
        const u = new URL(url);

        // Dạng phổ biến nhất: path chứa i.{shopid}.{itemid}
        const pathMatch = u.pathname.match(/i\.(\d+)\.(\d+)/);
        if (pathMatch) return { shopid: pathMatch[1], itemid: pathMatch[2] };

        // Dạng query string
        const shopid = u.searchParams.get('shopid');
        const itemid = u.searchParams.get('itemid');
        if (shopid && itemid) return { shopid, itemid };

        // Dạng shop.shopee.vn/product/SHOPID/ITEMID
        const shopMatch = u.pathname.match(/\/product\/(\d+)\/(\d+)/);
        if (shopMatch) return { shopid: shopMatch[1], itemid: shopMatch[2] };

    } catch (_) {}
    return null;
}

async function fetchShopeeApi(url) {
    // Nếu là short link (s.shopee.vn) → follow redirect trước để lấy URL thật
    let resolvedUrl = url;
    if (/s\.shopee\.(vn|com|co\.id|com\.my|ph|com\.br|com\.mx|sg|co\.th)/.test(url)) {
        try {
            const r = await axios.head(url, {
                maxRedirects: 10, timeout: 5000,
                validateStatus: s => s < 400,
            });
            resolvedUrl = r.request?.res?.responseUrl || r.config?.url || url;
        } catch (_) {}
    }

    const ids = parseShopeeIds(resolvedUrl);
    if (!ids) {
        console.log('⚠️ Không parse được shopid/itemid');
        return null;
    }

    console.log(`🛍️  Shopee API: shop=${ids.shopid} item=${ids.itemid}`);
    try {
        const resp = await axios.get('https://shopee.vn/api/v4/item/get', {
            params: { itemid: ids.itemid, shopid: ids.shopid },
            timeout: 6000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Referer': 'https://shopee.vn/',
                'Accept': 'application/json',
                'x-api-source': 'pc',
                'x-shopee-language': 'vi',
            },
        });

        const item = resp.data?.data?.item;
        if (!item) {
            console.log('⚠️ Shopee API không trả data');
            return null;
        }

        const name = (item.name || '').trim().substring(0, 200);
        // images[] là mảng hash; ghép thành URL CDN
        const imgHash = item.image || (item.images && item.images[0]) || '';
        const image = imgHash
            ? `https://down-vn.img.susercontent.com/file/${imgHash}`
            : '';

        if (!name) return null;

        console.log(`✅ Shopee API: ${name.substring(0, 60)}`);
        return { name, image };

    } catch (e) {
        console.log(`⚠️ Shopee API lỗi: ${e.message}`);
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
