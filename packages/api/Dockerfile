FROM oven/bun:1

WORKDIR /app

# Copy root package file for workspace context
COPY package.json ./

# Copy API package files and source first
COPY packages/api ./packages/api

# Copy SQL migrations (repo-root migrations/ → /app/migrations). The migration
# runner resolves this at runtime; without it migrations never run (bug-list #3).
COPY migrations ./migrations

# Install dependencies in packages/api (after source is copied)
WORKDIR /app/packages/api
RUN bun install

EXPOSE 3000

CMD ["bun", "run", "start"]
