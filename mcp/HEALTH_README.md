# Health MCP server + Apple Health auto-export

Exposes **one user's** Apple Health data (steps, sleep, HRV, resting HR, weight,
workouts, …) to an AI health agent — read-only — the same way the PepBros MCP
exposes peptides. No more pulling a report every 7 days and dropping it in
`/healthdata`.

## Why there's an ingest function (Apple Health has no cloud API)

HealthKit data lives on your phone; nothing queries it remotely. So the data path is:

```
iPhone — "Health Auto Export" app (daily, background)
   │  POST JSON  (Authorization: Bearer <secret>)
   ▼
Supabase Edge Function  health-ingest   ← reshapes + upserts, holds the keys
   ▼
Supabase table  health   (user_id, id, data jsonb, …)   ← same shape as the other stores
   ▼
mcp/health-server.js   (read-only, scoped to your user)   →   Health Agent
```

## Multi-user safety
Same guarantee as PepBros: the server uses the **service_role** key (sees every
row), so it **scopes to a single user** — resolves `HEALTH_USER_EMAIL` → `user_id`
at startup and **refuses to start without one**. `HEALTH_*` env vars fall back to
the existing `PEPBROS_*` ones (same Supabase project), so your current `mcp/.env`
already works — no new secrets needed for the read side.

## Tools
- `list_available_metrics()` — which metrics are exported, with date ranges (call first)
- `get_daily_metrics(date?)` — all metric values for one day (default: latest)
- `get_metric_history(metric, since?, limit?)` — one metric over time
- `get_sleep(since?, limit?)` — nightly time in bed / asleep + stage breakdown
- `get_workouts(since?, limit?)` — workout sessions: HR, calories, duration, start time
- `get_recent_summary(days?)` — rollup of the last N days (default 7)

### Workout reconciliation with LiftLog
`get_workouts` returns the **physiological** side of a session (HR, calories,
duration). The **lifts/sets/weights** stay in the LiftLog MCP. The `get_workouts`
description tells the agent to match the two by **date + start time** and count
them as **one** session — so strength workouts are never double-counted.

---

## Setup — one-time

### 1. Create the table
In the Supabase **SQL editor** (same place the other tables' DDL ran), paste and
run [`../supabase/health_schema.sql`](../supabase/health_schema.sql).

### 2. Deploy the ingest function
```bash
# from the repo root, with the Supabase CLI logged in to this project
supabase functions deploy health-ingest --no-verify-jwt   # --no-verify-jwt: the phone uses our own bearer secret, not a Supabase JWT
supabase secrets set HEALTH_INGEST_SECRET="$(openssl rand -hex 24)"   # note the value
supabase secrets set HEALTH_INGEST_USER_ID="<your user_id>"           # same id the MCP scopes to
```
Get your `user_id` from Supabase → **Authentication → Users** (your `jsmc88@gmail.com`
row), or it's whatever the PepBros server resolved. The function URL is:
`https://mxcpjsdvdqhgutdzzggo.supabase.co/functions/v1/health-ingest`

The secret is passed in the **URL** as `?key=…`, NOT a header — Health Auto Export
does not reliably attach custom headers (the function also accepts `Authorization:
Bearer` or an `x-api-key` header if some other client can send them).

Smoke-test it (secret in the query string):
```bash
SECRET=<HEALTH_INGEST_SECRET>
curl -X POST "https://mxcpjsdvdqhgutdzzggo.supabase.co/functions/v1/health-ingest?key=$SECRET" \
  -H "content-type: application/json" \
  -d '{"data":{"metrics":[{"name":"step_count","units":"count","data":[{"date":"2026-06-17 00:00:00 -0500","qty":8123}]}]}}'
# → {"ok":true,"upserted":1}
```

### 3. Configure Health Auto Export on the iPhone
Install **"Health Auto Export – JSON+CSV"** (Lyfeware) and create an **Automation**:
- **Type:** REST API  ·  **Format:** JSON
- **URL (secret included):**
  `https://mxcpjsdvdqhgutdzzggo.supabase.co/functions/v1/health-ingest?key=<HEALTH_INGEST_SECRET>`
- **Aggregation:** **per day**, and crucially the **method must fit the metric** —
  **Sum** for cumulative metrics (Step Count, Active Energy), **Average** for rate/level
  metrics (Heart Rate, Resting HR, HRV, Weight). Averaging steps yields a tiny fractional
  value, not the daily total. The function keeps ONE value per metric per day, so the
  aggregation has to be correct on the phone side.
- **Schedule:** daily (e.g. 06:00). Enable background delivery.
- **First run:** keep the date range to ~1 day to confirm it lands fast, then widen the
  backfill — a full-history export of every metric can be large enough to time out
  (`NSURLError -1001`) on the phone before the upload finishes.
- **Metrics to enable:**
  - *Core daily:* Step Count, Active Energy, Resting Heart Rate, Weight & Body Fat %
  - *Sleep:* Sleep Analysis
  - *Cardio/recovery:* Heart Rate Variability, VO2 Max, Respiratory Rate, Blood Oxygen
  - *Workouts:* enable workout export (carries type, HR, calories, duration)

> Automated REST export needs the app's paid tier (~a few $/mo). Metric names in
> the payload (e.g. `step_count`, `heart_rate_variability`, `body_mass`) are what
> `get_metric_history` expects — `list_available_metrics` shows the exact strings
> once data lands. A secret in the URL can appear in server logs — rotate it
> (`supabase secrets set HEALTH_INGEST_SECRET=…` + update the phone URL) if that matters.

### 4. Register the MCP server with Claude Desktop
Add to `~/Library/Application Support/Claude/claude_desktop_config.json` under
`mcpServers` (alongside `pepbros`):
```json
"health": { "command": "/opt/homebrew/bin/node",
  "args": ["/Volumes/EXCHANGE/Peptidetracker/mcp/health-server.js"] }
```
Restart Claude Desktop, then ask the agent to call `list_available_metrics`.

## Notes
- Requires Node 18+ (global `fetch`). Shares `mcp/node_modules` and `mcp/.env` with the PepBros server.
- Re-exports upsert on `(user_id, id)`, so re-sending a day overwrites it — safe to run daily.
- The server never writes; the only writer is the Edge Function.
