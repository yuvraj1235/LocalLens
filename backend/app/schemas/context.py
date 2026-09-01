"""
These schemas are the CONTRACT between Ankit/Rohit's extension and this server.
Nothing in here should ever carry raw PII — the extension's local privacy
engine (Nishant/Yuvraj/Jayant's pipeline) must have already redacted before
this reaches the server. The server enforces shape, not privacy — privacy is
enforced on-device, but we still validate here defensively.
"""
from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field


class BoundingBox(BaseModel):
    x: float
    y: float
    width: float
    height: float


class RedactionTag(str, Enum):
    PASSWORD = "PASSWORD_REDACTED"
    EMAIL = "EMAIL_REDACTED"
    CARD = "CARD_REDACTED"
    FACE = "FACE_BLURRED"
    PII_GENERIC = "PII_REDACTED"
    NONE = "NONE"


class UIElement(BaseModel):
    """One node from the local UI Graph (DOM + accessibility tree + CV fusion)."""

    element_id: str = Field(..., description="Stable id assigned client-side, e.g. 'btn_17'")
    role: str = Field(..., description="ARIA role / element type, e.g. 'button', 'textbox'")
    label: str | None = Field(None, description="Visible or accessible text, already sanitized")
    bbox: BoundingBox | None = None
    redaction: RedactionTag = RedactionTag.NONE
    clickable: bool = False
    editable: bool = False


class SanitizedContext(BaseModel):
    """The ONLY payload allowed to leave the device, per the architecture doc."""

    session_id: str
    url_domain: str | None = Field(
        None, description="Domain only, no path/query — avoid leaking URL-embedded PII"
    )
    screenshot_b64: str | None = Field(
        None, description="Sanitized/redacted screenshot, already blurred/masked client-side"
    )
    ui_graph: list[UIElement] = Field(default_factory=list)
    viewport_width: int | None = None
    viewport_height: int | None = None


class TaskRequest(BaseModel):
    """What the user asked the agent to do, plus the current sanitized context."""

    session_id: str
    task: str = Field(..., description="Natural language user goal, e.g. 'submit this form'")
    context: SanitizedContext
    history: list[str] = Field(
        default_factory=list, description="Short log of prior actions this session, for grounding"
    )


ActionType = Literal["CLICK", "TYPE", "SCROLL", "SELECT", "NAVIGATE", "WAIT", "DONE", "ASK_USER"]


class StructuredAction(BaseModel):
    """What the server hands back for the Action Validator/Executor to run."""

    action: ActionType
    element_id: str | None = Field(None, description="Required for CLICK/TYPE/SELECT")
    value: str | None = Field(None, description="Text to type, option to select, etc.")
    reasoning: str | None = Field(None, description="Short rationale, useful for debugging/eval")
    confidence: float = Field(ge=0.0, le=1.0, default=0.0)
    done: bool = False
