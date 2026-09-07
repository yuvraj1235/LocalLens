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

    # --- Speech / Audio Services ---
    deepgram_api_key: str = ""

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

    # --- Jev (TypeSafe AI) fast-path classification ---
    # Set TYPESAFE_API_KEY in .env to enable the Jev fast path.
    # Leave empty ("") to disable Jev and always use the VLM.
    typesafe_api_key: str = ""

    # Minimum Jev Choice confidence required to trust the classified action.
    # Below this threshold the request falls through to the VLM.
    jev_action_confidence_gate: float = 0.70

    # Minimum Jev Noul score for the winning element to be accepted.
    jev_element_score_gate: float = 0.65

    # Secondary verification probability gate.
    jev_element_verify_gate: float = 0.60

    # When True, the Jev fast path is attempted before the VLM for every
    # request.  Set to False to disable Jev globally without removing the key.
    jev_enabled: bool = True

    # Optional: minimum_confidence_threshold already used by ActionPlanner for
    # downgrading low-confidence VLM actions to ASK_USER.
    min_confidence_threshold: float | None = None


settings = Settings()