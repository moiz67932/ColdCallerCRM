# Portive Cloudflare orchestration

Vercel keeps the frontend/authenticated APIs and Telnyx webhook. Supabase keeps authoritative call/CRM state. This isolated Worker project replaces the persistent watchdog with SQLite Durable Objects, authenticated event-driven execution, alarms and a five-minute recovery scan. It requires no paid hosting, D1, Queues, KV, R2 or custom domain.

Read [the architecture audit](../../docs/CLOUDFLARE-DIALER-AUDIT.md) and [deployment runbook](../../docs/CLOUDFLARE-DIALER.md) before enabling it. Both deployment environments ship with Parallel dialing disabled. No production deployment or live calls are performed by the repository tests.

```bash
npm ci
npm run typecheck
npm test
npm run bundle
npm run probe:sdk
```

`npm test` runs in Cloudflare's local workerd runtime with real DO SQLite/alarm/eviction APIs and mocked external fetch. The root PostgreSQL integration suite exercises actual transactions, locks and the new RPCs on a disposable database. Neither suite proves real Telnyx/media timing.
