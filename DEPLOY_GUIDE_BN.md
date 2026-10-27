# GitHub ও Render-এ Smart Farming FRG-2024 আপডেট প্রকাশের নির্দেশনা

এই সংস্করণে frontend ও FastAPI backend দুটোই পরিবর্তিত হয়েছে; `data/frg2024_crop_tables.json` নতুন প্রয়োজনীয় FRG crop/variety table। শুধু ESP32 firmware upload করলে web interface আপডেট হবে না।

## ১. Local repository-তে file replace

1. `Smart-Farming-Bangla-FRG2024-Final.zip` extract করুন।
2. Extract folder-এর **ভেতরের contents** আপনার local clone-এর root folder-এ copy/paste করুন; একই path-এর file replace করুন।
3. `.git`, `.gitignore`, `.devcontainer` delete করবেন না। `data/smart_farming.db`, `.env`, Wi-Fi password বা secret GitHub-এ upload করবেন না। ZIP-এ database intentionally থাকে না।

গুরুত্বপূর্ণ source paths:

- `frontend/index.html`
- `frontend/app.js`
- `frontend/style.css`
- `backend/main.py`
- `backend/requirements.txt`
- `data/frg2024_crop_tables.json`
- `data/FRG-2024-NPK-critical-limits.csv`
- `esp32/Smart_Farming_ESP32_Refresh.ino` (existing firmware; website work-এর জন্য বদলাতে হয়নি)

## ২. GitHub Desktop দিয়ে commit ও push

1. সঠিক repository নির্বাচন করুন: `Taher-221106/Smart-Ferming-Monitoring-and-Fertilizer-Calculator` (নামটির শেষে `-Project` নেই)।
2. `Changes` tab-এ updated files review করুন।
3. Summary: `Add FRG-2024 Bengali crop, VRA, and yield recommendations` লিখুন।
4. **Commit to main** চাপুন; শেষে **Push origin** চাপুন।
5. GitHub web page-এ branch `main`-এর সর্বশেষ commit দেখা যাচ্ছে কি না নিশ্চিত করুন।

## ৩. Render deployment

1. Render Dashboard-এ আপনার Smart Farming service খুলুন।
2. নিশ্চিত করুন linked repository হলো উপরের মূল repository এবং branch `main`।
3. Auto-deploy হলে push-এর পর deployment শুরু হবে; না হলে manual deploy করুন।
4. Deployment status `Live` না হওয়া পর্যন্ত নতুন frontend/API-কে live ধরে নেবেন না।
5. Website খুলে hard refresh (`Ctrl+F5`) দিন। Health endpoint: `/api/health`; latest data endpoint: `/api/live`।

## ৪. নতুন workflow test করুন

1. Crop selector-এ ধান, গম, মসুর ডাল বা পেঁয়াজ নির্বাচন করুন। মৌসুম ও জাত FRG-2024 profile থেকে নির্বাচন করুন; yield goal স্বয়ংক্রিয়ভাবে দেখাবে।
2. Field length/width/spacing দিয়ে grid তৈরি করুন। মাঠের একটি কোণ A `(0,0)` চিহ্নিত করে X/Y দূরত্ব মেপে প্রতিটি point-এ যান।
3. Point ID ক্লিক করুন; live sensor readings স্বয়ংক্রিয়ভাবে refresh হবে। ওই point নির্বাচন করার পর ESP32 থেকে নতুন reading আসলে Save সক্রিয় হবে। মান যাচাই করে save করুন।
4. Full-field analysis-এর আগে grid-এর সব point save করুন। Analysis incomplete হলে backend পুরো-জমির dose/yield recommendation দেবে না।
5. Analyze চাপলে yield reference, FRG-2024 nutrient dose range এবং IDW VRA map দেখাবে। Map legend-এ range kg/ha-এ দেখুন। High/Very High class-এ আলাদা FRG crop-table dose না থাকলে gray দেখায়।

## ৫. Persistent data

Render-এর persistent disk mount path `/var/data` হলে environment variable যোগ করুন:

```text
SMART_FARMING_DATA_DIR=/var/data
```

Persistent disk/managed database configure না থাকলে ephemeral filesystem-এর SQLite file restart/redeploy-এ হারাতে পারে। Existing database schema additive migration দিয়ে update হয়; তবু production migration-এর আগে database backup রাখুন।

## Validity & limitations

- Backend Python syntax, JavaScript syntax, crop options, field/grid/sample flow, incomplete-sampling rejection, FRG calculation, IDW surface generation ও response structure local tests-এ যাচাই করা হয়েছে। Live Render-এ deployment ও physical sensor-to-site workflow deploy করার পর আপনার device দিয়ে যাচাই করতে হবে।
- IDW surface একটি preliminary spatial estimate; sparse data-তে validated ML/Kriging claim নয়। ৪+ point থাকলে leave-one-out error দেখায়, তবে সেটি guarantee নয়।
- NPK sensor unit/calibration lab soil test দিয়ে independently verify করা দরকার। S, Mg, Zn, B, Mo sensor-এ মাপা হয় না; lab results ছাড়া তাদের dose auto-fill হয় না।
- Yield-before range FRG-2024 Table 2-এর general soil-test response band থেকে আসে, field-এর actual historical yield নয়। Yield-after FRG crop goal (± tolerance), guaranteed yield forecast নয়।
- VRA boundary length/width-ভিত্তিক rectangle। Satellite imagery-এর উপর irregular real field boundary চাইলে surveyed corner coordinates অথবা KML/GeoJSON প্রয়োজন।
- PDF report-এর body এখনও ইংরেজিতে।
