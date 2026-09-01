# Server — On-device Visual Perception for Lightweight Browser Agents (SIH2026)

Shreya's piece: FastAPI backend, prompt generation, structured action
generation, server optimization.

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

## Run it locally

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

Then set `VLM_BASE_URL=http://localhost:8001/v1` in `.env`. During the SIH
finale, if GPU access is limited, swap this for any cloud-hosted
OpenAI-compatible Qwen endpoint — nothing else in the code changes.

## Integration contract for the rest of the team

- **Rohit** (extension action validator/executor + WS client): the WebSocket
  at `/ws/agent` expects a JSON `TaskRequest` per message and replies with one
  `StructuredAction` JSON message. One action per round-trip so your
  Verification step (#13) can run between turns.
- **Ankit/Nishant/Yuvraj/Jayant** (local perception + redaction pipeline):
  whatever your local privacy engine outputs must serialize into
  `SanitizedContext` — specifically `ui_graph: list[UIElement]`, with
  `redaction` tags set on anything you masked (see `RedactionTag` enum). The
  server never tries to un-redact anything; it treats those values as opaque.

## Next steps / TODO

- [ ] Swap `strict_element_validation` guard rail into a proper eval metric
      (false-hallucination rate) for the "accuracy of visual context" scoring.
- [ ] Add Redis-backed session/history store once multi-turn sessions need to
      survive a server restart (currently history is passed in by the client
      each turn — stateless, scales horizontally for free).
- [ ] Add response streaming from the WS route if the demo needs lower
      perceived latency.
- [ ] Swap `chat_json`'s `response_format=json_object` for a JSON-schema
      constrained decoding call if vLLM's structured output support covers it
      — tighter than prompting alone.
