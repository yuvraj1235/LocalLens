from __future__ import annotations

import logging
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

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

        action = await planner.plan_next_action(request)

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
            raw = await websocket.receive_json()
            try:
                request = TaskRequest.model_validate(raw)
            except ValidationError as e:
                await websocket.send_json({"error": "invalid_request", "detail": e.errors()})
                continue
            
            server_history = await session_store.get_history(request.session_id)
            request.history = server_history

            try:
                action = await planner.plan_next_action(request)
                
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
    except WebSocketDisconnect:
        logger.info("client disconnected")
    finally:
        await client.close()