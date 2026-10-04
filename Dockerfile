# OpenTerminal — single image: FastAPI backend serving the built web app.
#   docker compose up --build   →  http://localhost:8000

# ---- web build ---------------------------------------------------------------
FROM node:20-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---- server ------------------------------------------------------------------
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    OPENTERM_DATA_DIR=/data OPENTERM_SQLITE_PATH=/data/openterm.db OPENTERM_WEB_DIST=/app/web
WORKDIR /app/server
COPY server/pyproject.toml ./
COPY server/app ./app
COPY server/scripts ./scripts
RUN pip install --no-cache-dir .
COPY --from=web /web/dist /app/web
VOLUME /data
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health').status==200 else 1)"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
