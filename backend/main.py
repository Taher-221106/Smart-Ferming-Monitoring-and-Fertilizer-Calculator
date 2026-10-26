from __future__ import annotations

import math
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
    conn.commit()
    conn.close()


init_db()


# FRG-2024 Appendix-8 critical-limit classes shown by the user.
# These are interpretation ranges, not crop-specific fertilizer doses.
N_CLASSES = [
    (0.09, "Very Low"),
    (0.18, "Low"),
    (0.27, "Medium"),
    (0.36, "Optimum"),
    (0.45, "High"),
    (math.inf, "Very High"),
]
P_CLASSES = [
    (9.0, "Very Low"),
    (18.0, "Low"),
    (27.0, "Medium"),
    (36.0, "Optimum"),
    (45.0, "High"),
    (math.inf, "Very High"),
]
K_CLASSES = [
    (0.09, "Very Low"),
    (0.18, "Low"),
    (0.27, "Medium"),
    (0.36, "Optimum"),
    (0.45, "High"),
    (math.inf, "Very High"),
]

# Fertilizer analysis factors used only for source-to-nutrient conversion.
# Actual FRG crop/variety/HYG dose tables are intentionally kept in a separate
# data file so they can be entered from the user's guidebook without inventing values.
FERTILIZERS = {
    "Urea": {"N": 0.46, "P": 0.0, "K": 0.0},
    "TSP": {"N": 0.0, "P": 0.20, "K": 0.0},
    "MOP": {"N": 0.0, "P": 0.0, "K": 0.50},
    "DAP": {"N": 0.18, "P": 0.20, "K": 0.0},
}


def class_from_thresholds(value: float, table: list[tuple[float, str]]) -> str:
    v = max(0.0, float(value))
    for upper, label in table:
        if v <= upper:
            return label
    return "Very High"


def soil_classes(n: float, p: float, k: float) -> dict[str, str]:
    return {
        "N": class_from_thresholds(n, N_CLASSES),
        "P": class_from_thresholds(p, P_CLASSES),
        "K": class_from_thresholds(k, K_CLASSES),
    }


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


@app.get("/")
def home() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "index.html")


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
    conn = db()
    cur = conn.execute(
        """
        INSERT INTO fields(name, length_m, width_m, spacing_m, crop, variety, season, yield_goal, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    field = conn.execute("SELECT * FROM fields WHERE id = ?", (payload.field_id,)).fetchone()
    samples = conn.execute("SELECT * FROM samples WHERE field_id = ? ORDER BY point_no", (payload.field_id,)).fetchall()
    conn.close()
    if not field:
        raise HTTPException(status_code=404, detail="Field not found")
    if not samples:
        raise HTTPException(status_code=400, detail="No soil samples saved for this field")

    n_avg = sum(s["n_frg"] for s in samples) / len(samples)
    p_avg = sum(s["p_frg"] for s in samples) / len(samples)
    k_avg = sum(s["k_frg"] for s in samples) / len(samples)
    classes = soil_classes(n_avg, p_avg, k_avg)

    # This section intentionally does NOT fabricate crop-specific FRG dose numbers.
    # It returns the measured fertility status and nutrient targets as inputs to the
    # separate FRG table that will be populated from the user's guidebook.
    result = {
        "status": "FRG_TABLE_REQUIRED",
        "message": "Crop-specific FRG-2024 fertilizer dose table is not hard-coded until the guidebook table is entered/verified.",
        "field_area_ha": field["length_m"] * field["width_m"] / 10000.0,
        "sample_count": len(samples),
        "average_frg": {"N": n_avg, "P": p_avg, "K": k_avg},
        "classes": classes,
        "fertilizer_sources": FERTILIZERS,
        "crop": payload.crop,
        "variety": payload.variety,
        "season": payload.season,
        "yield_goal": payload.yield_goal,
    }
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


@app.get("/api/vra/{field_id}")
def vra(field_id: int, grid: int = 24) -> dict[str, Any]:
    conn = db()
    field = conn.execute("SELECT * FROM fields WHERE id = ?", (field_id,)).fetchone()
    rows = conn.execute("SELECT * FROM samples WHERE field_id = ? ORDER BY point_no", (field_id,)).fetchall()
    conn.close()
    if not field:
        raise HTTPException(status_code=404, detail="Field not found")
    samples = [dict(r) for r in rows]
    grid = max(8, min(50, int(grid)))
    surface: list[dict[str, Any]] = []
    for gy in range(grid):
        y = field["width_m"] * (gy + 0.5) / grid
        for gx in range(grid):
            x = field["length_m"] * (gx + 0.5) / grid
            surface.append({
                "x_m": round(x, 3),
                "y_m": round(y, 3),
                "N": idw(samples, x, y, "n_frg"),
                "P": idw(samples, x, y, "p_frg"),
                "K": idw(samples, x, y, "k_frg"),
            })
    return {"field": dict(field), "samples": samples, "surface": surface}


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

    n_avg = sum(s["n_frg"] for s in samples) / len(samples) if samples else 0
    p_avg = sum(s["p_frg"] for s in samples) / len(samples) if samples else 0
    k_avg = sum(s["k_frg"] for s in samples) / len(samples) if samples else 0
    classes = soil_classes(n_avg, p_avg, k_avg)

    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=A4, rightMargin=36, leftMargin=36, topMargin=36, bottomMargin=36)
    styles = getSampleStyleSheet()
    story = [
        Paragraph("Smart Farming — Field Soil & VRA Report", styles["Title"]),
        Spacer(1, 12),
        Paragraph(f"Field: {field['name']}", styles["Normal"]),
        Paragraph(f"Area: {field['length_m'] * field['width_m'] / 10000:.4f} ha", styles["Normal"]),
        Paragraph(f"Crop / Variety: {field['crop']} / {field['variety']}", styles["Normal"]),
        Paragraph(f"Season / Yield goal: {field['season']} / {field['yield_goal']}", styles["Normal"]),
        Paragraph(f"Generated: {now_iso()}", styles["Normal"]),
        Spacer(1, 16),
        Paragraph("Average FRG-2024 interpretation inputs", styles["Heading2"]),
        Spacer(1, 8),
    ]
    data = [
        ["N", f"{n_avg:.4f}", classes["N"]],
        ["P", f"{p_avg:.4f}", classes["P"]],
        ["K", f"{k_avg:.4f}", classes["K"]],
    ]
    tbl = Table([["Nutrient", "Value", "Class"]] + data, colWidths=[100, 120, 130])
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,0), colors.HexColor("#d8f0df")),
        ("GRID", (0,0), (-1,-1), 0.5, colors.grey),
        ("FONTNAME", (0,0), (-1,0), "Helvetica-Bold"),
        ("ALIGN", (1,1), (-1,-1), "CENTER"),
    ]))
    story.append(tbl)
    story.append(Spacer(1, 16))
    story.append(Paragraph(
        "Note: Crop-specific FRG-2024 fertilizer dose tables are not fabricated by this MVP. "
        "They must be entered from the verified guidebook tables before issuing fertilizer quantities.",
        styles["BodyText"],
    ))
    story.append(Spacer(1, 12))
    story.append(Paragraph(f"Sampling points: {len(samples)}", styles["Normal"]))
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
