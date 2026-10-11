"""GLM stream shim — translates z.ai (GLM) SSE tool-call deltas into the
OpenAI shape CopilotKit expects.

Problem (found 10-10): GLM re-sends the tool_call `id`/`name` on multiple
delta chunks; OpenAI sends id only on the first. CopilotKit's event layer
keys TOOL_CALL_START on id presence -> duplicate START -> run dies.

Fix: stateful proxy. First chunk carrying an id passes through and the
id is remembered; every later chunk with the SAME id is stripped of
id+name so downstream sees argument continuation, not a new call.

Run: uvicorn on :8125 (agent venv). Point OPENAI_BASE_URL here.
"""
import json
import os
import httpx
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, Response

UPSTREAM = os.environ.get("SHIM_UPSTREAM", "https://api.z.ai/api/coding/paas/v4")
app = FastAPI()


@app.get("/v1/models")
async def models():
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.get(UPSTREAM + "/models",
                        headers={"Authorization": _auth()})
        return Response(r.content, status_code=r.status_code,
                        media_type="application/json")


def _auth():
    # the agent passes its key through; shim adds nothing
    return ""


@app.post("/v1/chat/completions")
async def chat(request: Request):
    body = await request.body()
    data = json.loads(body)
    headers = {
        "Content-Type": "application/json",
        "Authorization": request.headers.get("Authorization", ""),
    }
    stream = data.get("stream", False)
    async with httpx.AsyncClient(timeout=600) as c:
        if not stream:
            r = await c.post(UPSTREAM + "/chat/completions", content=body,
                             headers=headers)
            return Response(r.content, status_code=r.status_code,
                            media_type="application/json")

        async def gen():
            seen = {}
            async with c.stream("POST", UPSTREAM + "/chat/completions",
                                 content=body, headers=headers) as r:
                async for line in r.aiter_lines():
                    if not line.startswith("data:"):
                        yield line + "\n"
                        continue
                    payload = line[5:].strip()
                    if payload == "[DONE]":
                        yield "data: [DONE]\n"
                        continue
                    try:
                        chunk = json.loads(payload)
                    except Exception:
                        yield line + "\n"
                        continue
                    try:
                        tcs = chunk["choices"][0]["delta"].get("tool_calls")
                    except Exception:
                        tcs = None
                    if tcs:
                        for tc in tcs:
                            tc_id = tc.get("id")
                            idx = tc.get("index", 0)
                            if tc_id:
                                if tc_id in seen:
                                    # GLM duplicate: strip identity so this
                                    # reads as args-continuation downstream
                                    tc["id"] = None
                                    fn = tc.get("function") or {}
                                    if fn.get("name") and seen[tc_id].get(fn["name"]):
                                        fn["name"] = None
                                else:
                                    seen[tc_id] = {tc.get("function", {}).get("name") or "": True}
                        # strip None-id entries entirely (OpenAI shape: no id on continuation)
                        chunk["choices"][0]["delta"]["tool_calls"] = [
                            {k: v for k, v in tc.items() if v is not None}
                            for tc in tcs if not (tc.get("id") is None and not tc.get("function"))
                        ] or tcs
                    yield "data: " + json.dumps(chunk) + "\n"

        return StreamingResponse(gen(), media_type="text/event-stream")


@app.get("/healthz")
async def healthz():
    return {"ok": True}
