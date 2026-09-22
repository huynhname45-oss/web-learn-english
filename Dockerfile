# Atlas English - Container for macOS (Apple Silicon / Intel) & Linux
FROM node:22-bookworm-slim

# Install Python and dependencies for neural text-to-speech
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy all application files
COPY . .

# Setup Python virtual environment with edge-tts
RUN python3 -m venv /app/.venv-speech && \
    /app/.venv-speech/bin/pip install --no-cache-dir edge-tts

# Install Linux-native workerd and sharp binaries
RUN npm install --no-package-lock miniflare@3.20241205.0 sharp

# Configure container environment
ENV NODE_ENV=production
ENV ATLAS_DATA_DIR=/app/data
ENV ATLAS_HOST=0.0.0.0
ENV ATLAS_PORT=3000
ENV ATLAS_PYTHON_EXE=/app/.venv-speech/bin/python
ENV PORT=3000

# Persistent volume for user study progress, test scores and notes
VOLUME ["/app/data"]

EXPOSE 3000

CMD ["node", "scripts/server.mjs"]
