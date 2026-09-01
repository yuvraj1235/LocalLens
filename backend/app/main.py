import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.routers.agent import router as agent_router

logging.basicConfig(level=settings.log_level.upper())

app = FastAPI(title=settings.app_name)

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
