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
        // Thử nhiều URL format - prioritize theo hiệu quả
        const urlFormats = [
            // Format 1: /product/shopId/itemId (Direct - BEST)
            `https://shopee.vn/product/${shopId}/${itemId}`,
            // Format 2: /product/shopId/itemId với affiliate params
            `https://shopee.vn/product/${shopId}/${itemId}?mmp_pid=an_17396630390`,
            // Format 3: Cũ (có thể 404)
            `https://shopee.vn/-i.${shopId}.${itemId}`,
        ];

        let html = null;
        let workingUrl = null;

        // Thử từng URL cho đến khi thành công
        for (let pageUrl of urlFormats) {
            try {
                console.log(`🔗 Trying: ${pageUrl}`);
                const response = await axios.get(pageUrl, {
                    timeout: 8000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'Accept-Language': 'vi-VN,vi;q=0.9',
                        'Cache-Control': 'no-cache',
                        'Cookie': 'SPC_F=; SPC_T=;'
                    }
                });

                if (response.status === 200 && response.data.length > 1000) {
                    html = response.data;
                    workingUrl = pageUrl;
                    console.log(`✅ Got response from: ${pageUrl} (${response.data.length} bytes)`);
                    break;
                }
            } catch (error) {
                console.log(`⚠️ Failed: ${error.response?.status || error.message}`);
                continue;
            }
        }

        if (!html) {
            console.log('❌ Không thể lấy HTML từ bất kỳ URL nào');
            return null;
        }

        // ==================== Extract JSON từ script ====================
        console.log('📝 Parsing HTML...');

        // Tìm script tag chứa product data
        const scriptMatches = html.match(/<script[^>]*>([\s\S]*?)<\/script>/g) || [];
        console.log(`📊 Found ${scriptMatches.length} script tags`);

        for (let i = 0; i < scriptMatches.length; i++) {
            const script = scriptMatches[i];
            if (script.includes('item') && script.includes('name') && script.length > 100) {
                try {
                    // Extract JSON string
                    const jsonMatch = script.match(/\{[\s\S]*"name"[\s\S]*\}/);
                    if (jsonMatch) {
                        const data = JSON.parse(jsonMatch[0]);
                        const productInfo = extractProductFromData(data);
                        if (productInfo && productInfo.name && productInfo.name.length > 3) {
                            console.log(`✅ Product from JSON script #${i}: ${productInfo.name}`);
                            return productInfo;
                        }
                    }
                } catch (e) {
                    // Continue searching
                }
            }
        }

        // ==================== Parse HTML với cheerio ====================
        console.log('🔍 Parsing with cheerio...');
        const $ = cheerio.load(html);

        // Debug: Log available data
        console.log('📊 Page title:', $('title').text().substring(0, 100));

        // Debug: Log HTML elements
        console.log(`📊 h1 count: ${$('h1').length}`);
        console.log(`📊 h2 count: ${$('h2').length}`);
        console.log(`📊 img count: ${$('img').length}`);
        console.log(`📊 span[class*="price"] count: ${$('span[class*="price"]').length}`);

        // Log first few h1/h2
        $('h1').slice(0, 3).each((i, elem) => {
            console.log(`  h1[${i}]: ${$(elem).text().substring(0, 80)}`);
        });

        $('h2').slice(0, 3).each((i, elem) => {
            console.log(`  h2[${i}]: ${$(elem).text().substring(0, 80)}`);
        });

        // Tìm product title - cách 1: h1
        let productName = $('h1').first().text().trim();

        // Cách 2: Meta og:title
        if (!productName || productName.length < 3) {
            productName = $('meta[property="og:title"]').attr('content') || '';
        }

        // Cách 3: h2
        if (!productName || productName.length < 3) {
            productName = $('h2').first().text().trim();
        }

        // Cách 4: Span chứa từ "product" hoặc "sản phẩm"
        if (!productName || productName.length < 3) {
            $('span, div, h1, h2, h3').each((i, elem) => {
                const text = $(elem).text().trim();
                if (text.length > 5 && text.length < 300 && !text.includes('http')) {
                    productName = text;
                    return false; // Break
                }
            });
        }

        // Clean name
        productName = productName
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, 200);

        if (productName.includes('|')) {
            productName = productName.split('|')[0].trim();
        }

        console.log(`📝 Product name: "${productName}"`);

        // Tìm hình ảnh
        let productImage = '';

        // Cách 1: og:image
        productImage = $('meta[property="og:image"]').attr('content') || '';
        console.log(`  og:image: ${productImage ? 'Found' : 'Not found'}`);

        // Cách 2: img tag có src mcdn hoặc shopee
        if (!productImage) {
            $('img').each((i, elem) => {
                const src = $(elem).attr('src');
                if (src && (src.includes('mcdn') || src.includes('shopee') || src.includes('img'))) {
                    productImage = src;
                    console.log(`  Found img[${i}]: ${src.substring(0, 60)}`);
                    return false; // break
                }
            });
        }

        // Cách 3: Bất kỳ img tag nào
        if (!productImage) {
            const firstImg = $('img[src]').first();
            if (firstImg.length) {
                productImage = firstImg.attr('src') || '';
                console.log(`  Fallback img: ${productImage.substring(0, 60)}`);
            }
        }

        // Normalize image URL
        if (productImage && !productImage.startsWith('http')) {
            productImage = 'https:' + productImage;
        }

        console.log(`🖼️  Image: ${productImage ? 'Found' : 'Not found'}`);

        // Tìm giá
        let price = 0;
        const priceElements = $('span[class*="price"], div[class*="price"]');
        console.log(`  price elements: ${priceElements.length}`);
        if (priceElements.length > 0) {
            const priceText = priceElements.first().text();
            console.log(`  price text: ${priceText.substring(0, 60)}`);
            const priceMatch = priceText.match(/[\d.,]+/);
            if (priceMatch) {
                price = parseFloat(priceMatch[0].replace(/[.,]/g, '')) / 100000;
            }
        }

        // Tìm rating
        let rating = 0;
        const ratingText = $('span[class*="rating"], div[class*="rating"]').first().text();
        if (ratingText) {
            const ratingMatch = ratingText.match(/[\d.]+/);
            if (ratingMatch) {
                rating = parseFloat(ratingMatch[0]) / 2;
            }
        }

        // Tìm sales
        let sales = 0;
        const salesText = $('span[class*="sold"], div[class*="sold"]').first().text();
        if (salesText) {
            const salesMatch = salesText.match(/[\d.]+/);
            if (salesMatch) {
                sales = parseFloat(salesMatch[0]);
            }
        }

        // Nếu lấy được tên, return
        if (productName && productName.length > 3 && productName !== 'Sản phẩm') {
            const result = {
                name: productName,
                image: productImage,
                sales: sales,
                rating: rating,
                price: price
            };
            console.log(`✅ Product info extracted: ${result.name}`);
            if (price > 0) console.log(`   - Price: ${result.price}`);
            if (rating > 0) console.log(`   - Rating: ${result.rating}/5`);
            if (sales > 0) console.log(`   - Sales: ${result.sales}`);
            return result;
        }

        console.log('⚠️ Không thể lấy đủ thông tin sản phẩm');
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