-- Migration: add bgp_sessions.observed_endpoint
-- Stores the source IP the agent learns from a NAT peer's WireGuard handshake.
-- NAT peers connect without a declared endpoint, so their origin can't be vetted
-- at approval time; the agent reports the learned IP and the CP geolocates it to
-- enforce CN/region policy at connect time.
-- Idempotent: IF NOT EXISTS. Non-destructive: nullable column, no data change.

ALTER TABLE bgp_sessions ADD COLUMN IF NOT EXISTS observed_endpoint VARCHAR(255);
