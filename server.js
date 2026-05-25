// server.js - Shopee Affiliate Link Resolver
const express = require('express');
const axios = require('axios');
const cors = require('cors');
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

        // Resolve short URL
        console.log('🔗 Resolving short URL...');
        let resolvedUrl = url;

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
 * Lấy thông tin sản phẩm từ Shopee API
 */
async function fetchProductInfo(shopId, itemId) {
    try {
        console.log(`📝 Fetching product info: shop=${shopId}, item=${itemId}`);

        // Shopee API endpoint
        const apiUrl = `https://shopee.vn/api/v2/item/get?itemid=${itemId}&shopid=${shopId}`;

        console.log(`🔗 Trying Shopee API: ${apiUrl}`);

        const response = await axios.get(apiUrl, {
            timeout: 8000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json',
                'Accept-Language': 'vi-VN,vi;q=0.9',
                'Referer': `https://shopee.vn/-i.${shopId}.${itemId}`
            }
        });

        if (response.data && response.data.data) {
            const item = response.data.data;

            console.log(`✅ Product info from API: ${item.name}`);

            return {
                name: item.name || 'Sản phẩm',
                image: item.image ? `https://cf.shopee.vn/file/${item.image}` : '',
                price: item.price ? item.price / 100000 : 0,
                rating: item.rating ? item.rating / 20 : 0,
                sales: item.sold || 0
            };
        }

        console.log('❌ No data in API response');
        return null;

    } catch (error) {
        console.log(`❌ API Error: ${error.message}`);

        // Fallback: Return minimal info
        if (error.response?.status === 404) {
            console.log('⚠️ Product not found');
            return null;
        }

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