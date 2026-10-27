# স্মার্ট ফার্মিং মনিটরিং ও FRG-2024 ভিত্তিক সার পরিকল্পনা

ESP32 + RS485 7-in-1 মাটি সেন্সর + DHT22 + DS18B20-ভিত্তিক বাংলা Smart Farming ওয়েব অ্যাপ। Crop selector-এ কেবল **ধান, গম, মসুর ডাল ও পেঁয়াজ** আছে; মৌসুম, জাত ও yield goal আপলোড করা FRG-2024-এর যাচাইকৃত crop tables থেকে আসে।

## ওয়েবসাইটের অংশ

1. **সরাসরি সেন্সর ড্যাশবোর্ড** — ESP32-এর সর্বশেষ sensor reading ও preliminary N/P/K class।
2. **মাঠ ও নমুনা পরিকল্পনা** — field length, width ও spacing থেকে local-coordinate sampling grid তৈরি; A `(0,0)` corner থেকে X/Y মাপ, nearest point distance এবং প্রতিটি point-এর ID দেখায়। GPS প্রয়োজন নেই; measuring tape ব্যবহার করা যায়।
3. **Point-wise live sampling** — point নির্বাচন করলে live sensor value স্বয়ংক্রিয়ভাবে দেখা যায়। ওই point নির্বাচন করার পর ESP32-এর পরবর্তী নতুন reading এলে Save সক্রিয় হয়। সংরক্ষণ করলে reading নির্দিষ্ট point ID-তে যুক্ত হয়। প্রতি point-এর সর্বশেষ একটি reading সংরক্ষিত হয়; তিন-reading average নয়।
4. **FRG-2024 crop recommendation** — সব grid point save না হলে full-field prescription তৈরি হয় না। পুরো মাঠের IDW surface থেকে পুষ্টি-শ্রেণি, Urea/TSP/MOP-এর FRG-table dose-range, area-integrated total amount, organic fertilizer এবং yield-goal তুলনা তৈরি হয়।
5. **VRA map** — IDW interpolation-এর 40×40 raster surface। রঙ nutrient status / FRG dose class বোঝায়; প্রতিটি legend entry-তে fertilizer range (kg/ha) আছে। FRG crop table-এ High/Very High-এর আলাদা dose না থাকলে area gray দেখায়, zero dose বলে ধরে না।
6. **ইতিহাস ও প্রতিবেদন** — আগে তৈরি করা মাঠ খুলে sample progress দেখা যায়; PDF report-এর বর্তমান body ইংরেজিতে।

## পদ্ধতি ও সীমাবদ্ধতা

- Spatial method: inverse-distance weighting (IDW, power 2) ব্যবহার করা হয়েছে। কম point-এ Kriging/ML-কে যাচাইকৃত বলে দাবি করা হয় না। চার বা তার বেশি sample থাকলে leave-one-out cross-validation-এর MAE/RMSE diagnostic দেখানো হয়। Sparse sampling-এ এই metric স্থিতিশীল accuracy guarantee নয়।
- Crop/yield-goal/fertilizer table values `data/frg2024_crop_tables.json`-এ BARC Fertilizer Recommendation Guide-2024 থেকে transcribe করা হয়েছে; `source_page` field-এ printed page উল্লেখ থাকে।
- Soil nutrient classes Appendix-8-এর critical-limit values অনুসরণ করে। Urea/TSP/MOP kg/ha conversion factor Appendix-10 থেকে (N→urea 2.17, P→TSP 5.0, K→MOP 2.0)।
- Connected ESP32 NPK/soil sensor S, Mg, Zn, B ও Mo সরাসরি মাপে না। এই nutrient-এর নির্দিষ্ট rate laboratory soil test ছাড়া auto-assign করা হয় না।
- Sensor output laboratory soil-test result দিয়ে calibrate না করা হলে, color map ও dose prescription-কে **প্রাথমিক নির্দেশক** হিসেবে ব্যবহার করতে হবে। FRG yield goal কোনো guaranteed yield prediction নয়; actual pre/post-fertilizer yield জানতে একই field-এর harvest/treatment history প্রয়োজন।
- VRA field boundary বর্তমানে length/width থেকে তৈরি rectangular local-coordinate map, satellite/GPS polygon নয়। Real irregular boundary overlay করতে surveyed corner coordinates বা KML/GeoJSON দরকার।

## API

- `POST /api/esp32/readings` — ESP32 sensor reading গ্রহণ করে।
- `GET /api/live` — latest reading ফেরত দেয়।
- `GET /api/live/recent` — ID-এর পরের নতুন readings নিয়ে average endpoint (legacy/diagnostic; current UI latest-reading capture ব্যবহার করে)।
- `GET /api/frg/options` — crop/season/variety profile ও yield goal।
- `POST /api/fields` — field ও grid তৈরি করে।
- `GET /api/fields/{id}/grid` — point coordinates ও saved status।
- `POST /api/samples` — point-এর sensor reading save/update করে।
- `POST /api/fertilizer/calculate` — সব grid point saved থাকলে FRG-2024 recommendation ও yield reference তৈরি করে।
- `GET /api/vra/{id}?grid=40` — field samples, IDW surface, legend, prescription, progress ও validation diagnostic।
- `GET /api/history` — field history।

## Local run

```bash
python -m pip install -r backend/requirements.txt
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

তারপর `http://localhost:8000` খুলুন।

## Render persistent storage

SQLite database `SMART_FARMING_DATA_DIR`-এ থাকে (local default `data/`)। Render-এ persistent disk mount path `/var/data` হলে environment variable সেট করুন:

```text
SMART_FARMING_DATA_DIR=/var/data
```

Persistent disk/managed database না থাকলে service restart/redeploy-এ field/sample history হারাতে পারে। Real Wi-Fi password, API secret বা database secret GitHub-এ commit করবেন না।
