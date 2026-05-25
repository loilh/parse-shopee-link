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
 * Lấy thông tin sản phẩm từ Shopee bằng scraping HTML
 */
async function fetchProductInfo(shopId, itemId) {
    try {
        // Construct product URL
        const productUrl = `https://shopee.vn/api/v4/pdp/get_pc?shop_id=${shopId}&item_id=${itemId}`;
        console.log(`🔗 Fetching product from: https://shopee.vn/-i.${shopId}.${itemId}`);

        // Tạo URL page view
        const pageUrl = `https://shopee.vn/-i.${shopId}.${itemId}`;

        const response = await axios.get(pageUrl, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'vi-VN,vi;q=0.9',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache'
            }
        });

        // Extract JSON data từ HTML
        // Shopee inject dữ liệu vào <script> tag
        const htmlContent = response.data;

        // Tìm data trong script tag
        const jsonMatch = htmlContent.match(/window\.__INITIAL_STATE__\s*=\s*({.*?});/s);

        if (jsonMatch) {
            try {
                const jsonStr = jsonMatch[1];
                // Cố gắng parse JSON
                const startIdx = jsonStr.indexOf('{');
                const data = JSON.parse(jsonStr);

                // Extract product info từ nested data
                const productInfo = extractProductFromData(data);
                if (productInfo) {
                    console.log(`✅ Product info scraped: ${productInfo.name}`);
                    console.log(`   - Price: ${productInfo.price}`);
                    console.log(`   - Rating: ${productInfo.rating}/5`);
                    console.log(`   - Sales: ${productInfo.sales}`);
                    return productInfo;
                }
            } catch (e) {
                console.log('⚠️ JSON parse failed:', e.message);
            }
        }

        // Fallback: Extract từ HTML meta tags
        console.log('🔄 Trying meta tags extraction...');

        // OG tags thường có title và image
        const titleMatch = htmlContent.match(/<meta\s+property="og:title"\s+content="([^"]*)"/);
        const imageMatch = htmlContent.match(/<meta\s+property="og:image"\s+content="([^"]*)"/);
        const descMatch = htmlContent.match(/<meta\s+name="description"\s+content="([^"]*)"/);

        if (titleMatch) {
            const productInfo = {
                name: titleMatch[1] || 'Sản phẩm',
                image: imageMatch ? imageMatch[1] : '',
                sales: 0,
                rating: 0,
                price: 0
            };
            console.log(`✅ Meta tags extracted: ${productInfo.name}`);
            return productInfo;
        }

        console.log('⚠️ Không thể lấy thông tin sản phẩm');
        return null;

    } catch (error) {
        if (error.response) {
            console.log(`❌ Error ${error.response.status}:`, error.message);
        } else if (error.request) {
            console.log('❌ No response:', error.message);
        } else {
            console.log('❌ Error:', error.message);
        }
        return null;
    }
}

/**
 * Extract product info từ __INITIAL_STATE__ data
 */
function extractProductFromData(data) {
    try {
        // Tìm item info trong data structure
        // Shopee stores product info ở nhiều level khác nhau

        // Cách 1: Tìm itemDetail
        if (data?.itemDetail?.item) {
            const item = data.itemDetail.item;
            return {
                name: item.name || 'Sản phẩm',
                image: item.image || '',
                sales: item.sold || item.historical_sold || 0,
                rating: (item.rating || 0) / 2,
                price: (item.price || 0) / 100000
            };
        }

        // Cách 2: Tìm product info
        if (data?.product) {
            const product = data.product;
            return {
                name: product.name || 'Sản phẩm',
                image: product.image || '',
                sales: product.sold || 0,
                rating: (product.rating || 0) / 2,
                price: (product.price || 0) / 100000
            };
        }

        // Cách 3: Recursive search
        const result = recursiveSearch(data, 'item');
        if (result) {
            return {
                name: result.name || 'Sản phẩm',
                image: result.image || '',
                sales: result.sold || result.historical_sold || 0,
                rating: (result.rating || result.rating_star || 0) / 2,
                price: (result.price || 0) / 100000
            };
        }

    } catch (e) {
        console.log('⚠️ Data extraction failed:', e.message);
    }
    return null;
}

/**
 * Recursive search để tìm object có properties cần
 */
function recursiveSearch(obj, key, depth = 0) {
    if (depth > 5) return null; // Limit depth

    if (!obj || typeof obj !== 'object') return null;

    // Check current object
    if (obj[key] && obj[key].name && obj[key].price) {
        return obj[key];
    }

    // Search nested
    for (let k in obj) {
        if (obj.hasOwnProperty(k)) {
            const result = recursiveSearch(obj[k], key, depth + 1);
            if (result) return result;
        }
    }

    return null;
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