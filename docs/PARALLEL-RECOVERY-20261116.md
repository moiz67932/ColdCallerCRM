# Parallel recovery incident, 2026-11-16

Session `3094202c-6771-44ef-beb6-ed840793a0e9` placed one operator call and no prospect calls.

The stored, signature-verified operator hangup occurred 220 ms after initiation:
SIP 403, `user_busy`, CDR `recv_refuse`, connected=0 and billed seconds=0.
The operator credential connection had an empty SIP URI calling preference.
It was changed to `internal`, permitting calls only from the same account.
Live readiness now checks this setting as well as registration prerequisites.

Replaying the verified hangup failed with SQLSTATE `42501`, `permission denied
for table dialer_cost_holds`. The terminal trigger ran as service_role, whose
ledger writes are intentionally revoked. Migration 202611160005 grants owner
execution to the two fixed hold triggers, retaining direct ledger restrictions.
A disposable PostgreSQL test reproduces the failure as service_role, applies
the migration, verifies terminal updates, and verifies direct writes still fail.

After the operator applied the migration, replay succeeded. A current Telnyx GET
also confirmed `is_alive: false`. The session is stopped/disconnected, with the
original terminal timestamp and no prospect attempts. The uncertain operator
hangup command was settled using that evidence, without resending any dial.
The existing Worker then accepted a recovery wake with HTTP 200.

The operator's 12-cent hold now records terminal evidence. Actual SIP and Call
Control CDRs report zero cost; partial billing ingestion must not finalize an
invoice or release the hold. Available credit/headroom still fund the quote.

The original quote 503 response body was unavailable and retained Vercel runtime
logs contained no exception. A controlled invocation of the actual quote route
with production provider/database configuration returned 200, 18 eligible,
no blockers and no funding shortfall. No shared cause is claimed. The route now
logs sanitized operation diagnostics and the UI backs off failed quote retries.

Committed commands return their durable state and a recovery warning when a
Worker wake fails. Parallel media/heartbeat POSTs stop on failure, expiry or
non-running states; recovery uses existing bounded Worker alarms and read-only
browser polling. Diagnostics omit request bodies, headers, credentials and JWTs.
