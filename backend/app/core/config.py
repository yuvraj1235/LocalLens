"""
Central config, loaded from environment variables / .env.
single source of truth deployment ke liye
so server optimization (batching, timeouts, model choice) is one-file-editable.
"""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # --- Server ---
    app_name: str = "on-device-perception-agent-server"
    host: str = "0.0.0.0"
    port: int = 8000
    log_level: str = "info"

    # --- LLM / VLM backend (vLLM exposes an OpenAI-compatible endpoint) ---
    # During SIH finale you can point this at a cloud-hosted Qwen3-VL / Qwen3
    # endpoint; locally point it at your own vLLM server.
    vlm_base_url: str = "http://localhost:8001/v1"
    vlm_model_name: str = "qwen3-vl"
    vlm_api_key: str = "not-needed-for-local-vllm"

    llm_base_url: str = "http://localhost:8002/v1"
    llm_model_name: str = "qwen3"
    llm_api_key: str = "not-needed-for-local-vllm"

    request_timeout_s: float = 30.0
    max_output_tokens: int = 512

    # --- Redis (session/context cache, optional at first) ---
    redis_url: str | None = None

    # --- Safety / validation ---
    # server never trusts client-declared element ids blindly; it must appear
    # in the UI graph it was just given.
    strict_element_validation: bool = True


settings = Settings()
