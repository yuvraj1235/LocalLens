"""
Thin async client around an OpenAI-compatible chat completions endpoint.
vLLM serves this out of the box (`vllm serve <model> --api-key ...`), and it's
also what most hosted Qwen-compatible endpoints speak — so this same client
works locally during dev and against a cloud endpoint at the finale, just by
swapping base_url / api_key / model in config.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any

import httpx

from app.core.config import settings

logger = logging.getLogger("agent")



class LLMClient:
    def __init__(self, base_url: str, api_key: str, model: str, timeout: float):
        self._base_url = base_url.rstrip("/")
        self._model = model
        self._api_key = api_key
        self._client = httpx.AsyncClient(
            base_url=self._base_url,
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=timeout,
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def chat_json(
        self,
        system_prompt: str,
        user_prompt: str,
        image_b64: str | None = None,
        max_tokens: int = 512,
    ) -> dict[str, Any]:
        """
        Calls chat/completions and parses the response as JSON.
        Raises ValueError if the model didn't return valid JSON — caller decides
        how to handle/retry (this is intentionally strict; structured-action
        parsing should never silently guess).
        """
        # MOCK MODE check
        if self._api_key == "bana lijie":
            import asyncio
            await asyncio.sleep(1)  # simulate network delay
            if "submit" in user_prompt.lower():
                return {"action": "DONE", "value": None, "element_id": None, "confidence": 1.0}
            else:
                return {
                    "action": "ASK_USER",
                    "value": "Running in MOCK mode because VLM_API_KEY is set to 'bana lijie'. Provide a real API key in .env to call OpenRouter.",
                    "element_id": None,
                    "confidence": 1.0,
                }

        content: Any
        if image_b64:
            content = [
                {"type": "text", "text": user_prompt},
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/png;base64,{image_b64}"},
                },
            ]
        else:
            content = user_prompt

        # NOTE: Do NOT send response_format: json_object to OpenRouter/Qwen —
        # it causes some providers to return null content. Instead we instruct
        # the model via the system prompt and parse the text ourselves.
        payload = {
            "model": self._model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": content},
            ],
            "max_tokens": max_tokens,
            "temperature": 0.0,
        }

        resp = await self._client.post("/chat/completions", json=payload)
        if not resp.is_success:
            logger.error("API error %s: %s", resp.status_code, resp.text)
        resp.raise_for_status()
        data = resp.json()

        msg = data["choices"][0]["message"]
        text: str | None = msg.get("content")

        # Qwen3 on OpenRouter sometimes puts the answer only in reasoning_content
        # and leaves content=null when thinking mode is active.
        if text is None:
            text = msg.get("reasoning_content") or msg.get("reasoning")
            if text is None:
                logger.error("Null content from model. Full response: %s", data)
                raise ValueError(
                    "Model returned null content. Full response logged above. "
                    "Try switching VLM_MODEL_NAME to 'qwen/qwen3-8b' or 'mistralai/mistral-7b-instruct'."
                )
            logger.debug("Falling back to reasoning_content field")

        # Strip <think>...</think> reasoning blocks emitted by Qwen3
        text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()

        if not text:
            raise ValueError("Model response was empty after stripping <think> blocks.")

        # Try direct JSON parse first
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            pass

        # Fallback: extract JSON from markdown code fences
        match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
        if match:
            try:
                return json.loads(match.group(1))
            except json.JSONDecodeError:
                pass

        # Last resort: find first { ... } block in the text
        match = re.search(r"(\{.*\})", text, re.DOTALL)
        if match:
            try:
                return json.loads(match.group(1))
            except json.JSONDecodeError:
                pass

        raise ValueError(f"Model did not return valid JSON: {text!r}")


def get_vlm_client() -> LLMClient:
    return LLMClient(
        base_url=settings.vlm_base_url,
        api_key=settings.vlm_api_key,
        model=settings.vlm_model_name,
        timeout=settings.request_timeout_s,
    )


def get_llm_client() -> LLMClient:
    return LLMClient(
        base_url=settings.llm_base_url,
        api_key=settings.llm_api_key,
        model=settings.llm_model_name,
        timeout=settings.request_timeout_s,
    )