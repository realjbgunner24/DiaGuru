import { computePriorityScore } from './priority';
import { supabase } from './supabase';

export type CaptureStatus = 'pending' | 'scheduled' | 'awaiting_confirmation' | 'completed';

export type Capture = {
  id: string;
  user_id: string;
  content: string;
  estimated_minutes: number | null;
  importance: number;
  status: CaptureStatus;
  scheduled_for: string | null;
  planned_start: string | null;
  planned_end: string | null;
  calendar_event_id: string | null;
  last_check_in: string | null;
  scheduling_notes: string | null;
  constraint_type: ConstraintType;
  constraint_time: string | null;
  constraint_end: string | null;
  constraint_date: string | null;
  original_target_time: string | null;
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
  constraintType?: ConstraintType;
  constraintTime?: string | null;
  constraintEnd?: string | null;
  constraintDate?: string | null;
  originalTargetTime?: string | null;
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

function mapCaptureRow(row: Record<string, any>): Capture {
  const constraintType = normalizeConstraintType(row.constraint_type);
  const capture: Capture = {
    id: row.id,
    user_id: row.user_id,
    content: row.content,
    estimated_minutes: row.estimated_minutes ?? null,
    importance: row.importance,
    status: row.status as CaptureStatus,
    scheduled_for: row.scheduled_for ?? null,
    planned_start: row.planned_start ?? null,
    planned_end: row.planned_end ?? null,
    calendar_event_id: row.calendar_event_id ?? null,
    last_check_in: row.last_check_in ?? null,
    scheduling_notes: row.scheduling_notes ?? null,
    constraint_type: constraintType,
    constraint_time: row.constraint_time ?? null,
    constraint_end: row.constraint_end ?? null,
    constraint_date: row.constraint_date ?? null,
    original_target_time: row.original_target_time ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    priorityScore: 0,
  };

  capture.priorityScore = computePriorityScore({
    estimated_minutes: capture.estimated_minutes,
    importance: capture.importance,
    created_at: capture.created_at,
    constraint_type: capture.constraint_type,
    constraint_time: capture.constraint_time,
    constraint_date: capture.constraint_date,
    original_target_time: capture.original_target_time,
  });

  return capture;
}

export type ParseMode = 'deterministic' | 'conversational';

export type ParseTaskResponse = {
  content: string;
  structured: {
    estimated_minutes?: number;
    datetime?: string;
    window?: { start: string; end: string };
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
      mode: input.mode ?? 'deterministic',
      timezone: input.timezone,
      now: input.now,
    },
  });

  if (error) {
    const message =
      (typeof error === 'object' && error !== null && 'message' in error && typeof (error as any).message === 'string'
        ? (error as any).message
        : typeof error === 'string'
        ? error
        : null) ?? 'Unable to parse capture text.';
    throw new Error(message);
  }

  if (!data || typeof data !== 'object') {
    throw new Error('Empty response from parse-task function.');
  }

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
      conflicts: Array<{ id: string; summary?: string; start?: string; end?: string; diaGuru?: boolean }>;
      suggestion?: { start: string; end: string } | null;
      advisor?: ScheduleAdvisor | null;
      metadata?: {
        llmAttempted: boolean;
        llmModel?: string | null;
        llmError?: string | null;
      };
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
    constraintType = 'flexible',
    constraintTime = null,
    constraintEnd = null,
    constraintDate = null,
    originalTargetTime = null,
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
      user_id: targetUserId,
      constraint_type: constraintType,
      constraint_time: constraintTime,
      constraint_end: constraintEnd,
      constraint_date: constraintDate,
      original_target_time: originalTargetTime,
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
  };
  return {
    ...payload,
    capture: payload.capture ? mapCaptureRow(payload.capture) : null,
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
