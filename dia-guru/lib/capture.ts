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

export async function invokeScheduleCapture(captureId: string, action: 'schedule' | 'reschedule' = 'schedule') {
  const { data, error } = await supabase.functions.invoke('schedule-capture', {
    body: { captureId, action },
  });
  if (error) throw error;
  return data as { capture: Capture | null; message: string };
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
