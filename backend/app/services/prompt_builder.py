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

Decide the SINGLE next best action to move the task forward.

STRICT ELEMENT_ID RULES:
- You MUST select an element_id strictly from the "element_id" fields listed in the UI GRAPH.
- NEVER fabricate, hallucinate, or predict generic IDs (e.g., "agent_12", "btn_1", "input_0").
- If the required element is not listed in the UI GRAPH, output action="ASK_USER" or "WAIT".

Respond with ONLY a valid JSON object matching this schema, no prose or markdown:
{
  "action": "CLICK" | "TYPE" | "SCROLL" | "SELECT" | "NAVIGATE" | "WAIT" | "DONE" | "ASK_USER",
  "element_id": string or null,
  "value": string or null,
  "reasoning": short string explaining your decision,
  "confidence": number between 0.0 and 1.0,
  "done": boolean
}

Action-Specific Guidelines:
- "CLICK", "TYPE", "SELECT" MUST provide a valid element_id present in the UI GRAPH.
- "TYPE" and "SELECT" MUST provide a non-empty string in "value".
- Use "DONE" with done=true only when the task is fully completed.
- Use "ASK_USER" if user input is needed or if a redacted value (e.g. PASSWORD_REDACTED) must be entered by the user.
"""


def build_user_prompt(request: TaskRequest) -> str:
    valid_ids = [el.element_id for el in request.context.ui_graph if el.element_id]
    
    graph_json = json.dumps(
        [el.model_dump(exclude_none=True) for el in request.context.ui_graph],
        indent=2,
    )
    history = "\n".join(f"- {h}" for h in request.history) or "(none yet)"

    return f"""TASK: {request.task}

DOMAIN: {request.context.url_domain or "unknown"}

AVAILABLE VALID ELEMENT_IDS:
{json.dumps(valid_ids)}

ACTION HISTORY:
{history}

UI GRAPH (sanitized):
{graph_json}
"""