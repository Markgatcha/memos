# syntax=docker/dockerfile:1
# Multi-stage build: compile TypeScript, then run Python server

# --- Stage 1: Build TypeScript SDK ---
FROM node:22-slim AS ts-build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --ignore-scripts
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# --- Stage 2: Python runtime ---
FROM python:3.12-slim AS runtime
WORKDIR /app

# Install system deps (make/g++/python3 let better-sqlite3 compile from
# source if no prebuilt binary matches this Node version)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    nodejs \
    npm \
    make \
    g++ \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Copy Python source first (needed by hatchling for wheel build)
COPY memos/ ./memos/

# Install Python deps
COPY pyproject.toml ./
RUN pip install --no-cache-dir fastapi uvicorn[standard] pydantic langchain langchain-core ollama

# Copy built TypeScript into the bundled-SDK location the server expects
COPY --from=ts-build /app/dist ./memos/_js
COPY --from=ts-build /app/package.json ./
# Native Node deps for the bundled SDK (better-sqlite3 cannot live in a wheel)
RUN npm install --omit=dev --no-audit --no-fund better-sqlite3@^12.11.1

# Data volume
VOLUME /root/.memos

# Expose API port
EXPOSE 7400

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:7400/health || exit 1

# Default command
CMD ["uvicorn", "memos.server.main:app", "--host", "0.0.0.0", "--port", "7400"]
