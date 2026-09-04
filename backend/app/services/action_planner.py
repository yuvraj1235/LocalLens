from __future__ import annotations

import logging

from app.core.config import settings
from app.schemas.context import StructuredAction, TaskRequest
from app.services.llm_client import LLMClient
from app.services.prompt_builder import SYSTEM_PROMPT, build_user_prompt

logger = logging.getLogger("agent")


class ActionPlanner:
    def __init__(self, vlm_client: LLMClient):
        # Using the VLM client since it can take the sanitized screenshot too;
        # swap to a pure-text LLM client if you want a cheaper text-only path
        # when no screenshot is attached.
        self._client = vlm_client

    async def plan_next_action(self, request: TaskRequest) -> StructuredAction:
        user_prompt = build_user_prompt(request)

        raw = await self._client.chat_json(
            system_prompt=SYSTEM_PROMPT,
            user_prompt=user_prompt,
            image_b64=request.context.screenshot_b64,
            max_tokens=settings.max_output_tokens,
        )

        action = StructuredAction.model_validate(raw)
        self._validate_against_graph(action, request)
        return action

    def _validate_against_graph(self, action: StructuredAction, request: TaskRequest) -> None:
        """
        Never trust the model's element_id blindly. If it references an id
        that isn't in the UI graph we just sent it, downgrade to ASK_USER
        rather than letting the extension click something arbitrary.
        """
        if not settings.strict_element_validation:
            return
        if action.element_id is None:
            return

        valid_ids = {el.element_id for el in request.context.ui_graph}
        if action.element_id not in valid_ids:
            hallucinated_id = action.element_id
            logger.warning(
                "Hallucination guard triggered for session %s: model requested unknown element_id '%s'",
                request.session_id,
                hallucinated_id,
            )

            action.action = "ASK_USER"
            action.element_id = None
            action.value = f"The model attempted to interact with non-existent element '{hallucinated_id}'. Please perform this step manually or re-orient the agent."
            action.confidence = 0.0
            action.reasoning = (
                f"Model referenced unknown element_id '{hallucinated_id}' (hallucination guard triggered)."
            )