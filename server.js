// server.js - Shopee Affiliate Link Resolver with Facebook Integration
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const cheerio = require('cheerio');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ⭐ CONFIG
const ALLOWED_ORIGINS = [
    'https://loilh.github.io',
];

const FACEBOOK_PAGE_ID = process.env.FACEBOOK_PAGE_ID || '61590079334647';
const FACEBOOK_APP_TOKEN = process.env.FACEBOOK_APP_TOKEN || '';
const AFFILIATE_ID = '17396630390';

// Cache
const linkCache = new Map();
const CACHE_TIME = 1000 * 60 * 60; // 1 hour

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
 * Main endpoint: Resolve link + Post to FB + Get product info
 */
app.get('/api/resolve-link', async (req, res) => {
    try {
        const { url, postToFb } = req.query;

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

        // Get product info - Try multiple methods
        let productInfo = null;

        // Method 1: Scrape HTML meta tags
        console.log('📊 Trying to fetch product info...');
        productInfo = await fetchProductInfo(shopId, itemId);

        // Method 2: If failed, post to FB and scrape from there
        if (!productInfo && postToFb === 'true' && FACEBOOK_APP_TOKEN) {
            console.log('📤 Posting to Facebook to scrape product info...');
            productInfo = await postToFbAndScrape(resolvedUrl);
        }

        const result = {
            originalUrl: url,
            resolvedUrl: resolvedUrl,
            productInfo: productInfo,
            cached: false
        };

        // Cache result
        linkCache.set(url, { data: result, timestamp: Date.now() });

        console.log('✨ Response sent');
        res.json(result);

    } catch (error) {
        console.error('❌ Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Post to Facebook and scrape product info from post
 */
async function postToFbAndScrape(shopeeLink) {
    try {
        // Create message
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

        // Wait for Facebook to process
        await new Promise(r => setTimeout(r, 3000));

        // Get post details (like engagement, comments with product info)
        // Note: We can't scrape from Facebook easily, so return null
        // In production, you'd use Facebook's Graph API to get post data

        console.log('⚠️ Cannot scrape Facebook post data (requires special permissions)');
        return null;

    } catch (error) {
        console.log(`⚠️ Post to FB failed: ${error.message}`);
        return null;
    }
}

/**
 * Fetch product info from HTML - parse script tags for JSON data
 */
async function fetchProductInfo(shopId, itemId) {
    try {
        const productUrl = `https://shopee.vn/product/${shopId}/${itemId}`;

        console.log(`🔗 Fetching: ${productUrl.substring(0, 60)}...`);

        const response = await axios.get(productUrl, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'vi-VN,vi;q=0.9',
                'Referer': 'https://shopee.vn/',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none'
            },
            jar: true,
            withCredentials: true
        });

        const html = response.data;
        console.log(`✅ Got HTML (${html.length} bytes)`);

        // Parse with cheerio
        const $ = cheerio.load(html);

        // Extract from meta tags first
        let name = $('meta[property="og:title"]').attr('content');
        let image = $('meta[property="og:image"]').attr('content');
        let description = $('meta[property="og:description"]').attr('content') || '';

        console.log(`📊 Meta - name: ${name ? '✅' : '❌'}, image: ${image ? '✅' : '❌'}`);

        // Try to extract from script tags containing product data
        if (!name) {
            console.log('🔍 Searching JSON in script tags...');

            $('script').each((i, el) => {
                const text = $(el).text();

                // Look for product data in JSON
                if (text.includes('"name"') && text.includes('"itemId"')) {
                    try {
                        // Try to extract JSON object
                        const jsonMatch = text.match(/\{"[^}]*"name"[^}]*"itemId"[^}]*\}/);
                        if (jsonMatch) {
                            const jsonStr = jsonMatch[0];
                            const data = JSON.parse(jsonStr);

                            if (data.name && data.name.length > 3) {
                                name = data.name;
                                price = data.price || 0;
                                if (data.images && data.images.length > 0) {
                                    image = data.images[0];
                                }
                                console.log(`✅ Found JSON data in script ${i}`);
                                console.log(`   Name: ${name.substring(0, 50)}`);
                            }
                        }
                    } catch (e) {
                        // Try simpler regex extraction
                        try {
                            const nameMatch = text.match(/"name":"([^"]+)"/);
                            const priceMatch = text.match(/"price":(\d+)/);
                            const imageMatch = text.match(/"image":"([^"]+)"/);

                            if (nameMatch && nameMatch[1].length > 3) {
                                name = nameMatch[1];
                                if (priceMatch) price = priceMatch[1];
                                if (imageMatch) image = imageMatch[1];

                                console.log(`✅ Extracted from script ${i}`);
                                return false; // break
                            }
                        } catch (e2) { }
                    }
                }
            });
        }

        // Fallback: H1 tag
        if (!name) {
            name = $('h1').first().text().trim();
            if (name) console.log(`✅ Found in h1: ${name.substring(0, 50)}`);
        }

        // Fallback: Any text in h2, h3
        if (!name) {
            name = $('h2').first().text().trim();
            if (!name) name = $('h3').first().text().trim();
            if (name) console.log(`✅ Found in heading: ${name.substring(0, 50)}`);
        }

        if (!name || name.length < 3) {
            console.log('⚠️ Cannot get product name');
            return null;
        }

        // Parse price, rating, sales from description
        let price = 0;
        let rating = 0;
        let sales = 0;

        if (description) {
            const priceMatch = description.match(/₫\s*([0-9,.]+)/);
            if (priceMatch) {
                price = parseFloat(priceMatch[1].replace(/[,.]/g, '')) / 100000;
            }

            const ratingMatch = description.match(/(\d+(?:\.\d+)?)\s*\/\s*5/);
            if (ratingMatch) {
                rating = parseFloat(ratingMatch[1]);
            }

            const salesMatch = description.match(/(\d+(?:\.\d+)?)[k]?\s*(?:đã bán|sold)/i);
            if (salesMatch) {
                sales = parseFloat(salesMatch[1]) * (description.match(/\d+k/i) ? 1000 : 1);
            }
        }

        const result = {
            name: name.replace(/\s*\|\s*Shopee.*$/i, '').trim().substring(0, 200),
            image: image && image.startsWith('http') ? image : '',
            price: price > 0 ? price : 0,
            rating: rating > 0 ? rating : 0,
            sales: sales > 0 ? sales : 0
        };

        console.log(`✅ Extracted: ${result.name.substring(0, 50)}`);
        if (result.price > 0) console.log(`   Price: ${result.price}`);
        if (result.rating > 0) console.log(`   Rating: ${result.rating}/5`);
        if (result.sales > 0) console.log(`   Sales: ${result.sales}`);

        return result;

    } catch (error) {
        console.log(`❌ Error: ${error.message}`);
        return null;
    }
}

// ==================== SERVER ====================

app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║   Shopee Affiliate Backend                                 ║
║   Port: ${PORT}                                              ║
║   Endpoints:                                               ║
║   - GET /api/health                                        ║
║   - GET /api/resolve-link?url=...&postToFb=true           ║
╚════════════════════════════════════════════════════════════╝
    `);
});