"""
Thin async client around an OpenAI-compatible chat completions endpoint.
vLLM serves this out of the box (`vllm serve <model> --api-key ...`), and it's
also what most hosted Qwen-compatible endpoints speak — so this same client
works locally during dev and against a cloud endpoint at the finale, just by
swapping base_url / api_key / model in config.
"""
from __future__ import annotations

import json
from typing import Any

import httpx

from app.core.config import settings


class LLMClient:
    def __init__(self, base_url: str, api_key: str, model: str, timeout: float):
        self._base_url = base_url.rstrip("/")
        self._model = model
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

        payload = {
            "model": self._model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": content},
            ],
            "max_tokens": max_tokens,
            "temperature": 0.0,  # deterministic action planning
            "response_format": {"type": "json_object"},
        }

        resp = await self._client.post("/chat/completions", json=payload)
        resp.raise_for_status()
        data = resp.json()
        text = data["choices"][0]["message"]["content"]

        try:
            return json.loads(text)
        except json.JSONDecodeError as e:
            raise ValueError(f"Model did not return valid JSON: {text!r}") from e


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
