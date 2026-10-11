"""
This is the main entry point for the agent.
It defines the workflow graph, state, tools, nodes and edges.
"""

import os
import warnings

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from copilotkit import CopilotKitMiddleware
from ag_ui_langgraph import add_langgraph_fastapi_endpoint
from ag_ui.core import EventType
from deepagents import create_deep_agent

from src.anthropic_compat import ConsecutiveSystemMessagesMiddleware
from src.bounded_memory_saver import BoundedMemorySaver
from src.model import build_model, RequestModelMiddleware, CredentialScopedModel
from src.credentials import (
    CredentialsMiddleware,
    CredentialScopedAgent,
    current_credentials,
    validate_credentials,
)
from src.visualization_router import JevVisualizationMiddleware
from src.skill_backend import SKILL_SOURCES, build_agent_backend
from src.query import query_data
from src.todos import AgentState, todo_tools
from src.form import generate_form
from src.trip_images import get_trip_stop_images
from src.plan import plan_visualization
from src.prompt import SYSTEM_PROMPT

load_dotenv()

agent = create_deep_agent(
    model=CredentialScopedModel(fallback=build_model(allow_unconfigured=True)),
    tools=[query_data, get_trip_stop_images, plan_visualization, *todo_tools, generate_form],
    middleware=[
        RequestModelMiddleware(),
        CopilotKitMiddleware(),
        JevVisualizationMiddleware(),
        ConsecutiveSystemMessagesMiddleware(),
    ],
    context_schema=AgentState,
    skills=SKILL_SOURCES,
    backend=build_agent_backend,
    checkpointer=BoundedMemorySaver(max_threads=200),
    system_prompt=SYSTEM_PROMPT,
)

app = FastAPI()
app.add_middleware(CredentialsMiddleware)


class DedupToolCallAgent(CredentialScopedAgent):
    """GLM/langgraph double-emit guard: the framework can emit the same
    tool-call sequence twice per run; the @ag-ui client treats a second
    TOOL_CALL_START for an open id as fatal. Drop duplicates at dispatch."""

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self._open_tool_calls = set()

    def _dispatch_event(self, event):
        t = getattr(event, "type", None)
        try:
            with open("/tmp/agent-events.log", "a") as f:
                f.write(f"{t} {getattr(event,'tool_call_id',getattr(event,'message_id',''))} "
                        f"{getattr(event,'tool_call_name','')} {str(getattr(event,'delta',''))[:60]}\n")
        except Exception:
            pass
        if t == EventType.RUN_STARTED:
            self._open_tool_calls.clear()
        elif t == EventType.TOOL_CALL_START:
            tcid = getattr(event, "tool_call_id", None)
            if tcid in self._open_tool_calls:
                return None
            self._open_tool_calls.add(tcid)
        elif t == EventType.TOOL_CALL_ARGS:
            if getattr(event, "tool_call_id", None) not in self._open_tool_calls:
                return None
        elif t == EventType.TOOL_CALL_END:
            tcid = getattr(event, "tool_call_id", None)
            if tcid not in self._open_tool_calls:
                return None
            self._open_tool_calls.discard(tcid)
        return super()._dispatch_event(event)


@app.post("/credentials/validate")
async def validate_provider_credentials():
    credentials = current_credentials.get()
    if credentials is None:
        return JSONResponse({"ok": False, "code": "invalid_keys"}, status_code=400)
    return await validate_credentials(credentials)


@app.get("/health")
def health():
    return {"status": "ok"}


add_langgraph_fastapi_endpoint(
    app=app,
    agent=DedupToolCallAgent(
        name="honey",
        description="Honey — answers you can interact with",
        graph=agent,
    ),
    path="/",
)

warnings.filterwarnings("ignore", category=UserWarning, module="pydantic")

if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8123"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
