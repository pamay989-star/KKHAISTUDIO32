FROM node:20-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    fonts-noto-core \
    ca-certificates \
    && pip3 install --no-cache-dir --break-system-packages edge-tts \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=4567
EXPOSE 4567

CMD ["node", "engine/auto-dub-runner.mjs"]
