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

app.get('/api/health', (req, res) => {
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

        let productInfo = null;
        let facebookPostId = null;

        if (FACEBOOK_APP_TOKEN) {
            const result = await commentToFbAndGetOgData(resolvedUrl);
            productInfo = result.productInfo;
            facebookPostId = result.postId;
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
 * Comment link vào post ngày hôm nay + lấy OG data từ Facebook
 */
async function commentToFbAndGetOgData(shopeeLink) {
    try {
        // Bước 1: Trigger Facebook crawl OG data trước
        console.log('🕷️ Trigger FB crawl OG...');
        let productInfo = null;
        try {
            // POST scrape để FB crawl URL này
            await axios.post(
                `https://graph.facebook.com/v22.0/`,
                null,
                {
                    params: {
                        id: shopeeLink,
                        scrape: true,
                        access_token: FACEBOOK_APP_TOKEN
                    }
                }
            );

            // Lấy OG data mà FB đã crawl
            const ogRes = await axios.get(
                `https://graph.facebook.com/v22.0/`,
                {
                    params: {
                        id: shopeeLink,
                        fields: 'og_object{title,description,image}',
                        access_token: FACEBOOK_APP_TOKEN
                    }
                }
            );

            const og = ogRes.data?.og_object;
            if (og?.title) {
                const rawDesc = og.description || '';

                let price = 0, rating = 0, sales = 0;

                const priceMatch = rawDesc.match(/₫\s*([0-9,.]+)/);
                if (priceMatch) price = parseFloat(priceMatch[1].replace(/[,.]/g, '')) / 100000;

                const ratingMatch = rawDesc.match(/(\d+(?:\.\d+)?)\s*\/\s*5/);
                if (ratingMatch) rating = parseFloat(ratingMatch[1]);

                const salesMatch = rawDesc.match(/(\d+(?:\.\d+)?)[k]?\s*(?:đã bán|sold)/i);
                if (salesMatch) sales = parseFloat(salesMatch[1]) * (rawDesc.match(/\d+k/i) ? 1000 : 1);

                const imageUrl = og.image?.[0]?.url || og.image?.url || '';

                productInfo = {
                    name: og.title.replace(/\s*\|\s*Shopee.*$/i, '').trim().substring(0, 200),
                    image: imageUrl.startsWith('http') ? imageUrl : '',
                    price,
                    rating,
                    sales
                };

                console.log(`✅ OG từ FB: ${productInfo.name.substring(0, 60)}`);
                if (productInfo.price > 0)  console.log(`   Price:  ${productInfo.price}`);
                if (productInfo.rating > 0) console.log(`   Rating: ${productInfo.rating}/5`);
                if (productInfo.sales > 0)  console.log(`   Sales:  ${productInfo.sales}`);
            } else {
                console.log('⚠️ FB chưa có OG data cho URL này');
            }
        } catch (e) {
            console.log(`⚠️ Không lấy được OG từ FB: ${e.message}`);
        }

        // Bước 2: Comment link vào post ngày hôm nay (không tạo post mới)
        console.log('💬 Comment link vào post ngày hôm nay...');
        const postId = await getOrCreateDailyPost();

        const commentText = productInfo
            ? `${productInfo.name.substring(0, 80)}\n${shopeeLink}`
            : shopeeLink;

        await axios.post(
            `https://graph.facebook.com/v22.0/${postId}/comments`,
            {
                message: commentText,
                access_token: FACEBOOK_APP_TOKEN
            }
        );
        console.log(`✅ Đã comment vào post ${postId}`);

        return { productInfo, postId };

    } catch (error) {
        console.log(`❌ FB failed: ${error.message}`);
        if (error.response) {
            console.log(`   Detail:`, JSON.stringify(error.response.data, null, 2));
        }
        return { productInfo: null, postId: null };
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
