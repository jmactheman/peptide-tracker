#!/usr/bin/env node
'use strict';

// ── PepBros MCP server ────────────────────────────────────────────────────────
// Exposes ONE user's peptide data (logged in the PepBros PWA, stored in Supabase)
// to an AI health agent as structured tools. Read-only.
//
// PepBros is multi-user. This server authenticates with the service_role key
// (which bypasses Row-Level Security and can see every user's rows), so it MUST
// scope to a single user. It resolves PEPBROS_USER_EMAIL → user_id at startup and
// REFUSES TO START without one — so it can never return another household
// member's peptides. The service_role key stays local (.env, never committed).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Minimal .env loader (no dependency).
(function loadDotEnv() {
  try {
    const envPath = join(dirname(fileURLToPath(import.meta.url)), '.env');
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (e) { /* rely on real env vars */ }
})();

const SB = process.env.PEPBROS_SUPABASE_URL;
const KEY = process.env.PEPBROS_SUPABASE_SERVICE_KEY;
const EMAIL = process.env.PEPBROS_USER_EMAIL || null;
let UID = process.env.PEPBROS_USER_ID || null;

if (!SB || !KEY) {
  console.error('[pepbros-mcp] Missing PEPBROS_SUPABASE_URL or PEPBROS_SUPABASE_SERVICE_KEY.');
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
async function fetchTable(table) {
  const url = `${SB}/rest/v1/${table}?user_id=eq.${UID}&deleted=eq.false&select=id,data&limit=20000`;
  const res = await fetch(url, { headers: H });
  if (!res.ok) throw new Error(`Supabase ${table} ${res.status}: ${await res.text()}`);
  return (await res.json()).map(r => r.data).filter(Boolean);
}
const round = n => Math.round(n * 100) / 100;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ok = obj => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });

// dailyDose is stored in mcg (base unit); displayUnit decides how it's shown.
function doseDisplay(p) {
  const du = p.displayUnit || p.unit || '';
  let val = p.dailyDose;
  if (du === 'mg') val = (p.dailyDose || 0) / 1000;
  return `${round(val)} ${du}`;
}
function scheduleText(p) {
  const s = p.schedule || {};
  const times = (s.times && s.times.length) ? s.times.join(', ') : (s.time || '');
  let when;
  if (s.mode === 'daily') when = 'daily';
  else if (s.mode === 'specificDays') when = (s.days || []).map(d => DOW[d]).join('/') || 'specific days';
  else if (s.mode === 'everyN') when = `every ${s.everyN} days`;
  else if (s.mode === 'random') when = 'as needed';
  else when = `${p.dosesPerWeek || '?'}×/week`;
  return times ? `${when} at ${times}` : when;
}
async function loadPeptides() {
  const peps = await fetchTable('peptides');
  peps.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return peps;
}

// ── Server ────────────────────────────────────────────────────────────────────
const server = new McpServer({ name: 'pepbros', version: '1.0.0' });

server.tool(
  'get_current_protocol',
  "The user's current peptide stack: each peptide with its dose, schedule, and active cycle. This is the prescribed protocol — what they're supposed to be taking.",
  {},
  async () => {
    const [peps, cycles] = await Promise.all([loadPeptides(), fetchTable('cycles')]);
    const activeByPep = {};
    cycles.filter(c => c.status === 'active').forEach(c => { activeByPep[c.peptideId] = c; });
    return ok({ count: peps.length, protocol: peps.map(p => ({
      name: p.name, dose: doseDisplay(p), schedule: scheduleText(p),
      dosesPerWeek: p.dosesPerWeek, tracking: p.trackingMode,
      activeCycle: activeByPep[p.id] ? { startDate: activeByPep[p.id].startDate,
        plannedEndDate: activeByPep[p.id].plannedEndDate, plannedWeeks: activeByPep[p.id].plannedDuration } : null
    })) });
  }
);

server.tool(
  'list_recent_doses',
  'Logged peptide doses, newest first (date, time, peptide, amount + unit, injection site, notes). This is the dose LOG — what was actually taken.',
  { since: z.string().optional().describe('ISO date/time; only doses logged after this'),
    limit: z.number().int().positive().max(500).optional().describe('max doses (default 50)') },
  async ({ since, limit }) => {
    let doses = await fetchTable('doses');
    doses.sort((a, b) => new Date(b.loggedAt || b.date) - new Date(a.loggedAt || a.date));
    if (since) { const t = new Date(since); doses = doses.filter(d => new Date(d.loggedAt || d.date) > t); }
    doses = doses.slice(0, limit || 50);
    return ok({ count: doses.length, doses: doses.map(d => ({
      date: d.date, time: d.time, peptide: d.peptideName,
      amount: d.amount, unit: d.unit, site: d.site || null, notes: d.notes || null
    })) });
  }
);

server.tool(
  'get_dose_history',
  'All logged doses for one peptide (matched by name, case-insensitive), newest first.',
  { peptide: z.string().describe('peptide name, e.g. "Retatrutide"'),
    since: z.string().optional(), limit: z.number().int().positive().max(500).optional() },
  async ({ peptide, since, limit }) => {
    const q = peptide.trim().toLowerCase();
    let doses = (await fetchTable('doses')).filter(d => (d.peptideName || '').toLowerCase() === q);
    doses.sort((a, b) => new Date(b.loggedAt || b.date) - new Date(a.loggedAt || a.date));
    if (since) { const t = new Date(since); doses = doses.filter(d => new Date(d.loggedAt || d.date) > t); }
    doses = doses.slice(0, limit || 100);
    return ok({ peptide, count: doses.length, doses: doses.map(d => ({
      date: d.date, time: d.time, amount: d.amount, unit: d.unit, site: d.site || null, notes: d.notes || null })) });
  }
);

server.tool(
  'get_peptide_supply',
  'Supply status per tracked peptide: vials on hand, reorder flag, current-vial remaining units, and a rough weeks-of-supply estimate from unopened vials. Use to flag reorders.',
  {},
  async () => {
    const peps = (await loadPeptides()).filter(p => p.trackingMode === 'full');
    return ok({ count: peps.length, supply: peps.map(p => {
      const unopenedMg = (p.vialsOnHand || 0) * (p.mgPerVial || 0);
      const weeklyMg = (p.dosesPerWeek || 0) * ((p.dailyDose || 0) / 1000);
      const weeksUnopened = weeklyMg > 0 ? round(unopenedMg / weeklyMg) : null;
      return {
        name: p.name, vialsOnHand: p.vialsOnHand, mgPerVial: p.mgPerVial,
        reorderThreshold: p.reorderThreshold, needsReorder: (p.vialsOnHand || 0) <= (p.reorderThreshold ?? 0),
        unopenedSupplyMg: round(unopenedMg), approxWeeksFromUnopenedVials: weeksUnopened,
        currentVialRemainingUnits: p.reconstituted ? (p.reconstituted.remainingUnits ?? null) : null,
        reconstitutedAt: p.reconstituted ? (p.reconstituted.reconstitutedAt || null) : null
      };
    }) });
  }
);

server.tool(
  'get_cycles',
  'Peptide cycles (active and historical) with start, planned end, duration, and progress.',
  { status: z.string().optional().describe('filter by status, e.g. "active"') },
  async ({ status }) => {
    let cycles = await fetchTable('cycles');
    if (status) cycles = cycles.filter(c => c.status === status);
    cycles.sort((a, b) => new Date(b.startDate || 0) - new Date(a.startDate || 0));
    const today = new Date();
    return ok({ count: cycles.length, cycles: cycles.map(c => {
      let progressPct = null;
      if (c.startDate && c.plannedEndDate) {
        const s = new Date(c.startDate), e = new Date(c.plannedEndDate);
        progressPct = Math.max(0, Math.min(100, round((today - s) / (e - s) * 100)));
      }
      return { peptide: c.peptideName, status: c.status, startDate: c.startDate,
        plannedEndDate: c.plannedEndDate, endDate: c.endDate || null,
        plannedWeeks: c.plannedDuration, progressPct };
    }) });
  }
);

server.tool(
  'get_adherence',
  'Adherence per peptide over a window: scheduled doses (from dosesPerWeek) vs doses actually logged, with a percentage. Default window: last 14 days.',
  { since: z.string().optional().describe('ISO date/time (default: 14 days ago)') },
  async ({ since }) => {
    const cut = since ? new Date(since) : new Date(Date.now() - 14 * 864e5);
    const days = Math.max(1, (Date.now() - cut.getTime()) / 864e5);
    const [peps, doses] = await Promise.all([loadPeptides(), fetchTable('doses')]);
    const inWin = doses.filter(d => new Date(d.loggedAt || d.date) > cut);
    return ok({ since: cut.toISOString(), windowDays: round(days), peptides: peps.map(p => {
      const logged = inWin.filter(d => (d.peptideName || '').toLowerCase() === (p.name || '').toLowerCase()).length;
      const expected = round((p.dosesPerWeek || 0) * days / 7);
      return { name: p.name, scheduledPerWeek: p.dosesPerWeek, expected, logged,
        adherencePct: expected > 0 ? round(logged / expected * 100) : null };
    }) });
  }
);

server.tool(
  'list_peptides',
  'The full peptide library with config (name, dose, display unit, schedule, tracking mode).',
  {},
  async () => {
    const peps = await loadPeptides();
    return ok({ count: peps.length, peptides: peps.map(p => ({
      name: p.name, dose: doseDisplay(p), schedule: scheduleText(p),
      dosesPerWeek: p.dosesPerWeek, tracking: p.trackingMode, unit: p.unit, displayUnit: p.displayUnit })) });
  }
);

// ── Start ─────────────────────────────────────────────────────────────────────
UID = await resolveUid();
if (!UID) {
  console.error('[pepbros-mcp] Could not resolve a user to scope to. Set PEPBROS_USER_EMAIL ' +
    '(matching a PepBros account) or PEPBROS_USER_ID. Refusing to start unscoped on a multi-user DB.');
  process.exit(1);
}
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[pepbros-mcp] ready — 7 tools, scoped to a single user, reading from ${SB}`);
