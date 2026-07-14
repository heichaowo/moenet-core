#!/bin/bash
# Deploy (or roll back) the moenet-core app on the control plane.
#
# Usage:
#   ./deploy.sh            # deploy the VERSION already set in .env
#   ./deploy.sh 3.1.0      # pin api/bot to image tag 3.1.0 (also the rollback path)
#
# Run this FROM the control-plane checkout (/opt/moenet-core), where the
# server-local docker-compose.override.yml lives. It only touches the app
# services (api, bot) — the ones tagged with ${VERSION}. Traefik/Postgres/
# Redis/Prometheus/Grafana are left untouched, which also sidesteps the
# external-volume abort that a full `up -d` can hit.
#
# NOTE: uses a BARE `docker compose` on purpose. Passing `-f docker-compose.yml`
# silently drops docker-compose.override.yml (Traefik loses its file provider
# and cert mounts). See docs/operations/deployment.md.

set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
    echo "❌ .env not found. Copy from .env.example and configure."
    exit 1
fi

# A version argument pins the image tag (overriding .env); no argument keeps
# whatever VERSION .env already declares.
VERSION_ARG="${1:-}"
if [ -n "$VERSION_ARG" ]; then
    export VERSION="$VERSION_ARG"
    echo "🚀 Deploying moenet-core app pinned to version: $VERSION"
else
    echo "🚀 Deploying moenet-core app (VERSION from .env)"
fi

echo "📦 Pulling app images..."
docker compose pull api bot

echo "🔄 Starting app services..."
docker compose up -d api bot

echo "⏳ Waiting for api to report healthy..."
status=""
for _ in $(seq 1 30); do
    status="$(docker inspect -f '{{.State.Health.Status}}' moenet-api 2>/dev/null || echo missing)"
    [ "$status" = "healthy" ] && break
    sleep 2
done

if [ "$status" != "healthy" ]; then
    echo "❌ api did not become healthy (last status: $status)"
    docker compose logs --tail=50 api
    exit 1
fi
echo "✅ api is healthy"

# Reclaim space from the images we just replaced. Dangling-only — never
# `system prune`, which would also reap the co-hosted stacks on this machine.
echo "🧹 Pruning dangling images..."
docker image prune -f

echo "✅ Deployment complete!"
docker compose ps api bot
