import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { CalendarTokenRow, CaptureEntryRow, Database } from "../types.ts";
import {
  schedulerConfig,
  computePrioritySnapshot,
  computeRigidityScore,
  logSchedulerEvent,
} from "./scheduler-config.ts";
import { replaceCaptureChunks } from "./chunks.ts";
import { computePriorityScore, type PriorityInput } from "../../../shared/priority.ts";

const GOOGLE_EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";

const BUFFER_MINUTES = 30;
const COMPRESSED_BUFFER_MINUTES = 15;
const SEARCH_DAYS = 7;
const DAY_END_HOUR = 22;
const SLOT_INCREMENT_MINUTES = 15;
const STABILITY_WINDOW_MINUTES = 30;

export class ScheduleError extends Error {
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
  etag?: string;
  updated?: string;
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

type CalendarClientCredentials = {
  accountId: number;
  accessToken: string;
  refreshToken: string | null;
  refreshed: boolean;
};

type GoogleCalendarActions = {
  listEvents: (timeMin: string, timeMax: string) => Promise<CalendarEvent[]>;
  deleteEvent: (options: { eventId: string; etag?: string | null }) => Promise<void>;
  createEvent: (options: {
    capture: CaptureEntryRow;
    slot: { start: Date; end: Date };
    planId?: string | null;
    actionId: string;
    priorityScore: number;
    description?: string;
  }) => Promise<{ id: string; etag: string | null }>;
  getEvent: (eventId: string) => Promise<CalendarEvent | null>;
};

type CaptureSnapshot = {
  status: string | null;
  planned_start: string | null;
  planned_end: string | null;
  calendar_event_id: string | null;
  calendar_event_etag: string | null;
  freeze_until: string | null;
  plan_id: string | null;
};

type PlanActionRecord = {
  actionId: string;
  planId: string;
  captureId: string;
  captureContent: string;
  actionType: "scheduled" | "rescheduled" | "unscheduled";
  prev: CaptureSnapshot;
  next: CaptureSnapshot;
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
    const google = createGoogleCalendarActions({
      credentials: calendarClient,
      admin,
      clientId,
      clientSecret,
    });

    if (action === "complete") {
      if (capture.calendar_event_id) {
        await google.deleteEvent({
          eventId: capture.calendar_event_id,
          etag: capture.calendar_event_etag ?? undefined,
        });
      }
      const { error: updateError } = await admin
        .from("capture_entries")
        .update({
          status: "completed",
          last_check_in: new Date().toISOString(),
          scheduling_notes: "Marked completed by user.",
          calendar_event_id: null,
          calendar_event_etag: null,
          planned_start: null,
          planned_end: null,
          scheduled_for: null,
          freeze_until: null,
        })
        .eq("id", capture.id);
      if (updateError) return json({ error: updateError.message }, 500);
      return json({ message: "Capture marked completed.", capture: null });
    }

    if (action === "reschedule" && capture.calendar_event_id) {
      await google.deleteEvent({
        eventId: capture.calendar_event_id,
        etag: capture.calendar_event_etag ?? undefined,
      });
      await admin
        .from("capture_entries")
        .update({
          calendar_event_id: null,
          calendar_event_etag: null,
          planned_start: null,
          planned_end: null,
          scheduling_notes: "Rescheduling initiated.",
          status: "pending",
          scheduled_for: null,
          freeze_until: null,
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
    const planId = crypto.randomUUID();
    const planActions: PlanActionRecord[] = [];
    let planRunCreated = false;

    const prioritySnapshot = computePrioritySnapshot(capture as CaptureEntryRow, now);
    const rigidityScore = computeRigidityScore(capture as CaptureEntryRow, now);
    logSchedulerEvent("capture.metrics", {
      captureId: capture.id,
      priority: prioritySnapshot.score,
      perMinute: Number(prioritySnapshot.perMinute.toFixed(3)),
      rigidity: Number(rigidityScore.toFixed(2)),
      durationMinutes,
    });

    const ensurePlanRun = async () => {
      if (planRunCreated) return;
      const { error } = await admin
        .from("plan_runs")
        .insert({ id: planId, user_id: userId })
        .select("id")
        .single();
      if (error) {
        throw new ScheduleError("Failed to register scheduling plan.", 500, error);
      }
      planRunCreated = true;
    };

    const recordPlanAction = async (action: Omit<PlanActionRecord, "planId">) => {
      await ensurePlanRun();
      planActions.push({ ...action, planId });
    };

    const finalizePlan = async () => {
      if (!planRunCreated || planActions.length === 0) return null;
      const rows = planActions.map((action) => convertPlanActionForInsert(action));
      const { error } = await admin.from("plan_actions").insert(rows);
      if (error) {
        throw new ScheduleError("Failed to persist plan audit trail.", 500, error);
      }
      const summaryText = buildPlanSummaryText(planActions);
      await admin.from("plan_runs").update({ summary: summaryText }).eq("id", planId);
      return buildPlanSummary(planId, planActions);
    };
    const timeMin = now.toISOString();
    const timeMax = new Date(now.getTime() + SEARCH_DAYS * 86400000).toISOString();
    let events = await google.listEvents(timeMin, timeMax);
    let eventsById = new Map(events.map((event) => [event.id, event]));
    let busyIntervals = computeBusyIntervals(events);

    const requestPreferred = preferredStartIso
      ? parsePreferredSlot(preferredStartIso, preferredEndIso, durationMinutes)
      : null;

    const plan = computeSchedulingPlan(capture, durationMinutes, offsetMinutes, now);
    const capturePriority = priorityForCapture(capture, now);
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

      // Determine if overlap is actually allowed under policy
      let effectiveAllowOverlap = allowOverlap;
      if (effectiveAllowOverlap) {
        // Must be inside working window
        if (!slotWithinWindow) {
          effectiveAllowOverlap = false;
        } else if (externalConflicts.length > 0) {
          // Never overlap external events
          effectiveAllowOverlap = false;
        } else {
          // Respect cannot_overlap flags for current and conflicting DiaGuru captures
          const currentCannot = readCannotOverlapFromNotes(capture);
          if (currentCannot) {
            effectiveAllowOverlap = false;
          } else if (diaGuruConflicts.length > 0) {
            const conflictMap = await loadConflictCaptures(admin, diaGuruConflicts);
            for (const v of conflictMap.values()) {
              if (readCannotOverlapFromNotes(v)) {
                effectiveAllowOverlap = false;
                break;
              }
            }
          }
        }
      }

      if (!effectiveAllowOverlap && (hasConflict || !slotWithinWindow)) {
        const respondWithConflictDecision = async () => {
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
            admin,
          });

          await admin
            .from("capture_entries")
            .update({ scheduling_notes: note })
            .eq("id", capture.id);

          return json({
            message: decision.message,
            capture,
            decision,
          });
        };

        let captureMap: Map<string, CaptureEntryRow> | null = null;
        let selectedConflicts: ConflictSummary[] = [];
        let canRebalance = false;

        if (
          plan.mode !== "flexible" &&
          slotWithinWindow &&
          conflicts.length > 0 &&
          externalConflicts.length === 0 &&
          diaGuruConflicts.length > 0
        ) {
          captureMap = await loadConflictCaptures(admin, diaGuruConflicts);
          if (captureMap.size > 0) {
            const movable: ConflictSummary[] = [];
            let hasLocked = false;

            for (const conflict of diaGuruConflicts) {
              const blocker = conflict.captureId ? captureMap.get(conflict.captureId) : null;
              if (!blocker) {
                hasLocked = true;
                break;
              }
              const frozen = hasActiveFreeze(blocker, now);
              const stabilityLocked = withinStabilityWindow(blocker, now) && plan.mode !== "deadline";
              if (frozen || stabilityLocked) {
                hasLocked = true;
                break;
              }
              movable.push(conflict);
            }

            if (!hasLocked && movable.length > 0) {
              const outranksAll = movable.every((conflict) => {
                const blocker = conflict.captureId ? captureMap!.get(conflict.captureId) : null;
                if (!blocker) return false;
                const blockerPriority = priorityForCapture(blocker, now);
                return capturePriority > blockerPriority;
              });

              if (outranksAll) {
                const preemptionPlan = selectMinimalPreemptionSet({
                  slot: preferredSlot,
                  events,
                  candidateIds: movable.map((conflict) => conflict.id),
                  offsetMinutes,
                  allowCompressedBuffer: plan.mode === "deadline",
                });
                if (preemptionPlan) {
                  const idSet = new Set(preemptionPlan.ids);
                  selectedConflicts = movable.filter((conflict) => idSet.has(conflict.id));
                  canRebalance = selectedConflicts.length > 0;
                }
              }
            }
          }
        }

        if (canRebalance && selectedConflicts.length > 0 && captureMap) {
        rescheduleQueue = await reclaimDiaGuruConflicts(selectedConflicts, google, admin, {
          captureMap,
          eventsById,
          planId,
          recordPlanAction,
        });
          if (rescheduleQueue.length > 0) {
            const removedIds = new Set(selectedConflicts.map((conflict) => conflict.id));
            events = events.filter((event) => !removedIds.has(event.id));
            eventsById = new Map(events.map((event) => [event.id, event]));
            busyIntervals = computeBusyIntervals(events);
          } else {
            return await respondWithConflictDecision();
          }
        } else {
          return await respondWithConflictDecision();
        }
      }

      // Hard guard: ensure slot respects deadline/window
      if (!isSlotWithinConstraints(capture, preferredSlot)) {
        return json({ error: "Requested slot exceeds deadline/window." }, 409);
      }
      const actionId = crypto.randomUUID();
      const prevSnapshot = snapshotFromRow(capture);
      const createdEvent = await google.createEvent({
        capture,
        slot: preferredSlot,
        planId,
        actionId,
        priorityScore: capturePriority,
      });
      registerInterval(busyIntervals, preferredSlot);

      if (rescheduleQueue.length > 0) {
        await rescheduleCaptures({
          captures: rescheduleQueue,
          admin,
          busyIntervals,
          offsetMinutes,
          referenceNow: now,
          google,
          planId,
          recordPlanAction,
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
          calendar_event_id: createdEvent.id,
          calendar_event_etag: createdEvent.etag,
          plan_id: planId,
          freeze_until: null,
          scheduling_notes: schedulingNote,
        })
        .eq("id", capture.id)
        .select("*")
        .single();

      if (updateError) return json({ error: updateError.message }, 500);

      await replaceCaptureChunks(admin, updated as CaptureEntryRow, [
        { start: preferredSlot.start, end: preferredSlot.end },
      ]);

      await recordPlanAction({
        actionId,
        captureId: capture.id,
        captureContent: capture.content,
        actionType: prevSnapshot.status === "scheduled" ? "rescheduled" : "scheduled",
        prev: prevSnapshot,
        next: snapshotFromRow(updated as CaptureEntryRow),
      });

      const planSummary = await finalizePlan();
      return json({
        message: "Capture scheduled.",
        capture: updated,
        planSummary,
      });
    }

    const candidate = scheduleWithPlan({
      plan,
      durationMinutes,
      busyIntervals,
      offsetMinutes,
      referenceNow: now,
      isSoftStart: capture.is_soft_start,
    });
    if (!candidate) {
      // Fallback preemption attempt for deadline/window plans: try latest legal slot and rebalance DiaGuru tasks
      if (plan.mode === "deadline" && plan.deadline) {
        const latestStart = new Date(plan.deadline.getTime() - durationMinutes * 60000);
        const preferredSlot = { start: new Date(Math.max(latestStart.getTime(), now.getTime())), end: plan.deadline };
        // Validate working window
        const withinWorkingHours = isSlotWithinWorkingWindow(preferredSlot, offsetMinutes);
        if (withinWorkingHours && isSlotWithinConstraints(capture, preferredSlot)) {
          const conflicts = collectConflictingEvents(preferredSlot, events);
          const externalConflicts = conflicts.filter((c) => !c.diaGuru);
          const diaGuruConflicts = conflicts.filter((c) => c.diaGuru && c.captureId);
          if (conflicts.length > 0 && externalConflicts.length === 0 && diaGuruConflicts.length > 0) {
            // Remove conflicting DiaGuru events and reschedule them after placing this urgent task
            const conflictIds = new Set(diaGuruConflicts.map((c) => c.id));
            events = events.filter((e) => !conflictIds.has(e.id));
            eventsById = new Map(events.map((e) => [e.id, e]));
            busyIntervals = computeBusyIntervals(events);

            const actionId = crypto.randomUUID();
            const prevSnapshot = snapshotFromRow(capture);
            const createdEvent = await google.createEvent({ capture, slot: preferredSlot, planId, actionId, priorityScore: capturePriority });
            registerInterval(busyIntervals, preferredSlot);

            // Load capture rows and attempt reschedule of displaced captures
            const conflictMap = await loadConflictCaptures(admin, diaGuruConflicts);
            const toReschedule = Array.from(conflictMap.values());
            if (toReschedule.length > 0) {
              await rescheduleCaptures({ captures: toReschedule, admin, busyIntervals, offsetMinutes, referenceNow: now, google, planId, recordPlanAction });
            }

            const { data: updated, error: updateError } = await admin
              .from("capture_entries")
              .update({
                status: "scheduled",
                planned_start: preferredSlot.start.toISOString(),
                planned_end: preferredSlot.end.toISOString(),
                scheduled_for: preferredSlot.start.toISOString(),
                calendar_event_id: createdEvent.id,
                calendar_event_etag: createdEvent.etag,
                plan_id: planId,
                freeze_until: null,
                scheduling_notes: "Scheduled at latest legal slot; rebalanced DiaGuru sessions.",
              })
              .eq("id", capture.id)
              .select("*")
              .single();
            if (updateError) return json({ error: updateError.message }, 500);

            if (updated) {
              await replaceCaptureChunks(admin, updated as CaptureEntryRow, [
                { start: preferredSlot.start, end: preferredSlot.end },
              ]);
            }

            await recordPlanAction({
              actionId,
              captureId: capture.id,
              captureContent: capture.content,
              actionType: prevSnapshot.status === "scheduled" ? "rescheduled" : "scheduled",
              prev: prevSnapshot,
              next: snapshotFromRow(updated as CaptureEntryRow),
            });

            const planSummary = await finalizePlan();
            return json({ message: "Capture scheduled via preemption.", capture: updated, planSummary });
          }
        }
      }
      // No legal slot available. Return detailed reason for client logging.
      const deadlineIso = capture.deadline_at ?? capture.window_end ?? capture.constraint_end ?? (capture.constraint_type === "deadline_time" ? capture.constraint_time : null);
      return json(
        {
          error: "No available slot within constraints.",
          reason: "no_slot",
          capture_id: capture.id,
          mode: plan.mode,
          duration_minutes: durationMinutes,
          deadline: deadlineIso,
          reference_now: now.toISOString(),
        },
        409,
      );
    }

    const autoActionId = crypto.randomUUID();
    const prevSnapshot = snapshotFromRow(capture);
    // Hard guard: ensure slot respects deadline/window
    if (!isSlotWithinConstraints(capture, candidate)) {
      return json(
        {
          error: "Found slot exceeds deadline/window.",
          reason: "slot_exceeds_deadline",
          capture_id: capture.id,
          slot: { start: candidate.start.toISOString(), end: candidate.end.toISOString() },
          deadline: capture.deadline_at ?? capture.window_end ?? capture.constraint_end ?? (capture.constraint_type === "deadline_time" ? capture.constraint_time : null),
        },
        409,
      );
    }
    const createdEvent = await google.createEvent({
      capture,
      slot: candidate,
      planId,
      actionId: autoActionId,
      priorityScore: capturePriority,
    });

    const { data: updated, error: updateError } = await admin
      .from("capture_entries")
      .update({
        status: "scheduled",
          planned_start: candidate.start.toISOString(),
          planned_end: candidate.end.toISOString(),
          scheduled_for: candidate.start.toISOString(),
          calendar_event_id: createdEvent.id,
          calendar_event_etag: createdEvent.etag,
          plan_id: planId,
          freeze_until: null,
          scheduling_notes: `Scheduled automatically with ${BUFFER_MINUTES} minute buffer.`,
        })
      .eq("id", capture.id)
      .select("*")
      .single();

    if (updateError) return json({ error: updateError.message }, 500);

    if (updated) {
      await replaceCaptureChunks(admin, updated as CaptureEntryRow, [
        { start: candidate.start, end: candidate.end },
      ]);
    }

    await recordPlanAction({
      actionId: autoActionId,
      captureId: capture.id,
      captureContent: capture.content,
      actionType: prevSnapshot.status === "scheduled" ? "rescheduled" : "scheduled",
      prev: prevSnapshot,
      next: snapshotFromRow(updated as CaptureEntryRow),
    });

    const planSummary = await finalizePlan();
    return json({
      message: "Capture scheduled.",
      capture: updated,
      planSummary,
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

export async function resolveCalendarClient(
  admin: SupabaseClient<Database, "public">,
  userId: string,
  clientId: string,
  clientSecret: string,
) {
  const { data: account, error: accountError } = await admin
    .from("calendar_accounts")
    .select("id, needs_reconnect")
    .eq("user_id", userId)
    .eq("provider", "google")
    .single();
  if (accountError || !account) return null;

  const { data: tokenRow, error: tokenError } = await admin
    .from("calendar_tokens")
    .select("access_token, refresh_token, expiry")
    .eq("account_id", account.id)
    .single();
  if (tokenError || !tokenRow) {
    await setCalendarReconnectFlag(admin, account.id, true);
    return null;
  }

  const typedToken = tokenRow as CalendarTokenRow;

  const credentials: CalendarClientCredentials = {
    accountId: account.id,
    accessToken: typedToken.access_token,
    refreshToken: typedToken.refresh_token,
    refreshed: false,
  };

  const expiryMillis = typedToken.expiry ? Date.parse(typedToken.expiry) : 0;
  const expiryIsValid = Number.isFinite(expiryMillis) && expiryMillis > 0;
  const alreadyExpired = expiryIsValid ? expiryMillis <= Date.now() : true;
  const expiresSoon = expiryIsValid ? expiryMillis <= Date.now() + 30_000 : true;
  const needsRefresh =
    !credentials.accessToken || alreadyExpired || expiresSoon || account.needs_reconnect;

  if (needsRefresh) {
    const refreshed = await refreshCalendarAccess({
      credentials,
      admin,
      clientId,
      clientSecret,
    });
    if (!refreshed) {
      await setCalendarReconnectFlag(admin, credentials.accountId, true);
      return null;
    }
  }

  await setCalendarReconnectFlag(admin, credentials.accountId, false);
  return credentials;
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

function computeBusyIntervals(events: CalendarEvent[], bufferMinutes = BUFFER_MINUTES) {
  const intervals = events
    .map((event) => {
      const start = parseEventDate(event.start);
      const end = parseEventDate(event.end);
      if (!start || !end) return null;
      return {
        start: addMinutes(start, -bufferMinutes),
        end: addMinutes(end, bufferMinutes),
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
  isSoftStart?: boolean;
}): PreferredSlot | null {
  const { plan, durationMinutes, busyIntervals, offsetMinutes, referenceNow, isSoftStart } = args;
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
    const toleranceMinutes = isSoftStart ? 120 : 60;
    const toleranceEnd = addMinutes(plan.preferredSlot.start, toleranceMinutes);
    const windowSlot = findSlotWithinWindow(busyIntervals, durationMinutes, offsetMinutes, {
      windowStart: plan.preferredSlot.start,
      windowEnd: toleranceEnd,
      referenceNow,
    });
    if (windowSlot) return windowSlot;
  }

  return findNextAvailableSlot(busyIntervals, durationMinutes, offsetMinutes, { referenceNow });
}

export function priorityForCapture(capture: CaptureEntryRow, referenceNow: Date) {
  return computePriorityScore(buildPriorityInput(capture), referenceNow);
}

function buildPriorityInput(capture: CaptureEntryRow): PriorityInput {
  let urgency: number | null = null;
  let impact: number | null = null;
  let reschedule_penalty: number | null = null;
  // Prefer direct DB columns when available
  if (typeof capture.urgency === 'number') urgency = capture.urgency;
  if (typeof capture.impact === 'number') impact = capture.impact;
  if (typeof capture.reschedule_penalty === 'number') reschedule_penalty = capture.reschedule_penalty;
  if (urgency == null || impact == null || reschedule_penalty == null) {
    try {
      const notes = typeof (capture as any).scheduling_notes === 'string' ? (capture as any).scheduling_notes : null;
      if (notes && notes.trim().length > 0) {
        const parsed = JSON.parse(notes);
        if (parsed && typeof parsed === 'object') {
          if (parsed.importance && typeof parsed.importance === 'object') {
            const imp = parsed.importance as Record<string, unknown>;
            const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : null);
            if (urgency == null) urgency = num(imp.urgency);
            if (impact == null) impact = num(imp.impact);
            if (reschedule_penalty == null) reschedule_penalty = num(imp.reschedule_penalty);
          }
        }
      }
    } catch {}
  }

  return {
    estimated_minutes: capture.estimated_minutes ?? null,
    importance: capture.importance ?? 1,
    urgency: urgency ?? null,
    impact: impact ?? null,
    reschedule_penalty: reschedule_penalty ?? null,
    created_at: capture.created_at ?? new Date().toISOString(),
    constraint_type: capture.constraint_type,
    constraint_time: capture.constraint_time,
    constraint_end: capture.constraint_end,
    constraint_date: capture.constraint_date,
    original_target_time: capture.original_target_time,
    deadline_at: capture.deadline_at,
    window_start: capture.window_start,
    window_end: capture.window_end,
    start_target_at: capture.start_target_at,
    is_soft_start: capture.is_soft_start,
    externality_score: capture.externality_score,
    reschedule_count: capture.reschedule_count,
  };
}

function isSlotWithinConstraints(capture: CaptureEntryRow, slot: { start: Date; end: Date }) {
  const candidates: Date[] = [];
  const pushIfValid = (iso: string | null) => {
    if (!iso) return;
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) candidates.push(d);
  };
  pushIfValid(capture.deadline_at);
  pushIfValid(capture.window_end);
  pushIfValid(capture.constraint_end);
  if (capture.constraint_type === "deadline_time") pushIfValid(capture.constraint_time);
  if (candidates.length === 0) return true;
  const minEnd = new Date(Math.min(...candidates.map((d) => d.getTime())));
  return slot.end.getTime() <= minEnd.getTime();
}

function hasActiveFreeze(capture: CaptureEntryRow, referenceNow: Date) {
  if (!capture.freeze_until) return false;
  const freezeTs = Date.parse(capture.freeze_until);
  if (!Number.isFinite(freezeTs)) return false;
  return freezeTs > referenceNow.getTime();
}

function withinStabilityWindow(capture: CaptureEntryRow, referenceNow: Date) {
  if (!capture.planned_start) return false;
  const plannedTs = Date.parse(capture.planned_start);
  if (!Number.isFinite(plannedTs)) return false;
  return plannedTs - referenceNow.getTime() <= STABILITY_WINDOW_MINUTES * 60_000;
}

function selectMinimalPreemptionSet(args: {
  slot: PreferredSlot;
  events: CalendarEvent[];
  candidateIds: string[];
  offsetMinutes: number;
  allowCompressedBuffer: boolean;
}) {
  if (args.candidateIds.length === 0) return null;
  const buffers = args.allowCompressedBuffer
    ? [BUFFER_MINUTES, COMPRESSED_BUFFER_MINUTES]
    : [BUFFER_MINUTES];
  const uniqueBuffers = Array.from(new Set(buffers));
  const maxCombinationSize = Math.min(args.candidateIds.length, 4);

  for (const buffer of uniqueBuffers) {
    for (let size = 1; size <= maxCombinationSize; size++) {
      const combos = generateCombinations(args.candidateIds, size, 64);
      for (const combo of combos) {
        const removalSet = new Set(combo);
        const filteredEvents = args.events.filter((event) => !removalSet.has(event.id));
        const intervals = computeBusyIntervals(filteredEvents, buffer);
        if (isSlotFeasible(args.slot, args.offsetMinutes, intervals)) {
          return { ids: combo, bufferMinutes: buffer };
        }
      }
    }
  }

  return null;
}

function readCannotOverlapFromNotes(capture: CaptureEntryRow): boolean {
  if (typeof (capture as any).cannot_overlap === 'boolean') return Boolean((capture as any).cannot_overlap);
  try {
    const raw = (capture as any).scheduling_notes as string | null | undefined;
    if (!raw || typeof raw !== 'string') return false;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.flexibility && typeof parsed.flexibility === 'object') {
      return Boolean((parsed.flexibility as any).cannot_overlap);
    }
  } catch {}
  return false;
}

function generateCombinations<T>(items: T[], size: number, limit = 64): T[][] {
  if (size <= 0) return [[]];
  if (size > items.length) return [];
  const results: T[][] = [];

  const backtrack = (start: number, path: T[]) => {
    if (results.length >= limit) return;
    if (path.length === size) {
      results.push([...path]);
      return;
    }
    for (let i = start; i < items.length; i++) {
      path.push(items[i]);
      backtrack(i + 1, path);
      path.pop();
      if (results.length >= limit) return;
    }
  };

  backtrack(0, []);
  return results;
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
  google: GoogleCalendarActions,
  admin: SupabaseClient<Database, "public">,
  options: {
    captureMap: Map<string, CaptureEntryRow>;
    eventsById: Map<string, CalendarEvent>;
    planId: string;
    recordPlanAction: (action: Omit<PlanActionRecord, "planId">) => Promise<void>;
  },
) {
  const removed: CaptureEntryRow[] = [];
  for (const conflict of conflicts) {
    if (!conflict.captureId) continue;
    const blocker = options.captureMap.get(conflict.captureId);
    const prevSnapshot = blocker ? snapshotFromRow(blocker) : null;
    try {
      const event = options.eventsById.get(conflict.id);
      await google.deleteEvent({
        eventId: conflict.id,
        etag: blocker?.calendar_event_etag ?? event?.etag,
      });
    } catch (error) {
      if (error instanceof ScheduleError && error.status === 412) {
        const refreshed = await google.getEvent(conflict.id);
        if (refreshed) {
          options.eventsById.set(conflict.id, refreshed);
          try {
            await google.deleteEvent({
              eventId: conflict.id,
              etag: refreshed.etag ?? undefined,
            });
          } catch (retryError) {
            console.log("Retry delete failed for event", conflict.id, retryError);
          }
        }
      } else {
        console.log("Failed to delete conflicting event", conflict.id, error);
      }
    }
    const nextRescheduleCount = (options.captureMap.get(conflict.captureId)?.reschedule_count ?? 0) + 1;
    const { data, error } = await admin
      .from("capture_entries")
      .update({
        status: "pending",
        calendar_event_id: null,
        calendar_event_etag: null,
        planned_start: null,
        planned_end: null,
        scheduled_for: null,
        reschedule_count: nextRescheduleCount,
        plan_id: options.planId,
        freeze_until: null,
        scheduling_notes: "Rebalanced to honour a higher priority constraint.",
      })
      .eq("id", conflict.captureId)
      .select("*")
      .single();
    if (error || !data) continue;
    removed.push(data as CaptureEntryRow);
    options.eventsById.delete(conflict.id);
    if (prevSnapshot) {
      await options.recordPlanAction({
        actionId: crypto.randomUUID(),
        captureId: conflict.captureId,
        captureContent: blocker?.content ?? "Capture",
        actionType: "unscheduled",
        prev: prevSnapshot,
        next: snapshotFromRow(data as CaptureEntryRow),
      });
    }
  }
  return removed;
}

async function loadConflictCaptures(
  admin: SupabaseClient<Database, "public">,
  conflicts: ConflictSummary[],
) {
  const ids = Array.from(
    new Set(
      conflicts
        .map((conflict) => conflict.captureId)
        .filter((value): value is string => Boolean(value)),
    ),
  );
  if (ids.length === 0) {
    return new Map();
  }
  const { data, error } = await admin
    .from("capture_entries")
    .select("*")
    .in("id", ids);
  if (error || !data) {
    return new Map();
  }
  const map = new Map<string, CaptureEntryRow>();
  for (const row of data as CaptureEntryRow[]) {
    map.set(row.id, row);
  }
  return map;
}

async function rescheduleCaptures(args: {
  captures: CaptureEntryRow[];
  google: GoogleCalendarActions;
  admin: SupabaseClient<Database, "public">;
  busyIntervals: { start: Date; end: Date }[];
  offsetMinutes: number;
  referenceNow: Date;
  planId: string;
  recordPlanAction: (action: Omit<PlanActionRecord, "planId">) => Promise<void>;
}) {
  const {
    captures,
    google,
    admin,
    busyIntervals,
    offsetMinutes,
    referenceNow,
    planId,
    recordPlanAction,
  } = args;
  const queue = [...captures].sort((a, b) => {
    const bPriority = priorityForCapture(b, referenceNow);
    const aPriority = priorityForCapture(a, referenceNow);
    if (bPriority !== aPriority) return bPriority - aPriority;
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
      isSoftStart: capture.is_soft_start,
    });

    if (!slot) {
      await admin
        .from("capture_entries")
        .update({
          status: "pending",
          scheduling_notes: "Unable to reschedule automatically. Please choose a new time.",
        })
        .eq("id", capture.id);
      await replaceCaptureChunks(admin, capture, []);
      continue;
    }

    try {
      const actionId = crypto.randomUUID();
      const priorityScore = priorityForCapture(capture, referenceNow);
      const createdEvent = await google.createEvent({
        capture,
        slot,
        planId,
        actionId,
        priorityScore,
      });
      const prevSnapshot = snapshotFromRow(capture);
      const { data, error } = await admin
        .from("capture_entries")
        .update({
          status: "scheduled",
          planned_start: slot.start.toISOString(),
          planned_end: slot.end.toISOString(),
          scheduled_for: slot.start.toISOString(),
          calendar_event_id: createdEvent.id,
          calendar_event_etag: createdEvent.etag,
          plan_id: planId,
          freeze_until: null,
          scheduling_notes: "Rescheduled automatically after calendar reflow.",
        })
        .eq("id", capture.id)
        .select("*")
        .single();
      if (!error && data) {
        await replaceCaptureChunks(admin, data as CaptureEntryRow, [
          { start: slot.start, end: slot.end },
        ]);
        registerInterval(busyIntervals, slot);
        await recordPlanAction({
          actionId,
          captureId: capture.id,
          captureContent: capture.content,
          actionType: "rescheduled",
          prev: prevSnapshot,
          next: snapshotFromRow(data as CaptureEntryRow),
        });
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
      await replaceCaptureChunks(admin, capture, []);
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
  admin: SupabaseClient<Database, "public">;
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

  // enrich conflicts with capture details when available
  const diaGuruConflicts = args.conflicts.filter((c) => c.diaGuru && c.captureId);
  const captureMap = await loadConflictCaptures(args.admin, diaGuruConflicts);
  const conflictCaptures = Array.from(captureMap.values()).map((c) => {
    let facets: any = {};
    try {
      const raw = (c as any).scheduling_notes as string | null | undefined;
      if (raw && typeof raw === 'string' && raw.trim().length > 0) facets = JSON.parse(raw);
    } catch {}
    return {
      id: c.id,
      content: c.content,
      estimated_minutes: c.estimated_minutes,
      constraint_type: c.constraint_type,
      constraint_time: c.constraint_time,
      constraint_end: c.constraint_end,
      constraint_date: c.constraint_date,
      deadline_at: c.deadline_at,
      window_start: c.window_start,
      window_end: c.window_end,
      start_target_at: c.start_target_at,
      is_soft_start: c.is_soft_start,
      reschedule_count: c.reschedule_count,
      facets,
    };
  });

  const advisorResult = await adviseWithDeepSeek({
    config: args.llmConfig,
    capture,
    preferredSlot,
    conflicts: args.conflicts,
    conflictCaptures,
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
  conflictCaptures: Array<Record<string, unknown>>;
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
    conflict_captures: args.conflictCaptures,
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

async function getCalendarEvent(accessToken: string, eventId: string) {
  const res = await fetch(`${GOOGLE_EVENTS}/${eventId}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 404) return null;
  const payload = await safeParse(res);
  if (!res.ok) {
    const message =
      extractGoogleError(payload) ?? `Failed to fetch calendar event (status ${res.status})`;
    throw new ScheduleError(message, res.status, payload);
  }
  return payload as CalendarEvent;
}

async function deleteCalendarEvent(
  accessToken: string,
  options: { eventId: string; etag?: string | null },
) {
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
  if (options.etag) headers["If-Match"] = options.etag;
  const res = await fetch(`${GOOGLE_EVENTS}/${options.eventId}`, {
    method: "DELETE",
    headers,
  });
  if (!res.ok) {
    const payload = await safeParse(res);
    const message =
      extractGoogleError(payload) ?? `Failed to delete calendar event (status ${res.status})`;
    if (res.status === 412) {
      throw new ScheduleError(message, res.status, { eventId: options.eventId, payload });
    }
    if (res.status === 404) return;
    throw new ScheduleError(message, res.status, payload);
  }
}

async function createCalendarEvent(
  accessToken: string,
  params: {
    capture: CaptureEntryRow;
    slot: { start: Date; end: Date };
    planId?: string | null;
    actionId: string;
    priorityScore: number;
    description?: string;
  },
) {
  const { capture, slot, planId, actionId, priorityScore } = params;
  const summary = `[DG] ${capture.content}`.slice(0, 200);
  const privateProps: Record<string, string> = {
    diaGuru: "true",
    capture_id: capture.id,
    action_id: actionId,
    priority_snapshot: priorityScore.toFixed(2),
  };
  if (planId) {
    privateProps.plan_id = planId;
  }
  const body = {
    summary,
    description:
      params.description ??
      `DiaGuru scheduled task (importance ${capture.importance}).`,
    start: { dateTime: slot.start.toISOString() },
    end: { dateTime: slot.end.toISOString() },
    reminders: { useDefault: true },
    extendedProperties: {
      private: {
        ...privateProps,
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
  const etag =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>).etag : null;
  if (!identifier || typeof identifier !== "string") {
    throw new ScheduleError("Google did not return an event id", 502, payload);
  }
  return { id: identifier, etag: typeof etag === "string" ? etag : null };
}

function snapshotFromRow(row: CaptureEntryRow): CaptureSnapshot {
  return {
    status: row.status ?? null,
    planned_start: row.planned_start ?? null,
    planned_end: row.planned_end ?? null,
    calendar_event_id: row.calendar_event_id ?? null,
    calendar_event_etag: row.calendar_event_etag ?? null,
    freeze_until: row.freeze_until ?? null,
    plan_id: row.plan_id ?? null,
  };
}

function convertPlanActionForInsert(action: PlanActionRecord) {
  return {
    plan_id: action.planId,
    action_id: action.actionId,
    capture_id: action.captureId,
    capture_content: action.captureContent,
    action_type: action.actionType,
    prev_status: action.prev.status,
    prev_planned_start: action.prev.planned_start,
    prev_planned_end: action.prev.planned_end,
    prev_calendar_event_id: action.prev.calendar_event_id,
    prev_calendar_event_etag: action.prev.calendar_event_etag,
    prev_freeze_until: action.prev.freeze_until,
    prev_plan_id: action.prev.plan_id,
    next_status: action.next.status,
    next_planned_start: action.next.planned_start,
    next_planned_end: action.next.planned_end,
    next_calendar_event_id: action.next.calendar_event_id,
    next_calendar_event_etag: action.next.calendar_event_etag,
    next_freeze_until: action.next.freeze_until,
    next_plan_id: action.next.plan_id,
  };
}

function buildPlanSummary(planId: string, actions: PlanActionRecord[]) {
  return {
    id: planId,
    createdAt: new Date().toISOString(),
    actions: actions.map((action) => ({
      actionId: action.actionId,
      captureId: action.captureId,
      content: action.captureContent,
      actionType: action.actionType,
      previousStart: action.prev.planned_start,
      previousEnd: action.prev.planned_end,
      nextStart: action.next.planned_start,
      nextEnd: action.next.planned_end,
    })),
  };
}

function buildPlanSummaryText(actions: PlanActionRecord[]) {
  const scheduled = actions.filter((action) => action.actionType === "scheduled").length;
  const moved = actions.filter((action) => action.actionType === "rescheduled").length;
  const unscheduled = actions.filter((action) => action.actionType === "unscheduled").length;
  return `scheduled:${scheduled} moved:${moved} unscheduled:${unscheduled}`;
}

export function createGoogleCalendarActions(options: {
  credentials: CalendarClientCredentials;
  admin: SupabaseClient<Database, "public">;
  clientId: string;
  clientSecret: string;
}): GoogleCalendarActions {
  const { credentials, admin, clientId, clientSecret } = options;

  const run = async <T>(operation: (token: string) => Promise<T>): Promise<T> => {
    let refreshed = false;
    while (true) {
      try {
        const result = await operation(credentials.accessToken);
        await setCalendarReconnectFlag(admin, credentials.accountId, false);
        return result;
      } catch (error) {
        if (!refreshed && shouldAttemptTokenRefresh(error) && credentials.refreshToken) {
          const didRefresh = await refreshCalendarAccess({
            credentials,
            admin,
            clientId,
            clientSecret,
          });
          if (didRefresh) {
            refreshed = true;
            continue;
          }
        }

        if (isAuthError(error)) {
          await setCalendarReconnectFlag(admin, credentials.accountId, true);
          throw new ScheduleError("Google Calendar not linked", 400, error instanceof ScheduleError ? error.details : null);
        }
        throw error;
      }
    }
  };

  return {
    listEvents: (timeMin, timeMax) => run((token) => listCalendarEvents(token, timeMin, timeMax)),
    deleteEvent: (options) => run((token) => deleteCalendarEvent(token, options)),
    createEvent: (options) => run((token) => createCalendarEvent(token, options)),
    getEvent: (eventId) => run((token) => getCalendarEvent(token, eventId)),
  };
}

async function refreshCalendarAccess(args: {
  credentials: CalendarClientCredentials;
  admin: SupabaseClient<Database, "public">;
  clientId: string;
  clientSecret: string;
}): Promise<boolean> {
  const { credentials, admin, clientId, clientSecret } = args;
  const refreshToken = credentials.refreshToken;
  if (!refreshToken) return false;

  const refreshed = await refreshGoogleToken(refreshToken, clientId, clientSecret);
  if (!refreshed || typeof refreshed.access_token !== "string") {
    return false;
  }

  const nextRefreshToken =
    typeof refreshed.refresh_token === "string" && refreshed.refresh_token.trim().length > 0
      ? refreshed.refresh_token
      : refreshToken;

  credentials.accessToken = refreshed.access_token;
  credentials.refreshToken = nextRefreshToken;
  credentials.refreshed = true;

  const expiresIn =
    typeof refreshed.expires_in === "number" && Number.isFinite(refreshed.expires_in) && refreshed.expires_in > 0
      ? refreshed.expires_in
      : 3600;

  await persistCalendarToken(admin, {
    accountId: credentials.accountId,
    accessToken: credentials.accessToken,
    refreshToken: nextRefreshToken,
    expiresInSeconds: expiresIn,
  });

  return true;
}

async function persistCalendarToken(
  admin: SupabaseClient<Database, "public">,
  params: { accountId: number; accessToken: string; refreshToken: string | null; expiresInSeconds: number },
) {
  const expiryIso = new Date(Date.now() + Math.max(0, params.expiresInSeconds) * 1000).toISOString();
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
    account_id: params.accountId,
    access_token: params.accessToken,
    refresh_token: params.refreshToken,
    expiry: expiryIso,
  });

  return expiryIso;
}

async function setCalendarReconnectFlag(
  admin: SupabaseClient<Database, "public">,
  accountId: number,
  needsReconnect: boolean,
) {
  try {
    await admin.from("calendar_accounts").update({ needs_reconnect: needsReconnect }).eq("id", accountId);
  } catch (error) {
    console.log("Failed to update reconnect flag", error);
  }
}

function shouldAttemptTokenRefresh(error: unknown) {
  return error instanceof ScheduleError && error.status === 401;
}

function isAuthError(error: unknown) {
  return error instanceof ScheduleError && (error.status === 401 || error.status === 403);
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

export const __test__ = {
  createGoogleCalendarActions,
};
