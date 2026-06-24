-- Migration: Add REJECTED status (code 8)
-- Migrates existing false-positive DISABLED sessions that were actually rejections
-- Safe: only affects sessions with 'Rejected' in last_error

-- Pre-check: show affected rows
-- SELECT uuid, asn, status, last_error FROM bgp_sessions WHERE status = 1 AND last_error LIKE 'Rejected%';

BEGIN;

UPDATE bgp_sessions 
SET status = 8 
WHERE status = 1 
  AND last_error LIKE 'Rejected%';

COMMIT;

-- Post-check: verify migration
-- SELECT uuid, asn, status, last_error FROM bgp_sessions WHERE status = 8;
