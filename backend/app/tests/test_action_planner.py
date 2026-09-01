import pytest

from app.schemas.context import SanitizedContext, TaskRequest, UIElement
from app.services.action_planner import ActionPlanner


class FakeLLMClient:
    """Stands in for LLMClient so tests don't need a live vLLM server."""

    def __init__(self, canned_response: dict):
        self._canned = canned_response

    async def chat_json(self, **kwargs) -> dict:
        return self._canned


def make_request(element_ids: list[str]) -> TaskRequest:
    return TaskRequest(
        session_id="s1",
        task="click the submit button",
        context=SanitizedContext(
            session_id="s1",
            url_domain="example.com",
            ui_graph=[
                UIElement(element_id=eid, role="button", label="Submit", clickable=True)
                for eid in element_ids
            ],
        ),
    )


@pytest.mark.asyncio
async def test_valid_action_passes_through():
    fake = FakeLLMClient(
        {
            "action": "CLICK",
            "element_id": "btn_1",
            "value": None,
            "reasoning": "submit button matches task",
            "confidence": 0.92,
            "done": False,
        }
    )
    planner = ActionPlanner(fake)
    result = await planner.plan_next_action(make_request(["btn_1"]))

    assert result.action == "CLICK"
    assert result.element_id == "btn_1"


@pytest.mark.asyncio
async def test_hallucinated_element_id_is_downgraded():
    fake = FakeLLMClient(
        {
            "action": "CLICK",
            "element_id": "btn_does_not_exist",
            "value": None,
            "reasoning": "made up",
            "confidence": 0.8,
            "done": False,
        }
    )
    planner = ActionPlanner(fake)
    result = await planner.plan_next_action(make_request(["btn_1"]))

    assert result.action == "ASK_USER"
    assert result.element_id is None
    assert result.confidence == 0.0
