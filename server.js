// server.js - Resolve → Comment FB (1 post/ngày) → Lấy OG từ Facebook
const express = require('express');
const axios = require('axios');
const cors = require('cors');
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

// Cache sản phẩm (1 giờ)
const linkCache = new Map();
const CACHE_TIME = 1000 * 60 * 60;

// "Post ngày hôm nay" - chỉ tạo 1 post/ngày, link mới thì comment vào
let dailyPost = {
    id: null,
    date: null  // format: 'YYYY-MM-DD'
};

// ==================== MIDDLEWARE ====================

app.use((req, res, next) => {
    const origin = req.get('origin');

    if (!origin) {
        return res.status(403).json({ error: 'Origin header required' });
    }

    if (ALLOWED_ORIGINS.includes(origin)) {
        console.log(`✅ Request verified from: ${origin}`);
        res.header('Access-Control-Allow-Origin', origin);
        res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type');
        next();
    } else {
        console.log(`❌ Request denied from: ${origin}`);
        return res.status(403).json({ error: 'Origin not allowed' });
    }
});

app.use(express.json());

// ==================== API ROUTES ====================

app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * Main endpoint: Resolve → Comment FB → Get OG data từ Facebook
 */
app.get('/api/resolve-link', async (req, res) => {
    try {
        const { url } = req.query;

        if (!url) {
            return res.status(400).json({ error: 'URL parameter required' });
        }

        console.log(`\n🔄 Resolve link: ${url}`);

        // Check cache
        if (linkCache.has(url)) {
            const cached = linkCache.get(url);
            if (Date.now() - cached.timestamp < CACHE_TIME) {
                console.log('✅ From cache');
                return res.json({ ...cached.data, cached: true });
            } else {
                linkCache.delete(url);
            }
        }

        // Resolve short URL
        let resolvedUrl = url;
        const originLinkMatch = url.match(/origin_link=([^&]+)/);

        if (originLinkMatch) {
            try {
                resolvedUrl = decodeURIComponent(originLinkMatch[1]);
                console.log(`✅ Extracted origin_link`);
            } catch (e) {
                console.log('⚠️ Could not decode origin_link');
            }
        } else {
            console.log('🔗 Resolving short URL...');
            try {
                const response = await axios.get(url, {
                    maxRedirects: 5,
                    timeout: 8000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                });
                resolvedUrl = response.request.res.responseUrl || response.config.url;
            } catch (error) {
                if (error.response?.status === 301 || error.response?.status === 302) {
                    resolvedUrl = error.response.headers.location || url;
                }
            }
            console.log(`✅ Resolved: ${resolvedUrl.substring(0, 80)}...`);
        }

        // Extract shopId & itemId
        let shopId, itemId;
        const match1 = resolvedUrl.match(/\/([^\/]+)\/(\d+)\/(\d+)/);
        if (match1) {
            shopId = match1[2];
            itemId = match1[3];
        } else {
            const match2 = resolvedUrl.match(/-i\.(\d+)\.(\d+)/);
            if (match2) {
                shopId = match2[1];
                itemId = match2[2];
            }
        }

        if (!shopId || !itemId) {
            console.log(`❌ Cannot extract IDs`);
            return res.json({
                originalUrl: url,
                resolvedUrl: resolvedUrl,
                productInfo: null,
                cached: false
            });
        }

        console.log(`📝 IDs: shop=${shopId}, item=${itemId}`);

        // URL sạch: bỏ query params (?__mobile__=1&credential_token=...) vì làm FB OG fail
        const cleanUrl = resolvedUrl.split('?')[0];
        console.log(`🔗 Clean URL: ${cleanUrl}`);

        // Lấy thông tin sản phẩm từ Facebook OG cache (Shopee API bị block)
        const productInfo = FACEBOOK_APP_TOKEN
            ? await getProductInfoFromFacebookOG(cleanUrl)
            : null;

        // Comment lên Facebook (nếu có token)
        let facebookPostId = null;
        if (FACEBOOK_APP_TOKEN) {
            facebookPostId = await commentToFacebook(cleanUrl, productInfo);
        } else {
            console.log('⚠️ FACEBOOK_APP_TOKEN not set');
        }

        const response = {
            originalUrl: url,
            resolvedUrl: resolvedUrl,
            productInfo: productInfo,
            facebookPostId: facebookPostId,
            cached: false
        };

        // Cache
        linkCache.set(url, { data: response, timestamp: Date.now() });

        console.log('✨ Response sent');
        res.json(response);

    } catch (error) {
        console.error('❌ Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ==================== FACEBOOK LOGIC ====================

/**
 * Lấy hoặc tạo "post hôm nay" trên Page
 * - Mỗi ngày chỉ tạo 1 post mới
 * - Link mới → comment vào post đó
 */
async function getOrCreateDailyPost() {
    const today = new Date().toISOString().split('T')[0]; // 'YYYY-MM-DD'

    if (dailyPost.id && dailyPost.date === today) {
        console.log(`📌 Dùng post hôm nay: ${dailyPost.id}`);
        return dailyPost.id;
    }

    // Tạo post mới cho ngày hôm nay
    console.log(`📝 Tạo post mới cho ngày ${today}...`);
    const fbRes = await axios.post(
        `https://graph.facebook.com/v22.0/${FACEBOOK_PAGE_ID}/feed`,
        {
            message: `🛍️ Tổng hợp sản phẩm Shopee ngày ${today}\n\nCác sản phẩm hay hôm nay 👇`,
            access_token: FACEBOOK_APP_TOKEN
        }
    );

    dailyPost = { id: fbRes.data.id, date: today };
    console.log(`✅ Tạo post mới: ${dailyPost.id}`);
    return dailyPost.id;
}

/**
 * Lấy thông tin sản phẩm từ Facebook OG cache
 * Facebook crawl Shopee (kể cả SPA) và lưu OG data → ta đọc lại từ FB
 *
 * Flow:
 *   1. POST scrape=true  → force FB crawl URL (nếu chưa có cache)
 *   2. GET og_object     → đọc name, image, description mà FB đã crawl
 */
async function getProductInfoFromFacebookOG(shopeeLink) {
    try {
        // Bước 1: POST với form-data (không phải query string!)
        console.log('🕷️  FB OG scrape...');
        const formData = new URLSearchParams();
        formData.append('id', shopeeLink);
        formData.append('scrape', 'true');
        formData.append('access_token', FACEBOOK_APP_TOKEN);

        await axios.post(
            'https://graph.facebook.com/v22.0/',
            formData.toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        // Bước 2: GET og_object
        const ogRes = await axios.get('https://graph.facebook.com/v22.0/', {
            params: {
                id: shopeeLink,
                fields: 'og_object{title,description,image}',
                access_token: FACEBOOK_APP_TOKEN
            }
        });

        const og = ogRes.data?.og_object;
        if (!og?.title) {
            console.log('⚠️ FB OG: không có title');
            return null;
        }

        const desc = og.description || '';
        let price = 0, rating = 0, sales = 0;

        const priceMatch = desc.match(/₫\s*([0-9,.]+)/);
        if (priceMatch) price = parseFloat(priceMatch[1].replace(/[,.]/g, '')) / 100000;

        const ratingMatch = desc.match(/(\d+(?:\.\d+)?)\s*\/\s*5/);
        if (ratingMatch) rating = parseFloat(ratingMatch[1]);

        const salesMatch = desc.match(/(\d+(?:\.\d+)?k?)\s*(?:đã bán|sold)/i);
        if (salesMatch) {
            sales = parseFloat(salesMatch[1]) * (salesMatch[1].endsWith('k') ? 1000 : 1);
        }

        // Lấy image URL từ array hoặc object
        const imageUrl = Array.isArray(og.image)
            ? (og.image[0]?.url || '')
            : (og.image?.url || '');

        const productInfo = {
            name: og.title.replace(/\s*\|\s*Shopee.*$/i, '').trim().substring(0, 200),
            image: imageUrl.startsWith('http') ? imageUrl : '',
            price,
            rating,
            sales
        };

        console.log(`✅ FB OG: ${productInfo.name.substring(0, 60)}`);
        if (productInfo.price > 0)  console.log(`   Price:  ${productInfo.price}k`);
        if (productInfo.rating > 0) console.log(`   Rating: ${productInfo.rating}/5`);
        if (productInfo.sales > 0)  console.log(`   Sales:  ${productInfo.sales}`);

        return productInfo;

    } catch (e) {
        console.log(`⚠️ FB OG lỗi: ${e.message}`);
        if (e.response) console.log('   Detail:', JSON.stringify(e.response.data));
        return null;
    }
}

/**
 * Comment link vào post ngày hôm nay trên Facebook
 * Token cần có: pages_manage_posts + pages_manage_engagement
 */
async function commentToFacebook(shopeeLink, productInfo) {
    try {
        const postId = await getOrCreateDailyPost();

        const commentText = productInfo
            ? `${productInfo.name.substring(0, 80)}\n💰 ${productInfo.price}k${productInfo.rating > 0 ? `  ⭐ ${productInfo.rating}/5` : ''}\n${shopeeLink}`
            : shopeeLink;

        await axios.post(
            `https://graph.facebook.com/v22.0/${postId}/comments`,
            {
                message: commentText,
                access_token: FACEBOOK_APP_TOKEN
            }
        );
        console.log(`✅ Đã comment vào post ${postId}`);
        return postId;

    } catch (error) {
        console.log(`❌ FB comment failed: ${error.message}`);
        if (error.response) {
            console.log(`   Detail:`, JSON.stringify(error.response.data, null, 2));
        }
        return null;
    }
}

// ==================== SERVER ====================

app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║   Shopee Affiliate Backend                                 ║
║   Port: ${PORT}                                              ║
║   Strategy: 1 post/ngày + comment link + OG từ Facebook   ║
║   GET /api/health                                          ║
║   GET /api/resolve-link?url=...                            ║
╚════════════════════════════════════════════════════════════╝
    `);
});
