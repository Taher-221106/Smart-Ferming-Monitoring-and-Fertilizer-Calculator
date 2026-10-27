from __future__ import annotations

import math
import json
import os
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
# Set SMART_FARMING_DATA_DIR=/var/data on Render when a persistent disk is mounted.
# Local development defaults to the project's data/ directory.
DATA_DIR = Path(os.environ.get("SMART_FARMING_DATA_DIR", str(BASE_DIR / "data")))
DB_PATH = DATA_DIR / "smart_farming.db"

DATA_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Smart Farming Platform", version="2.0.0")
app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    conn = db()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS sensor_readings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            air_temp REAL NOT NULL,
            air_hum REAL NOT NULL,
            soil_temp REAL NOT NULL,
            moisture REAL NOT NULL,
            ec REAL NOT NULL,
            ph REAL NOT NULL,
            n_raw REAL NOT NULL,
            p_raw REAL NOT NULL,
            k_raw REAL NOT NULL,
            n_corrected REAL NOT NULL,
            p_corrected REAL NOT NULL,
            k_corrected REAL NOT NULL,
            n_frg REAL NOT NULL,
            p_frg REAL NOT NULL,
            k_frg REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS fields (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            length_m REAL NOT NULL,
            width_m REAL NOT NULL,
            spacing_m REAL NOT NULL,
            crop TEXT,
            variety TEXT,
            season TEXT,
            yield_goal TEXT,
            rhizobium_used INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS samples (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            field_id INTEGER NOT NULL,
            point_no INTEGER NOT NULL,
            x_m REAL NOT NULL,
            y_m REAL NOT NULL,
            moisture REAL NOT NULL,
            ec REAL NOT NULL,
            ph REAL NOT NULL,
            n_raw REAL NOT NULL,
            p_raw REAL NOT NULL,
            k_raw REAL NOT NULL,
            n_frg REAL NOT NULL,
            p_frg REAL NOT NULL,
            k_frg REAL NOT NULL,
            air_temp REAL NOT NULL DEFAULT 0,
            air_hum REAL NOT NULL DEFAULT 0,
            soil_temp REAL NOT NULL DEFAULT 0,
            n_corrected REAL NOT NULL DEFAULT 0,
            p_corrected REAL NOT NULL DEFAULT 0,
            k_corrected REAL NOT NULL DEFAULT 0,
            reading_count INTEGER NOT NULL DEFAULT 1,
            first_reading_at TEXT,
            last_reading_at TEXT,
            captured_at TEXT NOT NULL,
            FOREIGN KEY(field_id) REFERENCES fields(id),
            UNIQUE(field_id, point_no)
        );

        CREATE TABLE IF NOT EXISTS analyses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            field_id INTEGER NOT NULL,
            crop TEXT NOT NULL,
            created_at TEXT NOT NULL,
            total_area_ha REAL NOT NULL,
            result_json TEXT NOT NULL,
            FOREIGN KEY(field_id) REFERENCES fields(id)
        );
        """
    )
    # Safe, additive migrations for databases created by earlier deployments.
    # Existing field/sample records are retained.
    sample_columns = {row[1] for row in conn.execute("PRAGMA table_info(samples)").fetchall()}
    migrations = {
        "air_temp": "REAL NOT NULL DEFAULT 0",
        "air_hum": "REAL NOT NULL DEFAULT 0",
        "soil_temp": "REAL NOT NULL DEFAULT 0",
        "n_corrected": "REAL NOT NULL DEFAULT 0",
        "p_corrected": "REAL NOT NULL DEFAULT 0",
        "k_corrected": "REAL NOT NULL DEFAULT 0",
        "reading_count": "INTEGER NOT NULL DEFAULT 1",
        "first_reading_at": "TEXT",
        "last_reading_at": "TEXT",
    }
    for column, definition in migrations.items():
        if column not in sample_columns:
            conn.execute(f"ALTER TABLE samples ADD COLUMN {column} {definition}")
    field_columns = {row[1] for row in conn.execute("PRAGMA table_info(fields)").fetchall()}
    if "rhizobium_used" not in field_columns:
        conn.execute("ALTER TABLE fields ADD COLUMN rhizobium_used INTEGER NOT NULL DEFAULT 0")
    conn.commit()
    conn.close()


init_db()


# FRG-2024 source tables were transcribed from the uploaded guidebook.
FRG_PROFILES = json.loads((BASE_DIR / "data" / "frg2024_crop_tables.json").read_text(encoding="utf-8"))["profiles"]
SOIL_CLASS_LABELS = ["Very Low", "Low", "Medium", "Optimum", "High", "Very High"]
N_CLASS_UPPER = [0.09, 0.18, 0.27, 0.36, 0.45]
P_CLASS_UPPER_UPLAND = [9.0, 18.0, 27.0, 36.0, 45.0]
P_CLASS_UPPER_RICE = [7.5, 15.0, 22.5, 30.0, 37.5]
K_CLASS_UPPER = [0.09, 0.18, 0.27, 0.36, 0.45]
FERTILIZER_PRODUCTS = {
    "Urea": {"label_bn": "ইউরিয়া", "nutrient": "N", "factor": 2.17},
    "TSP": {"label_bn": "টিএসপি", "nutrient": "P", "factor": 5.0},
    "MOP": {"label_bn": "এমওপি (পটাশ)", "nutrient": "K", "factor": 2.0},
}
MAP_STATUS_COLORS = {
    "Optimum": "#2f965d", "Medium": "#e8df51", "Low": "#ef9e42",
    "Very Low": "#d93d38", "High": "#9ba7a0", "Very High": "#737f78",
}


def resolve_profile(crop: str, variety: str = "", season: str = "") -> dict[str, Any] | None:
    """Resolve an internal profile|cultivar token or a legacy cultivar value."""
    if variety and "|" in variety:
        profile_key, cultivar = variety.split("|", 1)
        profile = FRG_PROFILES.get(profile_key)
        if profile and profile["crop"] == crop and profile["season"] == season and cultivar in profile["varieties"]:
            return profile
        return None
    candidates = [p for p in FRG_PROFILES.values() if p["crop"] == crop and (not season or p["season"] == season)]
    cultivar = variety.split("|", 1)[-1] if variety else ""
    if cultivar:
        for profile in candidates:
            if cultivar in profile["varieties"]:
                return profile
        return None
    if crop == "Wheat": return FRG_PROFILES["wheat_45"]
    if crop == "Lentil": return FRG_PROFILES["lentil_18"]
    if crop == "Rice":
        return {"Boro": FRG_PROFILES["rice_boro_60"], "Aus": FRG_PROFILES["rice_aus_50"], "Aman": FRG_PROFILES["rice_taman_50"]}.get(season)
    if crop == "Onion":
        return FRG_PROFILES["summer_onion_12"] if season == "Summer" else FRG_PROFILES["onion_20"]
    return None


def _soil_class(value: float, upper_bounds: list[float]) -> str:
    v = max(0.0, float(value))
    for idx, upper in enumerate(upper_bounds):
        if v <= upper:
            return SOIL_CLASS_LABELS[idx]
    return "Very High"


def soil_classes(n: float, p: float, k: float, crop: str = "") -> dict[str, str]:
    p_bounds = P_CLASS_UPPER_RICE if crop == "Rice" else P_CLASS_UPPER_UPLAND
    return {"N": _soil_class(n, N_CLASS_UPPER), "P": _soil_class(p, p_bounds), "K": _soil_class(k, K_CLASS_UPPER)}


def critical_limit_response(n: float, p: float, k: float, crop: str) -> dict[str, Any]:
    # FRG-2024 Table 2 and Fig. 1, printed pp.11-12. The guide reports general
    # no-fertilizer response bands, not a guaranteed field-specific yield model.
    p_critical = 10.0 if crop == "Rice" else 12.0  # wetland rice / upland, Appendix-8
    ratios = {"N": float(n) / 0.12 * 100, "P": float(p) / p_critical * 100, "K": float(k) / 0.12 * 100}
    limiting = min(ratios, key=ratios.get)
    pct = ratios[limiting]
    if pct <= 75: cls, response = "Very Low", [25.0, 50.0]
    elif pct <= 150: cls, response = "Low", [50.0, 75.0]
    elif pct <= 225: cls, response = "Medium", [75.0, 100.0]
    elif pct <= 300: cls, response = "Optimum", None
    elif pct <= 375: cls, response = "High", None
    else: cls, response = "Very High", None
    return {"limiting_nutrient": limiting, "critical_limit_percent": pct, "response_class": cls, "unfertilized_yield_percent_range": response}


def range_for_status(profile: dict[str, Any], nutrient: str, status: str) -> list[float] | None:
    # Crop tables show only Optimum, Medium, Low and Very Low rows. Do not guess
    # a distinct nutrient dose where FRG does not provide one for High / Very High.
    index = {"Optimum": 0, "Medium": 1, "Low": 2, "Very Low": 3}.get(status)
    rows = profile.get("nutrients", {}).get(nutrient)
    if index is None or rows is None: return None
    value = rows[index]
    return [0.0, 0.0] if value is None else [float(value[0]), float(value[1])]


def product_recommendation(profile: dict[str, Any], status: str, product_key: str) -> dict[str, Any]:
    product = FERTILIZER_PRODUCTS[product_key]
    nutrient_range = range_for_status(profile, product["nutrient"], status)
    if nutrient_range is None:
        return {"applicable": False, "status_class": status, "min_kg_ha": None, "max_kg_ha": None,
                "nutrient": product["nutrient"], "product_label_bn": product["label_bn"],
                "note_bn": "এই মাটির শ্রেণির জন্য FRG-2024 ফসলের সারণিতে আলাদা মাত্রা নেই; নিশ্চিত soil-test নিয়ে স্থানীয় কৃষি কর্মকর্তার পরামর্শ নিন।"}
    factor = float(product["factor"])
    return {"applicable": True, "status_class": status, "nutrient": product["nutrient"],
            "nutrient_min_kg_ha": nutrient_range[0], "nutrient_max_kg_ha": nutrient_range[1],
            "min_kg_ha": nutrient_range[0] * factor, "max_kg_ha": nutrient_range[1] * factor,
            "factor": factor, "product_label_bn": product["label_bn"],
            "note_bn": "FRG-2024 Appendix-10-এর nutrient-to-fertilizer conversion factor ব্যবহার করা হয়েছে।"}

def build_map_legend(profile: dict[str, Any], rhizobium_used: bool = False) -> dict[str, Any]:
    legend: dict[str, Any] = {}
    for product_key, product in FERTILIZER_PRODUCTS.items():
        entries = []
        if product_key == "Urea" and profile["crop"] == "Lentil" and rhizobium_used:
            entries.append({"status_class": "Optimum", "color": MAP_STATUS_COLORS["Optimum"],
                            "applicable": True, "min_kg_ha": 0.0, "max_kg_ha": 0.0,
                            "label_bn": product["label_bn"],
                            "note_bn": "রাইজোবিয়াম ইনোকুল্যান্ট ব্যবহার নির্বাচিত; FRG-2024 অনুযায়ী ইউরিয়া প্রয়োগ নয়।"})
        else:
            for status in ["Very Low", "Low", "Medium", "Optimum", "High", "Very High"]:
                item = product_recommendation(profile, status, product_key)
                entries.append({"status_class": status, "color": MAP_STATUS_COLORS[status],
                                "applicable": item["applicable"], "min_kg_ha": item["min_kg_ha"],
                                "max_kg_ha": item["max_kg_ha"], "label_bn": item["product_label_bn"],
                                "note_bn": item["note_bn"]})
        legend[product_key] = entries
    for nutrient, label in [("N", "নাইট্রোজেনের শ্রেণি"), ("P", "ফসফরাসের শ্রেণি"), ("K", "পটাশিয়ামের শ্রেণি")]:
        legend[f"{nutrient}_STATUS"] = [{"status_class": status, "color": MAP_STATUS_COLORS[status],
                                       "applicable": True, "label_bn": label} for status in SOIL_CLASS_LABELS]
    return legend


def build_vra_surface(field: dict[str, Any], samples: list[dict[str, Any]], profile: dict[str, Any], grid: int = 24) -> list[dict[str, Any]]:
    grid = max(8, min(50, int(grid)))
    surface: list[dict[str, Any]] = []
    for gy in range(grid):
        y = float(field["width_m"]) * (gy + 0.5) / grid
        for gx in range(grid):
            x = float(field["length_m"]) * (gx + 0.5) / grid
            n, p, k = idw(samples, x, y, "n_frg"), idw(samples, x, y, "p_frg"), idw(samples, x, y, "k_frg")
            classes = soil_classes(n or 0, p or 0, k or 0, profile["crop"])
            product_rates = {key: product_recommendation(profile, classes[FERTILIZER_PRODUCTS[key]["nutrient"]], key) for key in FERTILIZER_PRODUCTS}
            if profile["crop"] == "Lentil" and bool(field.get("rhizobium_used", 0)):
                product_rates["Urea"] = {"applicable": True, "status_class": "Optimum", "nutrient": "N", "nutrient_min_kg_ha": 0.0, "nutrient_max_kg_ha": 0.0, "min_kg_ha": 0.0, "max_kg_ha": 0.0, "product_label_bn": "ইউরিয়া", "note_bn": "রাইজোবিয়াম ইনোকুল্যান্ট ব্যবহার নির্বাচিত; FRG-2024 অনুযায়ী N সার প্রয়োগ নয়।"}
            surface.append({"x_m": round(x, 3), "y_m": round(y, 3), "N": n, "P": p, "K": k,
                            "classes": classes, "product_rates": product_rates})
    return surface


def prescription_totals(surface: list[dict[str, Any]], area_ha: float) -> dict[str, Any]:
    totals: dict[str, Any] = {}
    if not surface: return totals
    cell_area = area_ha / len(surface) if area_ha > 0 else 0.0
    for key, product in FERTILIZER_PRODUCTS.items():
        valid = [point["product_rates"][key] for point in surface if point["product_rates"][key]["applicable"]]
        valid_area = len(valid) * cell_area
        total_min = sum(float(item["min_kg_ha"]) * cell_area for item in valid)
        total_max = sum(float(item["max_kg_ha"]) * cell_area for item in valid)
        coverage = len(valid) / len(surface) * 100.0
        totals[key] = {"label_bn": product["label_bn"], "nutrient": product["nutrient"],
                       "coverage_percent": coverage, "rated_area_ha": valid_area,
                       "unrated_area_ha": max(0.0, area_ha - valid_area), "total_min_kg": total_min,
                       "total_max_kg": total_max, "area_total_complete": coverage >= 99.999,
                       "average_min_kg_ha": total_min / valid_area if valid_area else None,
                       "average_max_kg_ha": total_max / valid_area if valid_area else None}
    return totals


def build_recommendation(field: dict[str, Any], samples: list[dict[str, Any]], profile: dict[str, Any], surface: list[dict[str, Any]]) -> dict[str, Any]:
    area_ha = float(field["length_m"]) * float(field["width_m"]) / 10000.0
    # Use equal-area interpolated cells to describe the whole field surface, not
    # just an unweighted list of sample records. The sample readings remain the
    # source inputs; the output is still preliminary IDW, not lab validation.
    if surface:
        n_values = [float(point["N"]) for point in surface if point.get("N") is not None]
        p_values = [float(point["P"]) for point in surface if point.get("P") is not None]
        k_values = [float(point["K"]) for point in surface if point.get("K") is not None]
    else:
        n_values = [float(item["n_frg"]) for item in samples]
        p_values = [float(item["p_frg"]) for item in samples]
        k_values = [float(item["k_frg"]) for item in samples]
    n_avg = sum(n_values) / len(n_values)
    p_avg = sum(p_values) / len(p_values)
    k_avg = sum(k_values) / len(k_values)
    classes = soil_classes(n_avg, p_avg, k_avg, profile["crop"])
    response = critical_limit_response(n_avg, p_avg, k_avg, profile["crop"])
    goal, tolerance = float(profile["yield_goal_t_ha"]), float(profile["yield_tolerance_t_ha"])
    goal_min, goal_max = max(0.0, goal - tolerance), goal + tolerance
    yield_comparison: dict[str, Any] = {
        "yield_goal_t_ha": goal, "yield_tolerance_t_ha": tolerance,
        "after_fertilizer_min_t_ha": goal_min, "after_fertilizer_max_t_ha": goal_max,
        "after_fertilizer_min_field_kg": goal_min * area_ha * 1000,
        "after_fertilizer_max_field_kg": goal_max * area_ha * 1000,
        "before_range_available": response["unfertilized_yield_percent_range"] is not None,
        "before_percent_range": response["unfertilized_yield_percent_range"],
        "limiting_nutrient": response["limiting_nutrient"],
        "critical_limit_percent": response["critical_limit_percent"], "response_class": response["response_class"],
    }
    if response["unfertilized_yield_percent_range"] is not None:
        low_pct, high_pct = response["unfertilized_yield_percent_range"]
        before_min, before_max = goal * low_pct / 100.0, goal * high_pct / 100.0
        yield_comparison.update({"before_fertilizer_min_t_ha": before_min, "before_fertilizer_max_t_ha": before_max,
                                 "before_fertilizer_min_field_kg": before_min * area_ha * 1000,
                                 "before_fertilizer_max_field_kg": before_max * area_ha * 1000})
    extra = []
    for nutrient, label in [("S", "সালফার (S)"), ("Mg", "ম্যাগনেসিয়াম (Mg)"), ("Zn", "জিঙ্ক (Zn)"), ("B", "বোরন (B)"), ("Mo", "মলিবডেনাম (Mo)")]:
        if nutrient in profile.get("nutrients", {}):
            extra.append({"nutrient": nutrient, "label_bn": label, "note_bn": "সংযুক্ত ESP32 সেন্সর এই nutrient সরাসরি মাপে না; laboratory soil test ছাড়া নির্দিষ্ট মাত্রা নির্বাচন করা হয়নি।"})
    official_variety = str(field.get("variety") or "").split("|", 1)[-1]
    crop_labels_bn = {"Rice": "ধান", "Wheat": "গম", "Lentil": "মসুর ডাল", "Onion": "পেঁয়াজ"}
    season_labels_bn = {"Boro": "বোরো", "Aus": "আউশ", "Aman": "আমন", "Rabi": "রবি", "Summer": "গ্রীষ্মকালীন"}
    variety_bn = cultivar_label_bn(official_variety) if "cultivar_label_bn" in globals() else official_variety
    return {
        "status": "preliminary", "rhizobium_used": bool(field.get("rhizobium_used", 0)), "crop": profile["crop"], "crop_label_bn": crop_labels_bn.get(profile["crop"], profile["crop"]),
        "variety": official_variety, "variety_bn": variety_bn,
        "season": field.get("season"), "season_label_bn": season_labels_bn.get(str(field.get("season") or ""), field.get("season")), "source_page": profile["source_page"],
        "yield_goal_display_bn": f"{goal:g} ± {tolerance:g} টন/হেক্টর", "field_area_ha": area_ha,
        "field_area_m2": area_ha * 10000, "sample_count": len(samples),
        "average_frg": {"N": n_avg, "P": p_avg, "K": k_avg}, "classes": classes,
        "limiting_response": response, "yield_comparison": yield_comparison,
        "fertilizer_totals": prescription_totals(surface, area_ha),
        "organic_fertilizer_t_ha": profile.get("organic_fertilizer_t_ha"),
        "organic_fertilizer_field_t": profile.get("organic_fertilizer_t_ha") * area_ha if profile.get("organic_fertilizer_t_ha") is not None else None,
        "extra_nutrients_not_measured": extra, "application_bn": profile.get("application_bn", []),
        "limitations_bn": [
            "এটি FRG-2024-এর সারণি ও ESP32-এর সংরক্ষিত পাঠ থেকে তৈরি প্রাথমিক হিসাব; সেন্সরের মান পরীক্ষাগারের soil-test result-এর সঙ্গে যাচাই করা হয়নি।",
            "ফসলের yield goal লক্ষ্য, নিশ্চিত yield prediction নয়। বাস্তব ফলন জানতে একই জমির harvest data, পানি, আবহাওয়া, রোগবালাই ও ব্যবস্থাপনার তথ্য প্রয়োজন।",
            "FRG-2024 crop table-এ High / Very High শ্রেণির জন্য আলাদা সারমাত্রা নেই; ওই অঞ্চলগুলো map-এ ধূসর দেখানো হয়েছে এবং মোট পরিমাণে অন্তর্ভুক্ত নয়।",
            "S, Mg, Zn, B ও Mo connected sensor-এ মাপা হয় না; laboratory soil test ছাড়া এদের নির্দিষ্ট পরিমাণ স্বয়ংক্রিয়ভাবে নির্ধারণ করা হয়নি।",
        ]}

class SensorReading(BaseModel):
    air_temp: float = 0
    air_hum: float = 0
    soil_temp: float = 0
    moisture: float = 0
    ec: float = 0
    ph: float = 0
    n_raw: float = 0
    p_raw: float = 0
    k_raw: float = 0
    n_corrected: float = 0
    p_corrected: float = 0
    k_corrected: float = 0
    n_frg: float = 0
    p_frg: float = 0
    k_frg: float = 0


class FieldCreate(BaseModel):
    name: str = Field(default="Field 1", min_length=1, max_length=100)
    length_m: float = Field(gt=0)
    width_m: float = Field(gt=0)
    spacing_m: float = Field(gt=0)
    crop: str = ""
    variety: str = ""
    season: str = ""
    yield_goal: str = ""
    rhizobium_used: bool = False


class SampleCreate(BaseModel):
    field_id: int = Field(gt=0)
    point_no: int = Field(gt=0)
    x_m: float = Field(ge=0)
    y_m: float = Field(ge=0)
    moisture: float = 0
    ec: float = 0
    ph: float = 0
    n_raw: float = 0
    p_raw: float = 0
    k_raw: float = 0
    n_frg: float = 0
    p_frg: float = 0
    k_frg: float = 0
    air_temp: float = 0
    air_hum: float = 0
    soil_temp: float = 0
    n_corrected: float = 0
    p_corrected: float = 0
    k_corrected: float = 0
    reading_count: int = Field(default=1, ge=1, le=10)
    first_reading_at: str | None = None
    last_reading_at: str | None = None


class FertilizerRequest(BaseModel):
    field_id: int = Field(gt=0)
    crop: str = Field(min_length=1)
    variety: str = ""
    season: str = ""
    yield_goal: str = ""
    rhizobium_used: bool = False


@app.get("/")
def home() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "index.html")


def cultivar_label_bn(name: str) -> str:
    """Readable Bengali cultivar text while keeping official name as metadata."""
    import re
    def bn_digits(value: str) -> str:
        return value.translate(str.maketrans("0123456789", "০১২৩৪৫৬৭৮৯"))
    if name.startswith("BRRI dhan"):
        return "বিআরআরআই ধান " + bn_digits(name.removeprefix("BRRI dhan"))
    if name.startswith("Bangabandhu dhan"):
        return "বঙ্গবন্ধু ধান " + bn_digits(name.removeprefix("Bangabandhu dhan"))
    if name.startswith("Binadhan-"):
        return "বিনাধান " + bn_digits(name.removeprefix("Binadhan-"))
    if name.startswith("BARI Gom "):
        return "বারি গম " + bn_digits(name.removeprefix("BARI Gom "))
    if name.startswith("BWMRI Gom "):
        return "বিডব্লিউএমআরআই গম " + bn_digits(name.removeprefix("BWMRI Gom "))
    if name.startswith("BARI Masur-"):
        return "বারি মসুর " + bn_digits(name.removeprefix("BARI Masur-"))
    if name.startswith("Binamasur-"):
        return "বিনামসুর " + bn_digits(name.removeprefix("Binamasur-"))
    if name.startswith("BARI Peyaz-"):
        return "বারি পেঁয়াজ " + bn_digits(name.removeprefix("BARI Peyaz-"))
    if name.startswith("BR") and name[2:].isdigit():
        return "বিআর " + bn_digits(name[2:])
    if name.startswith("BR") and name[2:].replace("RI", "").isdigit():
        return "বিআর " + bn_digits(name[2:])
    if name.startswith("Kataribhog"):
        return "কাতারিভোগ"
    if name == "Kalijira": return "কালিজিরা"
    if name == "Chinigura": return "চিনিগুঁড়া"
    return name


@app.get("/api/frg/options")
def frg_options() -> dict[str, Any]:
    labels = {"Rice": "ধান", "Wheat": "গম", "Lentil": "মসুর ডাল", "Onion": "পেঁয়াজ"}
    seasons = {"Boro": "বোরো", "Aus": "আউশ", "Aman": "আমন", "Rabi": "রবি", "Summer": "গ্রীষ্মকালীন"}
    profiles = []
    for key, profile in FRG_PROFILES.items():
        profiles.append({
            "key": key, "crop": profile["crop"], "crop_label_bn": labels[profile["crop"]],
            "season": profile["season"], "season_label_bn": seasons[profile["season"]],
            "yield_goal_t_ha": profile["yield_goal_t_ha"],
            "yield_tolerance_t_ha": profile["yield_tolerance_t_ha"],
            "source_page": profile["source_page"],
            "varieties": [{"value": f"{key}|{cultivar}", "official_name": cultivar,
                           "label_bn": cultivar_label_bn(cultivar)} for cultivar in profile["varieties"]],
        })
    return {"crops": [{"key": "Rice", "label_bn": "ধান"}, {"key": "Wheat", "label_bn": "গম"},
                       {"key": "Lentil", "label_bn": "মসুর ডাল"}, {"key": "Onion", "label_bn": "পেঁয়াজ"}],
            "profiles": profiles,
            "disclaimer_bn": "ফলন লক্ষ্য ও সারমাত্রা FRG-2024 সারণি থেকে; সেন্সরের মান পরীক্ষাগারের soil-test value-এর সঙ্গে যাচাই করা প্রয়োজন।"}


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"ok": True, "service": "smart-farming", "time": now_iso()}


@app.get("/api/live")
def live() -> dict[str, Any]:
    conn = db()
    row = conn.execute("SELECT * FROM sensor_readings ORDER BY id DESC LIMIT 1").fetchone()
    conn.close()
    if not row:
        return {"available": False}
    item = dict(row)
    item["available"] = True
    item["classes"] = soil_classes(item["n_frg"], item["p_frg"], item["k_frg"])
    return item


@app.get("/api/live/recent")
def recent_live_readings(
    after_id: int = Query(default=0, ge=0),
    limit: int = Query(default=3, ge=1, le=10),
    max_age_sec: int = Query(default=120, ge=10, le=600),
) -> dict[str, Any]:
    """Return new, recent sensor readings after a capture baseline.

    The point-capture UI uses this to collect several fresh readings only after
    the farmer starts a capture at a selected grid point, then averages them.
    """
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(seconds=max_age_sec)
    conn = db()
    rows = conn.execute(
        "SELECT * FROM sensor_readings WHERE id > ? ORDER BY id ASC LIMIT 500",
        (after_id,),
    ).fetchall()
    conn.close()

    fresh: list[dict[str, Any]] = []
    numeric_keys = (
        "air_temp", "air_hum", "soil_temp", "moisture", "ec", "ph",
        "n_raw", "p_raw", "k_raw", "n_corrected", "p_corrected",
        "k_corrected", "n_frg", "p_frg", "k_frg",
    )
    for row in rows:
        item = dict(row)
        try:
            timestamp = datetime.fromisoformat(str(item["timestamp"]).replace("Z", "+00:00"))
            if timestamp.tzinfo is None:
                timestamp = timestamp.replace(tzinfo=timezone.utc)
            timestamp = timestamp.astimezone(timezone.utc)
        except (TypeError, ValueError):
            continue
        if timestamp < cutoff or timestamp > now + timedelta(seconds=15):
            continue
        item["age_seconds"] = max(0, int((now - timestamp).total_seconds()))
        fresh.append(item)
        if len(fresh) >= limit:
            break

    result: dict[str, Any] = {
        "available": len(fresh) >= limit,
        "count": len(fresh),
        "required": limit,
        "after_id": after_id,
        "max_age_sec": max_age_sec,
        "readings": [
            {"id": r["id"], "timestamp": r["timestamp"], "age_seconds": r["age_seconds"]}
            for r in fresh
        ],
    }
    if fresh:
        result["latest_timestamp"] = fresh[-1]["timestamp"]
        result["latest_id"] = fresh[-1]["id"]
    if len(fresh) >= limit:
        result["average"] = {
            key: sum(float(row[key]) for row in fresh) / len(fresh)
            for key in numeric_keys
        }
        result["first_reading_at"] = fresh[0]["timestamp"]
        result["last_reading_at"] = fresh[-1]["timestamp"]
        result["reading_ids"] = [row["id"] for row in fresh]
    return result


@app.post("/api/esp32/readings")
def ingest_reading(payload: SensorReading) -> dict[str, Any]:
    conn = db()
    conn.execute(
        """
        INSERT INTO sensor_readings (
            timestamp, air_temp, air_hum, soil_temp, moisture, ec, ph,
            n_raw, p_raw, k_raw, n_corrected, p_corrected, k_corrected,
            n_frg, p_frg, k_frg
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            now_iso(), payload.air_temp, payload.air_hum, payload.soil_temp,
            payload.moisture, payload.ec, payload.ph, payload.n_raw,
            payload.p_raw, payload.k_raw, payload.n_corrected,
            payload.p_corrected, payload.k_corrected, payload.n_frg,
            payload.p_frg, payload.k_frg,
        ),
    )
    conn.commit()
    conn.close()
    return {"ok": True}


@app.post("/api/fields")
def create_field(payload: FieldCreate) -> dict[str, Any]:
    if payload.crop not in {"Rice", "Wheat", "Lentil", "Onion"}:
        raise HTTPException(status_code=422, detail="শুধু ধান, গম, মসুর ডাল বা পেঁয়াজ নির্বাচন করুন।")
    if not payload.season or not payload.variety:
        raise HTTPException(status_code=422, detail="FRG-2024 তালিকা থেকে মৌসুম ও জাত নির্বাচন করুন।")
    if not resolve_profile(payload.crop, payload.variety, payload.season):
        raise HTTPException(status_code=422, detail="নির্বাচিত ফসল, মৌসুম ও জাতের জন্য FRG-2024 সারণি পাওয়া যায়নি।")
    conn = db()
    cur = conn.execute(
        """
        INSERT INTO fields(name, length_m, width_m, spacing_m, crop, variety, season, yield_goal, rhizobium_used, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            payload.name,
            payload.length_m,
            payload.width_m,
            payload.spacing_m,
            payload.crop,
            payload.variety,
            payload.season,
            payload.yield_goal,
            int(payload.rhizobium_used),
            now_iso(),
        ),
    )
    conn.commit()
    field_id = cur.lastrowid
    conn.close()
    return {"id": field_id, **payload.model_dump()}


@app.get("/api/fields/{field_id}")
def get_field(field_id: int) -> dict[str, Any]:
    conn = db()
    field = conn.execute("SELECT * FROM fields WHERE id = ?", (field_id,)).fetchone()
    if not field:
        conn.close()
        raise HTTPException(status_code=404, detail="Field not found")
    samples = conn.execute(
        "SELECT * FROM samples WHERE field_id = ? ORDER BY point_no", (field_id,)
    ).fetchall()
    analyses = conn.execute(
        "SELECT id, crop, created_at, total_area_ha, result_json FROM analyses WHERE field_id = ? ORDER BY id DESC",
        (field_id,),
    ).fetchall()
    conn.close()
    return {
        "field": dict(field),
        "samples": [dict(x) for x in samples],
        "analyses": [dict(x) for x in analyses],
    }


@app.post("/api/samples")
def save_sample(payload: SampleCreate) -> dict[str, Any]:
    conn = db()
    field = conn.execute("SELECT * FROM fields WHERE id = ?", (payload.field_id,)).fetchone()
    if not field:
        conn.close()
        raise HTTPException(status_code=404, detail="Field not found")
    x_values, y_values = grid_axes(float(field["length_m"]), float(field["width_m"]), float(field["spacing_m"]))
    point_index = payload.point_no - 1
    if not x_values or not y_values or point_index < 0 or point_index >= len(x_values) * len(y_values):
        conn.close()
        raise HTTPException(status_code=400, detail="এই মাঠে নির্বাচিত নমুনা পয়েন্ট নেই")
    expected_x = x_values[point_index % len(x_values)]
    expected_y = y_values[point_index // len(x_values)]
    if abs(float(payload.x_m) - expected_x) > 0.02 or abs(float(payload.y_m) - expected_y) > 0.02:
        conn.close()
        raise HTTPException(status_code=422, detail="নমুনা পয়েন্টের স্থানাঙ্ক গ্রিডের সঙ্গে মিলছে না")
    conn.execute(
        """
        INSERT INTO samples(
            field_id, point_no, x_m, y_m, moisture, ec, ph,
            n_raw, p_raw, k_raw, n_frg, p_frg, k_frg,
            air_temp, air_hum, soil_temp, n_corrected, p_corrected, k_corrected,
            reading_count, first_reading_at, last_reading_at, captured_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(field_id, point_no) DO UPDATE SET
            x_m=excluded.x_m,
            y_m=excluded.y_m,
            moisture=excluded.moisture,
            ec=excluded.ec,
            ph=excluded.ph,
            n_raw=excluded.n_raw,
            p_raw=excluded.p_raw,
            k_raw=excluded.k_raw,
            n_frg=excluded.n_frg,
            p_frg=excluded.p_frg,
            k_frg=excluded.k_frg,
            air_temp=excluded.air_temp,
            air_hum=excluded.air_hum,
            soil_temp=excluded.soil_temp,
            n_corrected=excluded.n_corrected,
            p_corrected=excluded.p_corrected,
            k_corrected=excluded.k_corrected,
            reading_count=excluded.reading_count,
            first_reading_at=excluded.first_reading_at,
            last_reading_at=excluded.last_reading_at,
            captured_at=excluded.captured_at
        """,
        (
            payload.field_id,
            payload.point_no,
            payload.x_m,
            payload.y_m,
            payload.moisture,
            payload.ec,
            payload.ph,
            payload.n_raw,
            payload.p_raw,
            payload.k_raw,
            payload.n_frg,
            payload.p_frg,
            payload.k_frg,
            payload.air_temp,
            payload.air_hum,
            payload.soil_temp,
            payload.n_corrected,
            payload.p_corrected,
            payload.k_corrected,
            payload.reading_count,
            payload.first_reading_at,
            payload.last_reading_at,
            now_iso(),
        ),
    )
    conn.commit()
    conn.close()
    return {"ok": True, "point_no": payload.point_no, "field_id": payload.field_id, "reading_count": payload.reading_count, "captured_at": now_iso()}


def grid_axes(length_m: float, width_m: float, spacing_m: float) -> tuple[list[float], list[float]]:
    """Return X/Y coordinates of sample centers, starting half a spacing from an edge."""
    xs: list[float] = []
    x = min(spacing_m / 2.0, length_m / 2.0)
    while x < length_m - 1e-9:
        xs.append(round(x, 3))
        x += spacing_m
    ys: list[float] = []
    y = min(spacing_m / 2.0, width_m / 2.0)
    while y < width_m - 1e-9:
        ys.append(round(y, 3))
        y += spacing_m
    return xs, ys


def grid_points(length_m: float, width_m: float, spacing_m: float) -> list[dict[str, Any]]:
    """Build a grid centered inside field edges and include farmer-readable coordinates."""
    xs, ys = grid_axes(length_m, width_m, spacing_m)
    points: list[dict[str, Any]] = []
    no = 1
    for row_no, y_value in enumerate(ys, start=1):
        for col_no, x_value in enumerate(xs, start=1):
            points.append({
                "point_no": no,
                "row_no": row_no,
                "col_no": col_no,
                "x_m": x_value,
                "y_m": y_value,
                "distance_from_origin_m": round(math.hypot(x_value, y_value), 3),
                "distance_from_length_start_m": x_value,
                "distance_from_width_start_m": y_value,
                "distance_to_far_length_edge_m": round(max(0.0, length_m - x_value), 3),
                "distance_to_far_width_edge_m": round(max(0.0, width_m - y_value), 3),
            })
            no += 1

    # Store nearest-point distances in the response so the map and point card
    # display measured distances instead of assuming that spacing always divides
    # the field dimensions exactly.
    for point in points:
        neighbours = []
        for other in points:
            if other["point_no"] == point["point_no"]:
                continue
            distance = math.hypot(float(point["x_m"]) - float(other["x_m"]), float(point["y_m"]) - float(other["y_m"]))
            neighbours.append({"point_no": other["point_no"], "distance_m": round(distance, 3)})
        point["nearest_points"] = sorted(neighbours, key=lambda item: item["distance_m"])[:4]
    return points

@app.get("/api/fields/{field_id}/grid")
def get_grid(field_id: int) -> dict[str, Any]:
    conn = db()
    field = conn.execute("SELECT * FROM fields WHERE id = ?", (field_id,)).fetchone()
    samples = conn.execute("SELECT * FROM samples WHERE field_id = ?", (field_id,)).fetchall()
    conn.close()
    if not field:
        raise HTTPException(status_code=404, detail="Field not found")
    sample_map = {int(s["point_no"]): dict(s) for s in samples}
    points = grid_points(field["length_m"], field["width_m"], field["spacing_m"])
    for p in points:
        saved = sample_map.get(int(p["point_no"]))
        p["saved"] = bool(saved)
        if saved:
            p["sample"] = dict(saved)
    return {"field": dict(field), "points": points}


@app.post("/api/fertilizer/calculate")
def calculate_fertilizer(payload: FertilizerRequest) -> dict[str, Any]:
    conn = db()
    field_row = conn.execute("SELECT * FROM fields WHERE id = ?", (payload.field_id,)).fetchone()
    sample_rows = conn.execute("SELECT * FROM samples WHERE field_id = ? ORDER BY point_no", (payload.field_id,)).fetchall()
    conn.close()
    if not field_row:
        raise HTTPException(status_code=404, detail="Field not found")
    if not sample_rows:
        raise HTTPException(status_code=400, detail="No soil samples saved for this field")
    field = dict(field_row)
    samples = [dict(row) for row in sample_rows]
    expected_x, expected_y = grid_axes(float(field["length_m"]), float(field["width_m"]), float(field["spacing_m"]))
    required_points = len(expected_x) * len(expected_y)
    if len(samples) < required_points:
        raise HTTPException(
            status_code=400,
            detail=f"পুরো জমির বিশ্লেষণের আগে সব নমুনা পয়েন্ট সংরক্ষণ করুন। সংরক্ষিত {len(samples)} / {required_points}টি।",
        )
    crop = payload.crop or field.get("crop", "")
    variety = payload.variety or field.get("variety", "")
    season = payload.season or field.get("season", "")
    profile = resolve_profile(crop, variety, season)
    if not profile:
        raise HTTPException(status_code=422, detail="এই ফসল, মৌসুম ও জাতের জন্য যাচাইকৃত FRG-2024 সারণি পাওয়া যায়নি।")
    field["crop"], field["variety"], field["season"] = crop, variety, season
    field["rhizobium_used"] = int(payload.rhizobium_used)
    conn = db()
    conn.execute("UPDATE fields SET rhizobium_used = ?, crop = ?, variety = ?, season = ?, yield_goal = ? WHERE id = ?", (int(payload.rhizobium_used), crop, variety, season, str(profile["yield_goal_t_ha"]), payload.field_id))
    conn.commit()
    conn.close()
    surface = build_vra_surface(field, samples, profile, grid=40)
    result = build_recommendation(field, samples, profile, surface)
    result["profile_key"] = next((key for key, item in FRG_PROFILES.items() if item is profile), None)
    result["map_resolution"] = 40
    result["spatial_validation"] = spatial_cross_validation(samples)
    result["map_legend"] = build_map_legend(profile, bool(field.get("rhizobium_used", 0)))
    return result


def idw(samples: list[dict[str, float]], x: float, y: float, key: str, power: float = 2.0) -> float | None:
    if not samples:
        return None
    weighted = 0.0
    weights = 0.0
    for s in samples:
        try:
            value = float(s[key])
        except (KeyError, TypeError, ValueError):
            continue
        d = math.hypot(x - float(s["x_m"]), y - float(s["y_m"]))
        if d < 1e-9:
            return value
        w = 1.0 / (d**power)
        weighted += w * value
        weights += w
    return weighted / weights if weights else None


def spatial_cross_validation(samples: list[dict[str, Any]]) -> dict[str, Any]:
    """Leave-one-out IDW validation. This is only a diagnostic with sparse points."""
    result: dict[str, Any] = {
        "method": "IDW (power=2) + leave-one-out cross-validation",
        "sample_count": len(samples),
        "valid": len(samples) >= 4,
        "metrics": {},
        "note_bn": "কমপক্ষে ৪টি পৃথক নমুনা পয়েন্ট না থাকলে cross-validation পরিসংখ্যান নির্ভরযোগ্যভাবে দেখানো হয় না।",
    }
    if len(samples) < 4:
        return result
    for key, label in (("n_frg", "N"), ("p_frg", "P"), ("k_frg", "K")):
        actual: list[float] = []
        predicted: list[float] = []
        for index, holdout in enumerate(samples):
            training = samples[:index] + samples[index + 1:]
            estimate = idw(training, float(holdout["x_m"]), float(holdout["y_m"]), key)
            if estimate is None:
                continue
            actual.append(float(holdout[key]))
            predicted.append(float(estimate))
        if not actual:
            continue
        errors = [p - a for p, a in zip(predicted, actual)]
        mae = sum(abs(e) for e in errors) / len(errors)
        rmse = math.sqrt(sum(e * e for e in errors) / len(errors))
        mean_actual = sum(actual) / len(actual)
        ss_tot = sum((a - mean_actual) ** 2 for a in actual)
        ss_res = sum(e * e for e in errors)
        result["metrics"][label] = {
            "mae": mae,
            "rmse": rmse,
            "r2": (1 - ss_res / ss_tot) if ss_tot > 1e-12 else None,
            "n": len(actual),
        }
    result["valid"] = len(result["metrics"]) == 3
    result["note_bn"] = "এটি সংরক্ষিত নমুনায় leave-one-out error; ঘন নমুনা ও পরীক্ষাগারের সঙ্গে sensor calibration ছাড়া একে মাঠজুড়ে নিশ্চিত accuracy ধরা যাবে না।"
    return result


@app.get("/api/vra/{field_id}")
def vra(field_id: int, grid: int = 40) -> dict[str, Any]:
    conn = db()
    field_row = conn.execute("SELECT * FROM fields WHERE id = ?", (field_id,)).fetchone()
    sample_rows = conn.execute("SELECT * FROM samples WHERE field_id = ? ORDER BY point_no", (field_id,)).fetchall()
    conn.close()
    if not field_row:
        raise HTTPException(status_code=404, detail="Field not found")
    field = dict(field_row)
    samples = [dict(row) for row in sample_rows]
    profile = resolve_profile(field.get("crop", ""), field.get("variety", ""), field.get("season", ""))
    actual_grid = max(8, min(50, int(grid)))
    xs, ys = grid_axes(float(field["length_m"]), float(field["width_m"]), float(field["spacing_m"]))
    required_points = len(xs) * len(ys)
    progress = {"required_points": required_points, "saved_points": len(samples),
                "complete": len(samples) >= required_points,
                "missing_points": max(0, required_points - len(samples))}
    if not samples or not profile:
        return {"field": field, "samples": samples, "surface": [], "grid_resolution": actual_grid,
                "sampling_progress": progress, "recommendation": None, "legend": {}, "spatial_validation": spatial_cross_validation(samples)}
    surface = build_vra_surface(field, samples, profile, grid=actual_grid)
    recommendation = build_recommendation(field, samples, profile, surface) if progress["complete"] else None
    return {
        "field": field,
        "samples": samples,
        "surface": surface,
        "sampling_progress": progress,
        "spatial_validation": spatial_cross_validation(samples),
        "grid_resolution": actual_grid,
        "profile_key": next((key for key, item in FRG_PROFILES.items() if item is profile), None),
        "crop_profile": {"crop": profile["crop"], "season": profile["season"], "yield_goal_t_ha": profile["yield_goal_t_ha"], "yield_tolerance_t_ha": profile["yield_tolerance_t_ha"], "source_page": profile["source_page"]},
        "recommendation": recommendation,
        "legend": build_map_legend(profile, bool(field.get("rhizobium_used", 0))),
    }


@app.get("/api/history")
def history() -> dict[str, Any]:
    conn = db()
    rows = conn.execute(
        "SELECT id, name, length_m, width_m, crop, variety, season, created_at FROM fields ORDER BY id DESC"
    ).fetchall()
    fields = []
    for row in rows:
        item = dict(row)
        item["area_m2"] = round(float(item["length_m"]) * float(item["width_m"]), 2)
        count = conn.execute("SELECT COUNT(*) FROM samples WHERE field_id = ?", (item["id"],)).fetchone()[0]
        item["sample_count"] = int(count)
        fields.append(item)
    conn.close()
    return {"fields": fields}


@app.get("/api/report/{field_id}.pdf")
def report_pdf(field_id: int):
    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.styles import getSampleStyleSheet
        from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
        from reportlab.lib import colors
    except ImportError as exc:
        raise HTTPException(status_code=500, detail="reportlab is not installed") from exc

    conn = db()
    field = conn.execute("SELECT * FROM fields WHERE id = ?", (field_id,)).fetchone()
    samples = conn.execute("SELECT * FROM samples WHERE field_id = ? ORDER BY point_no", (field_id,)).fetchall()
    conn.close()
    if not field:
        raise HTTPException(status_code=404, detail="Field not found")

    import io

    field = dict(field)
    sample_dicts = [dict(sample) for sample in samples]
    n_avg = sum(s["n_frg"] for s in sample_dicts) / len(sample_dicts) if sample_dicts else 0
    p_avg = sum(s["p_frg"] for s in sample_dicts) / len(sample_dicts) if sample_dicts else 0
    k_avg = sum(s["k_frg"] for s in sample_dicts) / len(sample_dicts) if sample_dicts else 0
    classes = soil_classes(n_avg, p_avg, k_avg, str(field.get("crop") or ""))
    profile = resolve_profile(str(field.get("crop") or ""), str(field.get("variety") or ""), str(field.get("season") or ""))
    xs, ys = grid_axes(float(field["length_m"]), float(field["width_m"]), float(field["spacing_m"]))
    required_points = len(xs) * len(ys)
    complete = bool(profile and sample_dicts and len(sample_dicts) >= required_points)
    recommendation = None
    if complete:
        surface = build_vra_surface(field, sample_dicts, profile, grid=40)
        recommendation = build_recommendation(field, sample_dicts, profile, surface)
        n_avg = recommendation["average_frg"]["N"]
        p_avg = recommendation["average_frg"]["P"]
        k_avg = recommendation["average_frg"]["K"]
        classes = recommendation["classes"]

    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=A4, rightMargin=36, leftMargin=36, topMargin=36, bottomMargin=36)
    styles = getSampleStyleSheet()
    official_variety = str(field.get("variety") or "").split("|", 1)[-1]
    story = [
        Paragraph("Smart Farming — FRG-2024 Field & VRA Report", styles["Title"]),
        Spacer(1, 12),
        Paragraph(f"Field: {field['name'] if str(field['name']).isascii() else f'Field {field_id}'}", styles["Normal"]),
        Paragraph(f"Area: {field['length_m'] * field['width_m'] / 10000:.4f} ha ({field['length_m'] * field['width_m']:.2f} m2)", styles["Normal"]),
        Paragraph(f"Crop / Variety: {field.get('crop') or 'Not selected'} / {official_variety or 'Not selected'}", styles["Normal"]),
        Paragraph(f"Season: {field.get('season') or 'Not selected'}", styles["Normal"]),
        Paragraph(f"Sampling points saved: {len(sample_dicts)} / {required_points} ({'complete' if len(sample_dicts) >= required_points else 'incomplete'})", styles["Normal"]),
        Paragraph(f"Generated: {now_iso()}", styles["Normal"]),
        Spacer(1, 16),
        Paragraph("Field-wide FRG-2024 nutrient status (IDW area-weighted estimate when complete)", styles["Heading2"]),
        Spacer(1, 8),
    ]
    nutrient_rows = [["Nutrient", "Value", "Class"],
                     ["N", f"{n_avg:.4f}", classes["N"]],
                     ["P", f"{p_avg:.4f}", classes["P"]],
                     ["K", f"{k_avg:.4f}", classes["K"]]]
    tbl = Table(nutrient_rows, colWidths=[100, 120, 170])
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#d8f0df")),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("ALIGN", (1, 1), (-1, -1), "CENTER"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    story.append(tbl)
    story.append(Spacer(1, 16))

    if recommendation:
        story.append(Paragraph(f"FRG-2024 crop yield goal: {profile['yield_goal_t_ha']:.2f} ± {profile['yield_tolerance_t_ha']:.2f} t/ha", styles["Heading2"]))
        y = recommendation["yield_comparison"]
        if y["before_range_available"]:
            before_text = (f"Guide-based no-fertilizer reference: {y['before_fertilizer_min_t_ha']:.2f}–"
                           f"{y['before_fertilizer_max_t_ha']:.2f} t/ha; field equivalent "
                           f"{y['before_fertilizer_min_field_kg']:.1f}–{y['before_fertilizer_max_field_kg']:.1f} kg.")
        else:
            before_text = "FRG Table 2 does not provide a numeric no-fertilizer yield band for this critical-limit category."
        after_text = (f"FRG yield goal range (not guaranteed actual yield): {y['after_fertilizer_min_t_ha']:.2f}–"
                      f"{y['after_fertilizer_max_t_ha']:.2f} t/ha; field equivalent "
                      f"{y['after_fertilizer_min_field_kg']:.1f}–{y['after_fertilizer_max_field_kg']:.1f} kg.")
        story.append(Paragraph(before_text, styles["BodyText"]))
        story.append(Spacer(1, 6))
        story.append(Paragraph(after_text, styles["BodyText"]))
        story.append(Spacer(1, 14))
        story.append(Paragraph("Fertilizer products (FRG table ranges converted with Appendix-10 factors)", styles["Heading2"]))
        product_rows = [["Product", "Average rate range (kg/ha)", "Field amount / rated coverage"]]
        for key, item in recommendation["fertilizer_totals"].items():
            if item["average_min_kg_ha"] is None:
                rate_text = "Not rated from available data"
            else:
                rate_text = f"{item['average_min_kg_ha']:.1f}–{item['average_max_kg_ha']:.1f}"
            total_text = f"{item['total_min_kg']:.2f}–{item['total_max_kg']:.2f} kg; {item['coverage_percent']:.1f}% area"
            if item["unrated_area_ha"] > 0.000001:
                total_text += f"; unrated {item['unrated_area_ha']:.4f} ha"
            product_rows.append([key, rate_text, total_text])
        product_table = Table(product_rows, colWidths=[110, 145, 195], repeatRows=1)
        product_table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#d8f0df")),
            ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ]))
        story.append(product_table)
        if recommendation["organic_fertilizer_t_ha"] is not None:
            story.append(Spacer(1, 8))
            story.append(Paragraph(f"Organic fertilizer from selected FRG profile: {recommendation['organic_fertilizer_t_ha']:.2f} t/ha; field total {recommendation['organic_fertilizer_field_t']:.3f} t.", styles["BodyText"]))
        story.append(Spacer(1, 12))
        story.append(Paragraph("Cautions", styles["Heading2"]))
        caveats = [
            "This is a preliminary FRG-2024 estimate from ESP32 readings; validate sensor units/calibration against laboratory soil analysis.",
            "The FRG yield goal is not a guaranteed yield forecast. Actual yield depends on irrigation, weather, cultivar, pests/diseases and management.",
            "No separate High/Very High crop-table dose is invented. Gray/unrated areas must not be interpreted as zero fertilizer requirement.",
            "S, Mg, Zn, B and Mo are not directly measured by this connected sensor; use laboratory soil test before prescribing their specific rates.",
        ]
        for caveat in caveats:
            story.append(Paragraph("• " + caveat, styles["BodyText"]))
        story.append(Spacer(1, 8))
        story.append(Paragraph(f"Source: BARC, Fertilizer Recommendation Guide-2024; crop table {profile['source_page']}; Appendix-8 soil-test classes; Appendix-10 conversion factors.", styles["BodyText"]))
    else:
        story.append(Paragraph("Full-field fertilizer and yield recommendation is not available yet. Save every generated sampling-grid point and select a crop, season and variety covered by the FRG-2024 profile. The current report only shows the available sample readings.", styles["BodyText"]))
        story.append(Spacer(1, 8))
        story.append(Paragraph("N/P/K class values are preliminary sensor-derived values; laboratory calibration is required before making a field prescription.", styles["BodyText"]))

    story.append(Spacer(1, 12))
    story.append(Paragraph(f"Source sampling points saved: {len(sample_dicts)} of {required_points}", styles["Normal"]))
    doc.build(story)
    buffer.seek(0)
    return StreamingResponse(
        buffer,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="field_{field_id}_report.pdf"'},
    )


@app.exception_handler(Exception)
async def unhandled_error(_, exc: Exception):
    return JSONResponse(status_code=500, content={"error": str(exc)})
