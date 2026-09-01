# Server — On-device Visual Perception for Lightweight Browser Agents (SIH2026)

## What's here

```
app/
  core/config.py        # all env-driven settings in one place
  schemas/context.py     # the CONTRACT with the extension: SanitizedContext,
                          # TaskRequest, StructuredAction — share this file's
                          # shape with Rohit/Ankit so client & server never drift
  services/llm_client.py     # OpenAI-compatible client (works with vLLM)
  services/prompt_builder.py # system + user prompt for the planner
  services/action_planner.py # calls the model, validates element_id against
                              # the UI graph we were just sent (hallucination guard)
  routers/agent.py       # WebSocket /ws/agent (realtime loop) + POST /plan-action (REST, for curl testing)
  main.py                # FastAPI app, CORS, /health
  tests/                 # pytest, uses a FakeLLMClient so no live model needed
```

## Run locally

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # edit VLM_BASE_URL etc once vLLM is up

uvicorn app.main:app --reload --port 8000
```

Test without any extension, using curl:

```bash
curl -X POST http://localhost:8000/plan-action \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "s1",
    "task": "click the submit button",
    "context": {
      "session_id": "s1",
      "url_domain": "example.com",
      "ui_graph": [
        {"element_id": "btn_1", "role": "button", "label": "Submit", "clickable": true}
      ]
    }
  }'
```

Run tests:

```bash
pytest app/tests/ -v
```

## Serving the model with vLLM (matches the tech stack doc)

```bash
pip install vllm
vllm serve Qwen/Qwen3-VL-7B-Instruct --port 8001 --api-key not-needed-for-local-vllm
```

