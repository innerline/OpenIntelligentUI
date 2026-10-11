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
    if not stream:
        async with httpx.AsyncClient(timeout=600) as c:
            r = await c.post(UPSTREAM + "/chat/completions", content=body,
                             headers=headers)
            return Response(r.content, status_code=r.status_code,
                            media_type="application/json")

    async def gen():
        seen = {}
        async with httpx.AsyncClient(timeout=600) as c:
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
                        out = []
                        for tc in tcs:
                            tc_id = tc.get("id")
                            if tc_id and tc_id in seen:
                                fn = tc.get("function") or {}
                                cont = {"index": tc.get("index", 0),
                                        "function": {"arguments": fn.get("arguments", "")}}
                                out.append(cont)
                            elif tc_id:
                                nm = (tc.get("function") or {}).get("name") or ""
                                seen[tc_id] = {nm: True}
                                out.append(tc)
                            else:
                                out.append(tc)
                        chunk["choices"][0]["delta"]["tool_calls"] = out
                    yield "data: " + json.dumps(chunk) + "\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.get("/healthz")
async def healthz():
    return {"ok": True}
