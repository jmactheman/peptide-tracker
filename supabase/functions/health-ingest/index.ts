// ── health-ingest ─────────────────────────────────────────────────────────────
// Supabase Edge Function. Receives the JSON that the iPhone "Health Auto Export"
// app POSTs on a schedule, reshapes it into one row per metric/day, sleep/night,
// and workout, and UPSERTs into the `health` table for a single configured user.
//
// Why a function and not a direct PostgREST insert: Health Auto Export's JSON is
// nested (data.metrics[].data[]), the phone shouldn't hold a Supabase write key,
// and we want to map types ourselves. This validates a shared-secret bearer token,
// holds the service_role key server-side, and never trusts the caller for identity.
//
// Deploy:  supabase functions deploy health-ingest --no-verify-jwt
// Secrets: supabase secrets set HEALTH_INGEST_SECRET=... HEALTH_INGEST_USER_ID=...
//   (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by the platform.)

// Note: the DB write goes straight to PostgREST with fetch (no supabase-js / no
// esm.sh import) — nothing to fetch on cold start, and this module stays
// importable by a plain-Node test harness to exercise reshape().

const env = (k: string): string => (globalThis as any).Deno?.env?.get(k) ?? '';
const SECRET  = env('HEALTH_INGEST_SECRET');
const USER_ID = env('HEALTH_INGEST_USER_ID');
const SB_URL  = env('SUPABASE_URL');
const SB_KEY  = env('SUPABASE_SERVICE_ROLE_KEY');

const num = (v: unknown): number | null => {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'object' && 'qty' in (v as Record<string, unknown>)) return num((v as Record<string, unknown>).qty);
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
// Health Auto Export dates look like "2026-06-17 06:30:00 -0500". Grab YYYY-MM-DD.
const dayOf = (s: unknown): string | null => {
  const m = String(s ?? '').match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
};
const pick = (o: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) if (o[k] != null) return o[k];
  return null;
};

// Pure transform: Health Auto Export payload → health-table rows. Exported so a
// Node test harness can verify the reshaping without Supabase or Deno.
export function reshape(body: any, userId: string) {
  const root = body?.data ?? body ?? {};
  const rows: Array<{ user_id: string; id: string; data: any; deleted: boolean }> = [];
  const add = (id: string, data: Record<string, unknown>) =>
    rows.push({ user_id: userId, id, data, deleted: false });

  // ── metrics & sleep ───────────────────────────────────────────────────────────
  // Samples can arrive as many raw points per day (aggregation OFF in the export
  // app). Aggregate per metric per day HERE so correctness doesn't depend on the
  // phone choosing the right function: SUM cumulative quantities (steps, energy,
  // distance, time-based totals), AVERAGE everything else (rates/levels like heart
  // rate, weight, SpO2). If the app already sent one value per day, sum/avg of a
  // single point is that point — so this is also correct for pre-aggregated input.
  const CUMULATIVE = new Set([
    'step_count', 'active_energy', 'basal_energy_burned', 'apple_exercise_time',
    'apple_stand_time', 'apple_stand_hour', 'flights_climbed', 'time_in_daylight',
    'walking_running_distance', 'distance_walking_running', 'distance_cycling',
    'distance_swimming', 'swimming_stroke_count', 'dietary_energy', 'dietary_water',
  ]);
  const macc = new Map<string, any>();   // `${name}|${date}` → {_sum,_n,...}
  const sacc = new Map<string, any>();   // date → sleep accumulator
  const addDur = (a: any, k: string, v: number | null) => { if (v != null) a[k] = (a[k] ?? 0) + v; };

  for (const metric of (root.metrics ?? []) as any[]) {
    const name: string = String(metric?.name ?? '').trim();
    const units = metric?.units ?? null;
    if (!name) continue;

    for (const pt of (metric?.data ?? []) as any[]) {
      const date = dayOf(pt?.date);
      if (!date) continue;

      if (/sleep/i.test(name)) {
        // Sleep carries stage durations; sum them across the night's segments.
        const a = sacc.get(date) ?? { date, units, source: pick(pt, 'source') ?? null };
        addDur(a, 'inBed', num(pick(pt, 'inBed', 'inBedDuration', 'inbed')));
        addDur(a, 'asleep', num(pick(pt, 'asleep', 'totalSleep', 'asleepDuration', 'sleepDuration')));
        addDur(a, 'core', num(pick(pt, 'core', 'lightSleep')));
        addDur(a, 'deep', num(pick(pt, 'deep', 'deepSleep')));
        addDur(a, 'rem', num(pick(pt, 'rem', 'remSleep')));
        addDur(a, 'awake', num(pick(pt, 'awake', 'awakeDuration')));
        const s = pick(pt, 'sleepStart', 'startDate', 'inBedStart');
        const e = pick(pt, 'sleepEnd', 'endDate', 'inBedEnd');
        if (s && (!a.sleepStart || String(s) < a.sleepStart)) a.sleepStart = String(s);
        if (e && (!a.sleepEnd || String(e) > a.sleepEnd)) a.sleepEnd = String(e);
        sacc.set(date, a);
      } else {
        const qty = num(pick(pt, 'qty', 'Avg', 'avg', 'value'));
        if (qty == null) continue;
        const key = `${name}|${date}`;
        const a = macc.get(key) ?? { metric: name, date, units, source: pick(pt, 'source') ?? null, _sum: 0, _n: 0 };
        a._sum += qty; a._n += 1;
        macc.set(key, a);
      }
    }
  }

  for (const a of macc.values()) {
    const qty = CUMULATIVE.has(a.metric) ? a._sum : a._sum / a._n;
    add(`${a.metric}:${a.date}`, { kind: 'metric', metric: a.metric, date: a.date, qty, units: a.units, source: a.source });
  }
  for (const a of sacc.values()) {
    add(`sleep:${a.date}`, {
      kind: 'sleep', date: a.date,
      inBed: a.inBed ?? null, asleep: a.asleep ?? null,
      core: a.core ?? null, deep: a.deep ?? null, rem: a.rem ?? null, awake: a.awake ?? null,
      sleepStart: a.sleepStart ?? null, sleepEnd: a.sleepEnd ?? null,
      units: a.units, source: a.source,
    });
  }

  // ── workouts: physiological record (HR, calories, duration). Kept in full —
  //    LiftLog owns the lifts; the agent reconciles by start time. ───────────────
  for (const w of (root.workouts ?? []) as any[]) {
    const start = pick(w, 'start', 'startDate', 'startTime');
    if (!start) continue;
    const type = String(pick(w, 'name', 'type', 'workoutActivityType') ?? 'Workout');
    let durationMin = num(pick(w, 'duration'));
    // Health Auto Export usually reports duration in seconds; normalise to minutes.
    if (durationMin != null && durationMin > 600) durationMin = durationMin / 60;
    add(`workout:${String(start)}`, {
      kind: 'workout', type,
      start: String(start), end: pick(w, 'end', 'endDate', 'endTime') ?? null,
      durationMin,
      avgHr: num(pick(w, 'avgHeartRate', 'averageHeartRate', 'avgHr')),
      maxHr: num(pick(w, 'maxHeartRate', 'maximumHeartRate', 'maxHr')),
      activeCalories: num(pick(w, 'activeEnergy', 'activeEnergyBurned', 'activeCalories')),
      totalCalories: num(pick(w, 'totalEnergy', 'totalEnergyBurned', 'totalCalories')),
      distanceKm: num(pick(w, 'distance')),
    });
  }

  return rows;
}

const JSON_HEADERS = { 'content-type': 'application/json' };
const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });

async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });

  // ── auth: shared secret ──────────────────────────────────────────────────────
  // Accept the secret from any of: Authorization: Bearer, a custom api-key header,
  // or a ?key= / ?secret= query param. The query param is the most portable —
  // some export apps don't reliably attach custom headers.
  const url = new URL(req.url);
  const auth = req.headers.get('authorization') ?? '';
  const headerToken = auth.replace(/^Bearer\s+/i, '').trim();
  const altHeader = (req.headers.get('x-api-key') || req.headers.get('x-health-key') || '').trim();
  const qpKey = (url.searchParams.get('key') || url.searchParams.get('secret') || '').trim();
  const token = headerToken || altHeader || qpKey;
  if (!SECRET || token !== SECRET) return new Response('unauthorized', { status: 401 });
  if (!USER_ID) return new Response('server not configured (HEALTH_INGEST_USER_ID)', { status: 500 });

  let body: any;
  try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }

  const rows = reshape(body, USER_ID);
  if (!rows.length) return json({ ok: true, upserted: 0 });

  // Dedupe by id: a single upsert statement can't touch the same (user_id,id)
  // row twice, and a payload can carry repeats. Last write wins. Stamp updated_at.
  const uniq = new Map<string, any>();
  const now = new Date().toISOString();
  for (const r of rows) uniq.set(r.id, { ...r, updated_at: now });
  const stamped = [...uniq.values()];

  // Upsert straight to PostgREST (no esm.sh import). Chunk so each request stays
  // small even on a big first backfill.
  const endpoint = `${SB_URL}/rest/v1/health?on_conflict=user_id,id`;
  const headers = {
    apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
    'content-type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=minimal',
  };
  for (let i = 0; i < stamped.length; i += 500) {
    const chunk = stamped.slice(i, i + 500);
    const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(chunk) });
    if (!res.ok) return json({ ok: false, error: `upsert ${res.status}: ${await res.text()}` }, 500);
  }

  return json({ ok: true, upserted: stamped.length });
}

// Only start the HTTP server under Deno (the platform runtime); stay inert when
// imported by the Node test harness.
(globalThis as any).Deno?.serve?.(handler);
