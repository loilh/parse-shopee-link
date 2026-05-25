// server.js
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
 * Lấy thông tin sản phẩm từ Shopee bằng scraping HTML với cheerio
 */
async function fetchProductInfo(shopId, itemId) {
    try {
        const pageUrl = `https://shopee.vn/-i.${shopId}.${itemId}`;
        console.log(`🔗 Scraping: ${pageUrl}`);

        const response = await axios.get(pageUrl, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'vi-VN,vi;q=0.9',
                'Cache-Control': 'no-cache'
            }
        });

        const html = response.data;

        // ==================== Cách 1: Extract JSON từ script tag ====================
        console.log('📝 Parsing HTML...');

        // Tìm script tag chứa product data
        const scriptMatch = html.match(/<script[^>]*>([\s\S]*?)<\/script>/g);

        if (scriptMatch) {
            for (let script of scriptMatch) {
                // Tìm __INITIAL_STATE__ hoặc __data
                if (script.includes('__INITIAL_STATE__') || script.includes('item')) {
                    try {
                        // Extract JSON
                        const jsonMatch = script.match(/\{[\s\S]*\}/);
                        if (jsonMatch) {
                            const data = JSON.parse(jsonMatch[0]);
                            const productInfo = extractProductFromData(data);
                            if (productInfo) {
                                console.log(`✅ Product scraped from script: ${productInfo.name}`);
                                return productInfo;
                            }
                        }
                    } catch (e) {
                        // Continue searching
                    }
                }
            }
        }

        // ==================== Cách 2: Parse HTML với cheerio ====================
        console.log('🔍 Parsing with cheerio...');
        const $ = cheerio.load(html);

        // Tìm product title từ h1 hoặc title tag
        let productName = $('h1').first().text() || $('title').text() || '';

        // Clean name
        productName = productName.replace(/\s+/g, ' ').trim();
        if (productName.includes('|')) {
            productName = productName.split('|')[0].trim();
        }

        // Tìm hình ảnh
        let productImage = '';
        const img = $('img[alt*="product"], img[alt*="Product"], img[class*="product"]').first();
        if (img.length) {
            productImage = img.attr('src') || '';
        }

        // Fallback: og:image
        if (!productImage) {
            productImage = $('meta[property="og:image"]').attr('content') || '';
        }

        // Fallback: Bất kỳ img tag đầu tiên
        if (!productImage) {
            productImage = $('img').first().attr('src') || '';
        }

        // Tìm giá - thường ở trong span hoặc div với class chứa "price"
        let price = 0;
        const priceElements = $('span[class*="price"], div[class*="price"]');
        if (priceElements.length) {
            const priceText = priceElements.first().text();
            const priceMatch = priceText.match(/[\d.,]+/);
            if (priceMatch) {
                price = parseFloat(priceMatch[0].replace(/[.,]/g, '')) / 100000;
            }
        }

        // Tìm rating - thường ở trong span hoặc div chứa "rating" hoặc star icon
        let rating = 0;
        const ratingElements = $('span[class*="rating"], div[class*="rating"]');
        if (ratingElements.length) {
            const ratingText = ratingElements.first().text();
            const ratingMatch = ratingText.match(/[\d.]+/);
            if (ratingMatch) {
                rating = parseFloat(ratingMatch[0]) / 2; // Normalize to 0-5
            }
        }

        // Tìm số lượt bán - thường ở trong span hoặc div chứa "sold"
        let sales = 0;
        const salesElements = $('span[class*="sold"], div[class*="sold"]');
        if (salesElements.length) {
            const salesText = salesElements.first().text();
            const salesMatch = salesText.match(/[\d.]+/);
            if (salesMatch) {
                sales = parseFloat(salesMatch[0]);
            }
        }

        // ==================== Cách 3: Meta tags ====================
        if (!productName) {
            productName = $('meta[property="og:title"]').attr('content') || 'Sản phẩm';
        }

        if (!productImage) {
            productImage = $('meta[property="og:image"]').attr('content') || '';
        }

        // Nếu lấy được tên sản phẩm, return
        if (productName && productName.length > 2) {
            const result = {
                name: productName,
                image: productImage,
                sales: sales,
                rating: rating,
                price: price
            };
            console.log(`✅ Product info extracted: ${result.name}`);
            console.log(`   - Price: ${result.price}`);
            console.log(`   - Rating: ${result.rating}/5`);
            console.log(`   - Sales: ${result.sales}`);
            return result;
        }

        console.log('⚠️ Không thể lấy thông tin sản phẩm từ HTML');
        return null;

    } catch (error) {
        if (error.response) {
            console.log(`❌ HTTP Error ${error.response.status}:`, error.message);
        } else {
            console.log('❌ Error:', error.message);
        }
        return null;
    }
}

/**
 * Extract product info từ JSON data
 */
function extractProductFromData(data) {
    try {
        // Search for item object
        const findItem = (obj, depth = 0) => {
            if (depth > 3) return null;
            if (!obj || typeof obj !== 'object') return null;

            // Check if current object is item
            if (obj.name && (obj.price || obj.shopId)) {
                return obj;
            }

            // Search in values
            for (let key in obj) {
                if (obj.hasOwnProperty(key)) {
                    const result = findItem(obj[key], depth + 1);
                    if (result) return result;
                }
            }
            return null;
        };

        const item = findItem(data);
        if (item) {
            return {
                name: item.name || 'Sản phẩm',
                image: item.image || item.images?.[0] || '',
                sales: item.sold || item.historical_sold || 0,
                rating: ((item.rating || item.rating_star) || 0) / 2,
                price: (item.price || 0) / 100000
            };
        }
    } catch (e) {
        // Silently fail
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