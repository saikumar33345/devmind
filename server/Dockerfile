FROM node:22-bookworm-slim

WORKDIR /app

# ONNX-based embeddings require the OpenMP runtime on slim Debian images.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libgomp1 \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=10000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY scripts ./scripts

EXPOSE 10000

CMD ["node", "src/server.js"]
