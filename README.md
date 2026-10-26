# স্মার্ট ফার্মিং মনিটরিং ও সার পরিকল্পনা

ESP32 + RS485 7-in-1 মাটি সেন্সর + DHT22 + DS18B20-ভিত্তিক বাংলা Smart Farming ওয়েব অ্যাপ।

## ওয়েবসাইটের পাতা

1. **ড্যাশবোর্ড** — ESP32-এর সর্বশেষ সেন্সর পাঠ ও FRG-2024 শ্রেণি।
2. **মাঠ ও নমুনা পরিকল্পনা** — মাঠের দৈর্ঘ্য, প্রস্থ ও নমুনার ব্যবধান থেকে grid তৈরি; প্রতিটি পয়েন্টের X/Y অবস্থান, মাঠের রেফারেন্স কোণ A থেকে দূরত্ব এবং কাছের পয়েন্টগুলোর মাপ দেখা যায়।
3. **সেন্সর থেকে নমুনা সংগ্রহ** — একটি পয়েন্টে গিয়ে “সেন্সর থেকে ৩টি নতুন পাঠ নিন” চাপলে ওই মুহূর্তের পর ESP32 থেকে আসা ৩টি নতুন পাঠের গড় তৈরি হয়। পুরোনো পাঠ ব্যবহার করা হয় না। গড় যাচাই করে “এই পয়েন্টের তথ্য সংরক্ষণ করুন” চাপলে ওই মাঠের ওই পয়েন্টে তথ্য সেভ হয়।
4. **স্থানভিত্তিক প্রয়োগ মানচিত্র (VRA)** — সংরক্ষিত নমুনার ভিত্তিতে IDW interpolation।
5. **ইতিহাস ও প্রতিবেদন** — আগের মাঠ খুলে নমুনা চালিয়ে যাওয়া এবং PDF রিপোর্ট। PDF রিপোর্টের বিন্যাস বর্তমানে ইংরেজি।

## Backend ও API

FastAPI + SQLite; frontend backend থেকেই serve হয়।

- `POST /api/esp32/readings` — ESP32-এর sensor reading গ্রহণ করে।
- `GET /api/live` — সর্বশেষ reading ও ID ফেরত দেয়।
- `GET /api/live/recent?after_id=<ID>&limit=3&max_age_sec=120` — নির্দিষ্ট reading ID-এর পর থেকে নতুন ও সাম্প্রতিক পাঠ সংগ্রহ করে; ৩টি পাঠ পাওয়া গেলে numerical sensor-field-এর গড় ফেরত দেয়।
- `POST /api/fields` — মাঠ তৈরি করে।
- `GET /api/fields/{field_id}/grid` — point coordinate, nearest-point distance ও saved sample ফেরত দেয়।
- `POST /api/samples` — একটি grid point-এর নমুনা save/update করে।

## নমুনা সংগ্রহের ব্যবহার

1. মাঠের একটি বাস্তব কোণকে A (0,0) হিসেবে চিহ্নিত করুন।
2. A থেকে দৈর্ঘ্য বরাবর X এবং প্রস্থ বরাবর Y মেপে grid-এর point-এ যান। GPS প্রয়োজন নেই; মাপার ফিতা ব্যবহার করা যায়।
3. ESP32-র সেন্সরকে মাটিতে স্থির রেখে “সেন্সর থেকে ৩টি নতুন পাঠ নিন” চাপুন। Firmware প্রতি ১৫ সেকেন্ডে upload করলে ৩টি নতুন পাঠ আসতে প্রায় ৩০–৪৫ সেকেন্ড লাগতে পারে।
4. গড় মান যাচাই করে save করুন। অন্য point-এ একই কাজ করুন।

## স্থানীয়ভাবে চালানো

```bash
python -m pip install -r backend/requirements.txt
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

তারপর `http://localhost:8000` খুলুন।

## কৃষি-সংক্রান্ত সতর্কতা

FRG-2024 critical-limit class মাটির পরীক্ষার ফল ব্যাখ্যার জন্য। যাচাইকৃত crop/variety/season/yield-goal dose table যুক্ত না করা পর্যন্ত সিস্টেম নির্দিষ্ট সারমাত্রা বানিয়ে দেয় না। ESP32-এর NPK calibration ও একক স্বাধীনভাবে যাচাই করা প্রয়োজন।

## Deployment note

SQLite database `data/smart_farming.db`-এ থাকে। Render-এর filesystem ephemeral হলে service restart বা redeploy-এ database মুছে যেতে পারে। স্থায়ী field/sample history দরকার হলে Render persistent disk বা managed database configure করুন।
