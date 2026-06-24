FROM oven/bun:1 AS builder

WORKDIR /app

# Copy package files
COPY package.json bun.lock ./
COPY packages/bot/package.json ./packages/bot/

# Install dependencies
RUN bun install

# Copy source
COPY packages/bot ./packages/bot

# Build
RUN cd packages/bot && bun build src/index.ts --outdir=dist --target=bun

# Production image
FROM oven/bun:1-slim

# Install openssh-client (ssh-keygen) and gnupg (gpg) for signature verification
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssh-client \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/packages/bot/dist ./
COPY --from=builder /app/node_modules ./node_modules

CMD ["bun", "run", "index.js"]
