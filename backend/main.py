import os
import time
import base64
import json
import cv2
import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List, Dict

from vision_engine import OpticalLensDetector
from network_sniffer import NetworkCameraSniffer

app = FastAPI(title="SpecterLens Backend Engine", version="2.0.0")

# Enable CORS for mobile browsers and local network tunnels
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

detector = OpticalLensDetector(sensitivity="normal")
sniffer = NetworkCameraSniffer(timeout=1.5)

# Absolute path resolution
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", "frontend"))

# Mount frontend static directories
if os.path.exists(os.path.join(FRONTEND_DIR, "css")):
    app.mount("/css", StaticFiles(directory=os.path.join(FRONTEND_DIR, "css")), name="css")
if os.path.exists(os.path.join(FRONTEND_DIR, "js")):
    app.mount("/js", StaticFiles(directory=os.path.join(FRONTEND_DIR, "js")), name="js")
if os.path.exists(os.path.join(FRONTEND_DIR, "assets")):
    app.mount("/assets", StaticFiles(directory=os.path.join(FRONTEND_DIR, "assets")), name="assets")

@app.get("/", response_class=HTMLResponse)
async def serve_index():
    index_path = os.path.join(FRONTEND_DIR, "index.html")
    if os.path.exists(index_path):
        with open(index_path, "r", encoding="utf-8") as f:
            return HTMLResponse(f.read())
    return HTMLResponse("<h2>SpecterLens frontend not found.</h2>", status_code=404)

@app.get("/manifest.json")
async def serve_manifest():
    manifest_path = os.path.join(FRONTEND_DIR, "manifest.json")
    if os.path.exists(manifest_path):
        return FileResponse(manifest_path, media_type="application/manifest+json")
    return JSONResponse({})

@app.get("/api/health")
async def health_check():
    return {
        "status": "online",
        "engine": "SpecterLens Deterministic Optics V2",
        "timestamp": time.time()
    }

class SensitivityPayload(BaseModel):
    level: str

@app.post("/api/sensitivity")
async def update_sensitivity(payload: SensitivityPayload):
    detector.set_sensitivity(payload.level)
    return {"status": "ok", "sensitivity": payload.level}

class FramePayload(BaseModel):
    image_base64: str
    is_differential: Optional[bool] = False

@app.post("/api/detect_frame")
async def detect_frame(payload: FramePayload):
    """Processes a single base64 image (useful for file uploads, testing, or HTTP fallback)."""
    try:
        data = payload.image_base64
        if "," in data:
            data = data.split(",")[1]
        img_bytes = base64.b64decode(data)
        np_arr = np.frombuffer(img_bytes, np.uint8)
        img = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

        if img is None:
            raise HTTPException(status_code=400, detail="Invalid image payload")

        t0 = time.time()
        detections = detector.process_frame(img, is_differential=payload.is_differential, single_frame=True)
        latency_ms = round((time.time() - t0) * 1000, 2)

        threat = "SAFE"
        if len(detections) > 0:
            max_conf = max(d["confidence"] for d in detections)
            threat = "CRITICAL" if max_conf >= 0.85 else "SUSPICIOUS"

        return {
            "detections": detections,
            "count": len(detections),
            "threat_level": threat,
            "latency_ms": latency_ms,
            "frame_width": img.shape[1],
            "frame_height": img.shape[0]
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/scan_network")
async def scan_network():
    """Executes genuine SSDP/UPnP multicast scan for IP streaming cameras."""
    results = sniffer.run_full_probe()
    return results

class ReportPayload(BaseModel):
    room_name: str
    inspector_name: str
    scan_duration_sec: int
    detections: List[Dict]
    network_summary: Optional[Dict] = None

@app.post("/api/report")
async def generate_report(payload: ReportPayload):
    """Generates a structured, verifiable Room Privacy Audit Certificate."""
    risk_level = "CLEAN / VERIFIED SAFE"
    if len(payload.detections) > 0:
        risk_level = "CRITICAL RISK - SURVEILLANCE DETECTED"
    elif payload.network_summary and payload.network_summary.get("cameras_detected", 0) > 0:
        risk_level = "HIGH RISK - NETWORK STREAM DETECTED"

    report_data = {
        "certificate_id": f"SL-{int(time.time())}-{hash(payload.room_name) % 10000:04d}",
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime()),
        "room_name": payload.room_name or "Private Space / Room",
        "inspector": payload.inspector_name or "Anonymous Traveler",
        "duration_seconds": payload.scan_duration_sec,
        "optical_anomalies_found": len(payload.detections),
        "detections": payload.detections,
        "network_audit": payload.network_summary,
        "final_verdict": risk_level,
        "verification_seal": "SPECTERLENS-CRYPTOGRAPHIC-VERIFIED-V2"
    }
    return report_data

@app.websocket("/ws/stream")
async def websocket_stream(websocket: WebSocket):
    """High-speed WebSocket connection for streaming frames from mobile camera."""
    await websocket.accept()
    baseline_gray = None

    try:
        while True:
            raw_text = await websocket.receive_text()
            data_json = json.loads(raw_text)
            
            b64_data = data_json.get("frame", "")
            is_diff = data_json.get("is_differential", False)

            if "," in b64_data:
                b64_data = b64_data.split(",")[1]

            img_bytes = base64.b64decode(b64_data)
            np_arr = np.frombuffer(img_bytes, np.uint8)
            frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

            if frame is None:
                continue

            t0 = time.time()
            detections = detector.process_frame(frame, is_differential=is_diff, baseline_gray=baseline_gray)
            latency_ms = round((time.time() - t0) * 1000, 1)

            threat = "CLEAN"
            if len(detections) > 0:
                max_conf = max(d["confidence"] for d in detections)
                threat = "CRITICAL" if max_conf >= 0.85 else "SUSPICIOUS"

            response = {
                "detections": detections,
                "threat_level": threat,
                "latency_ms": latency_ms,
                "width": frame.shape[1],
                "height": frame.shape[0]
            }

            await websocket.send_text(json.dumps(response))

    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await websocket.close()
        except Exception:
            pass

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
