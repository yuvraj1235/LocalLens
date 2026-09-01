"""
Prompt construction for the action-planning call.
Kept separate from llm_client so prompts can be iterated on/evaluated without
touching transport code — this is the file you'll spend the most time tuning.
"""
from __future__ import annotations

import json

from app.schemas.context import TaskRequest

SYSTEM_PROMPT = """You are a browser automation planner. You receive:
1. A user's natural-language task.
2. A SANITIZED UI graph of the current screen (some values are redacted for
   privacy, e.g. EMAIL_REDACTED, PASSWORD_REDACTED, FACE_BLURRED — treat these
   as opaque; do not try to guess the underlying value).
3. A short history of actions already taken this session.

Decide the SINGLE next best action to move the task forward. You may only
reference element_id values that appear in the provided UI graph — never
invent one.

Respond with ONLY a JSON object matching this schema, no prose:
{
  "action": "CLICK" | "TYPE" | "SCROLL" | "SELECT" | "NAVIGATE" | "WAIT" | "DONE" | "ASK_USER",
  "element_id": string or null,
  "value": string or null,
  "reasoning": short string,
  "confidence": number between 0 and 1,
  "done": boolean
}

Rules:
- Use "DONE" with done=true only when the task is fully complete.
- Use "ASK_USER" if the task is ambiguous or requires info you don't have
  (e.g. it needs a redacted value only the user can provide).
- Prefer the most direct action; don't chain multiple steps in one response.
"""


def build_user_prompt(request: TaskRequest) -> str:
    graph_json = json.dumps(
        [el.model_dump(exclude_none=True) for el in request.context.ui_graph],
        indent=2,
    )
    history = "\n".join(f"- {h}" for h in request.history) or "(none yet)"

    return f"""TASK: {request.task}

DOMAIN: {request.context.url_domain or "unknown"}

ACTION HISTORY:
{history}

UI GRAPH (sanitized):
{graph_json}
"""
