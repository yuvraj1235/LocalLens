from __future__ import annotations

import logging
import time
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.routers.agent import router as agent_router

logging.basicConfig(level=settings.log_level.upper())
logger = logging.getLogger("agent")

app = FastAPI(title=settings.app_name)

# --- LATENCY TRACKING MIDDLEWARE ---
@app.middleware("http")
async def add_process_time_header(request: Request, call_next):
    start_time = time.perf_counter()
    response = await call_next(request)
    process_time = time.perf_counter() - start_time
    
    response.headers["X-Process-Time"] = f"{process_time:.4f}s"
    logger.info("ROUTE: %s | LATENCY: %.4fs", request.url.path, process_time)
    
    return response

# Extension origins are chrome-extension://... / moz-extension://... — CORS
# is wide open here for hackathon speed; tighten to your extension ids before
# any public deployment.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(agent_router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": settings.app_name}