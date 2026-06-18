#!/usr/bin/env node
'use strict';

// ── Health MCP server ─────────────────────────────────────────────────────────
// Exposes ONE user's Apple Health data to an AI health agent as structured tools.
// Read-only.
//
// Apple Health (HealthKit) has no cloud API, so the data path is:
//   iPhone "Health Auto Export" app  →  POST JSON  →  Supabase Edge Function
//   "health-ingest"  →  Supabase table `health`  →  THIS server  →  the agent.
//
// Like the PepBros server, this uses the service_role key (which bypasses RLS and
// can see every user's rows), so it MUST scope to a single user. It resolves
// HEALTH_USER_EMAIL → user_id at startup and REFUSES TO START without one — so it
// can never return another household member's health data. Env values fall back to
// the PEPBROS_* ones (same Supabase project), so an existing mcp/.env Just Works.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Minimal .env loader (no dependency). Shares mcp/.env with the PepBros server.
(function loadDotEnv() {
  try {
    const envPath = join(dirname(fileURLToPath(import.meta.url)), '.env');
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (e) { /* rely on real env vars */ }
})();

// HEALTH_* wins; fall back to PEPBROS_* (same project) so one .env serves both.
const SB = process.env.HEALTH_SUPABASE_URL || process.env.PEPBROS_SUPABASE_URL;
const KEY = process.env.HEALTH_SUPABASE_SERVICE_KEY || process.env.PEPBROS_SUPABASE_SERVICE_KEY;
const EMAIL = process.env.HEALTH_USER_EMAIL || process.env.PEPBROS_USER_EMAIL || null;
let UID = process.env.HEALTH_USER_ID || process.env.PEPBROS_USER_ID || null;

if (!SB || !KEY) {
  console.error('[health-mcp] Missing HEALTH_SUPABASE_URL/KEY (or PEPBROS_* fallback).');
  process.exit(1);
}
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

// Resolve the single user this server is allowed to read.
async function resolveUid() {
  if (UID) return UID;
  if (!EMAIL) return null;
  const res = await fetch(`${SB}/auth/v1/admin/users?per_page=200`, { headers: H });
  if (!res.ok) throw new Error(`admin/users ${res.status}`);
  const users = (await res.json()).users || [];
  const me = users.find(u => (u.email || '').toLowerCase() === EMAIL.toLowerCase());
  return me ? me.id : null;
}

// ── REST + domain helpers ─────────────────────────────────────────────────────
// Every health row is { id, data }, where data.kind is 'metric' | 'sleep' | 'workout'.
async function fetchHealth() {
  const url = `${SB}/rest/v1/health?user_id=eq.${UID}&deleted=eq.false&select=id,data&limit=50000`;
  const res = await fetch(url, { headers: H });
  if (!res.ok) throw new Error(`Supabase health ${res.status}: ${await res.text()}`);
  return (await res.json()).map(r => r.data).filter(Boolean);
}
const round = n => (n == null ? null : Math.round(n * 100) / 100);
const ok = obj => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const afterCut = (rows, since, key) => {
  if (!since) return rows;
  const t = new Date(since);
  return rows.filter(r => new Date(r[key]) > t);
};

let CACHE = null;            // single fetch per tool call is fine; tiny cache avoids refetch within a call
async function load() { CACHE = await fetchHealth(); return CACHE; }
const metrics  = rows => rows.filter(r => r.kind === 'metric');
const sleeps   = rows => rows.filter(r => r.kind === 'sleep');
const workouts = rows => rows.filter(r => r.kind === 'workout');

// ── Server ────────────────────────────────────────────────────────────────────
const server = new McpServer({ name: 'health', version: '1.0.0' });

server.tool(
  'list_available_metrics',
  "Which Apple Health metrics this user is exporting, with each metric's date range and sample count. Call this first to discover what's queryable (metric names vary by what the user enabled in Health Auto Export).",
  {},
  async () => {
    const ms = metrics(await load());
    const by = {};
    for (const m of ms) {
      const b = by[m.metric] || (by[m.metric] = { metric: m.metric, units: m.units, count: 0, earliest: m.date, latest: m.date });
      b.count++;
      if (m.date < b.earliest) b.earliest = m.date;
      if (m.date > b.latest) b.latest = m.date;
    }
    const out = Object.values(by).sort((a, b) => a.metric.localeCompare(b.metric));
    return ok({ count: out.length, metrics: out, hasSleep: sleeps(await load()).length > 0, hasWorkouts: workouts(await load()).length > 0 });
  }
);

server.tool(
  'get_daily_metrics',
  'All Apple Health metric values for a single day (steps, resting HR, weight, HRV, etc.). Defaults to the most recent day with data.',
  { date: z.string().optional().describe('YYYY-MM-DD; default = latest day available') },
  async ({ date }) => {
    const ms = metrics(await load());
    if (!ms.length) return ok({ date: null, metrics: [] });
    const day = date || ms.map(m => m.date).sort().at(-1);
    const today = ms.filter(m => m.date === day)
      .sort((a, b) => a.metric.localeCompare(b.metric))
      .map(m => ({ metric: m.metric, qty: round(m.qty), units: m.units, source: m.source || null }));
    return ok({ date: day, count: today.length, metrics: today });
  }
);

server.tool(
  'get_metric_history',
  'One metric over time, newest first (e.g. metric="resting_heart_rate" or "body_mass"). Use list_available_metrics to see exact names.',
  { metric: z.string().describe('exact metric name, e.g. "step_count", "heart_rate_variability", "body_mass"'),
    since: z.string().optional().describe('YYYY-MM-DD; only samples on/after this date'),
    limit: z.number().int().positive().max(1000).optional().describe('max samples (default 60)') },
  async ({ metric, since, limit }) => {
    const q = metric.trim().toLowerCase();
    let ms = metrics(await load()).filter(m => (m.metric || '').toLowerCase() === q);
    ms = afterCut(ms, since, 'date').sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit || 60);
    const units = ms[0]?.units || null;
    return ok({ metric, units, count: ms.length,
      samples: ms.map(m => ({ date: m.date, qty: round(m.qty), source: m.source || null })) });
  }
);

server.tool(
  'get_sleep',
  'Sleep records, newest first: time in bed, time asleep, and stage breakdown (core/deep/rem/awake hours) when available. The "date" is the morning the sleep ended.',
  { since: z.string().optional().describe('YYYY-MM-DD; only nights on/after this date'),
    limit: z.number().int().positive().max(365).optional().describe('max nights (default 30)') },
  async ({ since, limit }) => {
    let sl = sleeps(await load());
    sl = afterCut(sl, since, 'date').sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit || 30);
    return ok({ count: sl.length, nights: sl.map(s => ({
      date: s.date, inBedHours: round(s.inBed), asleepHours: round(s.asleep),
      core: round(s.core), deep: round(s.deep), rem: round(s.rem), awake: round(s.awake),
      sleepStart: s.sleepStart || null, sleepEnd: s.sleepEnd || null })) });
  }
);

server.tool(
  'get_workouts',
  'Apple Health workout sessions, newest first. Each is the PHYSIOLOGICAL record of a session: type, start/end time, duration, avg/max heart rate, active + total calories, distance. ' +
  'IMPORTANT — reconcile with LiftLog: for strength sessions the exercises, sets, and weights live in the LiftLog MCP, NOT here. Match a Health workout to a LiftLog workout by date and start time (allow a few minutes\' drift) and treat them as ONE session — Health = the body metrics, LiftLog = the lifts. Do NOT count a strength session as two separate workouts.',
  { since: z.string().optional().describe('ISO date/time; only workouts on/after this'),
    limit: z.number().int().positive().max(500).optional().describe('max workouts (default 50)') },
  async ({ since, limit }) => {
    let ws = workouts(await load());
    ws = afterCut(ws, since, 'start').sort((a, b) => new Date(b.start) - new Date(a.start)).slice(0, limit || 50);
    return ok({ count: ws.length, workouts: ws.map(w => ({
      type: w.type, start: w.start, end: w.end || null, durationMin: round(w.durationMin),
      avgHeartRate: round(w.avgHr), maxHeartRate: round(w.maxHr),
      activeCalories: round(w.activeCalories), totalCalories: round(w.totalCalories),
      distanceKm: round(w.distanceKm) })) });
  }
);

server.tool(
  'get_recent_summary',
  'A rollup of the last N days (default 7): for each exported metric, its average and latest value; plus sleep averages and workout count. Good for a quick "how have things been lately" read.',
  { days: z.number().int().positive().max(90).optional().describe('window length in days (default 7)') },
  async ({ days }) => {
    const win = days || 7;
    const cutStr = new Date(Date.now() - win * 864e5).toISOString().slice(0, 10);
    const all = await load();
    const ms = metrics(all).filter(m => m.date >= cutStr);
    const agg = {};
    for (const m of ms) {
      const a = agg[m.metric] || (agg[m.metric] = { metric: m.metric, units: m.units, n: 0, sum: 0, latest: null, latestDate: '' });
      a.n++; a.sum += (m.qty || 0);
      if (m.date > a.latestDate) { a.latestDate = m.date; a.latest = m.qty; }
    }
    const metricSummary = Object.values(agg).sort((a, b) => a.metric.localeCompare(b.metric))
      .map(a => ({ metric: a.metric, units: a.units, avg: round(a.sum / a.n), latest: round(a.latest), samples: a.n }));

    const sl = sleeps(all).filter(s => s.date >= cutStr);
    const avg = (arr, k) => { const v = arr.map(x => x[k]).filter(x => x != null); return v.length ? round(v.reduce((s, x) => s + x, 0) / v.length) : null; };
    const ws = workouts(all).filter(w => (w.start || '').slice(0, 10) >= cutStr);

    return ok({
      windowDays: win, since: cutStr,
      metrics: metricSummary,
      sleep: sl.length ? { nights: sl.length, avgAsleepHours: avg(sl, 'asleep'), avgInBedHours: avg(sl, 'inBed') } : null,
      workouts: { count: ws.length, types: [...new Set(ws.map(w => w.type))] }
    });
  }
);

// ── Start ─────────────────────────────────────────────────────────────────────
UID = await resolveUid();
if (!UID) {
  console.error('[health-mcp] Could not resolve a user to scope to. Set HEALTH_USER_EMAIL ' +
    '(or PEPBROS_USER_EMAIL) matching the account, or HEALTH_USER_ID. Refusing to start unscoped.');
  process.exit(1);
}
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[health-mcp] ready — 6 tools, scoped to a single user, reading from ${SB}`);
