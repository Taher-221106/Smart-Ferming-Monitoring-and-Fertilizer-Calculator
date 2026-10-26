#include <Wire.h>
#include <SPI.h>
#include <SD.h>
#include <RTClib.h>
#include <LiquidCrystal_I2C.h>
#include <DHT.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>

// ============================================================
// PIN DEFINITIONS
// ============================================================

#define DHTPIN 14
#define DHTTYPE DHT22

#define ONE_WIRE_BUS 25

#define RE_DE_PIN 4
#define RX_PIN 16
#define TX_PIN 17

#define SD_CS_PIN 5


// ============================================================
// OBJECTS
// ============================================================

DHT dht(DHTPIN, DHTTYPE);

OneWire oneWire(ONE_WIRE_BUS);
DallasTemperature ds18b20(&oneWire);

RTC_DS3231 rtc;

LiquidCrystal_I2C lcd(0x27, 16, 2);


// ============================================================
// CLOUD / WI-FI CONFIGURATION
// ============================================================
// Enter your mobile hotspot credentials here. ESP32 DevKit V1 uses 2.4 GHz Wi-Fi.
// Keep these placeholders in shared copies; enter credentials only in your local sketch.
const char* WIFI_SSID = "YOUR_HOTSPOT_NAME";
const char* WIFI_PASSWORD = "YOUR_HOTSPOT_PASSWORD";

const char* API_URL =
  "https://smart-ferming-monitoring-and-fertilizer.onrender.com/api/esp32/readings";

WiFiClientSecure cloudClient;
unsigned long lastCloudUploadTime = 0;
unsigned long lastWiFiReconnectAttempt = 0;
const unsigned long CLOUD_UPLOAD_INTERVAL = 15000;
const unsigned long WIFI_RECONNECT_INTERVAL = 10000;
const unsigned long WIFI_CONNECT_TIMEOUT = 20000;

// Wi-Fi state tracking avoids calling WiFi.reconnect() repeatedly while
// the ESP32 is already attempting to connect to the hotspot.
bool wifiConnecting = false;
bool wifiPreviouslyConnected = false;
unsigned long wifiAttemptStarted = 0;

// Only attempt SD writes when SD initialization and log-file creation succeed.
bool sdCardReady = false;


// ============================================================
// TIMING
// ============================================================

unsigned long lastSensorReadTime = 0;
unsigned long lastLogTime = 0;
unsigned long lastLCDTime = 0;

const unsigned long SENSOR_INTERVAL = 3000;
const unsigned long LOG_INTERVAL = 5000;
const unsigned long LCD_INTERVAL = 3000;


// ============================================================
// LCD
// ============================================================

int lcdPage = 0;


// ============================================================
// SD FILE
// ============================================================

char logFileName[20];


// ============================================================
// SENSOR VALID STATUS
// ============================================================

bool npkSensorValid = false;


// ============================================================
// SENSOR VARIABLES
// ============================================================

// Air
double g_airTemp = 0.0;
double g_airHum = 0.0;

// Soil temperature
double g_soilTempNPK = 0.0;
double g_soilTempDS = 0.0;

// Soil
double g_soilMoist = 0.0;
double g_soilEC = 0.0;
double g_soilpH = 0.0;


// ============================================================
// RAW NPK
// ============================================================

double g_N_raw = 0.0;
double g_P_raw = 0.0;
double g_K_raw = 0.0;


// ============================================================
// MOISTURE CORRECTED
// ============================================================

double g_N_corrected = 0.0;
double g_P_corrected = 0.0;
double g_K_corrected = 0.0;


// ============================================================
// FRG-2024 CALIBRATED
//
// N  = %
// P  = ug/g
// K  = meq/100g
// ============================================================

double g_N_FRG = 0.0;
double g_P_FRG = 0.0;
double g_K_FRG = 0.0;


// ============================================================
// FRG CLASS
// ============================================================

String g_N_class = "Unknown";
String g_P_class = "Unknown";
String g_K_class = "Unknown";


// ============================================================
// CALIBRATION STATUS
// ============================================================

String g_N_calStatus = "NO DATA";
String g_P_calStatus = "NO DATA";
String g_K_calStatus = "NO DATA";


// ============================================================
// MODBUS REQUEST FRAME
// ============================================================

const byte soil7in1Frame[] = {
  0x01,
  0x03,
  0x00,
  0x00,
  0x00,
  0x07,
  0x04,
  0x08
};


// ============================================================
// MOISTURE COMPENSATION
//
// Same-soil water-addition experiment.
//
// Compensation starts at 15%.
// Reference moisture = 18.3%
//
// IMPORTANT:
// This is a provisional moisture-response compensation model.
// ============================================================

const double MIN_COMPENSATION_MOISTURE = 15.0;
const double REFERENCE_MOISTURE = 18.3;


// ============================================================
// N MOISTURE RESPONSE
// N = a*M^2 + b*M + c
// ============================================================

const double N_RESP_A = -0.000691527765;
const double N_RESP_B =  0.146338244;
const double N_RESP_C = -1.79337842;


// ============================================================
// P MOISTURE RESPONSE
// ============================================================

const double P_RESP_A = -0.00102264518;
const double P_RESP_B =  0.211021175;
const double P_RESP_C = -2.61260337;


// ============================================================
// K MOISTURE RESPONSE
// ============================================================

const double K_RESP_A = -0.00230569861;
const double K_RESP_B =  0.477836689;
const double K_RESP_C = -5.78436745;


// ============================================================
// LAB CALIBRATION
//
// N:
// We use the positive linear laboratory relationship.
// This avoids the negative output produced by the previous
// quadratic model.
//
// P and K:
// Keep the current empirical quadratic calibration until
// a stronger redesign is performed.
// ============================================================


// ============================================================
// N CALIBRATION
//
// N_FRG (%) = -0.00789014 + 0.34936524*N_corrected
//
// N cannot be negative.
// ============================================================

const double N_CAL_SLOPE = 0.3493652441;
const double N_CAL_INTERCEPT = -0.0078901403;


// ============================================================
// P CALIBRATION
//
// Olsen-P laboratory reference.
//
// P_FRG = a*P_corrected^2
//       + b*P_corrected
//       + c
// ============================================================

const double P_CAL_A = -225.53576999;
const double P_CAL_B =  442.08742852;
const double P_CAL_C =  -70.57326791;


// ============================================================
// K CALIBRATION
//
// K_FRG = a*K_corrected^2
//       + b*K_corrected
//       + c
// ============================================================

const double K_CAL_A = -0.31084916;
const double K_CAL_B =  2.02966568;
const double K_CAL_C = -1.83074928;


// ============================================================
// FRG-2024 APPENDIX-8 LIMITS
// ============================================================


// ---------------- N (%) ----------------

const double N_VERY_LOW_LIMIT = 0.090;
const double N_LOW_LIMIT      = 0.180;
const double N_MEDIUM_LIMIT   = 0.270;
const double N_OPTIMUM_LIMIT  = 0.360;
const double N_HIGH_LIMIT     = 0.450;


// ---------------- P (ug/g) ----------------

const double P_VERY_LOW_LIMIT = 9.0;
const double P_LOW_LIMIT      = 18.0;
const double P_MEDIUM_LIMIT   = 27.0;
const double P_OPTIMUM_LIMIT  = 36.0;
const double P_HIGH_LIMIT     = 45.0;


// ---------------- K (meq/100g) ----------------

const double K_VERY_LOW_LIMIT = 0.090;
const double K_LOW_LIMIT      = 0.180;
const double K_MEDIUM_LIMIT   = 0.270;
const double K_OPTIMUM_LIMIT  = 0.360;
const double K_HIGH_LIMIT     = 0.450;


// ============================================================
// QUADRATIC FUNCTION
// ============================================================

double quadratic(
  double x,
  double a,
  double b,
  double c
)
{
  return (
    a * x * x +
    b * x +
    c
  );
}


// ============================================================
// MOISTURE COMPENSATION
// ============================================================

double compensateMoisture(
  double rawValue,
  double moisture,
  double a,
  double b,
  double c
)
{
  if (
    isnan(rawValue) ||
    isnan(moisture)
  )
  {
    return 0.0;
  }


  // ----------------------------------------------------------
  // Below 15%:
  // use raw value
  // ----------------------------------------------------------

  if (
    moisture < MIN_COMPENSATION_MOISTURE
  )
  {
    return rawValue;
  }


  double currentResponse =
    quadratic(
      moisture,
      a,
      b,
      c
    );


  double referenceResponse =
    quadratic(
      REFERENCE_MOISTURE,
      a,
      b,
      c
    );


  // ----------------------------------------------------------
  // Safety
  // ----------------------------------------------------------

  if (
    fabs(currentResponse) < 0.000001
  )
  {
    return rawValue;
  }


  // ----------------------------------------------------------
  // Normalize to reference moisture
  // ----------------------------------------------------------

  double corrected =
    rawValue *
    (
      referenceResponse /
      currentResponse
    );


  if (
    corrected < 0.0
  )
  {
    corrected = 0.0;
  }


  return corrected;
}


// ============================================================
// APPLY MOISTURE CORRECTION
// ============================================================

void calculateMoistureCorrected()
{

  if (!npkSensorValid)
  {
    g_N_corrected = 0.0;
    g_P_corrected = 0.0;
    g_K_corrected = 0.0;

    return;
  }


  g_N_corrected =
    compensateMoisture(
      g_N_raw,
      g_soilMoist,
      N_RESP_A,
      N_RESP_B,
      N_RESP_C
    );


  g_P_corrected =
    compensateMoisture(
      g_P_raw,
      g_soilMoist,
      P_RESP_A,
      P_RESP_B,
      P_RESP_C
    );


  g_K_corrected =
    compensateMoisture(
      g_K_raw,
      g_soilMoist,
      K_RESP_A,
      K_RESP_B,
      K_RESP_C
    );
}


// ============================================================
// N LAB CALIBRATION
//
// NEW:
//
// Positive linear model.
//
// No negative output allowed.
// No artificial upper clipping.
// ============================================================

double calibrateN()
{

  if (!npkSensorValid)
  {
    g_N_calStatus =
      "NO SENSOR DATA";

    return 0.0;
  }


  double value =
    N_CAL_INTERCEPT +
    N_CAL_SLOPE *
    g_N_corrected;


  // ----------------------------------------------------------
  // N cannot physically be negative
  // ----------------------------------------------------------

  if (
    value < 0.0
  )
  {
    value = 0.0;
  }


  // ----------------------------------------------------------
  // Status only
  // Do NOT reject the value.
  // ----------------------------------------------------------

  if (
    g_N_corrected < 0.275
  )
  {
    g_N_calStatus =
      "BELOW CAL RANGE";
  }

  else if (
    g_N_corrected > 0.543
  )
  {
    g_N_calStatus =
      "ABOVE CAL RANGE";
  }

  else
  {
    g_N_calStatus =
      "OK";
  }


  return value;
}


// ============================================================
// P LAB CALIBRATION
// ============================================================

double calibrateP()
{

  if (!npkSensorValid)
  {
    g_P_calStatus =
      "NO SENSOR DATA";

    return 0.0;
  }


  double value =
    quadratic(
      g_P_corrected,
      P_CAL_A,
      P_CAL_B,
      P_CAL_C
    );


  // ----------------------------------------------------------
  // Prevent negative P only
  // ----------------------------------------------------------

  if (
    value < 0.0
  )
  {
    value = 0.0;
  }


  // ----------------------------------------------------------
  // Status only
  // ----------------------------------------------------------

  if (
    g_P_corrected < 0.210
  )
  {
    g_P_calStatus =
      "BELOW CAL RANGE";
  }

  else if (
    g_P_corrected > 0.765
  )
  {
    g_P_calStatus =
      "ABOVE CAL RANGE";
  }

  else
  {
    g_P_calStatus =
      "OK";
  }


  return value;
}


// ============================================================
// K LAB CALIBRATION
// ============================================================

double calibrateK()
{

  if (!npkSensorValid)
  {
    g_K_calStatus =
      "NO SENSOR DATA";

    return 0.0;
  }


  double value =
    quadratic(
      g_K_corrected,
      K_CAL_A,
      K_CAL_B,
      K_CAL_C
    );


  // ----------------------------------------------------------
  // Prevent negative K only
  // ----------------------------------------------------------

  if (
    value < 0.0
  )
  {
    value = 0.0;
  }


  // ----------------------------------------------------------
  // Status only
  // ----------------------------------------------------------

  if (
    g_K_corrected < 1.20
  )
  {
    g_K_calStatus =
      "BELOW CAL RANGE";
  }

  else if (
    g_K_corrected > 2.80
  )
  {
    g_K_calStatus =
      "ABOVE CAL RANGE";
  }

  else
  {
    g_K_calStatus =
      "OK";
  }


  return value;
}


// ============================================================
// APPLY FRG CALIBRATION
// ============================================================

void calculateFRG()
{

  g_N_FRG =
    calibrateN();


  g_P_FRG =
    calibrateP();


  g_K_FRG =
    calibrateK();
}


// ============================================================
// N CLASSIFICATION
// ============================================================

String classifyN(
  double value
)
{

  if (!npkSensorValid)
  {
    return "No Data";
  }


  if (
    value <= N_VERY_LOW_LIMIT
  )
  {
    return "Very Low";
  }


  if (
    value <= N_LOW_LIMIT
  )
  {
    return "Low";
  }


  if (
    value <= N_MEDIUM_LIMIT
  )
  {
    return "Medium";
  }


  if (
    value <= N_OPTIMUM_LIMIT
  )
  {
    return "Optimum";
  }


  if (
    value <= N_HIGH_LIMIT
  )
  {
    return "High";
  }


  return "Very High";
}


// ============================================================
// P CLASSIFICATION
// ============================================================

String classifyP(
  double value
)
{

  if (!npkSensorValid)
  {
    return "No Data";
  }


  if (
    value <= P_VERY_LOW_LIMIT
  )
  {
    return "Very Low";
  }


  if (
    value <= P_LOW_LIMIT
  )
  {
    return "Low";
  }


  if (
    value <= P_MEDIUM_LIMIT
  )
  {
    return "Medium";
  }


  if (
    value <= P_OPTIMUM_LIMIT
  )
  {
    return "Optimum";
  }


  if (
    value <= P_HIGH_LIMIT
  )
  {
    return "High";
  }


  return "Very High";
}


// ============================================================
// K CLASSIFICATION
//
// CORRECT FRG-2024 LIMITS FROM YOUR SCREENSHOT
// ============================================================

String classifyK(
  double value
)
{

  if (!npkSensorValid)
  {
    return "No Data";
  }


  if (
    value <= K_VERY_LOW_LIMIT
  )
  {
    return "Very Low";
  }


  if (
    value <= K_LOW_LIMIT
  )
  {
    return "Low";
  }


  if (
    value <= K_MEDIUM_LIMIT
  )
  {
    return "Medium";
  }


  if (
    value <= K_OPTIMUM_LIMIT
  )
  {
    return "Optimum";
  }


  if (
    value <= K_HIGH_LIMIT
  )
  {
    return "High";
  }


  return "Very High";
}


// ============================================================
// UPDATE CLASSES
// ============================================================

void updateClasses()
{

  g_N_class =
    classifyN(
      g_N_FRG
    );


  g_P_class =
    classifyP(
      g_P_FRG
    );


  g_K_class =
    classifyK(
      g_K_FRG
    );
}


// ============================================================
// MODBUS CRC16
// ============================================================

uint16_t modbusCRC(
  const byte *buffer,
  int length
)
{
  uint16_t crc = 0xFFFF;


  for (
    int pos = 0;
    pos < length;
    pos++
  )
  {

    crc ^= buffer[pos];


    for (
      int i = 0;
      i < 8;
      i++
    )
    {

      if (
        crc & 0x0001
      )
      {
        crc >>= 1;

        crc ^= 0xA001;
      }

      else
      {
        crc >>= 1;
      }
    }
  }


  return crc;
}


// ============================================================
// VALIDATE MODBUS RESPONSE
// ============================================================

bool validateModbusResponse(
  byte *response
)
{

  // ----------------------------------------------------------
  // Slave address
  // ----------------------------------------------------------

  if (
    response[0] != 0x01
  )
  {
    return false;
  }


  // ----------------------------------------------------------
  // Function code
  // ----------------------------------------------------------

  if (
    response[1] != 0x03
  )
  {
    return false;
  }


  // ----------------------------------------------------------
  // 7 registers = 14 data bytes
  // ----------------------------------------------------------

  if (
    response[2] != 0x0E
  )
  {
    return false;
  }


  // ----------------------------------------------------------
  // CRC
  // ----------------------------------------------------------

  uint16_t calculatedCRC =
    modbusCRC(
      response,
      17
    );


  uint16_t receivedCRC =
    (
      (uint16_t)response[18] << 8
    )
    |
    response[17];


  if (
    calculatedCRC != receivedCRC
  )
  {
    return false;
  }


  return true;
}


// ============================================================
// ZERO ALL NPK SENSOR VALUES
// ============================================================

void resetNPKSensorValues()
{

  npkSensorValid = false;


  g_soilMoist = 0.0;
  g_soilTempNPK = 0.0;
  g_soilEC = 0.0;
  g_soilpH = 0.0;

  g_N_raw = 0.0;
  g_P_raw = 0.0;
  g_K_raw = 0.0;

  g_N_corrected = 0.0;
  g_P_corrected = 0.0;
  g_K_corrected = 0.0;

  g_N_FRG = 0.0;
  g_P_FRG = 0.0;
  g_K_FRG = 0.0;

  g_N_class = "No Data";
  g_P_class = "No Data";
  g_K_class = "No Data";

  g_N_calStatus = "NO SENSOR DATA";
  g_P_calStatus = "NO SENSOR DATA";
  g_K_calStatus = "NO SENSOR DATA";
}


// ============================================================
// 7-IN-1 SENSOR READER
// ============================================================

bool read7in1Sensor()
{

  byte response[19];


  // ----------------------------------------------------------
  // Clear receive buffer
  // ----------------------------------------------------------

  while (
    Serial2.available()
  )
  {
    Serial2.read();
  }


  // ----------------------------------------------------------
  // Send mode
  // ----------------------------------------------------------

  digitalWrite(
    RE_DE_PIN,
    HIGH
  );


  delay(10);


  Serial2.write(
    soil7in1Frame,
    sizeof(
      soil7in1Frame
    )
  );


  Serial2.flush();


  // ----------------------------------------------------------
  // Receive mode
  // ----------------------------------------------------------

  digitalWrite(
    RE_DE_PIN,
    LOW
  );


  // ----------------------------------------------------------
  // Wait for response
  // ----------------------------------------------------------

  unsigned long startTime =
    millis();


  while (
    Serial2.available() < 19 &&
    millis() - startTime < 500
  )
  {
    delay(5);
  }


  // ----------------------------------------------------------
  // No complete frame
  // ----------------------------------------------------------

  if (
    Serial2.available() < 19
  )
  {

    while (
      Serial2.available()
    )
    {
      Serial2.read();
    }


    resetNPKSensorValues();

    return false;
  }


  // ----------------------------------------------------------
  // Read frame
  // ----------------------------------------------------------

  for (
    int i = 0;
    i < 19;
    i++
  )
  {
    response[i] =
      Serial2.read();
  }


  // ----------------------------------------------------------
  // Validate
  // ----------------------------------------------------------

  if (
    !validateModbusResponse(
      response
    )
  )
  {

    resetNPKSensorValues();

    return false;
  }


  // ==========================================================
  // VALID SENSOR RESPONSE
  // ==========================================================

  npkSensorValid = true;


  // ----------------------------------------------------------
  // Moisture
  // ----------------------------------------------------------

  g_soilMoist =
    (
      (response[3] << 8) |
      response[4]
    ) / 10.0;


  // ----------------------------------------------------------
  // Soil temperature
  // ----------------------------------------------------------

  g_soilTempNPK =
    (
      (response[5] << 8) |
      response[6]
    ) / 10.0;


  // ----------------------------------------------------------
  // EC
  //
  // Preserve your current sensor-side conversion.
  // ----------------------------------------------------------

  double rawEC =
    (
      (response[7] << 8) |
      response[8]
    ) / 10.0;


  g_soilEC =
    rawEC * 0.5;


  // ----------------------------------------------------------
  // pH
  // ----------------------------------------------------------

  g_soilpH =
    (
      (response[9] << 8) |
      response[10]
    ) / 10.0;


  // ----------------------------------------------------------
  // N
  // ----------------------------------------------------------

  g_N_raw =
    (
      (response[11] << 8) |
      response[12]
    ) / 10.0;


  // ----------------------------------------------------------
  // P
  // ----------------------------------------------------------

  g_P_raw =
    (
      (response[13] << 8) |
      response[14]
    ) / 10.0;


  // ----------------------------------------------------------
  // K
  // ----------------------------------------------------------

  g_K_raw =
    (
      (response[15] << 8) |
      response[16]
    ) / 10.0;


  return true;
}


// ============================================================
// SETUP
// ============================================================

// ============================================================
// WI-FI MAINTENANCE
// ============================================================

void maintainWiFi()
{
  if (WiFi.status() == WL_CONNECTED)
  {
    wifiConnecting = false;

    if (!wifiPreviouslyConnected)
    {
      Serial.println("Wi-Fi connected successfully!");
      Serial.print("ESP32 IP address: ");
      Serial.println(WiFi.localIP());
    }

    wifiPreviouslyConnected = true;
    return;
  }

  wifiPreviouslyConnected = false;

  // While a connection attempt is in progress, wait for it to finish.
  // Do not repeatedly call WiFi.reconnect() during this period.
  if (wifiConnecting)
  {
    if (millis() - wifiAttemptStarted < WIFI_CONNECT_TIMEOUT)
    {
      return;
    }

    Serial.println("Wi-Fi connection timed out; will retry shortly.");
    wifiConnecting = false;
    lastWiFiReconnectAttempt = millis();
    WiFi.disconnect(false);
    return;
  }

  // Start a new attempt only after the retry interval has elapsed.
  if (millis() - lastWiFiReconnectAttempt >= WIFI_RECONNECT_INTERVAL)
  {
    lastWiFiReconnectAttempt = millis();
    wifiAttemptStarted = millis();
    wifiConnecting = true;

    Serial.println("Retrying Wi-Fi connection to hotspot...");
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  }
}


// ============================================================
// UPLOAD LATEST VALID SENSOR READING TO RENDER
// ============================================================

void sendReadingToCloud()
{
  if (millis() - lastCloudUploadTime < CLOUD_UPLOAD_INTERVAL)
  {
    return;
  }

  // Avoid uploading fabricated zero values when the 7-in-1 sensor
  // has not produced a valid Modbus response.
  if (!npkSensorValid)
  {
    Serial.println("Cloud upload skipped: no valid NPK/7-in-1 reading.");
    lastCloudUploadTime = millis();
    return;
  }

  if (WiFi.status() != WL_CONNECTED)
  {
    Serial.println("Cloud upload skipped: Wi-Fi is not connected.");
    lastCloudUploadTime = millis();
    return;
  }

  // PROTOTYPE ONLY: setInsecure disables server-certificate verification.
  // Replace with the correct root CA certificate before production use.
  cloudClient.setInsecure();

  HTTPClient http;
  http.setTimeout(8000);

  if (!http.begin(cloudClient, API_URL))
  {
    Serial.println("Cloud upload error: could not initialize HTTPS.");
    lastCloudUploadTime = millis();
    return;
  }

  http.addHeader("Content-Type", "application/json");

  // These keys match the FastAPI readings payload used by the dashboard.
  // soil_temp is sourced from the DS18B20, as requested.
  // NPK values use the existing sketch's current calibration outputs.
  String json = "{";
  json += "\"air_temp\":" + String(g_airTemp, 2) + ",";
  json += "\"air_hum\":" + String(g_airHum, 2) + ",";
  json += "\"soil_temp\":" + String(g_soilTempDS, 2) + ",";
  json += "\"moisture\":" + String(g_soilMoist, 2) + ",";
  json += "\"ec\":" + String(g_soilEC, 2) + ",";
  json += "\"ph\":" + String(g_soilpH, 2) + ",";
  json += "\"n_raw\":" + String(g_N_raw, 3) + ",";
  json += "\"p_raw\":" + String(g_P_raw, 3) + ",";
  json += "\"k_raw\":" + String(g_K_raw, 3) + ",";
  json += "\"n_corrected\":" + String(g_N_corrected, 3) + ",";
  json += "\"p_corrected\":" + String(g_P_corrected, 3) + ",";
  json += "\"k_corrected\":" + String(g_K_corrected, 3) + ",";
  json += "\"n_frg\":" + String(g_N_FRG, 5) + ",";
  json += "\"p_frg\":" + String(g_P_FRG, 3) + ",";
  json += "\"k_frg\":" + String(g_K_FRG, 4);
  json += "}";

  Serial.println("Uploading sensor data to Render...");
  Serial.println(json);

  int httpCode = http.POST(json);
  String response = http.getString();

  Serial.print("Cloud HTTP status: ");
  Serial.println(httpCode);
  Serial.print("Cloud response: ");
  Serial.println(response);
  if (httpCode < 0)
  {
    Serial.print("HTTPS/network error: ");
    Serial.println(http.errorToString(httpCode));
  }

  if (httpCode >= 200 && httpCode < 300)
  {
    Serial.println("Cloud upload successful.");
  }
  else
  {
    Serial.println("Cloud upload failed; check API response and Render logs.");
  }

  http.end();
  lastCloudUploadTime = millis();
}


void setup()
{

  Serial.begin(
    115200
  );


  // Start Wi-Fi without blocking local sensor/LCD/SD functions.
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  lastWiFiReconnectAttempt = millis();
  wifiAttemptStarted = millis();
  wifiConnecting = true;
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.println("Starting Wi-Fi connection to mobile hotspot...");
  Serial.println("Use a 2.4 GHz hotspot and check the SSID/password placeholders.");


  // ----------------------------------------------------------
  // RS485
  // ----------------------------------------------------------

  Serial2.begin(
    9600,
    SERIAL_8N1,
    RX_PIN,
    TX_PIN
  );


  pinMode(
    RE_DE_PIN,
    OUTPUT
  );


  digitalWrite(
    RE_DE_PIN,
    LOW
  );


  // ----------------------------------------------------------
  // I2C
  // ----------------------------------------------------------

  Wire.begin(
    21,
    22
  );


  // ----------------------------------------------------------
  // DHT22
  // ----------------------------------------------------------

  dht.begin();


  // ----------------------------------------------------------
  // DS18B20
  // ----------------------------------------------------------

  ds18b20.begin();


  // ----------------------------------------------------------
  // LCD
  // ----------------------------------------------------------

  lcd.init();

  lcd.backlight();

  lcd.clear();

  lcd.setCursor(
    0,
    0
  );

  lcd.print(
    "Smart Farming"
  );

  lcd.setCursor(
    0,
    1
  );

  lcd.print(
    "Starting..."
  );


  // ----------------------------------------------------------
  // RTC
  // ----------------------------------------------------------

  if (
    !rtc.begin()
  )
  {

    Serial.println(
      "ERROR: DS3231 not found!"
    );
  }

  else if (
    rtc.lostPower()
  )
  {

    rtc.adjust(
      DateTime(
        F(__DATE__),
        F(__TIME__)
      )
    );
  }


  // ----------------------------------------------------------
  // SD
  // ----------------------------------------------------------

  if (
    !SD.begin(
      SD_CS_PIN
    )
  )
  {
    sdCardReady = false;
    Serial.println(
      "ERROR: SD Card initialization failed! Check card, format, power, CS pin and wiring."
    );
  }

  else
  {
    sdCardReady = false; // Set true only after the log file opens successfully.

    int fileIndex = 1;


    while (true)
    {

      snprintf(
        logFileName,
        sizeof(
          logFileName
        ),
        "/log_%d.csv",
        fileIndex
      );


      if (
        !SD.exists(
          logFileName
        )
      )
      {
        break;
      }


      fileIndex++;
    }


    File dataFile =
      SD.open(
        logFileName,
        FILE_WRITE
      );


    if (
      dataFile
    )
    {

      dataFile.println(
        "Date,Time,"
        "Air_Temp_C,"
        "Air_Hum_pct,"
        "Soil_Temp_NPK_C,"
        "Soil_Temp_DS18B20_C,"
        "Soil_Moist_pct,"
        "Soil_EC_ppm,"
        "Soil_pH,"
        "N_raw_ppm,"
        "P_raw_ppm,"
        "K_raw_ppm,"
        "N_corrected_ppm,"
        "P_corrected_ppm,"
        "K_corrected_ppm,"
        "N_FRG_pct,"
        "P_FRG_ug_g,"
        "K_FRG_meq_100g,"
        "N_Class,"
        "P_Class,"
        "K_Class,"
        "N_Cal_Status,"
        "P_Cal_Status,"
        "K_Cal_Status,"
        "NPK_Sensor_Status"
      );


      dataFile.close();
      sdCardReady = true;

      Serial.print(
        "New File Created: "
      );

      Serial.println(
        logFileName
      );
    }
    else
    {
      sdCardReady = false;
      Serial.println("ERROR: Could not create/open SD log file. SD logging disabled.");
    }
  }


  delay(1500);

  lcd.clear();


  Serial.println();

  Serial.println(
    "=================================================="
  );

  Serial.println(
    " SMART FARMING SENSOR SYSTEM"
  );

  Serial.println(
    " MOISTURE + SRDI CALIBRATION"
  );

  Serial.println(
    " MODBUS CRC VALIDATION ENABLED"
  );

  Serial.println(
    "=================================================="
  );


  Serial.println();

  Serial.println(
    "NPK sensor supply supported by sensor:"
  );

  Serial.println(
    "5V - 30V"
  );

  Serial.println();

  Serial.println(
    "No valid Modbus response ->"
  );

  Serial.println(
    "NPK soil values = 0"
  );

  Serial.println();

  Serial.println(
    "=================================================="
  );
}


// ============================================================
// MAIN LOOP
// ============================================================

void loop()
{

  maintainWiFi();

  DateTime now =
    rtc.now();


  // ==========================================================
  // SENSOR READ
  // ==========================================================

  if (
    lastSensorReadTime == 0 ||
    millis() -
    lastSensorReadTime >=
    SENSOR_INTERVAL
  )
  {

    lastSensorReadTime =
      millis();


    // --------------------------------------------------------
    // Air sensor
    // --------------------------------------------------------

    double airTemp =
      dht.readTemperature();

    double airHum =
      dht.readHumidity();


    if (
      !isnan(airTemp)
    )
    {
      g_airTemp =
        airTemp;
    }


    if (
      !isnan(airHum)
    )
    {
      g_airHum =
        airHum;
    }


    // --------------------------------------------------------
    // DS18B20
    // --------------------------------------------------------

    ds18b20.requestTemperatures();


    double soilTempDS =
      ds18b20.getTempCByIndex(0);


    if (
      soilTempDS !=
      DEVICE_DISCONNECTED_C
    )
    {
      g_soilTempDS =
        soilTempDS;
    }


    // --------------------------------------------------------
    // NPK
    // --------------------------------------------------------

    bool sensorOK =
      read7in1Sensor();


    // --------------------------------------------------------
    // Calibration chain
    // --------------------------------------------------------

    if (
      sensorOK
    )
    {

      // Moisture correction
      calculateMoistureCorrected();


      // Laboratory calibration
      calculateFRG();


      // FRG classification
      updateClasses();
    }

    else
    {

      // Already zeroed by reset function
      resetNPKSensorValues();
    }


    // --------------------------------------------------------
    // Serial output
    // --------------------------------------------------------

    printSerialData();

    // Upload on the configured interval; local logging remains unchanged.
    sendReadingToCloud();
  }


  // ==========================================================
  // SD LOGGING
  // ==========================================================

  if (
    millis() -
    lastLogTime >=
    LOG_INTERVAL
  )
  {

    lastLogTime =
      millis();


    if (sdCardReady)
    {
      logToSDCard(now);
    }
  }


  // ==========================================================
  // LCD
  // ==========================================================

  if (
    millis() -
    lastLCDTime >=
    LCD_INTERVAL
  )
  {

    lastLCDTime =
      millis();


    updateLCD();
  }
}


// ============================================================
// SERIAL OUTPUT
// ============================================================

void printSerialData()
{

  Serial.println();

  Serial.println(
    "================ LIVE DATA ================="
  );


  // ----------------------------------------------------------
  // Environment
  // ----------------------------------------------------------

  Serial.print(
    "Air Temp          : "
  );

  Serial.print(
    g_airTemp,
    2
  );

  Serial.println(
    " C"
  );


  Serial.print(
    "Air Humidity      : "
  );

  Serial.print(
    g_airHum,
    2
  );

  Serial.println(
    " %"
  );


  // ----------------------------------------------------------
  // Soil
  // ----------------------------------------------------------

  Serial.print(
    "Soil Temp NPK     : "
  );

  Serial.print(
    g_soilTempNPK,
    2
  );

  Serial.println(
    " C"
  );


  Serial.print(
    "Soil Temp DS18B20 : "
  );

  Serial.print(
    g_soilTempDS,
    2
  );

  Serial.println(
    " C"
  );


  Serial.print(
    "Soil Moisture     : "
  );

  Serial.print(
    g_soilMoist,
    2
  );

  Serial.println(
    " %"
  );


  Serial.print(
    "Soil EC           : "
  );

  Serial.print(
    g_soilEC,
    2
  );

  Serial.println(
    " ppm"
  );


  Serial.print(
    "Soil pH           : "
  );

  Serial.println(
    g_soilpH,
    2
  );


  // ==========================================================
  // SENSOR STATUS
  // ==========================================================

  Serial.println(
    "------------- SENSOR STATUS ---------------"
  );


  if (
    npkSensorValid
  )
  {
    Serial.println(
      "NPK Sensor        : ONLINE / VALID"
    );
  }

  else
  {
    Serial.println(
      "NPK Sensor        : OFFLINE / NO VALID FRAME"
    );
  }


  // ==========================================================
  // RAW
  // ==========================================================

  Serial.println(
    "---------------- RAW NPK ----------------"
  );


  Serial.print(
    "N raw             : "
  );

  Serial.print(
    g_N_raw,
    3
  );

  Serial.println(
    " ppm"
  );


  Serial.print(
    "P raw             : "
  );

  Serial.print(
    g_P_raw,
    3
  );

  Serial.println(
    " ppm"
  );


  Serial.print(
    "K raw             : "
  );

  Serial.print(
    g_K_raw,
    3
  );

  Serial.println(
    " ppm"
  );


  // ==========================================================
  // MOISTURE CORRECTED
  // ==========================================================

  Serial.println(
    "----------- MOISTURE CORRECTED ----------"
  );


  Serial.print(
    "N corrected       : "
  );

  Serial.print(
    g_N_corrected,
    3
  );

  Serial.println(
    " ppm"
  );


  Serial.print(
    "P corrected       : "
  );

  Serial.print(
    g_P_corrected,
    3
  );

  Serial.println(
    " ppm"
  );


  Serial.print(
    "K corrected       : "
  );

  Serial.print(
    g_K_corrected,
    3
  );

  Serial.println(
    " ppm"
  );


  // ==========================================================
  // FRG
  // ==========================================================

  Serial.println(
    "---------- FRG-2024 CALIBRATED ----------"
  );


  Serial.print(
    "N                 : "
  );

  Serial.print(
    g_N_FRG,
    4
  );

  Serial.print(
    " % ["
  );

  Serial.print(
    g_N_class
  );

  Serial.println(
    "]"
  );


  Serial.print(
    "P                 : "
  );

  Serial.print(
    g_P_FRG,
    2
  );

  Serial.print(
    " ug/g ["
  );

  Serial.print(
    g_P_class
  );

  Serial.println(
    "]"
  );


  Serial.print(
    "K                 : "
  );

  Serial.print(
    g_K_FRG,
    4
  );

  Serial.print(
    " meq/100g ["
  );

  Serial.print(
    g_K_class
  );

  Serial.println(
    "]"
  );


  // ==========================================================
  // CAL STATUS
  // ==========================================================

  Serial.println(
    "------------- CAL STATUS ----------------"
  );


  Serial.print(
    "N Calibration     : "
  );

  Serial.println(
    g_N_calStatus
  );


  Serial.print(
    "P Calibration     : "
  );

  Serial.println(
    g_P_calStatus
  );


  Serial.print(
    "K Calibration     : "
  );

  Serial.println(
    g_K_calStatus
  );


  Serial.println(
    "============================================"
  );
}


// ============================================================
// SD CARD LOGGING
// ============================================================

void logToSDCard(
  DateTime t
)
{
  if (!sdCardReady)
  {
    return;
  }

  File dataFile =
    SD.open(
      logFileName,
      FILE_APPEND
    );


  if (
    !dataFile
  )
  {
    Serial.println("ERROR: SD write failed. SD logging paused; check card and wiring.");
    sdCardReady = false;
    return;
  }


  // ----------------------------------------------------------
  // Date
  // ----------------------------------------------------------

  dataFile.print(
    t.year()
  );

  dataFile.print("-");

  dataFile.print(
    t.month()
  );

  dataFile.print("-");

  dataFile.print(
    t.day()
  );

  dataFile.print(",");


  // ----------------------------------------------------------
  // Time
  // ----------------------------------------------------------

  dataFile.print(
    t.hour()
  );

  dataFile.print(":");

  dataFile.print(
    t.minute()
  );

  dataFile.print(":");

  dataFile.print(
    t.second()
  );

  dataFile.print(",");


  // ----------------------------------------------------------
  // Environment
  // ----------------------------------------------------------

  dataFile.print(
    g_airTemp,
    3
  );

  dataFile.print(",");


  dataFile.print(
    g_airHum,
    3
  );

  dataFile.print(",");


  // ----------------------------------------------------------
  // Soil temperature
  // ----------------------------------------------------------

  dataFile.print(
    g_soilTempNPK,
    3
  );

  dataFile.print(",");


  dataFile.print(
    g_soilTempDS,
    3
  );

  dataFile.print(",");


  // ----------------------------------------------------------
  // Soil
  // ----------------------------------------------------------

  dataFile.print(
    g_soilMoist,
    3
  );

  dataFile.print(",");


  dataFile.print(
    g_soilEC,
    3
  );

  dataFile.print(",");


  dataFile.print(
    g_soilpH,
    3
  );

  dataFile.print(",");


  // ==========================================================
  // RAW NPK
  // ==========================================================

  dataFile.print(
    g_N_raw,
    3
  );

  dataFile.print(",");


  dataFile.print(
    g_P_raw,
    3
  );

  dataFile.print(",");


  dataFile.print(
    g_K_raw,
    3
  );

  dataFile.print(",");


  // ==========================================================
  // CORRECTED
  // ==========================================================

  dataFile.print(
    g_N_corrected,
    3
  );

  dataFile.print(",");


  dataFile.print(
    g_P_corrected,
    3
  );

  dataFile.print(",");


  dataFile.print(
    g_K_corrected,
    3
  );

  dataFile.print(",");


  // ==========================================================
  // FRG
  // ==========================================================

  dataFile.print(
    g_N_FRG,
    5
  );

  dataFile.print(",");


  dataFile.print(
    g_P_FRG,
    3
  );

  dataFile.print(",");


  dataFile.print(
    g_K_FRG,
    4
  );

  dataFile.print(",");


  // Classes
  dataFile.print(
    g_N_class
  );

  dataFile.print(",");


  dataFile.print(
    g_P_class
  );

  dataFile.print(",");


  dataFile.print(
    g_K_class
  );

  dataFile.print(",");


  // Calibration status
  dataFile.print(
    g_N_calStatus
  );

  dataFile.print(",");


  dataFile.print(
    g_P_calStatus
  );

  dataFile.print(",");


  dataFile.print(
    g_K_calStatus
  );

  dataFile.print(",");


  // Sensor status
  if (
    npkSensorValid
  )
  {
    dataFile.println(
      "VALID"
    );
  }
  else
  {
    dataFile.println(
      "NO_VALID_RESPONSE"
    );
  }


  dataFile.close();
}


// ============================================================
// LCD
// ============================================================

void updateLCD()
{

  lcd.clear();


  // ==========================================================
  // PAGE 0
  // MOISTURE + pH
  // ==========================================================

  if (
    lcdPage == 0
  )
  {

    lcd.setCursor(
      0,
      0
    );

    lcd.print(
      "M:"
    );

    lcd.print(
      g_soilMoist,
      1
    );

    lcd.print(
      "%"
    );


    lcd.setCursor(
      0,
      1
    );

    lcd.print(
      "pH:"
    );

    lcd.print(
      g_soilpH,
      2
    );


    lcdPage = 1;
  }


  // ==========================================================
  // PAGE 1 - N
  // ==========================================================

  else if (
    lcdPage == 1
  )
  {

    lcd.setCursor(
      0,
      0
    );

    lcd.print(
      "N:"
    );

    lcd.print(
      g_N_FRG,
      3
    );

    lcd.print(
      "%"
    );


    lcd.setCursor(
      0,
      1
    );

    lcd.print(
      g_N_class
    );


    lcdPage = 2;
  }


  // ==========================================================
  // PAGE 2 - P
  // ==========================================================

  else if (
    lcdPage == 2
  )
  {

    lcd.setCursor(
      0,
      0
    );

    lcd.print(
      "P:"
    );

    lcd.print(
      g_P_FRG,
      1
    );


    lcd.setCursor(
      0,
      1
    );

    lcd.print(
      g_P_class
    );


    lcdPage = 3;
  }


  // ==========================================================
  // PAGE 3 - K
  // ==========================================================

  else if (
    lcdPage == 3
  )
  {

    lcd.setCursor(
      0,
      0
    );

    lcd.print(
      "K:"
    );

    lcd.print(
      g_K_FRG,
      2
    );


    lcd.setCursor(
      0,
      1
    );

    lcd.print(
      g_K_class
    );


    lcdPage = 4;
  }


  // ==========================================================
  // PAGE 4 - SENSOR STATUS
  // ==========================================================

  else if (
    lcdPage == 4
  )
  {

    lcd.setCursor(
      0,
      0
    );

    lcd.print(
      "NPK:"
    );


    if (
      npkSensorValid
    )
    {
      lcd.print(
        "ONLINE"
      );
    }
    else
    {
      lcd.print(
        "OFF"
      );
    }


    lcd.setCursor(
      0,
      1
    );

    lcd.print(
      "CRC: "
    );


    if (
      npkSensorValid
    )
    {
      lcd.print(
        "OK"
      );
    }
    else
    {
      lcd.print(
        "NO DATA"
      );
    }


    lcdPage = 5;
  }


  // ==========================================================
  // PAGE 5 - AIR
  // ==========================================================

  else if (
    lcdPage == 5
  )
  {

    lcd.setCursor(
      0,
      0
    );

    lcd.print(
      "AT:"
    );

    lcd.print(
      g_airTemp,
      1
    );

    lcd.print(
      "C"
    );


    lcd.setCursor(
      0,
      1
    );

    lcd.print(
      "AH:"
    );

    lcd.print(
      g_airHum,
      1
    );

    lcd.print(
      "%"
    );


    lcdPage = 0;
  }
}