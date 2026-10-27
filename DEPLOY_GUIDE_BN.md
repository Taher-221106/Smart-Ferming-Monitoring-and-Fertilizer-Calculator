# GitHub ও Render-এ আপডেট প্রকাশ করার নিয়ম

এই আপডেটে frontend/backend দুটোই বদলেছে। শুধু ESP32 firmware upload করলে website-এর নতুন point-capture workflow চালু হবে না; updated project Render-এ deploy হতে হবে।

## ১. ZIP থেকে ফাইল নিন

`Smart-Farming-Bangla-Updated-v2.zip` extract করুন। ভেতরের `Smart-Ferming-Monitoring-and-Fertilizer-Calculator-main` folder-এ updated project আছে।

## ২. GitHub repository-তে আপডেট দিন

আপনার existing repository-র local copy থাকলে ZIP-এর folder থেকে সংশ্লিষ্ট files একই path-এ কপি/replace করুন:

- `backend/main.py`
- `frontend/index.html`
- `frontend/app.js`
- `frontend/style.css`
- `README.md`
- `DEPLOY_GUIDE_BN.md`
- `esp32/README.md`
- `esp32/Smart_Farming_ESP32_Refresh.ino`

`data/smart_farming.db` upload করবেন না। ZIP-এ এটি ইচ্ছাকৃতভাবে রাখা হয়নি। Real Wi-Fi credentials GitHub-এ commit করবেন না; firmware-এ placeholders আছে।

তারপর repository folder-এ terminal খুলে চালান:

```bash
git add backend/main.py frontend/index.html frontend/app.js frontend/style.css README.md DEPLOY_GUIDE_BN.md esp32/README.md esp32/Smart_Farming_ESP32_Refresh.ino
git commit -m "Add Bengali sensor-based field sampling workflow"
git push origin main
```

আপনার default branch `main` না হলে `git push origin main`-এর বদলে নিজের branch-এর নাম দিন। GitHub-এর web interface দিয়ে কাজ করলে প্রতিটি changed file-কে তার একই path-এ replace করতে হবে।

## ৩. Render deploy করুন

Render Dashboard-এ service খুলুন। GitHub branch connected থাকলে push-এর পর auto-deploy শুরু হওয়ার কথা। না হলে manual deploy করুন। Deploy শেষ হলে:

- `https://smart-ferming-monitoring-and-fertilizer.onrender.com/` খুলুন এবং hard refresh (`Ctrl+F5`) দিন।
- `https://smart-ferming-monitoring-and-fertilizer.onrender.com/api/health` পরীক্ষা করুন।
- `https://smart-ferming-monitoring-and-fertilizer.onrender.com/api/live`-এ `available: true` আছে কি না দেখুন।

## ৪. মাঠের পয়েন্টে সেন্সর পাঠ সংগ্রহ

1. মাঠের একটি বাস্তব কোণকে A (0,0) হিসেবে চিহ্নিত করুন।
2. দৈর্ঘ্য X এবং প্রস্থ Y বরাবর মিটার মেপে মানচিত্রের পয়েন্টে যান।
3. মাঠে গিয়ে সেন্সর বসিয়ে মানচিত্রে ওই পয়েন্টের ID-তে ক্লিক করুন। প্যানেলে sensor value স্বয়ংক্রিয়ভাবে refresh হবে।
4. ESP32 প্রতি ১৫ সেকেন্ডে upload করলে পরের নতুন পাঠ আসতে প্রায় ১৫ সেকেন্ড লাগতে পারে। নতুন reading এলে Save সক্রিয় হবে; মান যাচাই করে **এই পয়েন্টের তথ্য সংরক্ষণ করুন** চাপুন। এই সংস্করণে প্রতি পয়েন্টে সর্বশেষ একটি reading save হয়, তিনটি পাঠের গড় নয়।
5. পরের পয়েন্টে গিয়ে একই পদ্ধতি অনুসরণ করুন।

## ৫. Field/sample history স্থায়ী রাখুন

SQLite ডাটাবেস `SMART_FARMING_DATA_DIR` environment variable দিয়ে নির্দিষ্ট করা যায়। Render service restart বা redeploy-এর পরও field/sample data রাখতে হলে Render-এ persistent disk configure করুন; mount path `/var/data` দিয়ে environment variable সেট করুন:

```text
SMART_FARMING_DATA_DIR=/var/data
```

যদি persistent disk/managed database configure না করা হয়, Render-এর ephemeral filesystem-এ থাকা SQLite data redeploy/restart হলে হারিয়ে যেতে পারে।

## সীমাবদ্ধতা ও যাচাই

- বাংলা UI, API, grid geometry, point-save flow এবং fresh three-reading average-এর backend route পরীক্ষা করা হয়েছে। Browser-এ live Render deployment থেকে end-to-end পরীক্ষা করা হয়নি; আপনার GitHub/Render deploy-এর পর বাস্তব device দিয়ে যাচাই করুন।
- PDF report-এর body এখনও ইংরেজিতে।
- ESP32 prototype firmware-এ HTTPS certificate verification বন্ধ করা আছে (`setInsecure()`); production use-এর আগে root CA validation যোগ করুন।
- N/P/K calibration accuracy ও sensor units আলাদাভাবে soil-lab reference দিয়ে যাচাই করা প্রয়োজন। Website FRG-2024 crop-specific fertilizer dose বানিয়ে দেয় না; verified dose table প্রয়োজন।
