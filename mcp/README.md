# PepBros MCP server

A local, **read-only** MCP server that exposes **one user's** peptide data (logged
in the PepBros PWA, synced to Supabase) to an AI health agent.

## Multi-user safety
PepBros is a shared database. This server uses the **service_role** key (which can
see every user's rows), so it **scopes to a single user** — it resolves
`PEPBROS_USER_EMAIL` → `user_id` at startup and **refuses to start without one**.
Every query is filtered by that `user_id`, so other household members' peptides are
never returned.

## Tools
- `get_current_protocol()` — current stack: each peptide's dose, schedule, active cycle
- `list_recent_doses(since?, limit?)` — the dose log (date, time, peptide, amount+unit, site, notes)
- `get_dose_history(peptide, since?, limit?)` — one peptide's doses over time
- `get_peptide_supply()` — vials on hand, reorder flags, current-vial remaining units, weeks-of-supply estimate
- `get_cycles(status?)` — active/historical cycles with progress
- `get_adherence(since?)` — scheduled vs logged doses per peptide (default last 14 days)
- `list_peptides()` — the library + config

## Setup
```bash
cd mcp
npm install
cp .env.example .env      # then paste your service_role key into .env
```
Get the **service_role** key from Supabase → **Settings → API**. It bypasses RLS, so
it stays **local only** (`.env` is gitignored). This server never writes.

## Register with Claude Desktop
Add to `~/Library/Application Support/Claude/claude_desktop_config.json` under
`mcpServers` (the server reads its config from `.env`, so no secrets here):
```json
"pepbros": { "command": "/opt/homebrew/bin/node",
  "args": ["/Volumes/EXCHANGE/Peptidetracker/mcp/server.js"] }
```
Restart Claude Desktop, then verify by asking the agent to call `get_current_protocol`.

## Notes
- Requires Node 18+ (global `fetch`).
- Doses are self-describing (`amount` + `unit`). Peptide `dailyDose` is stored in mcg;
  `displayUnit` decides mcg vs mg for display.
