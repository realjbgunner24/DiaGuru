import { computePriorityScore } from './priority';
import { supabase } from './supabase';

export type CaptureStatus = 'pending' | 'scheduled' | 'awaiting_confirmation' | 'completed';

export type Capture = {
  id: string;
  user_id: string;
  content: string;
  estimated_minutes: number | null;
  importance: number;
  urgency?: number | null;
  impact?: number | null;
  reschedule_penalty?: number | null;
  blocking?: boolean | null;
  status: CaptureStatus;
  scheduled_for: string | null;
  planned_start: string | null;
  planned_end: string | null;
  calendar_event_id: string | null;
  calendar_event_etag: string | null;
  last_check_in: string | null;
  scheduling_notes: string | null;
  constraint_type: ConstraintType;
  constraint_time: string | null;
  constraint_end: string | null;
  constraint_date: string | null;
  original_target_time: string | null;
  deadline_at: string | null;
  window_start: string | null;
  window_end: string | null;
  start_target_at: string | null;
  is_soft_start: boolean;
  cannot_overlap?: boolean | null;
  start_flexibility?: string | null;
  duration_flexibility?: string | null;
  min_chunk_minutes?: number | null;
  max_splits?: number | null;
  extraction_kind?: string | null;
  time_pref_time_of_day?: string | null;
  time_pref_day?: string | null;
  importance_rationale?: string | null;
  externality_score: number;
  reschedule_count: number;
  task_type_hint: string | null;
  freeze_until: string | null;
  plan_id: string | null;
  manual_touch_at: string | null;
  created_at: string;
  updated_at: string;
  priorityScore: number;
};

export type ConstraintType =
  | 'flexible'
  | 'deadline_time'
  | 'deadline_date'
  | 'start_time'
  | 'window';

export type CaptureInput = {
  content: string;
  estimatedMinutes?: number | null;
  importance?: number;
  urgency?: number | null;
  impact?: number | null;
  reschedulePenalty?: number | null;
  blocking?: boolean | null;
  cannotOverlap?: boolean | null;
  startFlexibility?: 'hard' | 'soft' | 'anytime' | null;
  durationFlexibility?: 'fixed' | 'split_allowed' | null;
  minChunkMinutes?: number | null;
  maxSplits?: number | null;
  extractionKind?: string | null;
  timePrefTimeOfDay?: 'morning' | 'afternoon' | 'evening' | 'night' | null;
  timePrefDay?: 'today' | 'tomorrow' | 'specific_date' | 'any' | null;
  importanceRationale?: string | null;
  schedulingNotes?: string | null;
  constraintType?: ConstraintType;
  constraintTime?: string | null;
  constraintEnd?: string | null;
  constraintDate?: string | null;
  originalTargetTime?: string | null;
  deadlineAt?: string | null;
  windowStart?: string | null;
  windowEnd?: string | null;
  startTargetAt?: string | null;
  isSoftStart?: boolean;
  externalityScore?: number;
  taskTypeHint?: string | null;
};

function normalizeConstraintType(value: unknown): ConstraintType {
  if (
    value === 'deadline_time' ||
    value === 'deadline_date' ||
    value === 'start_time' ||
    value === 'window'
  ) {
    return value;
  }
  return 'flexible';
}

function asNumber(value: unknown, fallback = 0) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asBoolean(value: unknown, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (['true', 't', '1', 'yes'].includes(value.toLowerCase())) return true;
    if (['false', 'f', '0', 'no'].includes(value.toLowerCase())) return false;
  }
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  return fallback;
}

function mapCaptureRow(row: Record<string, any>): Capture {
  const constraintType = normalizeConstraintType(row.constraint_type);
  const capture: Capture = {
    id: row.id,
    user_id: row.user_id,
    content: row.content,
    estimated_minutes: row.estimated_minutes ?? null,
    importance: row.importance,
    urgency: row.urgency ?? null,
    impact: row.impact ?? null,
    reschedule_penalty: row.reschedule_penalty ?? null,
    blocking: row.blocking ?? null,
    status: row.status as CaptureStatus,
    scheduled_for: row.scheduled_for ?? null,
    planned_start: row.planned_start ?? null,
    planned_end: row.planned_end ?? null,
    calendar_event_id: row.calendar_event_id ?? null,
    calendar_event_etag: row.calendar_event_etag ?? null,
    last_check_in: row.last_check_in ?? null,
    scheduling_notes: row.scheduling_notes ?? null,
    constraint_type: constraintType,
    constraint_time: row.constraint_time ?? null,
    constraint_end: row.constraint_end ?? null,
    constraint_date: row.constraint_date ?? null,
    original_target_time: row.original_target_time ?? null,
    deadline_at: row.deadline_at ?? null,
    window_start: row.window_start ?? null,
    window_end: row.window_end ?? null,
    start_target_at: row.start_target_at ?? null,
    is_soft_start: asBoolean(row.is_soft_start, false),
    cannot_overlap: asBoolean(row.cannot_overlap, false),
    start_flexibility: row.start_flexibility ?? null,
    duration_flexibility: row.duration_flexibility ?? null,
    min_chunk_minutes: row.min_chunk_minutes ?? null,
    max_splits: row.max_splits ?? null,
    extraction_kind: row.extraction_kind ?? null,
    time_pref_time_of_day: row.time_pref_time_of_day ?? null,
    time_pref_day: row.time_pref_day ?? null,
    importance_rationale: row.importance_rationale ?? null,
    externality_score: asNumber(row.externality_score, 0),
    reschedule_count: asNumber(row.reschedule_count, 0),
    task_type_hint: row.task_type_hint ?? null,
    freeze_until: row.freeze_until ?? null,
    plan_id: row.plan_id ?? null,
    manual_touch_at: row.manual_touch_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    priorityScore: 0,
  };

  capture.priorityScore = computePriorityScore({
    estimated_minutes: capture.estimated_minutes,
    importance: capture.importance,
    urgency: capture.urgency ?? null,
    impact: capture.impact ?? null,
    reschedule_penalty: capture.reschedule_penalty ?? null,
    created_at: capture.created_at,
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
  });

  return capture;
}

export type ParseMode = 'conversational_strict';

// Rich extraction types mirrored from parse-task
export type TaskExtraction = {
  title: string | null;
  estimated_minutes: number | null;
  deadline: { datetime: string | null; kind: 'hard' | 'soft' | null; source: 'explicit' | 'inferred' | null } | null;
  scheduled_time: { datetime: string | null; precision: 'exact' | 'approximate' | null; source: 'explicit' | 'inferred' | null } | null;
  execution_window: {
    relation: 'before_deadline' | 'after_deadline' | 'around_scheduled' | 'between' | 'on_day' | 'anytime' | null;
    start: string | null;
    end: string | null;
    source: 'explicit' | 'inferred' | 'default' | null;
  } | null;
  time_preferences: { time_of_day: 'morning' | 'afternoon' | 'evening' | 'night' | null; day: 'today' | 'tomorrow' | 'specific_date' | 'any' | null } | null;
  missing: string[];
  clarifying_question: string | null;
  notes: string[];
};

export type CaptureMapping = {
  estimated_minutes: number | null;
  constraint_type: 'flexible' | 'deadline_time' | 'deadline_date' | 'start_time' | 'window';
  constraint_time: string | null;
  constraint_end: string | null;
  constraint_date: string | null;
  original_target_time: string | null;
  deadline_at: string | null;
  window_start: string | null;
  window_end: string | null;
  start_target_at: string | null;
  is_soft_start: boolean;
  task_type_hint: string | null;
  reason?: string;
};

export type ParseTaskResponse = {
  content: string;
  structured: {
    estimated_minutes?: number;
    datetime?: string;
    window?: { start?: string; end?: string };
    extraction?: TaskExtraction;
    capture?: Partial<CaptureMapping> & { reason?: string };
  };
  notes: string[];
  needed: string[];
  mode: ParseMode;
  follow_up?: {
    type: 'clarify';
    prompt: string;
    missing: string[];
  } | null;
  metadata: {
    duckling: {
      enabled: boolean;
      latency_ms?: number;
      errored?: boolean;
    };
    heuristics: string[];
    deepseek: {
      enabled: boolean;
      attempted: boolean;
      latency_ms?: number;
      errored?: boolean;
      used_fallback?: boolean;
    };
  };
};

export type ParseCaptureArgs = {
  text: string;
  mode?: ParseMode;
  timezone?: string;
  now?: string;
};

export async function parseCapture(input: ParseCaptureArgs): Promise<ParseTaskResponse> {
  const { data, error } = await supabase.functions.invoke('parse-task', {
    body: {
      text: input.text,
      mode: input.mode ?? 'conversational_strict',
      timezone: input.timezone,
      now: input.now,
    },
  });

  if (error) {
    // Surface server-provided details from Edge Function (error.context)
    let message: string | null = null;
    if (typeof error === 'object' && error !== null) {
      const anyErr = error as any;
      if (typeof anyErr.message === 'string') message = anyErr.message;
      const ctx = anyErr.context;
      if (ctx) {
        // If context is a fetch Response (FunctionsHttpError), try to read JSON
        if (typeof (ctx as any).json === 'function') {
          try {
            const payload = await (ctx as any).json();
            // eslint-disable-next-line no-console
            console.log('parse-task response payload', payload);
            if (payload && typeof payload === 'object') {
              const rec = payload as Record<string, unknown>;
              const detailsStr =
                typeof rec.details === 'string' && (rec.details as string).trim().length > 0
                  ? (rec.details as string).trim()
                  : null;
              const errorStr =
                typeof rec.error === 'string' && (rec.error as string).trim().length > 0
                  ? (rec.error as string).trim()
                  : null;
              const messageStr =
                typeof rec.message === 'string' && (rec.message as string).trim().length > 0
                  ? (rec.message as string).trim()
                  : null;
              message = detailsStr ?? errorStr ?? messageStr ?? message;
            }
          } catch {
            // fall back to generic handling below
          }
        } else if (typeof ctx === 'string' && ctx.trim().length > 0) {
          message = ctx;
        } else if (typeof ctx === 'object') {
          const rec = ctx as Record<string, unknown>;
          const detailsStr =
            typeof rec.details === 'string' && (rec.details as string).trim().length > 0
              ? (rec.details as string).trim()
              : null;
          const errorStr =
            typeof rec.error === 'string' && (rec.error as string).trim().length > 0
              ? (rec.error as string).trim()
              : null;
          const messageStr =
            typeof rec.message === 'string' && (rec.message as string).trim().length > 0
              ? (rec.message as string).trim()
              : null;
          message = detailsStr ?? errorStr ?? messageStr ?? message;
        }
      }
    } else if (typeof error === 'string') {
      message = error;
    }

    try {
      console.log('parse-task error', {
        message: message ?? null,
        context: (error as any)?.context ?? null,
      });
    } catch {}

    throw new Error(message ?? 'Unable to parse capture text.');
  }

  if (!data || typeof data !== 'object') {
    throw new Error('Empty response from parse-task function.');
  }

  try {
    // eslint-disable-next-line no-console
    console.log('parse-task response payload', data);
  } catch {}

  return data as ParseTaskResponse;
}

export type ScheduleAdvisor = {
  action: 'suggest_slot' | 'ask_overlap' | 'defer';
  message: string;
  slot?: { start: string; end?: string | null } | null;
};

export type ScheduleDecision =
  | {
      type: 'preferred_conflict';
      message: string;
      preferred: { start: string; end: string };
      conflicts: { id: string; summary?: string; start?: string; end?: string; diaGuru?: boolean }[];
      suggestion?: { start: string; end: string } | null;
      advisor?: ScheduleAdvisor | null;
      metadata?: {
        llmAttempted: boolean;
        llmModel?: string | null;
        llmError?: string | null;
      };
    };

export type PlanActionSummary = {
  actionId: string;
  captureId: string;
  content: string;
  actionType: 'scheduled' | 'rescheduled' | 'unscheduled';
  previousStart: string | null;
  previousEnd: string | null;
  nextStart: string | null;
  nextEnd: string | null;
};

export type PlanSummary = {
  id: string;
  createdAt: string;
  actions: PlanActionSummary[];
};

export type ScheduleOptions = {
  preferredStart?: string;
  preferredEnd?: string;
  allowOverlap?: boolean;
  timezone?: string;
  timezoneOffsetMinutes?: number;
};

export async function listCaptures(): Promise<Capture[]> {
  const { data, error } = await supabase
    .from('capture_entries')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });

  if (error) throw error;

  const entries = (data ?? []).map((row) => mapCaptureRow(row as Record<string, unknown>));

  return entries.sort((a, b) => b.priorityScore - a.priorityScore);
}

export async function listRecentCaptures(limit = 10): Promise<Capture[]> {
  const { data, error } = await supabase
    .from('capture_entries')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;

  return (data ?? []).map((row) => mapCaptureRow(row as Record<string, unknown>));
}


export async function addCapture(input: CaptureInput, userId?: string) {
  const {
    content,
    estimatedMinutes = null,
    importance = 2,
    urgency = null,
    impact = null,
    reschedulePenalty = null,
    blocking = null,
    cannotOverlap = null,
    startFlexibility = null,
    durationFlexibility = null,
    minChunkMinutes = null,
    maxSplits = null,
    extractionKind = null,
    timePrefTimeOfDay = null,
    timePrefDay = null,
    importanceRationale = null,
    schedulingNotes = null,
    constraintType = 'flexible',
    constraintTime = null,
    constraintEnd = null,
    constraintDate = null,
    originalTargetTime = null,
    deadlineAt = null,
    windowStart = null,
    windowEnd = null,
    startTargetAt = null,
    isSoftStart = false,
    externalityScore = 0,
    taskTypeHint = null,
  } = input;
  const targetUserId =
    userId ??
    (await supabase.auth.getSession()).data.session?.user.id ??
    null;

  if (!targetUserId) {
    throw new Error('No authenticated user found while creating capture entry.');
  }

  const { data, error } = await supabase
    .from('capture_entries')
    .insert({
      content,
      estimated_minutes: estimatedMinutes,
      importance,
      urgency,
      impact,
      reschedule_penalty: reschedulePenalty,
      blocking,
      cannot_overlap: cannotOverlap,
      start_flexibility: startFlexibility,
      duration_flexibility: durationFlexibility,
      min_chunk_minutes: minChunkMinutes,
      max_splits: maxSplits,
      extraction_kind: extractionKind,
      time_pref_time_of_day: timePrefTimeOfDay,
      time_pref_day: timePrefDay,
      importance_rationale: importanceRationale,
      scheduling_notes: schedulingNotes,
      user_id: targetUserId,
      constraint_type: constraintType,
      constraint_time: constraintTime,
      constraint_end: constraintEnd,
      constraint_date: constraintDate,
      original_target_time: originalTargetTime,
      deadline_at: deadlineAt,
      window_start: windowStart,
      window_end: windowEnd,
      start_target_at: startTargetAt,
      is_soft_start: isSoftStart,
      externality_score: externalityScore,
      task_type_hint: taskTypeHint,
    })
    .select('*')
    .single();

  if (error) throw error;

  return mapCaptureRow(data as Record<string, unknown>);
}

export async function updateCaptureStatus(
  id: string,
  status: CaptureStatus,
  scheduledFor?: Date | null,
) {
  const { data, error } = await supabase
    .from('capture_entries')
    .update({
      status,
      scheduled_for: scheduledFor ? scheduledFor.toISOString() : null,
    })
    .eq('id', id)
    .select('*')
    .single();

  if (error) throw error;

  return mapCaptureRow(data as Record<string, unknown>);
}

export async function listScheduledCaptures(): Promise<Capture[]> {
  const { data, error } = await supabase
    .from('capture_entries')
    .select('*')
    .eq('status', 'scheduled')
    .order('planned_start', { ascending: true });

  if (error) throw error;

  return (data ?? []).map((row) => ({
    ...row,
    priorityScore: computePriorityScore(row),
  })) as Capture[];
}

export async function invokeScheduleCapture(
  captureId: string,
  action: 'schedule' | 'reschedule' = 'schedule',
  options?: ScheduleOptions,
) {
  const { data, error } = await supabase.functions.invoke('schedule-capture', {
    body: {
      captureId,
      action,
      ...(options ?? {}),
    },
  });
  if (error) throw error;
  const payload = data as {
    capture: Record<string, unknown> | null;
    message: string;
    decision?: ScheduleDecision | null;
    planSummary?: PlanSummary | null;
  };
  return {
    ...payload,
    capture: payload.capture ? mapCaptureRow(payload.capture) : null,
    planSummary: payload.planSummary ?? null,
  };
}

export async function invokeCaptureCompletion(
  captureId: string,
  action: 'complete' | 'reschedule',
) {
  const { data, error } = await supabase.functions.invoke('schedule-capture', {
    body: { captureId, action },
  });
  if (error) throw error;
  const payload = data as { capture: Record<string, unknown> | null; message: string };
  return {
    ...payload,
    capture: payload.capture ? mapCaptureRow(payload.capture) : null,
  };
}

export async function syncCaptureEvents() {
  const { data, error } = await supabase.functions.invoke('sync-captures');
  if (error) throw error;
  return data as {
    message: string;
    updates: number;
    scannedEvents: number;
    refreshedToken: boolean;
  };
}

export async function undoPlan(planId: string) {
  const { data, error } = await supabase.functions.invoke('undo-plan', {
    body: { planId },
  });
  if (error) throw error;
  return data as {
    message: string;
    planId: string;
    revertedCaptures: string[];
  };
}

export async function lockCaptureWindow(captureId: string, hours = 24) {
  const freezeUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('capture_entries')
    .update({ freeze_until: freezeUntil })
    .eq('id', captureId)
    .select('*')
    .single();

  if (error) throw error;
  return mapCaptureRow(data as Record<string, unknown>);
}
