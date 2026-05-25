// server.js - Shopee Affiliate Link Resolver
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const cheerio = require('cheerio');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ⭐ DOMAIN FE ĐƯỢC PHÉP
const ALLOWED_ORIGINS = [
    'https://loilh.github.io',
    'http://localhost:3000',
    'http://localhost:5000'
];

// Cache để tránh request trùng
const linkCache = new Map();
const CACHE_TIME = 1000 * 60 * 60; // 1 giờ

// ==================== MIDDLEWARE ====================

// Custom CORS - Chỉ accept từ allowed origins
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

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * Resolve Shopee short link & lấy product info
 */
app.get('/api/resolve-link', async (req, res) => {
    try {
        const { url } = req.query;

        if (!url) {
            return res.status(400).json({ error: 'URL parameter required' });
        }

        console.log(`\n🔄 Đang resolve link: ${url}`);

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

        let resolvedUrl = url;

        // Check if URL contains origin_link parameter (affiliate URL)
        const originLinkMatch = url.match(/origin_link=([^&]+)/);
        if (originLinkMatch) {
            try {
                resolvedUrl = decodeURIComponent(originLinkMatch[1]);
                console.log(`✅ Extracted origin_link: ${resolvedUrl}`);
            } catch (e) {
                console.log('⚠️ Could not decode origin_link, will resolve normally');
            }
        } else {
            // Normal short URL - resolve redirect
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
            console.log(`✅ Short link resolved: ${resolvedUrl}`);
        }

        // Extract shopId & itemId từ URL
        // Format: /shopname/shopid/itemid or /shopname/shopid/itemid?...
        let shopId, itemId;

        // Try format 1: /shopname/shopid/itemid
        const match1 = resolvedUrl.match(/\/([^\/]+)\/(\d+)\/(\d+)/);
        if (match1) {
            shopId = match1[2];
            itemId = match1[3];
        } else {
            // Try format 2: -i.shopid.itemid
            const match2 = resolvedUrl.match(/-i\.(\d+)\.(\d+)/);
            if (match2) {
                shopId = match2[1];
                itemId = match2[2];
            }
        }

        if (!shopId || !itemId) {
            console.log(`❌ Cannot extract shop/item ID from: ${resolvedUrl}`);
            return res.json({
                originalUrl: url,
                resolvedUrl: resolvedUrl,
                productInfo: null,
                cached: false
            });
        }

        console.log(`📝 Extracted: shop=${shopId}, item=${itemId}`);

        // Try to get product info
        let productInfo = null;

        try {
            productInfo = await fetchProductInfo(shopId, itemId);
        } catch (error) {
            console.log(`⚠️ Cannot fetch product info: ${error.message}`);
        }

        const result = {
            originalUrl: url,
            resolvedUrl: resolvedUrl,
            productInfo: productInfo,
            cached: false
        };

        // Cache result
        linkCache.set(url, { data: result, timestamp: Date.now() });

        console.log('✨ Response sent successfully');
        res.json(result);

    } catch (error) {
        console.error('❌ Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Lấy thông tin sản phẩm từ HTML meta tags
 */
async function fetchProductInfo(shopId, itemId) {
    try {
        console.log(`📝 Fetching product info: shop=${shopId}, item=${itemId}`);

        // Construct direct product URL
        const productUrl = `https://shopee.vn/product/${shopId}/${itemId}`;

        console.log(`🔗 Fetching HTML from: ${productUrl}`);

        const response = await axios.get(productUrl, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8',
                'Referer': 'https://shopee.vn/',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none'
            },
            // Add cookies
            jar: true,
            withCredentials: true
        });

        const html = response.data;
        console.log(`✅ Got HTML (${html.length} bytes)`);

        // Parse with cheerio
        const $ = cheerio.load(html);

        // Try multiple methods to extract data

        // Method 1: Meta tags
        let name = $('meta[property="og:title"]').attr('content');
        let image = $('meta[property="og:image"]').attr('content');
        let description = $('meta[property="og:description"]').attr('content');

        console.log(`📊 Meta - name: ${name ? 'Found' : 'Not found'}, image: ${image ? 'Found' : 'Not found'}`);

        // Method 2: Script tags with product data
        if (!name) {
            console.log('🔍 Searching in script tags...');
            $('script').each((i, el) => {
                const text = $(el).text();
                if (text.includes('"name"') && text.includes('"price"')) {
                    try {
                        // Try to extract JSON
                        const match = text.match(/\{"name":"([^"]+)"[^}]*"price":(\d+)/);
                        if (match) {
                            name = match[1];
                            console.log(`✅ Found name in script ${i}: ${name}`);
                        }
                    } catch (e) { }
                }
            });
        }

        // Method 3: H1 tag
        if (!name) {
            name = $('h1').first().text().trim();
            if (name) console.log(`✅ Found name in h1: ${name}`);
        }

        // Fallback
        if (!name || name.length < 3 || name === 'Sản phẩm') {
            console.log('⚠️ Could not extract valid product name');
            return null;
        }

        // Parse price, rating, sales from description or HTML
        let price = 0;
        let rating = 0;
        let sales = 0;

        if (description) {
            // Pattern: ₫ 99.000 or ₫99000
            const priceMatch = description.match(/₫\s*([0-9,.]+)\s*(?:đ|$)/);
            if (priceMatch) {
                price = parseFloat(priceMatch[1].replace(/[,.]/g, '')) / 100000;
            }

            // Pattern: 4.5/5 hoặc ⭐4.5
            const ratingMatch = description.match(/(?:⭐|★)?(\d+(?:\.\d+)?)\s*\/\s*5/);
            if (ratingMatch) {
                rating = parseFloat(ratingMatch[1]);
            }

            // Pattern: 1.2k đã bán hoặc 1200 sold
            const salesMatch = description.match(/(\d+(?:\.\d+)?)[k]?\s*(?:đã bán|sold)/i);
            if (salesMatch) {
                sales = parseFloat(salesMatch[1]) * (description.match(/\d+k/i) ? 1000 : 1);
            }
        }

        const result = {
            name: name.replace(/\s*\|\s*Shopee.*$/i, '').trim().substring(0, 200),
            image: image && image.startsWith('http') ? image : '',
            price: price,
            rating: rating,
            sales: sales
        };

        console.log(`✅ Product info extracted:`);
        console.log(`   Name: ${result.name.substring(0, 60)}`);
        if (result.price > 0) console.log(`   Price: ${result.price}`);
        if (result.rating > 0) console.log(`   Rating: ${result.rating}/5`);
        if (result.sales > 0) console.log(`   Sales: ${result.sales}`);

        return result;

    } catch (error) {
        console.log(`❌ Error fetching product info: ${error.message}`);
        return null;
    }
}

// ==================== SERVER ====================

app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║   Shopee Affiliate Backend                                 ║
║   Server running on port ${PORT}                              ║
║   https://parse-shopee-link.vercel.app                     ║
╚════════════════════════════════════════════════════════════╝
    `);
});