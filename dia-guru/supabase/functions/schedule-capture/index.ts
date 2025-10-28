import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CalendarTokenRow, CaptureEntryRow, Database } from "../types.ts";

const GOOGLE_EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";

const BUFFER_MINUTES = 30;
const SEARCH_DAYS = 7;
const DAY_END_HOUR = 22;
const SLOT_INCREMENT_MINUTES = 15;

class ScheduleError extends Error {
  status: number;
  details?: unknown;

  constructor(message: string, status = 500, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

type CalendarEvent = {
  id: string;
  summary?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  extendedProperties?: { private?: Record<string, string>; shared?: Record<string, string> };
};

type ScheduleAdvisor = {
  action: "suggest_slot" | "ask_overlap" | "defer";
  message: string;
  slot?: { start: string; end?: string | null } | null;
};

type ConflictSummary = {
  id: string;
  summary?: string;
  start?: string;
  end?: string;
  diaGuru?: boolean;
  captureId?: string;
};

type ScheduleDecision = {
  type: "preferred_conflict";
  message: string;
  preferred: { start: string; end: string };
  conflicts: ConflictSummary[];
  suggestion?: { start: string; end: string } | null;
  advisor?: ScheduleAdvisor | null;
  metadata?: {
    llmAttempted: boolean;
    llmModel?: string | null;
    llmError?: string | null;
  };
};

type ConflictDecision = {
  decision: ScheduleDecision;
  note: string;
};

type PreferredSlot = { start: Date; end: Date };

type SchedulingPlan = {
  mode: "flexible" | "deadline" | "window" | "start";
  preferredSlot: PreferredSlot | null;
  deadline?: Date | null;
  window?: { start: Date; end: Date } | null;
};

type LlmConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

type AdvisorResult = {
  advisor: ScheduleAdvisor | null;
  metadata: {
    llmAttempted: boolean;
    llmModel?: string | null;
    llmError?: string | null;
  };
  noteFragment?: string | null;
};

export async function handler(req: Request) {
  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return json({ error: "Missing Authorization" }, 401);

    const body = await req.json().catch(() => ({}));
    const captureId = body.captureId as string | undefined;
    const action = (body.action as "schedule" | "reschedule" | "complete") ?? "schedule";
    const timezoneOffsetMinutes =
      typeof body.timezoneOffsetMinutes === "number" && Number.isFinite(body.timezoneOffsetMinutes)
        ? body.timezoneOffsetMinutes
        : null;

    if (!captureId) return json({ error: "captureId required" }, 400);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRole = Deno.env.get("SERVICE_ROLE_KEY")!;
    const clientId = Deno.env.get("GOOGLE_CLIENT_ID")!;
    const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")!;

    const supaFromUser = createClient<Database, "public">(supabaseUrl, anon, {
      global: { headers: { Authorization: auth } },
    });
    const { data: userData, error: userError } = await supaFromUser.auth.getUser();
    if (userError || !userData?.user) return json({ error: "Unauthorized" }, 401);

    const userId = userData.user.id;
    const admin = createClient<Database, "public">(supabaseUrl, serviceRole);

    const { data: capture, error: captureError } = await admin
      .from("capture_entries")
      .select("*")
      .eq("id", captureId)
      .single();
    if (captureError || !capture) return json({ error: "Capture not found" }, 404);
    if (capture.user_id !== userId) return json({ error: "Forbidden" }, 403);

    const calendarClient = await resolveCalendarClient(admin, userId, clientId, clientSecret);
    if (!calendarClient) {
      return json({ error: "Google Calendar not linked" }, 400);
    }
    const { accessToken } = calendarClient;

    if (action === "complete") {
      if (capture.calendar_event_id) {
        await deleteCalendarEvent(accessToken, capture.calendar_event_id);
      }
      const { error: updateError } = await admin
        .from("capture_entries")
        .update({
          status: "completed",
          last_check_in: new Date().toISOString(),
          scheduling_notes: "Marked completed by user.",
          calendar_event_id: null,
          planned_start: null,
          planned_end: null,
          scheduled_for: null,
        })
        .eq("id", capture.id);
      if (updateError) return json({ error: updateError.message }, 500);
      return json({ message: "Capture marked completed.", capture: null });
    }

    if (action === "reschedule" && capture.calendar_event_id) {
      await deleteCalendarEvent(accessToken, capture.calendar_event_id);
      await admin
        .from("capture_entries")
        .update({
          calendar_event_id: null,
          planned_start: null,
          planned_end: null,
          scheduling_notes: "Rescheduling initiated.",
          status: "pending",
          scheduled_for: null,
        })
        .eq("id", capture.id);
    }

    if (capture.status === "completed") {
      return json({ error: "Capture already completed." }, 400);
    }

    const allowOverlap = Boolean(body.allowOverlap);
    const preferredStartIso = typeof body.preferredStart === "string" ? body.preferredStart : null;
    const preferredEndIso = typeof body.preferredEnd === "string" ? body.preferredEnd : null;
    const timezone = typeof body.timezone === "string" ? body.timezone : null;
    const offsetMinutes = timezoneOffsetMinutes ?? 0;

    const durationMinutes = Math.max(5, Math.min(capture.estimated_minutes ?? 30, 480));
    const now = new Date();
    const timeMin = now.toISOString();
    const timeMax = new Date(now.getTime() + SEARCH_DAYS * 86400000).toISOString();
    let events = await listCalendarEvents(accessToken, timeMin, timeMax);
    const busyIntervals = computeBusyIntervals(events);

    const requestPreferred = preferredStartIso
      ? parsePreferredSlot(preferredStartIso, preferredEndIso, durationMinutes)
      : null;

    const plan = computeSchedulingPlan(capture, durationMinutes, offsetMinutes, now);
    const preferredSlot = requestPreferred ?? plan.preferredSlot;

    if (preferredSlot) {
      const withinWorkingHours = isSlotWithinWorkingWindow(preferredSlot, offsetMinutes);
      const withinPlanWindow =
        plan.mode !== 'window' || !plan.window
          ? true
          : preferredSlot.start.getTime() >= plan.window.start.getTime() &&
            preferredSlot.end.getTime() <= plan.window.end.getTime();
      const slotWithinWindow = withinWorkingHours && withinPlanWindow;
      const conflicts = collectConflictingEvents(preferredSlot, events);
      const externalConflicts = conflicts.filter((conflict) => !conflict.diaGuru);
      const diaGuruConflicts = conflicts.filter((conflict) => conflict.diaGuru && conflict.captureId);
      const hasConflict = conflicts.length > 0;

      let rescheduleQueue: CaptureEntryRow[] = [];

      if (!allowOverlap && (hasConflict || !slotWithinWindow)) {
        const canRebalance =
          plan.mode !== 'flexible' &&
          slotWithinWindow &&
          conflicts.length > 0 &&
          externalConflicts.length === 0 &&
          diaGuruConflicts.length > 0;

        if (canRebalance) {
          rescheduleQueue = await reclaimDiaGuruConflicts(diaGuruConflicts, accessToken, admin);
          if (rescheduleQueue.length > 0) {
            const removedIds = new Set(diaGuruConflicts.map((conflict) => conflict.id));
            events = events.filter((event) => !removedIds.has(event.id));
            busyIntervals.splice(0, busyIntervals.length, ...computeBusyIntervals(events));
          } else {
            const suggestion = findNextAvailableSlot(busyIntervals, durationMinutes, offsetMinutes, {
              startFrom: addMinutes(preferredSlot.end, SLOT_INCREMENT_MINUTES),
              referenceNow: now,
            });
            const llmConfig = resolveLlmConfig();
            const { decision, note } = await buildConflictDecision({
              capture,
              preferredSlot,
              conflicts,
              suggestion,
              timezone,
              offsetMinutes,
              outsideWindow: !slotWithinWindow,
              llmConfig,
              busyIntervals,
            });

            await admin
              .from("capture_entries")
              .update({
                scheduling_notes: note,
              })
              .eq("id", capture.id);

            return json({
              message: decision.message,
              capture,
              decision,
            });
          }
        } else {
          const suggestion = findNextAvailableSlot(busyIntervals, durationMinutes, offsetMinutes, {
            startFrom: addMinutes(preferredSlot.end, SLOT_INCREMENT_MINUTES),
            referenceNow: now,
          });
          const llmConfig = resolveLlmConfig();
          const { decision, note } = await buildConflictDecision({
            capture,
            preferredSlot,
            conflicts,
            suggestion,
            timezone,
            offsetMinutes,
            outsideWindow: !slotWithinWindow,
            llmConfig,
            busyIntervals,
          });

          await admin
            .from("capture_entries")
            .update({
              scheduling_notes: note,
            })
            .eq("id", capture.id);

          return json({
            message: decision.message,
            capture,
            decision,
          });
        }
      }

      const eventId = await createCalendarEvent(accessToken, capture, preferredSlot);
      registerInterval(busyIntervals, preferredSlot);

      if (rescheduleQueue.length > 0) {
        await rescheduleCaptures({
          captures: rescheduleQueue,
          accessToken,
          admin,
          busyIntervals,
          offsetMinutes,
          referenceNow: now,
        });
      }

      const schedulingNote = rescheduleQueue.length > 0
        ? "Scheduled at preferred slot after auto rebalancing existing DiaGuru sessions."
        : allowOverlap
        ? "Scheduled at preferred slot with overlap permitted by user."
        : "Scheduled at preferred slot requested by user.";

      const { data: updated, error: updateError } = await admin
        .from("capture_entries")
        .update({
          status: "scheduled",
          planned_start: preferredSlot.start.toISOString(),
          planned_end: preferredSlot.end.toISOString(),
          scheduled_for: preferredSlot.start.toISOString(),
          calendar_event_id: eventId,
          scheduling_notes: schedulingNote,
        })
        .eq("id", capture.id)
        .select("*")
        .single();

      if (updateError) return json({ error: updateError.message }, 500);
      return json({
        message: "Capture scheduled.",
        capture: updated,
      });
    }

    const candidate = scheduleWithPlan({
      plan,
      durationMinutes,
      busyIntervals,
      offsetMinutes,
      referenceNow: now,
    });
    if (!candidate) {
      return json({ error: "No available slot within the next week." }, 409);
    }

    const eventId = await createCalendarEvent(accessToken, capture, candidate);

    const { data: updated, error: updateError } = await admin
      .from("capture_entries")
      .update({
        status: "scheduled",
        planned_start: candidate.start.toISOString(),
        planned_end: candidate.end.toISOString(),
        scheduled_for: candidate.start.toISOString(),
        calendar_event_id: eventId,
        scheduling_notes: `Scheduled automatically with ${BUFFER_MINUTES} minute buffer.`,
      })
      .eq("id", capture.id)
      .select("*")
      .single();

    if (updateError) return json({ error: updateError.message }, 500);
    return json({
      message: "Capture scheduled.",
      capture: updated,
    });
  } catch (error) {
    if (error instanceof ScheduleError) {
      return json(
        {
          error: error.message || "Scheduling failed",
          details: error.details ?? null,
        },
        error.status || 500,
      );
    }
    const fallbackMessage = error instanceof Error ? error.message : String(error);
    return json({ error: "Server error", details: fallbackMessage }, 500);
  }
}

if (import.meta.main) {
  Deno.serve(handler);
}

async function resolveCalendarClient(
  admin: SupabaseClient<Database, "public">,
  userId: string,
  clientId: string,
  clientSecret: string,
) {
  const { data: account, error: accountError } = await admin
    .from("calendar_accounts")
    .select("id")
    .eq("user_id", userId)
    .eq("provider", "google")
    .single();
  if (accountError || !account) return null;

  const { data: tokenRow, error: tokenError } = await admin
    .from("calendar_tokens")
    .select("access_token, refresh_token, expiry")
    .eq("account_id", account.id)
    .single();
  if (tokenError || !tokenRow) return null;

  const typedToken = tokenRow as CalendarTokenRow;

  let accessToken = typedToken.access_token;
  const refreshToken = typedToken.refresh_token;
  const expiry = typedToken.expiry ? Date.parse(typedToken.expiry) : 0;
  const aboutToExpire = expiry <= Date.now() + 30_000;

  if (aboutToExpire && refreshToken) {
    const refreshed = await refreshGoogleToken(refreshToken, clientId, clientSecret);
    if (!refreshed) return null;
    accessToken = refreshed.access_token;
    const calendarTokens = admin.from("calendar_tokens") as unknown as {
      upsert: (
        values: {
          account_id: number;
          access_token: string;
          refresh_token: string | null;
          expiry: string;
        },
      ) => Promise<unknown>;
    };
    await calendarTokens.upsert({
      account_id: account.id,
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token ?? refreshToken,
      expiry: new Date(Date.now() + (refreshed.expires_in ?? 0) * 1000).toISOString(),
    });
  }

  return { accessToken };
}

async function refreshGoogleToken(refreshToken: string, clientId: string, clientSecret: string) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const res = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) return null;
  return await res.json();
}

function findNextAvailableSlot(
  intervals: { start: Date; end: Date }[],
  durationMinutes: number,
  offsetMinutes: number,
  options: { startFrom?: Date; referenceNow?: Date } = {},
) {
  const referenceNow = options.referenceNow ?? new Date();
  intervals.sort((a, b) => a.start.getTime() - b.start.getTime());

  let cursor = options.startFrom
    ? new Date(Math.max(options.startFrom.getTime(), referenceNow.getTime()))
    : addMinutes(referenceNow, 5);

  if (isBeforeDayStart(cursor, offsetMinutes)) {
    cursor = startOfDayOffset(referenceNow, offsetMinutes);
  }

  for (let day = 0; day < SEARCH_DAYS; day++) {
    const dayAnchor = addDays(referenceNow, day);
    const dayStart = startOfDayOffset(dayAnchor, offsetMinutes);
    let candidateStart = new Date(Math.max(dayStart.getTime(), cursor.getTime()));

    while (true) {
      if (isAfterDayEnd(candidateStart, offsetMinutes)) break;
      const candidateEnd = addMinutes(candidateStart, durationMinutes);
      if (isAfterDayEnd(candidateEnd, offsetMinutes)) break;

      if (isSlotFree(candidateStart, candidateEnd, intervals)) {
        return { start: candidateStart, end: candidateEnd };
      }

      candidateStart = addMinutes(candidateStart, SLOT_INCREMENT_MINUTES);
    }

    cursor = startOfDayOffset(addDays(referenceNow, day + 1), offsetMinutes);
  }

  return null;
}

function computeBusyIntervals(events: CalendarEvent[]) {
  const intervals = events
    .map((event) => {
      const start = parseEventDate(event.start);
      const end = parseEventDate(event.end);
      if (!start || !end) return null;
      return {
        start: addMinutes(start, -BUFFER_MINUTES),
        end: addMinutes(end, BUFFER_MINUTES),
      };
    })
    .filter(Boolean) as { start: Date; end: Date }[];

  intervals.sort((a, b) => a.start.getTime() - b.start.getTime());
  return intervals;
}

function parsePreferredSlot(
  startIso: string,
  endIso: string | null,
  fallbackMinutes: number,
): PreferredSlot | null {
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) return null;
  let end: Date | null = null;
  if (endIso) {
    const parsedEnd = new Date(endIso);
    if (!Number.isNaN(parsedEnd.getTime())) {
      end = parsedEnd;
    }
  }
  if (!end) {
    end = addMinutes(start, fallbackMinutes);
  }
  if (end.getTime() <= start.getTime()) {
    end = addMinutes(start, Math.max(fallbackMinutes, 5));
  }
  return { start, end };
}

function normalizeConstraintType(value: string | null): "flexible" | "deadline_time" | "deadline_date" | "start_time" | "window" {
  if (
    value === "deadline_time" ||
    value === "deadline_date" ||
    value === "start_time" ||
    value === "window"
  ) {
    return value;
  }
  return "flexible";
}

function parseIsoDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function computeDateDeadline(dateInput: string | null, offsetMinutes: number): Date | null {
  if (!dateInput) return null;
  const base = new Date(`${dateInput}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return null;
  const local = toLocalDate(base, offsetMinutes);
  local.setHours(DAY_END_HOUR, 0, 0, 0);
  return toUtcDate(local, offsetMinutes);
}

function resolveDeadlineFromCapture(
  capture: CaptureEntryRow,
  offsetMinutes: number,
): Date | null {
  const candidates: Date[] = [];
  const constraintTime = parseIsoDate(capture.constraint_time);
  if (constraintTime) candidates.push(constraintTime);
  const original = parseIsoDate(capture.original_target_time);
  if (original) candidates.push(original);
  const dateDeadline = computeDateDeadline(capture.constraint_date, offsetMinutes);
  if (dateDeadline) candidates.push(dateDeadline);
  const windowEnd = parseIsoDate(capture.constraint_end);
  if (capture.constraint_type === "window" && windowEnd) candidates.push(windowEnd);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.getTime() - b.getTime());
  return candidates[0];
}

function computeSchedulingPlan(
  capture: CaptureEntryRow,
  durationMinutes: number,
  offsetMinutes: number,
  referenceNow: Date,
): SchedulingPlan {
  const constraintType = normalizeConstraintType(capture.constraint_type);
  const durationMs = durationMinutes * 60000;

  if (constraintType === "deadline_time" || constraintType === "deadline_date") {
    const deadline = resolveDeadlineFromCapture(capture, offsetMinutes);
    if (deadline) {
      return {
        mode: "deadline",
        preferredSlot: null,
        deadline,
        window: null,
      };
    }
  }

  if (constraintType === "start_time") {
    const targetStart =
      parseIsoDate(capture.constraint_time) ?? parseIsoDate(capture.original_target_time);
    if (targetStart) {
      const start = new Date(Math.max(targetStart.getTime(), referenceNow.getTime()));
      const end = new Date(start.getTime() + durationMs);
      return {
        mode: "start",
        preferredSlot: { start, end },
        deadline: null,
        window: null,
      };
    }
  }

  if (constraintType === "window") {
    const windowStart = parseIsoDate(capture.constraint_time);
    const windowEnd = parseIsoDate(capture.constraint_end);
    if (windowStart && windowEnd && windowEnd.getTime() > windowStart.getTime()) {
      const start = new Date(Math.max(windowStart.getTime(), referenceNow.getTime()));
      const end = new Date(start.getTime() + durationMs);
      if (end.getTime() <= windowEnd.getTime()) {
        return {
          mode: "window",
          preferredSlot: { start, end },
          deadline: null,
          window: { start: windowStart, end: windowEnd },
        };
      }
      const adjustedStart = new Date(windowEnd.getTime() - durationMs);
      if (adjustedStart.getTime() >= referenceNow.getTime()) {
        return {
          mode: "window",
          preferredSlot: { start: adjustedStart, end: windowEnd },
          deadline: null,
          window: { start: windowStart, end: windowEnd },
        };
      }
      return {
        mode: "deadline",
        preferredSlot: {
          start: new Date(Math.max(referenceNow.getTime(), windowEnd.getTime() - durationMs)),
          end: windowEnd,
        },
        deadline: windowEnd,
        window: { start: windowStart, end: windowEnd },
      };
    }
  }

  return {
    mode: "flexible",
    preferredSlot: null,
    deadline: null,
    window: null,
  };
}

function adjustSlotToReference(slot: PreferredSlot, referenceNow: Date): PreferredSlot {
  if (slot.start.getTime() >= referenceNow.getTime()) return slot;
  const duration = slot.end.getTime() - slot.start.getTime();
  const start = new Date(referenceNow.getTime());
  const end = new Date(start.getTime() + duration);
  return { start, end };
}

function isSlotFeasible(
  slot: PreferredSlot,
  offsetMinutes: number,
  intervals: { start: Date; end: Date }[],
) {
  if (isBeforeDayStart(slot.start, offsetMinutes)) return false;
  if (isAfterDayEnd(slot.end, offsetMinutes)) return false;
  return isSlotFree(slot.start, slot.end, intervals);
}

function findSlotBeforeDeadline(
  intervals: { start: Date; end: Date }[],
  durationMinutes: number,
  offsetMinutes: number,
  options: { deadline: Date; referenceNow: Date },
): PreferredSlot | null {
  const durationMs = durationMinutes * 60000;
  const latestStart = new Date(options.deadline.getTime() - durationMs);
  if (latestStart.getTime() < options.referenceNow.getTime()) return null;

  let candidateStart = new Date(Math.max(options.referenceNow.getTime(), Date.now()));
  if (isBeforeDayStart(candidateStart, offsetMinutes)) {
    candidateStart = startOfDayOffset(candidateStart, offsetMinutes);
  }
  if (isAfterDayEnd(candidateStart, offsetMinutes)) {
    candidateStart = startOfDayOffset(addDays(candidateStart, 1), offsetMinutes);
  }

  while (candidateStart.getTime() <= latestStart.getTime()) {
    const candidateEnd = new Date(candidateStart.getTime() + durationMs);
    if (candidateEnd.getTime() > options.deadline.getTime()) break;

    if (
      !isBeforeDayStart(candidateStart, offsetMinutes) &&
      !isAfterDayEnd(candidateEnd, offsetMinutes) &&
      isSlotFree(candidateStart, candidateEnd, intervals)
    ) {
      return { start: candidateStart, end: candidateEnd };
    }

    candidateStart = addMinutes(candidateStart, SLOT_INCREMENT_MINUTES);
    if (isAfterDayEnd(candidateStart, offsetMinutes)) {
      candidateStart = startOfDayOffset(addDays(candidateStart, 1), offsetMinutes);
    }
  }

  return null;
}

function findSlotWithinWindow(
  intervals: { start: Date; end: Date }[],
  durationMinutes: number,
  offsetMinutes: number,
  options: { windowStart: Date; windowEnd: Date; referenceNow: Date },
): PreferredSlot | null {
  const durationMs = durationMinutes * 60000;
  let candidateStart = new Date(Math.max(options.windowStart.getTime(), options.referenceNow.getTime()));

  while (candidateStart.getTime() + durationMs <= options.windowEnd.getTime()) {
    const candidateEnd = new Date(candidateStart.getTime() + durationMs);
    if (
      !isBeforeDayStart(candidateStart, offsetMinutes) &&
      !isAfterDayEnd(candidateEnd, offsetMinutes) &&
      isSlotFree(candidateStart, candidateEnd, intervals)
    ) {
      return { start: candidateStart, end: candidateEnd };
    }
    candidateStart = addMinutes(candidateStart, SLOT_INCREMENT_MINUTES);
  }

  return null;
}

function scheduleWithPlan(args: {
  plan: SchedulingPlan;
  durationMinutes: number;
  busyIntervals: { start: Date; end: Date }[];
  offsetMinutes: number;
  referenceNow: Date;
}): PreferredSlot | null {
  const { plan, durationMinutes, busyIntervals, offsetMinutes, referenceNow } = args;
  if (plan.preferredSlot) {
    const adjusted = adjustSlotToReference(plan.preferredSlot, referenceNow);
    if (isSlotFeasible(adjusted, offsetMinutes, busyIntervals)) {
      return adjusted;
    }
  }

  if (plan.mode === "deadline" && plan.deadline) {
    const deadlineSlot = findSlotBeforeDeadline(busyIntervals, durationMinutes, offsetMinutes, {
      deadline: plan.deadline,
      referenceNow,
    });
    if (deadlineSlot) return deadlineSlot;
  }

  if (plan.mode === "window" && plan.window) {
    const windowSlot = findSlotWithinWindow(busyIntervals, durationMinutes, offsetMinutes, {
      windowStart: plan.window.start,
      windowEnd: plan.window.end,
      referenceNow,
    });
    if (windowSlot) return windowSlot;
  }

  if (plan.mode === "start" && plan.preferredSlot) {
    const toleranceEnd = addMinutes(plan.preferredSlot.start, 60);
    const windowSlot = findSlotWithinWindow(busyIntervals, durationMinutes, offsetMinutes, {
      windowStart: plan.preferredSlot.start,
      windowEnd: toleranceEnd,
      referenceNow,
    });
    if (windowSlot) return windowSlot;
  }

  return findNextAvailableSlot(busyIntervals, durationMinutes, offsetMinutes, { referenceNow });
}

const DEADLINE_URGENCY_BONUS = 30;
const DEADLINE_WINDOW_HOURS = 48;
const START_WINDOW_HOURS = 12;

function computeUrgencyScore(
  capture: CaptureEntryRow,
  referenceNow: Date,
  offsetMinutes: number,
): number {
  const type = normalizeConstraintType(capture.constraint_type);
  const deadline = resolveDeadlineFromCapture(capture, offsetMinutes);
  if (deadline) {
    const hoursUntil = (deadline.getTime() - referenceNow.getTime()) / 1000 / 60 / 60;
    if (hoursUntil <= 0) {
      return DEADLINE_URGENCY_BONUS + capture.importance;
    }
    if (type === "deadline_time" || type === "deadline_date") {
      return (
        Math.max(0, DEADLINE_WINDOW_HOURS - hoursUntil) + capture.importance
      );
    }
    if (type === "start_time" || type === "window") {
      return Math.max(0, START_WINDOW_HOURS - Math.abs(hoursUntil)) + capture.importance;
    }
  }

  return capture.importance;
}

function collectConflictingEvents(slot: PreferredSlot, events: CalendarEvent[]): ConflictSummary[] {
  const conflicts: ConflictSummary[] = [];
  for (const event of events) {
    const start = parseEventDate(event.start);
    const end = parseEventDate(event.end);
    if (!start || !end) continue;
    const bufferedStart = addMinutes(start, -BUFFER_MINUTES);
    const bufferedEnd = addMinutes(end, BUFFER_MINUTES);
    const overlaps = slot.start < bufferedEnd && slot.end > bufferedStart;
  if (overlaps) {
    conflicts.push({
      id: event.id,
      summary: event.summary,
      start: start.toISOString(),
      end: end.toISOString(),
      diaGuru: event.extendedProperties?.private?.diaGuru === "true",
      captureId: event.extendedProperties?.private?.capture_id,
    });
  }
}
  return conflicts;
}

function isSlotWithinWorkingWindow(slot: PreferredSlot, offsetMinutes: number) {
  if (isBeforeDayStart(slot.start, offsetMinutes)) return false;
  if (isAfterDayEnd(slot.end, offsetMinutes)) return false;
  return true;
}

function registerInterval(intervals: { start: Date; end: Date }[], slot: PreferredSlot) {
  intervals.push({
    start: addMinutes(slot.start, -BUFFER_MINUTES),
    end: addMinutes(slot.end, BUFFER_MINUTES),
  });
  intervals.sort((a, b) => a.start.getTime() - b.start.getTime());
}

async function reclaimDiaGuruConflicts(
  conflicts: ConflictSummary[],
  accessToken: string,
  admin: SupabaseClient<Database, "public">,
) {
  const removed: CaptureEntryRow[] = [];
  for (const conflict of conflicts) {
    if (!conflict.captureId) continue;
    try {
      await deleteCalendarEvent(accessToken, conflict.id);
    } catch (error) {
      console.log("Failed to delete conflicting event", conflict.id, error);
    }
    const { data, error } = await admin
      .from("capture_entries")
      .update({
        status: "pending",
        calendar_event_id: null,
        planned_start: null,
        planned_end: null,
        scheduled_for: null,
        scheduling_notes: "Rebalanced to honour a higher priority constraint.",
      })
      .eq("id", conflict.captureId)
      .select("*")
      .single();
    if (error || !data) continue;
    removed.push(data as CaptureEntryRow);
  }
  return removed;
}

async function rescheduleCaptures(args: {
  captures: CaptureEntryRow[];
  accessToken: string;
  admin: SupabaseClient<Database, "public">;
  busyIntervals: { start: Date; end: Date }[];
  offsetMinutes: number;
  referenceNow: Date;
}) {
  const { captures, accessToken, admin, busyIntervals, offsetMinutes, referenceNow } = args;
  const queue = [...captures].sort((a, b) => {
    const bUrgency = computeUrgencyScore(b, referenceNow, offsetMinutes);
    const aUrgency = computeUrgencyScore(a, referenceNow, offsetMinutes);
    if (bUrgency !== aUrgency) return bUrgency - aUrgency;
    if (b.importance !== a.importance) return b.importance - a.importance;
    const aMinutes = Math.max(5, Math.min(a.estimated_minutes ?? 30, 480));
    const bMinutes = Math.max(5, Math.min(b.estimated_minutes ?? 30, 480));
    if (aMinutes !== bMinutes) return aMinutes - bMinutes;
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });

  for (const capture of queue) {
    const durationMinutes = Math.max(5, Math.min(capture.estimated_minutes ?? 30, 480));
    const plan = computeSchedulingPlan(capture, durationMinutes, offsetMinutes, referenceNow);
    const slot = scheduleWithPlan({
      plan,
      durationMinutes,
      busyIntervals,
      offsetMinutes,
      referenceNow,
    });

    if (!slot) {
      await admin
        .from("capture_entries")
        .update({
          status: "pending",
          scheduling_notes: "Unable to reschedule automatically. Please choose a new time.",
        })
        .eq("id", capture.id);
      continue;
    }

    try {
      const eventId = await createCalendarEvent(accessToken, capture, slot);
      const { error } = await admin
        .from("capture_entries")
        .update({
          status: "scheduled",
          planned_start: slot.start.toISOString(),
          planned_end: slot.end.toISOString(),
          scheduled_for: slot.start.toISOString(),
          calendar_event_id: eventId,
          scheduling_notes: "Rescheduled automatically after calendar reflow.",
        })
        .eq("id", capture.id);
      if (!error) {
        registerInterval(busyIntervals, slot);
      }
    } catch (error) {
      console.log("Failed to reschedule capture", capture.id, error);
      await admin
        .from("capture_entries")
        .update({
          status: "pending",
          scheduling_notes: "Reschedule attempt failed. Please retry manually.",
        })
        .eq("id", capture.id);
    }
  }
}

function resolveLlmConfig(): LlmConfig | null {
  const baseUrlRaw = Deno.env.get("LLM_BASE_URL");
  const apiKey = Deno.env.get("LLM_API_KEY");
  const model = Deno.env.get("LLM_MODEL") ?? "deepseek-v3";
  if (!baseUrlRaw || !apiKey) return null;
  const baseUrl = baseUrlRaw.replace(/\s+/g, "").replace(/\/+$/, "");
  if (!baseUrl) return null;
  return { baseUrl, apiKey, model };
}

async function buildConflictDecision(args: {
  capture: CaptureEntryRow;
  preferredSlot: PreferredSlot;
  conflicts: ConflictSummary[];
  suggestion: { start: Date; end: Date } | null;
  timezone: string | null;
  offsetMinutes: number;
  outsideWindow: boolean;
  llmConfig: LlmConfig | null;
  busyIntervals: { start: Date; end: Date }[];
}): Promise<ConflictDecision> {
  const { capture, preferredSlot } = args;
  const suggestionPayload = args.suggestion
    ? {
        start: args.suggestion.start.toISOString(),
        end: args.suggestion.end.toISOString(),
      }
    : null;

  const baseMessage = args.outsideWindow
    ? "This request falls outside DiaGuru's scheduling window (8am – 10pm)."
    : "That time is already blocked. Here is what we found.";

  const durationMinutes = Math.max(
    5,
    Math.round((preferredSlot.end.getTime() - preferredSlot.start.getTime()) / 60000),
  );

  const advisorResult = await adviseWithDeepSeek({
    config: args.llmConfig,
    capture,
    preferredSlot,
    conflicts: args.conflicts,
    suggestion: suggestionPayload,
    timezone: args.timezone,
    offsetMinutes: args.offsetMinutes,
    outsideWindow: args.outsideWindow,
    durationMinutes,
    busyIntervals: args.busyIntervals,
  });

  const decision: ScheduleDecision = {
    type: "preferred_conflict",
    message: advisorResult.advisor?.message?.trim() || baseMessage,
    preferred: {
      start: preferredSlot.start.toISOString(),
      end: preferredSlot.end.toISOString(),
    },
    conflicts: args.conflicts,
    suggestion: suggestionPayload,
    advisor: advisorResult.advisor,
    metadata: advisorResult.metadata,
  };

  const noteParts = [
    `Preferred slot conflict at ${decision.preferred.start}.`,
    args.outsideWindow ? "Outside working window." : null,
    `LLM attempted: ${advisorResult.metadata.llmAttempted ? "yes" : "no"}.`,
    advisorResult.metadata.llmModel ? `Model: ${advisorResult.metadata.llmModel}.` : null,
    advisorResult.metadata.llmError ? `LLM error: ${advisorResult.metadata.llmError}.` : null,
    advisorResult.advisor?.action ? `Advisor action: ${advisorResult.advisor.action}.` : null,
    advisorResult.advisor?.slot?.start ? `Advisor slot: ${advisorResult.advisor.slot.start}.` : null,
    suggestionPayload ? `Fallback slot: ${suggestionPayload.start}.` : null,
  ].filter(Boolean);

  const note = noteParts.join(" ");
  return { decision, note };
}

async function adviseWithDeepSeek(args: {
  config: LlmConfig | null;
  capture: CaptureEntryRow;
  preferredSlot: PreferredSlot;
  conflicts: ConflictSummary[];
  suggestion: { start: string; end: string } | null;
  timezone: string | null;
  offsetMinutes: number;
  outsideWindow: boolean;
  durationMinutes: number;
  busyIntervals: { start: Date; end: Date }[];
}): Promise<AdvisorResult> {
  if (!args.config) {
    return {
      advisor: null,
      metadata: { llmAttempted: false },
    };
  }

  const endpoint = args.config.baseUrl.match(/\/chat\/completions$/)
    ? args.config.baseUrl
    : `${args.config.baseUrl}/chat/completions`;

  const context = {
    capture: {
      id: args.capture.id,
      importance: args.capture.importance,
      estimated_minutes: args.capture.estimated_minutes,
      content: args.capture.content,
    },
    preferred_slot: {
      start: args.preferredSlot.start.toISOString(),
      end: args.preferredSlot.end.toISOString(),
    },
    duration_minutes: args.durationMinutes,
    conflicts: args.conflicts,
    suggestion: args.suggestion,
    timezone: args.timezone,
    timezone_offset_minutes: args.offsetMinutes,
    outside_window: args.outsideWindow,
    generated_at: new Date().toISOString(),
  };

  const payload = {
    model: args.config.model,
    messages: [
      {
        role: "system",
        content:
          "You are DiaGuru's scheduling assistant. Resolve conflicts succinctly and respond in JSON with keys: action ('suggest_slot' | 'ask_overlap' | 'defer'), message (string), optional slot { start, end } in ISO 8601.",
      },
      { role: "user", content: JSON.stringify(context) },
    ],
    temperature: 0.2,
    max_tokens: 400,
    response_format: { type: "json_object" },
  };

  const metadata: AdvisorResult["metadata"] = {
    llmAttempted: true,
    llmModel: args.config.model,
  };

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await safeParse(res);
    if (!res.ok) {
      const message = extractGoogleError(data) ?? `LLM request failed with status ${res.status}`;
      metadata.llmError = message;
      return { advisor: null, metadata };
    }

    const choicesValue =
      typeof data === "object" && data !== null
        ? (data as Record<string, unknown>).choices
        : undefined;
    const firstChoice = Array.isArray(choicesValue) ? choicesValue[0] : null;
    const messageValue =
      firstChoice && typeof firstChoice === "object"
        ? (firstChoice as Record<string, unknown>).message
        : undefined;
    const content =
      messageValue && typeof messageValue === "object"
        ? (messageValue as Record<string, unknown>).content
        : undefined;

    if (typeof content !== "string" || !content.trim()) {
      metadata.llmError = "LLM returned empty content.";
      return { advisor: null, metadata };
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      metadata.llmError = `Unable to parse LLM JSON: ${error instanceof Error ? error.message : "unknown error"}`;
      return { advisor: null, metadata };
    }

    const actionRaw = parsed.action;
    const messageRaw = parsed.message;
    const slotRaw = parsed.slot;

    if (actionRaw !== "suggest_slot" && actionRaw !== "ask_overlap" && actionRaw !== "defer") {
      metadata.llmError = "LLM returned an invalid action.";
      return { advisor: null, metadata };
    }

    const advisorSlotRaw = normalizeAdvisorSlot(slotRaw, args.durationMinutes);
    let advisorSlot: { start: string; end: string } | null = null;
    if (advisorSlotRaw) {
      const slotIsValid = validateAdvisorSlot(advisorSlotRaw, args.busyIntervals, args.offsetMinutes);
      if (slotIsValid) {
        advisorSlot = {
          start: advisorSlotRaw.start.toISOString(),
          end: advisorSlotRaw.end.toISOString(),
        };
      } else {
        metadata.llmError = "LLM proposed slot failed validation.";
      }
    }

    const messageText =
      typeof messageRaw === "string" && messageRaw.trim().length > 0
        ? messageRaw.trim()
        : "DiaGuru could not honour that slot without a conflict.";

    return {
      advisor: {
        action: actionRaw,
        message: messageText,
        slot: advisorSlot,
      },
      metadata,
    };
  } catch (error) {
    metadata.llmError = error instanceof Error ? error.message : String(error);
    return { advisor: null, metadata };
  }
}

function normalizeAdvisorSlot(
  slot: unknown,
  fallbackMinutes: number,
): PreferredSlot | null {
  if (!slot || typeof slot !== "object") return null;
  const slotRecord = slot as Record<string, unknown>;
  const startIso = typeof slotRecord.start === "string" ? slotRecord.start : null;
  const endIso = typeof slotRecord.end === "string" ? slotRecord.end : null;
  if (!startIso) return null;
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) return null;
  let end: Date | null = null;
  if (endIso) {
    const parsedEnd = new Date(endIso);
    if (!Number.isNaN(parsedEnd.getTime())) {
      end = parsedEnd;
    }
  }
  if (!end) {
    end = addMinutes(start, fallbackMinutes);
  }
  if (end.getTime() <= start.getTime()) {
    end = addMinutes(start, Math.max(fallbackMinutes, 5));
  }
  return { start, end };
}

function validateAdvisorSlot(
  slot: PreferredSlot,
  busyIntervals: { start: Date; end: Date }[],
  offsetMinutes: number,
) {
  if (!isSlotWithinWorkingWindow(slot, offsetMinutes)) return false;
  return isSlotFree(slot.start, slot.end, busyIntervals);
}

async function listCalendarEvents(accessToken: string, timeMin: string, timeMax: string) {
  const url = new URL(GOOGLE_EVENTS);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("timeMin", timeMin);
  url.searchParams.set("timeMax", timeMax);
  url.searchParams.set("maxResults", "250");

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const payload = await safeParse(res);
  if (!res.ok) {
    const message =
      extractGoogleError(payload) ?? `Google events fetch failed (status ${res.status})`;
    throw new ScheduleError(message, res.status, payload);
  }
  const itemsValue =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>).items
      : null;
  const rawItems = Array.isArray(itemsValue) ? (itemsValue as unknown[]) : [];
  return rawItems as CalendarEvent[];
}

async function deleteCalendarEvent(accessToken: string, eventId: string) {
  await fetch(`${GOOGLE_EVENTS}/${eventId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

async function createCalendarEvent(
  accessToken: string,
  capture: CaptureEntryRow,
  slot: { start: Date; end: Date },
) {
  const summary = `[DG] ${capture.content}`.slice(0, 200);
  const body = {
    summary,
    description: `DiaGuru scheduled task (importance ${capture.importance}).`,
    start: { dateTime: slot.start.toISOString() },
    end: { dateTime: slot.end.toISOString() },
    reminders: { useDefault: true },
    extendedProperties: {
      private: {
        diaGuru: "true",
        capture_id: capture.id,
      },
    },
  };

  const res = await fetch(GOOGLE_EVENTS, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await safeParse(res);
  if (!res.ok) {
    const message =
      extractGoogleError(payload) ?? `Failed to create calendar event (status ${res.status})`;
    throw new ScheduleError(message, res.status, payload);
  }
  const identifier =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>).id : null;
  if (!identifier || typeof identifier !== "string") {
    throw new ScheduleError("Google did not return an event id", 502, payload);
  }
  return identifier;
}

function parseEventDate(value: { dateTime?: string; date?: string }) {
  if (value.dateTime) return new Date(value.dateTime);
  if (value.date) return new Date(`${value.date}T00:00:00Z`);
  return null;
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60000);
}

function addDays(date: Date, days: number) {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

function startOfDayOffset(date: Date, offsetMinutes: number) {
  const local = toLocalDate(date, offsetMinutes);
  local.setHours(8, 0, 0, 0);
  return toUtcDate(local, offsetMinutes);
}

function isBeforeDayStart(date: Date, offsetMinutes: number) {
  const local = toLocalDate(date, offsetMinutes);
  const start = new Date(local.getTime());
  start.setHours(8, 0, 0, 0);
  return local.getTime() < start.getTime();
}

function isAfterDayEnd(date: Date, offsetMinutes: number) {
  const local = toLocalDate(date, offsetMinutes);
  if (local.getHours() > DAY_END_HOUR) return true;
  if (local.getHours() === DAY_END_HOUR && local.getMinutes() > 0) return true;
  return false;
}

function toLocalDate(date: Date, offsetMinutes: number) {
  return new Date(date.getTime() + offsetMinutes * 60000);
}

function toUtcDate(date: Date, offsetMinutes: number) {
  return new Date(date.getTime() - offsetMinutes * 60000);
}

function isSlotFree(start: Date, end: Date, intervals: { start: Date; end: Date }[]) {
  for (const interval of intervals) {
    if (start < interval.end && end > interval.start) {
      return false;
    }
  }
  return true;
}

async function safeParse(res: Response) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractGoogleError(payload: unknown) {
  if (!payload) return null;
  if (typeof payload === "string") return payload;
  if (typeof payload !== "object") return null;

  const top = payload as Record<string, unknown>;
  if (typeof top.error === "string" && top.error.trim()) return top.error;
  if (top.error && typeof top.error === "object") {
    const nested = top.error as Record<string, unknown>;
    if (typeof nested.message === "string" && nested.message.trim()) return nested.message;
    if (Array.isArray(nested.errors) && nested.errors.length > 0) {
      const first = nested.errors[0] as Record<string, unknown>;
      if (typeof first.message === "string" && first.message.trim()) return first.message;
      if (typeof first.reason === "string" && first.reason.trim()) return first.reason;
    }
  }
  if (typeof top.message === "string" && top.message.trim()) return top.message;
  if (Array.isArray(top.errors) && top.errors.length > 0) {
    const first = top.errors[0] as Record<string, unknown>;
    if (typeof first.message === "string" && first.message.trim()) return first.message;
  }

  return null;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
