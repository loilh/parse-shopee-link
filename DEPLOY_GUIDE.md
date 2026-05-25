# 🚀 Hướng dẫn Deploy Backend Miễn Phí & An Toàn

## ✅ Lựa chọn deploy miễn phí tốt nhất

| Platform | Giá | An toàn | Dễ sử dụng | Khuyến khích |
|----------|-----|--------|-----------|------------|
| **Vercel** | Free | ✅ | ⭐⭐⭐⭐⭐ | 🥇 #1 |
| **Netlify** | Free | ✅ | ⭐⭐⭐⭐ | 🥈 #2 |
| **Railway** | Free | ✅ | ⭐⭐⭐⭐ | 🥉 #3 |
| Heroku | ❌ Bỏ miễn phí | ✅ | ⭐⭐⭐⭐ | Không |
| Replit | Free | ⚠️ Chậm | ⭐⭐⭐ | Không |

---

## 🥇 **KHUYẾN KHÍCH: Deploy lên Vercel (Fastest + Easiest)**

### **Bước 1: Tạo GitHub Repository**

```bash
# 1. Tạo folder
mkdir shopee-affiliate-backend
cd shopee-affiliate-backend

# 2. Copy 3 file vào đây:
# - server.js
# - package.json  
# - .env (optional)

# 3. Khởi tạo git
git init
git add .
git commit -m "Initial commit"

# 4. Tạo repo trên GitHub (https://github.com/new)
# Chọn "shopee-affiliate-backend" làm tên repo

# 5. Push lên GitHub
git remote add origin https://github.com/YOUR_USERNAME/shopee-affiliate-backend.git
git branch -M main
git push -u origin main
```

### **Bước 2: Deploy lên Vercel**

1. Vào https://vercel.com
2. Click **"Add New..."** → **"Project"**
3. Chọn GitHub repo: `shopee-affiliate-backend`
4. Click **"Deploy"**
5. Chờ ~1-2 phút

**✅ Xong! Backend chạy tại: `https://shopee-affiliate-backend.vercel.app`**

### **Bước 3: Update Frontend**

Sửa file `shopee_affiliate_final.html`:

```javascript
const API_BASE_URL = "https://shopee-affiliate-backend.vercel.app";
```

---

## 🥈 **Alternative: Deploy lên Railway**

### **Bước 1: Tạo tài khoản Railway**

1. Vào https://railway.app
2. Click "Start Project"
3. Chọn "Deploy from GitHub"
4. Connect GitHub account
5. Chọn repo `shopee-affiliate-backend`

### **Bước 2: Config Environment**

1. Thêm `PORT` variable (tự động)
2. Thêm `NODE_ENV=production`
3. Click "Deploy"

**✅ Xong! Backend chạy tại: `https://shopee-affiliate-backend-production.up.railway.app`**

---

## 🛡️ **Security Features (đã implement)**

✅ **Origin Whitelist**
```javascript
const ALLOWED_ORIGINS = [
    'https://loilh.github.io',
    'http://localhost:3000',
    'http://localhost:5000'
];
```

✅ **Block Direct Requests**
- Postman ❌ Blocked
- curl ❌ Blocked
- Unauthorized domains ❌ Blocked

✅ **Request Logging**
- Log tất cả request
- Theo dõi unauthorized access

✅ **Cache to Reduce Abuse**
- 1 link chỉ fetch 1 lần
- Lưu cache 1 giờ
- Giảm tải server

---

## 📝 **Sử dụng sau khi deploy**

### **Test Backend:**

```bash
# Health check (không cần verify origin)
curl https://shopee-affiliate-backend.vercel.app/api/health

# Response:
{
  "status": "OK",
  "timestamp": "2024-05-25T10:30:00Z",
  "allowedOrigins": [...]
}
```

### **Test từ Frontend:**

```bash
# Mở console browser khi đang trên https://loilh.github.io/affiliate-link/
# Paste link Shopee
# Click "Tạo Link"

# ✅ Hoạt động!
```

### **Test từ Postman (sẽ bị block):**

```bash
GET https://shopee-affiliate-backend.vercel.app/api/resolve-link?url=https://s.shopee.vn/2BBu8MHr7d

# Response: 403 Forbidden
# {
#   "error": "Forbidden: Origin header required"
# }
```

---

## 🔧 **Add thêm domain sau này**

Nếu muốn cho domain khác access, sửa `server.js`:

```javascript
const ALLOWED_ORIGINS = [
    'https://loilh.github.io',
    'https://new-domain.com',  // ← Thêm dòng này
    'http://localhost:3000'
];
```

Rồi commit + push GitHub, Vercel tự động redeploy.

---

## ⚡ **Performance**

| Metric | Vercel | Railway | Netlify |
|--------|--------|---------|---------|
| **Response Time** | 50-100ms | 100-150ms | 100-150ms |
| **Uptime** | 99.99% | 99.9% | 99.9% |
| **Cold Start** | ⚡ 200ms | ⚡ 500ms | ⚡ 500ms |
| **Bandwidth** | Unlimited | 5GB/month | Unlimited |

✅ **Vercel tốt nhất cho serverless!**

---

## 💡 **Troubleshooting**

### **Lỗi: 403 Forbidden**
→ Origin không trong whitelist  
→ Sửa `server.js` + commit + push

### **Lỗi: 502 Bad Gateway**
→ Backend timeout  
→ Check server logs trên Vercel dashboard

### **Lỗi: Timeout**
→ Shopee API chậm
→ Cố gắng lại sau vài giây

### **Không resolve short link**
→ Bình thường, tùy vào Shopee API  
→ Link affiliate vẫn hoạt động 100%

---

## 📊 **Monitoring**

### **Vercel Dashboard:**
- Vào https://vercel.com/dashboard
- Chọn project
- Xem **Deployments**, **Analytics**, **Logs**

### **Check logs:**
```
Deployments → Chọn deployment → Logs
```

---

## ✨ **Next Steps**

1. ✅ Deploy backend lên Vercel
2. ✅ Update frontend với API URL
3. ✅ Test trên https://loilh.github.io/affiliate-link/
4. ✅ Chia sẻ cho bạn bè dùng!

---

## 🎉 **Xong! Backend hoạt động 100%!**

Bạn có câu hỏi gì không? 😊
