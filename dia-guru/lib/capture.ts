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
  created_at: string;
  updated_at: string;
  priorityScore: number;
};

export type CaptureInput = {
  content: string;
  estimatedMinutes?: number | null;
  importance?: number;
};

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

export type ScheduleDecision =
  | {
      type: 'preferred_conflict';
      message: string;
      preferred: { start: string; end: string };
      conflicts: Array<{ id: string; summary?: string; start?: string; end?: string; diaGuru?: boolean }>;
      suggestion?: { start: string; end: string } | null;
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

  const entries = (data ?? []).map((row) => ({
    ...row,
    priorityScore: computePriorityScore(row),
  })) as Capture[];

  return entries.sort((a, b) => b.priorityScore - a.priorityScore);
}

export async function listRecentCaptures(limit = 10): Promise<Capture[]> {
  const { data, error } = await supabase
    .from('capture_entries')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;

  return (data ?? []).map((row) => ({
    ...row,
    priorityScore: computePriorityScore(row),
  })) as Capture[];
}


export async function addCapture(input: CaptureInput, userId?: string) {
  const { content, estimatedMinutes = null, importance = 2 } = input;
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
    })
    .select('*')
    .single();

  if (error) throw error;

  return {
    ...data,
    priorityScore: computePriorityScore(data),
  } as Capture;
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

  return {
    ...data,
    priorityScore: computePriorityScore(data),
  } as Capture;
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
  return data as { capture: Capture | null; message: string; decision?: ScheduleDecision | null };
}

export async function invokeCaptureCompletion(
  captureId: string,
  action: 'complete' | 'reschedule',
) {
  const { data, error } = await supabase.functions.invoke('schedule-capture', {
    body: { captureId, action },
  });
  if (error) throw error;
  return data as { capture: Capture | null; message: string };
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
