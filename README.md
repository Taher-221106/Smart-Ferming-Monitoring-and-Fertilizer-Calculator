# Smart Farming Monitoring and Fertilizer Calculator

GitHub-ready MVP for an ESP32 + RS485 7-in-1 NPK + DHT22 + DS18B20 smart farming system.

## Pages

1. Live Dashboard — latest sensor reading and FRG-2024-style N/P/K interpretation.
2. Fertilizer Calculator — field dimensions, sampling spacing, generated sampling grid, point capture, and FRG status.
3. VRA Map — IDW interpolation of saved sampling points for N/P/K layers.
4. History & Report — saved fields and PDF report generation.

## Backend

FastAPI + SQLite. ESP32 can POST JSON readings to:

`POST /api/esp32/readings`

The frontend is served by the backend, so the whole MVP is one Python service and is suitable for Codespaces or a small cloud deployment.

## Important FRG-2024 note

Appendix-8 critical-limit classes currently encoded are the ranges supplied by the project owner for N, P (upland-crop scale), and K. Crop-specific FRG-2024 fertilizer-dose tables are intentionally not fabricated. Populate the verified crop/variety/season/HYG tables from the guidebook before the system is used for agronomic prescriptions.

## Run locally / Codespaces

```bash
python -m pip install -r backend/requirements.txt
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

Open the forwarded port 8000.

## Git

The `.gitignore` excludes SQLite databases, Python cache files and virtual environments. This keeps the repository clean for GitHub.
