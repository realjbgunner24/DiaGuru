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
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  extendedProperties?: { private?: Record<string, string>; shared?: Record<string, string> };
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

    const durationMinutes = Math.max(5, Math.min(capture.estimated_minutes ?? 30, 480));
    const candidate = await findNextAvailableSlot(accessToken, durationMinutes, timezoneOffsetMinutes);
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

async function findNextAvailableSlot(
  accessToken: string,
  durationMinutes: number,
  timezoneOffsetMinutes: number | null,
) {
  const offset = typeof timezoneOffsetMinutes === "number" && Number.isFinite(timezoneOffsetMinutes)
    ? timezoneOffsetMinutes
    : 0;
  const now = new Date();
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + SEARCH_DAYS * 86400000).toISOString();

  const events = await listCalendarEvents(accessToken, timeMin, timeMax);
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

  let cursor = addMinutes(now, 5);
  if (isBeforeDayStart(cursor, offset)) {
    cursor = startOfDayOffset(now, offset);
  }

  for (let day = 0; day < SEARCH_DAYS; day++) {
    const dayStart = startOfDayOffset(addDays(now, day), offset);
    let candidateStart = new Date(Math.max(dayStart.getTime(), cursor.getTime()));
    while (true) {
      if (isAfterDayEnd(candidateStart, offset)) break;
      const candidateEnd = addMinutes(candidateStart, durationMinutes);
      if (isAfterDayEnd(candidateEnd, offset)) break;

      if (isSlotFree(candidateStart, candidateEnd, intervals)) {
        return { start: candidateStart, end: candidateEnd };
      }

      candidateStart = addMinutes(candidateStart, SLOT_INCREMENT_MINUTES);
    }
    cursor = startOfDayOffset(addDays(now, day + 1), offset);
  }

  return null;
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
