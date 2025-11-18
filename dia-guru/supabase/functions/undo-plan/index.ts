import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CaptureEntryRow,
  Database,
  PlanActionRow,
  PlanRunRow,
} from "../types.ts";
import {
  ScheduleError,
  resolveCalendarClient,
  createGoogleCalendarActions,
  priorityForCapture,
} from "../schedule-capture/index.ts";

type UndoRequest = {
  planId?: string;
};

export async function handler(req: Request) {
  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return json({ error: "Missing Authorization" }, 401);

    const body = (await req.json().catch(() => ({}))) as UndoRequest;
    const planId = body.planId?.trim();
    if (!planId) return json({ error: "planId required" }, 400);

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
    const { data: plan, error: planError } = await admin
      .from("plan_runs")
      .select("*")
      .eq("id", planId)
      .single();
    if (planError || !plan) return json({ error: "Plan not found" }, 404);

    const typedPlan = plan as PlanRunRow;
    if (typedPlan.user_id !== userId) return json({ error: "Forbidden" }, 403);
    if (typedPlan.undone_at) return json({ error: "Plan already undone" }, 409);

    const { data: actionRows, error: actionsError } = await admin
      .from("plan_actions")
      .select("*")
      .eq("plan_id", planId)
      .order("performed_at", { ascending: false });
    if (actionsError) {
      return json({ error: "Unable to load plan actions" }, 500);
    }
    const planActions = (actionRows ?? []) as PlanActionRow[];
    if (planActions.length === 0) {
      return json({ error: "No actions recorded for this plan." }, 400);
    }

    const captureIds = Array.from(
      new Set(planActions.map((action) => action.capture_id)),
    );
    const { data: captureRows, error: captureError } = await admin
      .from("capture_entries")
      .select("*")
      .in("id", captureIds);
    if (captureError) return json({ error: "Unable to load captures" }, 500);
    const captureMap = new Map<string, CaptureEntryRow>();
    for (const row of (captureRows ?? []) as CaptureEntryRow[]) {
      captureMap.set(row.id, row);
    }

    const credentials = await resolveCalendarClient(admin, userId, clientId, clientSecret);
    if (!credentials) {
      return json({ error: "Google Calendar not linked" }, 400);
    }
    const google = createGoogleCalendarActions({
      credentials,
      admin,
      clientId,
      clientSecret,
    });

    const now = new Date();
    const revertedCaptureIds = new Set<string>();

    for (const action of planActions) {
      const capture = captureMap.get(action.capture_id);
      if (!capture) continue;

      if (action.next_calendar_event_id) {
        try {
          await google.deleteEvent({
            eventId: action.next_calendar_event_id,
            etag: action.next_calendar_event_etag ?? undefined,
          });
        } catch (error) {
          if (
            !(error instanceof ScheduleError && (error.status === 404 || error.status === 412))
          ) {
            console.log("Failed to delete plan event during undo", error);
          }
        }
      }

      let recreatedEvent: { id: string; etag: string | null } | null = null;
      const shouldRestoreEvent =
        action.prev_status === "scheduled" &&
        action.prev_planned_start &&
        action.prev_planned_end;

      if (shouldRestoreEvent) {
        const start = new Date(action.prev_planned_start!);
        const end = new Date(action.prev_planned_end!);
        if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
          try {
            recreatedEvent = await google.createEvent({
              capture,
              slot: { start, end },
              planId: action.prev_plan_id ?? null,
              actionId: crypto.randomUUID(),
              priorityScore: priorityForCapture(capture, now),
              description: "Restored via undo-plan.",
            });
          } catch (error) {
            console.log("Failed to recreate calendar event during undo", error);
          }
        }
      }

      const nextRescheduleCount =
        action.action_type === "scheduled"
          ? capture.reschedule_count ?? 0
          : Math.max(0, (capture.reschedule_count ?? 0) - 1);

      const restoredStatus =
        action.prev_status === "scheduled" && !recreatedEvent
          ? "pending"
          : action.prev_status;
      const restoredStart =
        action.prev_status === "scheduled" && !recreatedEvent
          ? null
          : action.prev_planned_start;
      const restoredEnd =
        action.prev_status === "scheduled" && !recreatedEvent
          ? null
          : action.prev_planned_end;

      const updatedValues = {
        status: restoredStatus,
        planned_start: restoredStart,
        planned_end: restoredEnd,
        scheduled_for: restoredStart,
        calendar_event_id: recreatedEvent ? recreatedEvent.id : null,
        calendar_event_etag: recreatedEvent ? recreatedEvent.etag : null,
        plan_id: action.prev_plan_id,
        freeze_until: action.prev_freeze_until,
        reschedule_count: nextRescheduleCount,
        scheduling_notes: "Restored via undo-plan.",
      };

      await admin.from("capture_entries").update(updatedValues).eq("id", action.capture_id);
      captureMap.set(action.capture_id, {
        ...capture,
        ...updatedValues,
      } as CaptureEntryRow);
      revertedCaptureIds.add(action.capture_id);
    }

    await admin
      .from("plan_runs")
      .update({
        undone_at: now.toISOString(),
        undo_user_id: userId,
      })
      .eq("id", planId);

    return json({
      message: "Plan undone.",
      planId,
      revertedCaptures: Array.from(revertedCaptureIds),
    });
  } catch (error) {
    if (error instanceof ScheduleError) {
      return json({ error: error.message, details: error.details ?? null }, error.status);
    }
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: "Undo failed", details: message }, 500);
  }
}

if (import.meta.main) {
  Deno.serve(handler);
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
