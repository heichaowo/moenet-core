-- Migration: enforce unique routers.node_id
-- node_id derives each node's loopback IPs, so duplicates cause IP collisions.
-- A unique index (not a NOT NULL constraint) — Postgres treats NULLs as distinct,
-- so unassigned routers with node_id IS NULL are unaffected.
-- Idempotent: IF NOT EXISTS. Safe on prod (verified no duplicate node_ids).

CREATE UNIQUE INDEX IF NOT EXISTS routers_node_id_unique ON routers (node_id);
