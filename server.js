// server.js - Resolve → Post FB → Scrape Product Info
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const cheerio = require('cheerio');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// CONFIG
const ALLOWED_ORIGINS = [
    'https://loilh.github.io',
    'http://localhost:3000',
    'http://localhost:5000'
];

const FACEBOOK_PAGE_ID = process.env.FACEBOOK_PAGE_ID || '61590079334647';
const FACEBOOK_APP_TOKEN = process.env.FACEBOOK_APP_TOKEN || '';

// Cache
const linkCache = new Map();
const CACHE_TIME = 1000 * 60 * 60;

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
 * Main endpoint: Resolve → Post to FB → Get Product Info
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

        // Post to Facebook to scrape product info
        console.log('📤 Posting to Facebook...');
        let productInfo = null;
        let facebookPostId = null;

        if (FACEBOOK_APP_TOKEN) {
            const result = await postToFbAndScrapeProductInfo(resolvedUrl);
            productInfo = result.productInfo;
            facebookPostId = result.postId;
        } else {
            console.log('⚠️ FACEBOOK_APP_TOKEN not set - cannot post to FB');
        }

        const response = {
            originalUrl: url,
            resolvedUrl: resolvedUrl,
            productInfo: productInfo,
            facebookPostId: facebookPostId,
            cached: false
        };

        // Cache result
        linkCache.set(url, { data: response, timestamp: Date.now() });

        console.log('✨ Response sent');
        res.json(response);

    } catch (error) {
        console.error('❌ Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Post to Facebook & Scrape Product Info from Shopee
 */
async function postToFbAndScrapeProductInfo(shopeeLink) {
    try {
        // Post to Facebook
        const message = `🛍️ Xem sản phẩm\n\n${shopeeLink}`;

        console.log('📤 Posting...');
        const fbResponse = await axios.post(
            `https://graph.facebook.com/v18.0/${FACEBOOK_PAGE_ID}/feed`,
            {
                message: message,
                access_token: FACEBOOK_APP_TOKEN
            }
        );

        const postId = fbResponse.data.id;
        console.log(`✅ Posted: ${postId}`);

        // Now scrape Shopee (Facebook already crawled it)
        console.log('🔍 Scraping product info from Shopee...');

        let productInfo = null;
        try {
            // Fetch Shopee page (with Facebook as referrer - less likely to be blocked)
            const response = await axios.get(shopeeLink, {
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Referer': 'https://www.facebook.com/',
                    'Accept': 'text/html,application/xhtml+xml',
                    'Accept-Language': 'vi-VN,vi;q=0.9',
                    'Cache-Control': 'no-cache'
                }
            });

            const html = response.data;
            console.log(`✅ Got HTML (${html.length} bytes)`);

            // Parse
            const $ = cheerio.load(html);

            // Try meta tags
            let name = $('meta[property="og:title"]').attr('content');
            let image = $('meta[property="og:image"]').attr('content');
            let description = $('meta[property="og:description"]').attr('content') || '';

            console.log(`📊 Meta - name: ${name ? '✅' : '❌'}, image: ${image ? '✅' : '❌'}`);

            // Parse description
            let price = 0;
            let rating = 0;
            let sales = 0;

            if (description) {
                const priceMatch = description.match(/₫\s*([0-9,.]+)/);
                if (priceMatch) price = parseFloat(priceMatch[1].replace(/[,.]/g, '')) / 100000;

                const ratingMatch = description.match(/(\d+(?:\.\d+)?)\s*\/\s*5/);
                if (ratingMatch) rating = parseFloat(ratingMatch[1]);

                const salesMatch = description.match(/(\d+(?:\.\d+)?)[k]?\s*(?:đã bán|sold)/i);
                if (salesMatch) sales = parseFloat(salesMatch[1]) * (description.match(/\d+k/i) ? 1000 : 1);
            }

            if (name) {
                productInfo = {
                    name: name.replace(/\s*\|\s*Shopee.*$/i, '').trim().substring(0, 200),
                    image: image && image.startsWith('http') ? image : '',
                    price: price,
                    rating: rating,
                    sales: sales
                };

                console.log(`✅ Extracted: ${productInfo.name.substring(0, 50)}`);
                if (productInfo.price > 0) console.log(`   Price: ${productInfo.price}`);
                if (productInfo.rating > 0) console.log(`   Rating: ${productInfo.rating}/5`);
                if (productInfo.sales > 0) console.log(`   Sales: ${productInfo.sales}`);
            }

        } catch (error) {
            console.log(`⚠️ Cannot scrape Shopee: ${error.message}`);
        }

        return {
            productInfo: productInfo,
            postId: postId
        };

    } catch (error) {
        console.log(`❌ Post to FB failed: ${error.message}`);
        return {
            productInfo: null,
            postId: null
        };
    }
}

// ==================== SERVER ====================

app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║   Shopee Affiliate Backend (FB Post → Scrape)              ║
║   Port: ${PORT}                                              ║
║   GET /api/health                                          ║
║   GET /api/resolve-link?url=...                            ║
╚════════════════════════════════════════════════════════════╝
    `);
});