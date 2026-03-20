# Analytics Dashboard by Adsmit

Shiprocket order analytics dashboard with delivery %, NDR/RTO tracking, breakeven calculator, and cost management.

---

## 🚀 Deploy in 3 Steps

### Option 1: Vercel (Recommended — Free, 1 minute)

1. **Push to GitHub:**
   ```bash
   # Create a new repo on github.com, then:
   cd adsmit-analytics-dashboard
   git init
   git add .
   git commit -m "Adsmit Analytics Dashboard"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
   git push -u origin main
   ```

2. **Deploy on Vercel:**
   - Go to [vercel.com](https://vercel.com) → Sign in with GitHub
   - Click **"New Project"** → Import your repo
   - Framework Preset: **Vite** (auto-detected)
   - Click **Deploy**
   - Done! Your dashboard is live at `https://your-project.vercel.app`

3. **Custom domain (optional):**
   - Vercel dashboard → Settings → Domains → Add `dashboard.adsmit.in`

---

### Option 2: Netlify (Free, 1 minute)

1. Push to GitHub (same as above)
2. Go to [netlify.com](https://netlify.com) → Sign in → **"New site from Git"**
3. Select your repo → Build command: `npm run build` → Publish directory: `dist`
4. Click Deploy. Done!

---

### Option 3: Run Locally

```bash
# Install Node.js 18+ from https://nodejs.org

cd adsmit-analytics-dashboard
npm install
npm run dev

# Opens at http://localhost:3000
# Shiprocket API works here (no CORS issues!)
```

---

## 📁 Project Structure

```
adsmit-analytics-dashboard/
├── index.html           # Entry HTML
├── package.json         # Dependencies
├── vite.config.js       # Vite config
├── src/
│   ├── main.jsx         # React entry point
│   ├── storage-shim.js  # localStorage adapter
│   └── App.jsx          # Dashboard (all-in-one)
└── README.md
```

---

## 🔑 Features

- **Shiprocket API login** — Auto-fetches orders (works locally, CORS blocks on hosted)
- **CSV upload** — Drag & drop Shiprocket export
- **Date range filter** — Last 7d, 15d, 30d, or custom range
- **Status groups** — Delivered, NDR (undelivered), RTO, In Transit, etc.
- **Delivery %** — Calculated on shipped orders only
- **Cost Manager** — Bulk update costs, saved in browser localStorage
- **Selling Price** — Auto-fills from CSV average
- **Breakeven Calculator** — Per-SKU breakeven delivery %, max CPA
- **Net Profit** — Per-SKU and grand total P&L

---

## ⚠️ Notes

- **Shiprocket API** works when running locally (`npm run dev`). On hosted domains, CORS blocks the API — use CSV upload instead.
- **Costs are saved in browser** localStorage. Clearing browser data will reset costs.
- **No backend needed** — everything runs client-side.
