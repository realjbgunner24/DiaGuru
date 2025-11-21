#!/usr/bin/env node
/**
 * Regression runner for the sleep / apply-to-jobs / assignment scenario.
 *
 * What it does:
 * 1) Reads regression-fixture.json (three captures).
 * 2) Inserts the captures into capture_entries for a test user (unless CAPTURE_IDS is provided).
 * 3) Calls the schedule-capture edge function for each capture with overlap + late placement enabled.
 *
 * Required env:
 *  - SUPABASE_URL
 *  - SERVICE_ROLE_KEY   (for inserting fixture captures)
 *  - USER_ID            (the user to associate the captures with)
 *  - USER_BEARER        (Access token for that user; used as Authorization when calling the function)
 *
 * Optional env:
 *  - FUNCTION_URL       (defaults to `${SUPABASE_URL}/functions/v1/schedule-capture`)
 *  - CAPTURE_IDS        (comma-separated list to reuse existing capture IDs instead of inserting)
 *  - TIMEZONE           (e.g., "America/Chicago")
 *  - TZ_OFFSET_MINUTES  (integer minutes)
 */

import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import fs from "node:fs";

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SERVICE_ROLE_KEY;
const userId = process.env.USER_ID;
const userBearer = process.env.USER_BEARER;

console.log(supabaseUrl+" \n"+serviceRoleKey+"\n "+userId+" \n"+userBearer);

if (!supabaseUrl || !serviceRoleKey || !userId || !userBearer) {
  console.error("Missing env. Need SUPABASE_URL, SERVICE_ROLE_KEY, USER_ID, USER_BEARER.");
  process.exit(1);
}

const functionUrl =
  process.env.FUNCTION_URL ?? `${supabaseUrl.replace(/\/$/, "")}/functions/v1/schedule-capture`;
const admin = createClient(supabaseUrl, serviceRoleKey);

const fixturePath = new URL("./regression-fixture.json", import.meta.url);
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

const reuseIds =
  typeof process.env.CAPTURE_IDS === "string" && process.env.CAPTURE_IDS.trim().length > 0
    ? process.env.CAPTURE_IDS.split(",").map((s) => s.trim())
    : null;

/** Minimal capture record builder for capture_entries */
function buildCaptureRecord(source, id) {
  const importance = Math.max(
    1,
    Math.min(
      5,
      source.importance ??
        source.urgency ??
        source.impact ??
        3,
    ),
  );
  const isDeadline = source.constraint_type === "deadline_time";
  const isStart = source.constraint_type === "start_time";
  const nowIso = new Date().toISOString();

  return {
    id,
    user_id: userId,
    content: source.content,
    estimated_minutes: source.estimated_minutes,
    importance,
    urgency: source.urgency ?? importance,
    impact: source.impact ?? importance,
    reschedule_penalty: source.reschedule_penalty ?? 0,
    blocking: source.blocking ?? false,
    status: "pending",
    scheduled_for: null,
    created_at: nowIso,
    updated_at: nowIso,
    calendar_event_id: null,
    calendar_event_etag: null,
    planned_start: null,
    planned_end: null,
    last_check_in: null,
    scheduling_notes: JSON.stringify({ fixture: true, note: "regression runner insertion" }),
    constraint_type: source.constraint_type,
    constraint_time: source.constraint_time ?? null,
    constraint_end: source.constraint_end ?? null,
    constraint_date: source.constraint_date ?? null,
    original_target_time: isStart ? source.constraint_time ?? null : null,
    deadline_at: isDeadline ? source.constraint_time ?? null : null,
    window_start: source.window_start ?? null,
    window_end: source.window_end ?? (isDeadline ? source.constraint_time ?? null : null),
    start_target_at: isStart ? source.constraint_time ?? null : null,
    is_soft_start: (source.start_flexibility ?? "soft") === "soft",
    externality_score: source.externality_score ?? 0,
    reschedule_count: 0,
    task_type_hint: source.task_type_hint ?? "task",
    freeze_until: null,
    plan_id: null,
    manual_touch_at: null,
    cannot_overlap: source.cannot_overlap ?? false,
    start_flexibility: source.start_flexibility ?? "soft",
    duration_flexibility: source.duration_flexibility ?? "fixed",
    min_chunk_minutes: source.min_chunk_minutes ?? 15,
    max_splits: source.max_splits ?? null,
    extraction_kind: source.task_type_hint ?? "task",
    time_pref_time_of_day: source.time_pref_time_of_day ?? null,
    time_pref_day: source.time_pref_day ?? "today",
    importance_rationale: source.importance_rationale ?? null,
  };
}

async function ensureCapture(source, reuseId) {
  if (reuseId) return reuseId;
  const id = crypto.randomUUID();
  const record = buildCaptureRecord(source, id);
  const { error } = await admin.from("capture_entries").insert(record);
  if (error) {
    console.error("Insert failed", error);
    process.exit(1);
  }
  return id;
}

async function scheduleCapture(captureId) {
  const body = {
    action: "schedule",
    captureId,
    allowOverlap: true,
    allowLatePlacement: true,
    timezone: process.env.TIMEZONE ?? null,
    timezoneOffsetMinutes: process.env.TZ_OFFSET_MINUTES
      ? Number(process.env.TZ_OFFSET_MINUTES)
      : undefined,
  };
  const res = await fetch(functionUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${userBearer}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  console.log("\n=== capture", captureId, "status", res.status, "===");
  console.dir(json, { depth: null });
}

async function main() {
  console.log("Fixture contains", fixture.captures.length, "captures");
  const ids = [];
  for (let i = 0; i < fixture.captures.length; i++) {
    const src = fixture.captures[i];
    const reuseId = reuseIds ? reuseIds[i] : null;
    const id = await ensureCapture(src, reuseId);
    ids.push(id);
  }

  console.log("Scheduling with overlap + late placement:", ids.join(", "));
  for (const id of ids) {
    await scheduleCapture(id);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
