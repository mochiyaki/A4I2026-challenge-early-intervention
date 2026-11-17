# =============================================================================
# A4I 2026 · Challenge 04 ("First Milestones")
# Unified Cloud Run Container:
#   - Official Google MCP Toolbox for Databases (`v0.27.0`)
#   - Python ADK Multi-Agent Hierarchy (`first_milestones`) + Gemini on Vertex AI
#   - FastAPI + SSE `/run` Streaming + Cytoscape.js Split-Pane Coordinator UI
# =============================================================================
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080 \
    TOOLBOX_URL=http://127.0.0.1:5000 \
    A4I_DATASET=a4i_early_intervention \
    A4I_MULTISTATE_DATASET=a4i_early_intervention_multistate \
    A4I_GEMINI_MODEL=gemini-2.5-pro \
    A4I_GEMINI_FALLBACK_MODELS=gemini-2.5-flash,gemini-3-flash-preview,gemini-3.1-pro-preview \
    A4I_SUBAGENT_MODEL=gemini-2.5-flash

WORKDIR /app

# Install curl + CA certificates and download official Google MCP Toolbox binary
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates \
    && curl -fsSL -o /usr/local/bin/toolbox \
      https://storage.googleapis.com/genai-toolbox/v0.27.0/linux/amd64/toolbox \
    && chmod +x /usr/local/bin/toolbox \
    && rm -rf /var/lib/apt/lists/*

COPY agent/requirements.txt agent/pyproject.toml* /app/agent/
RUN pip install --no-cache-dir -r /app/agent/requirements.txt

# Copy starter GeoParquet tables, vendored frontend assets, and ADK application
COPY data /app/data
COPY agent/static/vendor /app/agent/static/vendor
COPY agent /app/agent
RUN chmod +x /app/agent/entrypoint.sh

EXPOSE 8080

CMD ["/app/agent/entrypoint.sh"]
