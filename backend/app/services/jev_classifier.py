"""
backend/app/services/jev_classifier.py

Jev Classification Layer (TypeSafe AI "System One")
=====================================================

Replaces the slow VLM round-trip for clear-cut decisions by using Jev —
a non-autoregressive model optimised for fast, typed decisions (70–500 ms).

Architecture
------------
Three-pass cascade:

  Pass 1 — Action Classification (Choice)
    Which action type does this context call for?
    If Jev is confident → skip the VLM entirely.

  Pass 2 — Element Selection (Score + Noul)
    Among the candidate elements in the UI graph, which one is
    the best target?  Scores each element, then verifies the winner.

  Pass 3 — VLM Fallback
    Only reached when Jev's confidence falls below the gate thresholds.
    The VLM handles ambiguous / multi-modal cases (screenshots, etc.).

Integration points
------------------
  • ActionPlanner.plan_next_action() calls jev_fast_path() first.
  • If it returns None the caller falls through to the VLM path unchanged.
  • Confidence thresholds are tunable via Settings (see core/config.py).
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.schemas.context import TaskRequest, StructuredAction, UIElement

logger = logging.getLogger("agent.jev")

# ---------------------------------------------------------------------------
# SDK import — graceful degradation when the package is not yet installed
# ---------------------------------------------------------------------------
try:
    from typesafe_sdk import TypeSafeClient, Choice, Score, Noul  # type: ignore
    _SDK_AVAILABLE = True
except ModuleNotFoundError:
    _SDK_AVAILABLE = False
    logger.warning(
        "typesafe-sdk not installed — Jev fast path disabled. "
        "Run:  pip install typesafe-sdk"
    )

# ---------------------------------------------------------------------------
# Constants / thresholds
# ---------------------------------------------------------------------------

# Jev Choice confidence below this → escalate to VLM
JEV_ACTION_CONFIDENCE_GATE: float = 0.70

# Jev Score (element relevance) below this → escalate to VLM
JEV_ELEMENT_SCORE_GATE: float = 0.65

# Jev Noul (element verification) below this → escalate to VLM
JEV_ELEMENT_VERIFY_GATE: float = 0.60

# Maximum number of UI elements to send to Jev (keep state small)
MAX_ELEMENTS_FOR_JEV: int = 30

# Map Jev Choice labels → ActionType literals
_CHOICE_TO_ACTION: dict[str, str] = {
    "click":    "CLICK",
    "type":     "TYPE",
    "scroll":   "SCROLL",
    "select":   "SELECT",
    "navigate": "NAVIGATE",
    "wait":     "WAIT",
    "done":     "DONE",
    "ask_user": "ASK_USER",
}


# ---------------------------------------------------------------------------
# Public helpers
# ---------------------------------------------------------------------------

def is_available() -> bool:
    """True when the typesafe-sdk package is installed and importable."""
    return _SDK_AVAILABLE


def _build_element_summary(elements: list[UIElement], max_n: int = MAX_ELEMENTS_FOR_JEV) -> str:
    """
    Serialise the UI graph into a compact plaintext block that Jev can read.
    We keep it under ~2 KB so Jev's context window is not dominated by the
    element list.
    """
    lines: list[str] = []
    for el in elements[:max_n]:
        label = el.label or el.redacted_label or "(no label)"
        # Truncate very long labels
        if len(label) > 80:
            label = label[:77] + "..."
        role = el.role or "generic"
        bbox = el.bbox
        pos = f"({bbox.x:.0f},{bbox.y:.0f})" if bbox else "(?)"
        extra: list[str] = []
        if el.clickable:
            extra.append("clickable")
        if el.editable:
            extra.append("editable")
        extra_str = f"  [{', '.join(extra)}]" if extra else ""
        lines.append(f"  [{el.element_id}] {role}: \"{label}\" at {pos}{extra_str}")
    if len(elements) > max_n:
        lines.append(f"  ... and {len(elements) - max_n} more elements (truncated)")
    return "\n".join(lines)


def _build_state(request: TaskRequest) -> str:
    """
    Compose the Jev 'state' — the input context it evaluates.
    Jev works best with clean, structured text rather than raw JSON blobs.
    """
    ctx = request.context
    elements_block = _build_element_summary(ctx.ui_graph)

    state_parts = [
        f"USER TASK: {request.task}",
        f"DOMAIN: {ctx.url_domain or 'unknown'}",
        f"VIEWPORT: {ctx.viewport_width}×{ctx.viewport_height}",
    ]

    if request.history:
        state_parts.append("PRIOR STEPS:\n" + "\n".join(f"  - {h}" for h in request.history[-5:]))

    if elements_block:
        state_parts.append(f"UI ELEMENTS:\n{elements_block}")
    else:
        state_parts.append("UI ELEMENTS: (none detected)")

    return "\n".join(state_parts)


# ---------------------------------------------------------------------------
# Pass 1 — Action Classification
# ---------------------------------------------------------------------------

def _classify_action(client: TypeSafeClient, state: str) -> tuple[str | None, float]:
    """
    Ask Jev: which ActionType does this context require?

    Returns (action_type, confidence) or (None, 0.0) on failure.
    """
    try:
        result = client.system_one(
            state=state,
            questions={
                "action": Choice(
                    instructions=(
                        "Given the user's task and the current UI elements, "
                        "which single action should the browser agent take next?"
                    ),
                    criteria={
                        "click":    "Click a button, link, or other clickable element",
                        "type":     "Type text into an editable input field",
                        "select":   "Select an option from a dropdown or listbox",
                        "scroll":   "Scroll the page (no specific element to click)",
                        "navigate": "Navigate the browser to a different URL",
                        "wait":     "Wait for the page to finish loading or for an element to appear",
                        "done":     "The task is fully complete — no more actions are needed",
                        "ask_user": "The agent is uncertain and needs user clarification",
                    },
                ),
            },
        )
        answer = result.answers["action"]
        choice_key: str = answer.choice          # e.g. "click"
        confidence: float = answer.confidence     # 0.0–1.0

        action_type = _CHOICE_TO_ACTION.get(choice_key)
        if not action_type:
            logger.debug("Jev returned unknown choice key: %r", choice_key)
            return None, 0.0

        logger.debug(
            "Jev action classification → %s (confidence=%.2f)",
            action_type, confidence,
        )
        return action_type, confidence

    except Exception as exc:  # noqa: BLE001
        logger.warning("Jev action classification failed: %s", exc)
        return None, 0.0


# ---------------------------------------------------------------------------
# Pass 2 — Element Selection (Score + Noul)
# ---------------------------------------------------------------------------

def _select_element(
    client: TypeSafeClient,
    state: str,
    action_type: str,
    elements: list[UIElement],
) -> tuple[str | None, float]:
    """
    Ask Jev: among the candidate elements, which one is the best target for
    the given action?

    Strategy:
      • For each candidate element, ask Jev a Noul (yes/no) question:
        "Is this the right element to {action_type} for the user's task?"
      • Pick the element with the highest positive probability.
      • Gate on JEV_ELEMENT_SCORE_GATE.

    We batch all Noul questions in a single 
     call (Jev evaluates them
    in parallel at no latency penalty).
    """
    # Filter elements that are relevant to the action type
    candidates: list[UIElement] = []
    if action_type in ("CLICK", "TYPE", "SELECT"):
        for el in elements:
            if action_type == "CLICK" and el.clickable:
                candidates.append(el)
            elif action_type == "TYPE" and el.editable:
                candidates.append(el)
            elif action_type == "SELECT" and el.editable:
                candidates.append(el)
    else:
        # SCROLL / NAVIGATE / WAIT / DONE — no element required
        return None, 1.0

    if not candidates:
        logger.debug("No %s-eligible elements; returning None", action_type)
        return None, 0.0

    # Cap candidates to avoid a huge Jev payload
    candidates = candidates[:MAX_ELEMENTS_FOR_JEV]

    # Build per-element Noul questions
    questions: dict[str, Noul] = {}
    for el in candidates:
        label = el.label or el.redacted_label or "(no label)"
        q_key = f"el_{el.element_id}"
        questions[q_key] = Noul(
            instructions=(
                f"Is the element \"{label}\" (role={el.role}, id={el.element_id}) "
                f"the correct target for the action '{action_type}' "
                f"given the user's task?"
            )
        )

    try:
        result = client.system_one(state=state, questions=questions)

        best_id: str | None = None
        best_prob: float = 0.0

        for el in candidates:
            q_key = f"el_{el.element_id}"
            noul_answer = result.answers.get(q_key)
            if noul_answer is None:
                continue
            # Noul probability: 1.0 = definitely yes, 0.0 = definitely no
            prob: float = noul_answer.noul
            logger.debug(
                "  element %s → Noul=%.3f", el.element_id, prob
            )
            if prob > best_prob:
                best_prob = prob
                best_id = el.element_id

        logger.debug(
            "Jev element selection → %s (score=%.2f)",
            best_id, best_prob,
        )
        return best_id, best_prob

    except Exception as exc:  # noqa: BLE001
        logger.warning("Jev element selection failed: %s", exc)
        return None, 0.0


# ---------------------------------------------------------------------------
# Pass 2b — Element Verification (secondary Noul gate)
# ---------------------------------------------------------------------------

def _verify_element(
    client: TypeSafeClient,
    state: str,
    action_type: str,
    element: UIElement,
) -> tuple[bool, float]:
    """
    Final verification gate: ask Jev to confirm the winner before we commit.
    Returns (verified, probability).
    """
    label = element.label or element.redacted_label or "(no label)"
    try:
        result = client.system_one(
            state=state,
            questions={
                "verified": Noul(
                    instructions=(
                        f"Confirm: should the browser agent perform '{action_type}' "
                        f"on the element \"{label}\" (role={element.role}, id={element.element_id}) "
                        f"to make progress on the user's task? "
                        f"Answer yes only if you are confident this is correct."
                    )
                ),
            },
        )
        prob: float = result.answers["verified"].noul
        verified = prob >= JEV_ELEMENT_VERIFY_GATE
        logger.debug(
            "Jev element verification → verified=%s (p=%.3f)", verified, prob
        )
        return verified, prob

    except Exception as exc:  # noqa: BLE001
        logger.warning("Jev element verification failed: %s", exc)
        return False, 0.0


# ---------------------------------------------------------------------------
# Pass 3 (optional) — Type-value extraction for TYPE actions
# ---------------------------------------------------------------------------

def _extract_type_value(
    client: TypeSafeClient,
    state: str,
    element: UIElement,
) -> str | None:
    """
    For TYPE actions: ask Jev whether the value to type is deterministic
    from context.  If not confident, return None to let the VLM handle it.
    """
    label = element.label or element.redacted_label or "the input field"
    try:
        result = client.system_one(
            state=state,
            questions={
                "has_value": Noul(
                    instructions=(
                        f"Is the text to type into \"{label}\" "
                        f"unambiguously specified in the user's task?"
                    )
                ),
                "value_type": Choice(
                    instructions=(
                        f"What kind of value should be typed into \"{label}\"?"
                    ),
                    criteria={
                        "explicit":   "The user stated the exact text in their task",
                        "inferred":   "The value can be inferred from context or prior steps",
                        "unknown":    "The value is not clear from the available context",
                    },
                ),
            },
        )

        has_value_prob: float = result.answers["has_value"].noul
        value_type: str = result.answers["value_type"].choice

        if has_value_prob < 0.75 or value_type == "unknown":
            return None  # let VLM fill in

        # Very simple heuristic: extract quoted strings from the task
        import re
        task_text = state.split("USER TASK:")[-1].split("\n")[0].strip()
        quoted = re.findall(r'["\']([^"\']{1,200})["\']', task_text)
        if quoted:
            return quoted[0]

        return None  # still let VLM pick the exact value

    except Exception as exc:  # noqa: BLE001
        logger.warning("Jev value extraction failed: %s", exc)
        return None


# ---------------------------------------------------------------------------
# Public API — main entry point
# ---------------------------------------------------------------------------

async def jev_fast_path(
    request: TaskRequest,
    api_key: str,
) -> StructuredAction | None:
    """
    Attempt to resolve the next action purely via Jev (no VLM call).

    Returns a StructuredAction if Jev is confident enough, or None to
    signal that the VLM fallback should be used instead.

    This function is intentionally synchronous inside but declared async
    so it can be awaited at the call-site without breaking the existing
    async ActionPlanner interface.  Jev's SDK is currently synchronous;
    wrap with asyncio.to_thread if latency becomes a concern.
    """
    if not _SDK_AVAILABLE:
        return None

    from app.schemas.context import StructuredAction  # local import to avoid circular

    # ---------------------------------------------------------------------------
    # Initialise client (auto-reads TYPESAFE_API_KEY env var if key=="env")
    # ---------------------------------------------------------------------------
    try:
        kwargs = {}
        if api_key and api_key.lower() not in ("", "env", "not-set"):
            kwargs["api_key"] = api_key
            if api_key.startswith("sk-or-"):
                # Route through OpenRouter's System One endpoint
                kwargs["base_url"] = "https://openrouter.ai/api"
                kwargs["model"] = "~typesafe/jev-latest"
        client = TypeSafeClient(**kwargs)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to initialise TypeSafeClient: %s", exc)
        return None

    state = _build_state(request)

    # ------------------------------------------------------------------
    # Pass 1: Action classification
    # ------------------------------------------------------------------
    action_type, action_confidence = _classify_action(client, state)

    if not action_type or action_confidence < JEV_ACTION_CONFIDENCE_GATE:
        logger.info(
            "Jev action confidence %.2f < gate %.2f — escalating to VLM",
            action_confidence, JEV_ACTION_CONFIDENCE_GATE,
        )
        return None

    # Terminal actions need no element
    if action_type in ("DONE", "WAIT", "NAVIGATE", "SCROLL"):
        logger.info("Jev resolved terminal/no-element action: %s", action_type)
        return StructuredAction(
            action=action_type,  # type: ignore[arg-type]
            element_id=None,
            value=None,
            reasoning=f"Jev classified action as {action_type} (confidence={action_confidence:.2f})",
            confidence=action_confidence,
            done=(action_type == "DONE"),
        )

    # ------------------------------------------------------------------
    # Pass 2: Element selection
    # ------------------------------------------------------------------
    element_id, element_score = _select_element(
        client, state, action_type, request.context.ui_graph
    )

    if not element_id or element_score < JEV_ELEMENT_SCORE_GATE:
        logger.info(
            "Jev element score %.2f < gate %.2f — escalating to VLM",
            element_score, JEV_ELEMENT_SCORE_GATE,
        )
        return None

    # Find the winner element object for verification
    winner = next(
        (el for el in request.context.ui_graph if el.element_id == element_id), None
    )
    if not winner:
        logger.warning("Jev selected element_id %r not found in UI graph", element_id)
        return None

    # ------------------------------------------------------------------
    # Pass 2b: Element verification
    # ------------------------------------------------------------------
    verified, verify_prob = _verify_element(client, state, action_type, winner)
    if not verified:
        logger.info(
            "Jev verification failed (p=%.2f) — escalating to VLM", verify_prob
        )
        return None

    # ------------------------------------------------------------------
    # Pass 3 (optional): Value extraction for TYPE
    # ------------------------------------------------------------------
    value: str | None = None
    if action_type == "TYPE":
        value = _extract_type_value(client, state, winner)
        if value is None:
            # Can't resolve the value without the VLM
            logger.info("Jev could not determine TYPE value — escalating to VLM")
            return None

    # ------------------------------------------------------------------
    # Composite confidence: geometric mean of action + element + verify
    # ------------------------------------------------------------------
    composite_confidence = (action_confidence * element_score * verify_prob) ** (1 / 3)

    logger.info(
        "Jev resolved: action=%s element=%s composite_confidence=%.3f",
        action_type, element_id, composite_confidence,
    )

    return StructuredAction(
        action=action_type,  # type: ignore[arg-type]
        element_id=element_id,
        value=value,
        reasoning=(
            f"Jev (fast path): action={action_type} confidence={action_confidence:.2f}, "
            f"element={element_id} score={element_score:.2f}, "
            f"verified={verify_prob:.2f}"
        ),
        confidence=round(composite_confidence, 4),
        done=False,
    )
