# ESP32 Integration

Target hardware:

- ESP32
- 7-in-1 RS485 NPK sensor
- DHT22
- DS18B20

The production firmware should POST the latest validated/corrected values to:

`POST /api/esp32/readings`

The firmware should include a power/validity check so NPK data are not accepted when the sensor is not actually powered.
