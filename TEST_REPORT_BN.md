# Smart Farming FRG-2024 সংস্করণ — পরীক্ষার প্রতিবেদন

## পরীক্ষা পাস করেছে

- Python backend syntax check (`python -m py_compile backend/main.py`)
- JavaScript syntax check (`node --check frontend/app.js`)
- Crop option API-তে কেবল চারটি crop: ধান, গম, মসুর ডাল, পেঁয়াজ
- FRG profile/variety load: ১৩টি profile, ১০৬টি variety entry
- Field create ও sampling grid generation
- Live ESP32 reading গ্রহণ এবং `/api/live` response
- প্রতিটি grid point-এর coordinate যাচাইসহ sample save/update
- সব sample save না থাকলে full-field recommendation প্রত্যাখ্যান
- চার crop-এর জন্য full sample flow, FRG recommendation, yield goal ও fertilizer total response
- ৪০ × ৪০ = ১,৬০০-cell IDW surface
- মসুর ডাল + Rhizobium নির্বাচন করলে urea dose শূন্যের নিয়ম
- PDF report endpoint থেকে valid PDF তৈরি
- অনুমোদিত নয় এমন Potato crop option প্রত্যাখ্যান

## যা এখনো বাস্তব Render deployment-এ যাচাই হয়নি

- নতুন commit Render-এ deploy করার পর browser-based end-to-end পরীক্ষা
- বাস্তব ESP32 ও মাঠের sensor দিয়ে point-by-point capture পরীক্ষা
- সেন্সরের NPK calibration-কে laboratory soil-test result-এর সঙ্গে যাচাই

## বৈজ্ঞানিক ব্যবহারের সীমা

- Spatial map হলো IDW (power 2) estimate; এটি validated ML/Kriging model নয়।
- FRG-2024 yield target নিশ্চিত ফলন নয়। সার ছাড়া yield band হলো guidebook-এর general response band থেকে আনুমানিক reference।
- NPK sensor-এ সরাসরি মাপা হয় না এমন S, Mg, Zn, B, Mo-এর dose স্বয়ংক্রিয়ভাবে নির্ধারণ করা হয় না।
- Map boundary length/width থেকে তৈরি rectangular local-coordinate field; satellite map overlay করতে survey coordinates বা KML/GeoJSON লাগবে।
