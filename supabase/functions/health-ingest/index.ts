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

// Note: createClient is imported dynamically inside the handler (not a static
// top-level import) so this module can also be imported by a plain-Node test
// harness to exercise reshape() without pulling in esm.sh or the Deno runtime.

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

  // ── metrics: one row per metric per day. Sleep is split out into its own kind. ─
  for (const metric of (root.metrics ?? []) as any[]) {
    const name: string = String(metric?.name ?? '').trim();
    const units = metric?.units ?? null;
    if (!name) continue;

    for (const pt of (metric?.data ?? []) as any[]) {
      const date = dayOf(pt?.date);
      if (!date) continue;

      if (/sleep/i.test(name)) {
        // Sleep carries stage fields rather than a single qty.
        add(`sleep:${date}`, {
          kind: 'sleep', date,
          inBed: num(pick(pt, 'inBed', 'inBedDuration', 'inbed')),
          asleep: num(pick(pt, 'asleep', 'totalSleep', 'asleepDuration', 'sleepDuration')),
          core: num(pick(pt, 'core', 'lightSleep')),
          deep: num(pick(pt, 'deep', 'deepSleep')),
          rem: num(pick(pt, 'rem', 'remSleep')),
          awake: num(pick(pt, 'awake', 'awakeDuration')),
          sleepStart: pick(pt, 'sleepStart', 'startDate', 'inBedStart') ?? null,
          sleepEnd: pick(pt, 'sleepEnd', 'endDate', 'inBedEnd') ?? null,
          units, source: pick(pt, 'source') ?? null,
        });
      } else {
        const qty = num(pick(pt, 'qty', 'Avg', 'avg', 'value'));
        add(`${name}:${date}`, { kind: 'metric', metric: name, date, qty, units, source: pick(pt, 'source') ?? null });
      }
    }
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
  const auth = req.headers.get('authorization') ?? '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!SECRET || token !== SECRET) return new Response('unauthorized', { status: 401 });
  if (!USER_ID) return new Response('server not configured (HEALTH_INGEST_USER_ID)', { status: 500 });

  let body: any;
  try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }

  const rows = reshape(body, USER_ID);
  if (!rows.length) return json({ ok: true, upserted: 0 });

  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });
  // Stamp updated_at so the row reflects this ingest; upsert on the PK (user_id,id).
  const stamped = rows.map(r => ({ ...r, updated_at: new Date().toISOString() }));
  const { error } = await sb.from('health').upsert(stamped, { onConflict: 'user_id,id' });
  if (error) return json({ ok: false, error: error.message }, 500);

  return json({ ok: true, upserted: rows.length });
}

// Only start the HTTP server under Deno (the platform runtime); stay inert when
// imported by the Node test harness.
(globalThis as any).Deno?.serve?.(handler);
