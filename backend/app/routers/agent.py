from __future__ import annotations

import logging
import time
import httpx
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect, File, UploadFile
from pydantic import ValidationError
from app.core.config import settings
from app.schemas.context import StructuredAction, TaskRequest
from app.services.action_planner import ActionPlanner
from app.services.llm_client import get_vlm_client
from app.services.session_store import SessionStore

logger = logging.getLogger("agent")
router = APIRouter()
session_store = SessionStore()


@router.post("/plan-action", response_model=StructuredAction)
async def plan_action_http(request: TaskRequest) -> StructuredAction:
    """REST fallback — handy for Swagger/curl testing without a WS client."""
    client = get_vlm_client()
    try:
        planner = ActionPlanner(client)
        
        server_history = await session_store.get_history(request.session_id)
        request.history = server_history

        # Metric: Track HTTP inference latency
        inference_start = time.time()
        action = await planner.plan_next_action(request)
        inference_latency = time.time() - inference_start
        print(f"[METRIC] HTTP Inference Latency: {inference_latency:.3f}s")
        print("\n=== OUTGOING TO FRONTEND (HTTP) ===")
        print(action.model_dump_json(indent=2))
        print("===================================\n")
        if action.action != "ASK_USER" and action.element_id:
            action_desc = f"{action.action} on element '{action.element_id}'"
            if action.value:
                action_desc += f" with value '{action.value}'"
            await session_store.append_history(request.session_id, action_desc)

        return action
    except Exception as e:
        logger.exception("HTTP planning failed for session %s", request.session_id)
        raise HTTPException(status_code=500, detail=f"Planning failed: {str(e)}")
    finally:
        await client.close()


@router.websocket("/ws/agent")
async def agent_websocket(websocket: WebSocket) -> None:
    """Realtime loop for the browser extension."""
    await websocket.accept()
    
    client = get_vlm_client()
    planner = ActionPlanner(client)

    try:
        while True:
            # Metric: Start end-to-end timer the moment we wait for a message
            e2e_start = time.time()
            raw = await websocket.receive_json()
            
            try:
                request = TaskRequest.model_validate(raw)
                print("\n=== INCOMING FROM FRONTEND ===")
                print(request.model_dump_json(indent=2))
                print("==============================\n")
            except ValidationError as e:
                await websocket.send_json({"error": "invalid_request", "detail": e.errors()})
                continue
            
            server_history = await session_store.get_history(request.session_id)
            request.history = server_history

            try:
                # Metric: Start inference timer exactly before calling the AI
                inference_start = time.time()
                action = await planner.plan_next_action(request)
                inference_latency = time.time() - inference_start
                
                print("\n=== OUTGOING TO FRONTEND ===")
                print(action.model_dump_json(indent=2))
                print("============================\n")
                
                if action.action != "ASK_USER" and action.element_id:
                    action_desc = f"{action.action} on element '{action.element_id}'"
                    if action.value:
                        action_desc += f" with value '{action.value}'"
                    await session_store.append_history(request.session_id, action_desc)

            except Exception as e: 
                logger.exception("planning failed for session %s", request.session_id)
                await websocket.send_json({"error": "planning_failed", "detail": str(e)})
                continue

            await websocket.send_json(action.model_dump())
            
            # Metric: Calculate total time taken to receive, process, and reply
            e2e_latency = time.time() - e2e_start
            
            print(f"\nSession: {request.session_id}")
            print(f" ├─ VLM Inference Latency: {inference_latency:.3f} seconds")
            print(f" └─ End-to-End Turnaround: {e2e_latency:.3f} seconds\n")
            
    except WebSocketDisconnect:
        logger.info("client disconnected")
    finally:
        await client.close()


@router.post("/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    if not settings.deepgram_api_key:
        raise HTTPException(status_code=500, detail="DEEPGRAM_API_KEY is not configured on the backend.")
    
    audio_bytes = await file.read()
    
    async with httpx.AsyncClient() as client:
        try:
            response = await client.post(
                "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true",
                headers={
                    "Authorization": f"Token {settings.deepgram_api_key}",
                    "Content-Type": "audio/webm",
                },
                content=audio_bytes,
                timeout=10.0,
            )
            response.raise_for_status()
            result = response.json()
            
            transcript = (
                result.get("results", {})
                .get("channels", [{}])[0]
                .get("alternatives", [{}])[0]
                .get("transcript", "")
            )
            return {"transcript": transcript}
        except httpx.HTTPError as e:
            logger.error("Deepgram API error: %s", e)
            raise HTTPException(status_code=502, detail="Failed to transcribe audio via Deepgram.")