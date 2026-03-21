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

# Install system deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    nodejs \
    npm \
    && rm -rf /var/lib/apt/lists/*

# Copy Python source first (needed by hatchling for wheel build)
COPY server/ ./server/
COPY adapters/ ./adapters/

# Install Python deps
COPY pyproject.toml ./
RUN pip install --no-cache-dir fastapi uvicorn[standard] pydantic langchain langchain-core ollama

# Copy built TypeScript
COPY --from=ts-build /app/dist ./src
COPY --from=ts-build /app/package.json ./

# Data volume
VOLUME /root/.memos

# Expose API port
EXPOSE 7400

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:7400/health || exit 1

# Default command
CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "7400"]
