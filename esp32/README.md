# ESP32 firmware

`Smart_Farming_ESP32_Refresh.ino` is the current integrated firmware for the ESP32 DevKit V1 and the project's FastAPI endpoint. It retains the sensor reading, calibration, LCD, RTC, and SD logging features while posting readings to `/api/esp32/readings`.

Before uploading:

1. Open the `.ino` file in Arduino IDE and select **ESP32 Dev Module** (for a classic ESP32 DevKit V1).
2. Replace `YOUR_HOTSPOT_NAME` and `YOUR_HOTSPOT_PASSWORD` locally. Do not commit real Wi-Fi credentials.
3. Keep the phone hotspot on 2.4 GHz and ensure its client limit allows the ESP32 to connect.
4. Install the libraries used by this sketch (RTClib, LiquidCrystal_I2C, DHT sensor library, OneWire, DallasTemperature) and the ESP32 Arduino board package.
5. Open Serial Monitor at 115200 baud and verify `Cloud upload successful.`

The current prototype uses `WiFiClientSecure::setInsecure()`, which disables HTTPS certificate verification. Replace it with root-CA validation before production deployment. SD-card logging is skipped safely when the card is not initialized.
