// server.js
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
    const origin = req.headers.origin;

    if (ALLOWED_ORIGINS.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
        res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type');
    }

    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }

    next();
});

app.use(express.json());

// ==================== MIDDLEWARE - VERIFY ORIGIN ====================

/**
 * Middleware để verify request từ allowed origin
 */
const verifyOrigin = (req, res, next) => {
    const origin = req.headers.origin;

    // Block request không có origin (từ Postman, curl, etc.)
    if (!origin) {
        console.warn('⚠️ Request blocked - No origin header');
        return res.status(403).json({
            error: 'Forbidden: Origin header required',
            message: 'Direct requests are not allowed'
        });
    }

    // Check xem origin có trong whitelist không
    if (!ALLOWED_ORIGINS.includes(origin)) {
        console.warn(`⚠️ Request blocked - Unauthorized origin: ${origin}`);
        return res.status(403).json({
            error: 'Forbidden: Origin not allowed',
            origin: origin
        });
    }

    console.log(`✅ Request verified from: ${origin}`);
    next();
};

// ==================== API ENDPOINTS ====================

/**
 * Health check endpoint (không cần verify origin)
 */
app.get('/api/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        allowedOrigins: ALLOWED_ORIGINS
    });
});

/**
 * API endpoint: Resolve Shopee short link
 * GET /api/resolve-link?url=https://s.shopee.vn/xxxxx
 * 
 * ⭐ YÊU CẦU: Request phải từ allowed origin
 */
app.get('/api/resolve-link', verifyOrigin, async (req, res) => {
    try {
        const { url } = req.query;

        // Validate URL
        if (!url) {
            return res.status(400).json({ error: 'URL không được cung cấp' });
        }

        if (!url.includes('shopee')) {
            return res.status(400).json({ error: 'Link phải là từ Shopee' });
        }

        // Kiểm tra cache
        if (linkCache.has(url)) {
            const cached = linkCache.get(url);
            if (Date.now() - cached.timestamp < CACHE_TIME) {
                console.log('📦 Trả về từ cache:', url);
                return res.json({ ...cached.data, cached: true });
            }
        }

        console.log('🔄 Đang resolve link:', url);

        // Resolve short link
        let resolvedUrl = url;
        if (url.includes('s.shopee.vn')) {
            try {
                const response = await axios.get(url, {
                    maxRedirects: 5,
                    timeout: 5000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                });
                resolvedUrl = response.request.res.responseUrl || url;
                console.log('✅ Short link resolved:', resolvedUrl);
            } catch (error) {
                console.log('⚠️ Không thể resolve short link:', error.message);
                resolvedUrl = url;
            }
        }

        // Extract product ID - Shopee format: /username/shop_id/item_id
        // Hoặc: /product/123.456 hoặc /Tên-sản-phẩm-i.123.456
        let productInfo = null;
        let shopId = null;
        let itemId = null;

        // Format 1: /username/1292784148/40504817257?...
        const formatMatch1 = resolvedUrl.match(/\/[^\/]+\/(\d+)\/(\d+)/);
        if (formatMatch1) {
            shopId = formatMatch1[1];
            itemId = formatMatch1[2];
        }

        // Format 2: /product/123.456 hoặc /Tên-sản-phẩm-i.123.456
        if (!shopId) {
            const formatMatch2 = resolvedUrl.match(/\/(?:product\/)?(?:[^\/]*-)?i\.(\d+)\.(\d+)/);
            if (formatMatch2) {
                shopId = formatMatch2[1];
                itemId = formatMatch2[2];
            }
        }

        if (shopId && itemId) {
            console.log(`📝 Fetching product info: shop=${shopId}, item=${itemId}`);
            productInfo = await fetchProductInfo(shopId, itemId);
        } else {
            console.log('⚠️ Không thể extract product ID từ URL:', resolvedUrl);
        }

        const result = {
            originalUrl: url,
            resolvedUrl: resolvedUrl,
            productInfo: productInfo,
            cached: false
        };

        // Lưu vào cache
        linkCache.set(url, {
            data: result,
            timestamp: Date.now()
        });

        console.log('✨ Response sent successfully');
        res.json(result);

    } catch (error) {
        console.error('❌ Server error:', error);
        res.status(500).json({ error: 'Lỗi server: ' + error.message });
    }
});

// ==================== HELPER FUNCTIONS ====================

/**
 * Lấy thông tin sản phẩm từ Shopee API
 */
async function fetchProductInfo(shopId, itemId) {
    try {
        const url = `https://shopee.vn/api/v4/pdp/get_pc?shop_id=${shopId}&item_id=${itemId}`;
        console.log(`🔗 Calling Shopee API: ${url}`);

        const response = await axios.get(url, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://shopee.vn/'
            }
        });

        console.log(`📦 Response status: ${response.status}`);

        // Check xem API response có data không
        if (!response.data) {
            console.log('⚠️ Response data is empty');
            return null;
        }

        if (response.data?.data?.item) {
            const product = response.data.data.item;
            const productInfo = {
                name: product.name || 'Sản phẩm',
                image: product.image || '',
                sales: product.historical_sold || product.sold || 0,
                rating: (product.rating_star || 0) / 2, // Convert từ 0-10 sang 0-5
                price: (product.price || 0) / 100000
            };
            console.log(`✅ Product info fetched: ${product.name}`);
            console.log(`   - Price: ${productInfo.price}`);
            console.log(`   - Rating: ${productInfo.rating}/5`);
            console.log(`   - Sales: ${productInfo.sales}`);
            return productInfo;
        } else {
            console.log('⚠️ API response không có item data');
            console.log('Response data:', JSON.stringify(response.data).substring(0, 200));
            return null;
        }

    } catch (error) {
        if (error.response) {
            console.log(`❌ API Error ${error.response.status}:`, error.response.data?.message || error.message);
        } else if (error.request) {
            console.log('❌ No response from API:', error.message);
        } else {
            console.log('❌ Error:', error.message);
        }
        return null;
    }
}

// ==================== ERROR HANDLERS ====================

/**
 * 404 handler
 */
app.use((req, res) => {
    console.warn(`⚠️ 404 - Endpoint không tồn tại: ${req.method} ${req.path}`);
    res.status(404).json({ error: 'Endpoint không tồn tại' });
});

/**
 * Error handler
 */
app.use((err, req, res, next) => {
    console.error('❌ Error:', err);
    res.status(500).json({ error: 'Lỗi server' });
});

// ==================== SERVER START ====================

app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════╗
║   🚀 Shopee Affiliate Backend Server   ║
╚════════════════════════════════════════╝
    
Port: ${PORT}
Environment: ${process.env.NODE_ENV || 'development'}

✅ Allowed Origins:
${ALLOWED_ORIGINS.map(o => `   - ${o}`).join('\n')}

📍 Endpoints:
   - GET /api/health
   - GET /api/resolve-link

⚠️  Frontend khác sẽ bị BLOCK!
    `);
});

module.exports = app;