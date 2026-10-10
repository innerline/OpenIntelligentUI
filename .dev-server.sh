#!/bin/sh
export PATH="$HOME/.local/bin:$HOME/.hermes/node/bin:/usr/local/bin:/usr/bin:/bin"
unset LANGFUSE_HOST LANGFUSE_PUBLIC_KEY LANGFUSE_SECRET_KEY
unset LANGFUSE_TRACING LANGSMITH_TRACING_V2 LANGCHAIN_TRACING_V2 LANGSMITH_API_KEY LANGSMITH_ENDPOINT LANGSMITH_PROJECT
export LANGGRAPH_DEPLOYMENT_URL=http://localhost:8124
cd "$HOME/GitHub/OpenIntelligentUI"
( cd apps/agent && exec uv run uvicorn main:app --host 0.0.0.0 --port 8124 --reload ) >> /tmp/oiu-agent.log 2>&1 &
cd apps/app
exec env PORT=3100 pnpm exec next dev --turbopack
