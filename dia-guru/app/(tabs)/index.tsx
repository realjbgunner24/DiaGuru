import CalendarHealthNotice from '@/components/CalendarHealthNotice';
import { useSupabaseSession } from '@/hooks/useSupabaseSession';
import {
  addCapture,
  Capture,
  CaptureStatus,
  ConstraintType,
  invokeCaptureCompletion,
  invokeScheduleCapture,
  listCaptures,
  listScheduledCaptures,
  lockCaptureWindow,
  parseCapture,
  ParseMode,
  ParseTaskResponse,
  PlanSummary,
  ScheduleDecision,
  ScheduleOptions,
  syncCaptureEvents,
  undoPlan,
} from '@/lib/capture';
import { connectGoogleCalendar, getCalendarHealth, type CalendarHealth } from '@/lib/google-connect';
import {
  cancelScheduledNotification,
  scheduleReminderAt,
} from '@/lib/notifications';
import { getAssistantModePreference } from '@/lib/preferences';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

const IMPORTANCE_LEVELS = [
  { value: 1, label: 'Low' },
  { value: 2, label: 'Medium' },
  { value: 3, label: 'High' },
];

const REMINDER_STORAGE_KEY = '@diaGuru.reminders';

type PendingCaptureState = {
  baseContent: string;
  importance: number;
  appended: string[];
  mode: ParseMode;
};

type ReminderEntry = {
  notificationId: string;
  plannedEnd: string;
};

type ReminderRegistry = Record<string, ReminderEntry>;

function extractScheduleError(error: unknown) {
  if (!error) return 'Unable to schedule this item.';
  if (typeof error === 'string') return error;
  if (error instanceof Error && error.message) return error.message;

  const context = (error as { context?: unknown })?.context;
  if (typeof context === 'string') return context;
  if (context && typeof context === 'object') {
    const candidate =
      (context as Record<string, unknown>).error ??
      (context as Record<string, unknown>).details ??
      (context as Record<string, unknown>).message;
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate;
    }
  }

  return 'Unable to schedule this item.';
}

function formatConflictMessage(decision: ScheduleDecision) {
  const lines = [decision.message.trim()];
  if (decision.advisor?.message) {
    lines.push('', decision.advisor.message.trim());
  }
  if (decision.conflicts.length > 0) {
    lines.push('', 'Conflicts:');
    for (const conflict of decision.conflicts) {
      const label = conflict.summary?.trim() || 'Busy block';
      const startText = conflict.start ? new Date(conflict.start).toLocaleString() : 'unknown';
      const endText = conflict.end
        ? new Date(conflict.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '';
      const suffix = conflict.diaGuru ? ' (DiaGuru)' : '';
      const details = `${startText}${endText ? ` -> ${endText}` : ''}`;
      lines.push(`- ${label}${suffix}: ${details}`);
    }
  }
  if (decision.suggestion) {
    const suggestionStart = new Date(decision.suggestion.start).toLocaleString();
    const suggestionEnd = new Date(decision.suggestion.end).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    lines.push('', `Next available slot: ${suggestionStart} -> ${suggestionEnd}`);
  }
  if (decision.advisor?.slot?.start) {
    const advisorStart = new Date(decision.advisor.slot.start).toLocaleString();
    const advisorEnd =
      decision.advisor.slot.end &&
      new Date(decision.advisor.slot.end).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });
    lines.push(
      '',
      `Assistant suggestion: ${advisorStart}${advisorEnd ? ` -> ${advisorEnd}` : ''}`,
    );
  }
  return lines.join('\n');
}

type DerivedConstraint = {
  constraintType: ConstraintType;
  constraintTime: string | null;
  constraintEnd: string | null;
  constraintDate: string | null;
  originalTargetTime: string | null;
  deadlineAt: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  startTargetAt: string | null;
  isSoftStart: boolean;
  externalityScore: number;
  taskTypeHint: TaskTypeHint | null;
};

type TaskTypeHint =
  | 'deep_work'
  | 'admin'
  | 'creative'
  | 'errand'
  | 'health'
  | 'social'
  | 'collaboration';

const DEADLINE_KEYWORDS = [' due', 'due', 'deadline', 'before', 'submit', 'turn in', 'finish', 'complete', 'overdue'];
const START_KEYWORDS = [
  ' start',
  'begin',
  'meeting',
  'meet ',
  'meet-up',
  'meetup',
  'call',
  'appointment',
  'arrive',
  'leave',
  'ride',
  'flight',
  'depart',
  'pickup',
  'pick up',
  'drop off',
  'visit',
  'hangout',
  'lunch',
  'dinner',
  'breakfast',
  'nap',
  'sleep',
  'rest',
  'meditate',
];
const COLLAB_KEYWORDS = [
  'meet',
  'meeting',
  'call',
  'zoom',
  'hangout',
  'sync',
  'interview',
  'pair',
  'with ',
  'client',
  'team',
  'presentation',
  'demo',
  'standup',
];
const ADMIN_KEYWORDS = ['email', 'inbox', 'budget', 'file', 'tax', 'expense', 'admin', 'invoice', 'plan', 'review'];
const CREATIVE_KEYWORDS = ['write', 'draft', 'design', 'brainstorm', 'record', 'edit', 'sketch', 'prototype'];
const ERRAND_KEYWORDS = ['pickup', 'pick up', 'drop off', 'deliver', 'grocery', 'groceries', 'errand', 'store', 'commute'];
const HEALTH_KEYWORDS = ['workout', 'run', 'gym', 'yoga', 'meditate', 'doctor', 'dentist', 'therapy', 'rest', 'sleep'];
const SOCIAL_KEYWORDS = ['dinner', 'lunch', 'date', 'party', 'birthday', 'hangout', 'friends', 'family'];
const SOFT_START_HINTS = ['around', 'ish', 'about', 'maybe', 'whenever', 'some time', 'sometime', 'after', 'before', 'flexible'];
const HARD_ANCHOR_KEYWORDS = ['appointment', 'flight', 'depart', 'arrive', 'pickup', 'drop off', 'doctor', 'dentist', 'interview', 'call', 'meeting'];

function deriveConstraintData(
  content: string,
  parseResult: ParseTaskResponse | null,
  _estimatedMinutes: number | null,
): DerivedConstraint {
  const lowerContent = content.toLowerCase();
  const classification = classifyTaskType(lowerContent);
  const defaults: DerivedConstraint = {
    constraintType: 'flexible',
    constraintTime: null,
    constraintEnd: null,
    constraintDate: null,
    originalTargetTime: null,
    deadlineAt: null,
    windowStart: null,
    windowEnd: null,
    startTargetAt: null,
    isSoftStart: false,
    externalityScore: classification.externalityScore,
    taskTypeHint: classification.taskTypeHint,
  };
  if (!parseResult) return defaults;

  const structured = parseResult.structured ?? {};

  // Prefer rich capture mapping if provided by parse-task
  const cap = structured.capture as
    | {
        constraint_type?: 'flexible' | 'deadline_time' | 'deadline_date' | 'start_time' | 'window';
        constraint_time?: string | null;
        constraint_end?: string | null;
        constraint_date?: string | null;
        original_target_time?: string | null;
        deadline_at?: string | null;
        window_start?: string | null;
        window_end?: string | null;
        start_target_at?: string | null;
        is_soft_start?: boolean;
        task_type_hint?: TaskTypeHint | null;
      }
    | undefined;
  if (cap && cap.constraint_type) {
    return {
      ...defaults,
      constraintType: cap.constraint_type,
      constraintTime: cap.constraint_time ?? null,
      constraintEnd: cap.constraint_end ?? null,
      constraintDate: cap.constraint_date ?? null,
      originalTargetTime: cap.original_target_time ?? null,
      deadlineAt: cap.deadline_at ?? null,
      windowStart: cap.window_start ?? null,
      windowEnd: cap.window_end ?? null,
      startTargetAt: cap.start_target_at ?? null,
      isSoftStart: Boolean(cap.is_soft_start),
      taskTypeHint: (cap.task_type_hint as TaskTypeHint | null) ?? classification.taskTypeHint,
    };
  }
  const hasDeadlineKeyword = containsKeyword(lowerContent, DEADLINE_KEYWORDS);
  const hasStartKeyword = containsKeyword(lowerContent, START_KEYWORDS);

  const window = structured.window;
  if (window?.start && window?.end) {
    return {
      ...defaults,
      constraintType: 'window',
      constraintTime: window.start,
      constraintEnd: window.end,
      constraintDate: null,
      originalTargetTime: window.end ?? window.start ?? null,
      windowStart: window.start ?? null,
      windowEnd: window.end ?? null,
      deadlineAt: window.end ?? null,
    };
  }
  if (window?.start) {
    if (!window.start) return defaults;
    return {
      ...defaults,
      constraintType: 'start_time',
      constraintTime: window.start,
      constraintEnd: null,
      constraintDate: null,
      originalTargetTime: window.start,
      startTargetAt: window.start,
      isSoftStart: inferSoftStart(lowerContent),
    };
  }
  if (window?.end) {
    return {
      ...defaults,
      constraintType: 'deadline_time',
      constraintTime: window.end,
      constraintEnd: null,
      constraintDate: null,
      originalTargetTime: window.end,
      deadlineAt: window.end,
    };
  }

  const datetime = structured.datetime;
  if (!datetime) {
    return defaults;
  }

  const isDateOnly = /T00:00:00/iu.test(datetime);
  const hasExplicitTime = !isDateOnly;

  if (hasDeadlineKeyword && hasExplicitTime) {
    return {
      ...defaults,
      constraintType: 'deadline_time',
      constraintTime: datetime,
      constraintEnd: null,
      constraintDate: null,
      originalTargetTime: datetime,
      deadlineAt: datetime,
    };
  }

  if ((hasDeadlineKeyword && isDateOnly) || (isDateOnly && !hasStartKeyword)) {
    const date = datetime.slice(0, 10);
    const endOfDay = buildEndOfDayIso(datetime);
    return {
      ...defaults,
      constraintType: 'deadline_date',
      constraintTime: null,
      constraintEnd: null,
      constraintDate: date,
      originalTargetTime: endOfDay,
      deadlineAt: endOfDay,
    };
  }

  if (hasStartKeyword && !hasDeadlineKeyword) {
    if (!hasExplicitTime) {
      const date = datetime.slice(0, 10);
      const endOfDay = buildEndOfDayIso(datetime);
      return {
        ...defaults,
        constraintType: 'deadline_date',
        constraintTime: null,
        constraintEnd: null,
        constraintDate: date,
        originalTargetTime: endOfDay,
        deadlineAt: endOfDay,
      };
    }
    return {
      ...defaults,
      constraintType: 'start_time',
      constraintTime: datetime,
      constraintEnd: null,
      constraintDate: null,
      originalTargetTime: datetime,
      startTargetAt: datetime,
      isSoftStart: inferSoftStart(lowerContent),
    };
  }

  return {
    ...defaults,
    constraintType: 'deadline_time',
    constraintTime: datetime,
    constraintEnd: null,
    constraintDate: null,
    originalTargetTime: datetime,
    deadlineAt: datetime,
  };
}

function buildEndOfDayIso(datetime: string) {
  const date = new Date(datetime);
  if (Number.isNaN(date.getTime())) return null;
  date.setHours(23, 59, 0, 0);
  return date.toISOString();
}

function containsKeyword(content: string, keywords: string[]) {
  return keywords.some((keyword) => {
    const trimmed = keyword.trim();
    if (!trimmed) return false;
    const hasInternalWhitespace = /\s/.test(trimmed);
    const requiresLeadingWhitespace = keyword.startsWith(' ');
    const requiresTrailingWhitespace = keyword.endsWith(' ');
    const startBoundary = requiresLeadingWhitespace ? '(?:^|\\s)' : '\\b';
    const endBoundary = requiresTrailingWhitespace ? '(?:\\s|$)' : '\\b';

    if (hasInternalWhitespace) {
      const pattern = new RegExp(
        `${requiresLeadingWhitespace ? '(?:^|\\s)' : ''}${escapeRegex(trimmed)}${requiresTrailingWhitespace ? '(?:\\s|$)' : ''}`,
        'i',
      );
      return pattern.test(content);
    }

    const pattern = new RegExp(`${startBoundary}${escapeRegex(trimmed)}${endBoundary}`, 'i');
    return pattern.test(content);
  });
}

function classifyTaskType(content: string): { taskTypeHint: TaskTypeHint | null; externalityScore: number } {
  if (containsKeyword(content, COLLAB_KEYWORDS)) {
    return { taskTypeHint: 'collaboration', externalityScore: 3 };
  }
  if (containsKeyword(content, SOCIAL_KEYWORDS)) {
    return { taskTypeHint: 'social', externalityScore: 2 };
  }
  if (containsKeyword(content, ERRAND_KEYWORDS)) {
    return { taskTypeHint: 'errand', externalityScore: 1 };
  }
  if (containsKeyword(content, HEALTH_KEYWORDS)) {
    return { taskTypeHint: 'health', externalityScore: 1 };
  }
  if (containsKeyword(content, ADMIN_KEYWORDS)) {
    return { taskTypeHint: 'admin', externalityScore: 1 };
  }
  if (containsKeyword(content, CREATIVE_KEYWORDS)) {
    return { taskTypeHint: 'creative', externalityScore: 0 };
  }
  return { taskTypeHint: 'deep_work', externalityScore: containsKeyword(content, DEADLINE_KEYWORDS) ? 1 : 0 };
}

function inferSoftStart(content: string) {
  const hasSoftLanguage = containsKeyword(content, SOFT_START_HINTS);
  const hasHardAnchor = containsKeyword(content, HARD_ANCHOR_KEYWORDS);
  if (hasSoftLanguage && !hasHardAnchor) return true;
  return false;
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default function HomeTab() {
  const { session } = useSupabaseSession();
  const userId = session?.user?.id ?? null;
  const insets = useSafeAreaInsets();
  const timezone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
    } catch {
      return 'UTC';
    }
  }, []);
  const timezoneOffsetMinutes = useMemo(() => -new Date().getTimezoneOffset(), []);

  const [idea, setIdea] = useState('');
  const [minutesInput, setMinutesInput] = useState('');
  const [importance, setImportance] = useState(2);
  const [submitting, setSubmitting] = useState(false);
  const [pendingCapture, setPendingCapture] = useState<PendingCaptureState | null>(null);
  const [followUpState, setFollowUpState] = useState<{
    prompt: string;
    missing: string[];
  } | null>(null);
  const [followUpAnswer, setFollowUpAnswer] = useState('');

  const [pending, setPending] = useState<Capture[]>([]);
  const [scheduled, setScheduled] = useState<Capture[]>([]);
  const [pendingLoading, setPendingLoading] = useState(true);
  const [scheduledLoading, setScheduledLoading] = useState(true);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [scheduledError, setScheduledError] = useState<string | null>(null);
  const [calendarHealth, setCalendarHealth] = useState<CalendarHealth | null>(null);
  const [calendarHealthError, setCalendarHealthError] = useState<string | null>(null);
  const [calendarHealthChecking, setCalendarHealthChecking] = useState(false);
  const [recentPlan, setRecentPlan] = useState<PlanSummary | null>(null);
  const [undoingPlan, setUndoingPlan] = useState(false);
  const [lockingCaptureId, setLockingCaptureId] = useState<string | null>(null);


  const [refreshing, setRefreshing] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [actionCaptureId, setActionCaptureId] = useState<string | null>(null);

  const autoSchedulingRef = useRef(false);
  const reminderRegistryRef = useRef<ReminderRegistry>({});
  const reminderSyncingRef = useRef(false);
  const calendarHealthRequestRef = useRef(false);
  const [reminderLoaded, setReminderLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const stored = await AsyncStorage.getItem(REMINDER_STORAGE_KEY);
        if (stored && active) {
          reminderRegistryRef.current = JSON.parse(stored) as ReminderRegistry;
        }
      } catch (error) {
        console.log('reminder registry load failed', error);
      } finally {
        if (active) setReminderLoaded(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const ensureReminders = useCallback(async () => {
    if (!reminderLoaded) return;
    if (reminderSyncingRef.current) return;
    reminderSyncingRef.current = true;
    try {
      const registry = reminderRegistryRef.current;
      const nextRegistry: ReminderRegistry = {};
      const now = Date.now();

      for (const capture of scheduled) {
        if (capture.status !== 'scheduled') continue;
        if (!capture.planned_end) continue;

        const endDate = new Date(capture.planned_end);
        if (Number.isNaN(endDate.getTime())) continue;

        if (endDate.getTime() <= now) {
          const existing = registry[capture.id];
          if (existing) {
            await cancelScheduledNotification(existing.notificationId);
          }
          continue;
        }

        const existing = registry[capture.id];
        if (existing && existing.plannedEnd === capture.planned_end) {
          nextRegistry[capture.id] = existing;
          continue;
        }

        if (existing) {
          await cancelScheduledNotification(existing.notificationId);
        }

        try {
          const notificationId = await scheduleReminderAt(
            endDate,
            'Time to check in',
            `Did you complete "${capture.content}"?`,
          );
          nextRegistry[capture.id] = { notificationId, plannedEnd: capture.planned_end };
        } catch (error) {
          console.log('reminder schedule failed', error);
        }
      }

      for (const [captureId, entry] of Object.entries(registry)) {
        if (!nextRegistry[captureId]) {
          await cancelScheduledNotification(entry.notificationId);
        }
      }

      reminderRegistryRef.current = nextRegistry;
      await AsyncStorage.setItem(REMINDER_STORAGE_KEY, JSON.stringify(nextRegistry));
    } catch (error) {
      console.log('reminder sync failed', error);
    } finally {
      reminderSyncingRef.current = false;
    }
  }, [reminderLoaded, scheduled]);

  useEffect(() => {
    if (!reminderLoaded) return;
    ensureReminders();
  }, [ensureReminders, reminderLoaded]);

  const refreshCalendarHealth = useCallback(async () => {
    if (!userId) {
      setCalendarHealth(null);
      setCalendarHealthError(null);
      return;
    }
    if (calendarHealthRequestRef.current) return;
    calendarHealthRequestRef.current = true;
    setCalendarHealthChecking(true);
    try {
      const status = await getCalendarHealth();
      setCalendarHealth(status);
      setCalendarHealthError(null);
    } catch (error) {
      console.log('calendar health check failed', error);
      setCalendarHealthError('Unable to reach Google Calendar right now.');
    } finally {
      setCalendarHealthChecking(false);
      calendarHealthRequestRef.current = false;
    }
  }, [userId]);

  const loadPending = useCallback(async () => {
    if (!userId) return [];
    setPendingLoading(true);
    setPendingError(null);
    try {
      const list = await listCaptures();
      setPending(list);
      return list;
    } catch (error: any) {
      setPendingError(error?.message ?? 'Failed to load capture entries');
      return [];
    } finally {
      setPendingLoading(false);
    }
  }, [userId]);

  const loadScheduled = useCallback(async () => {
    if (!userId) return [];
    setScheduledLoading(true);
    setScheduledError(null);
    try {
      const list = await listScheduledCaptures();
      setScheduled(list);
      return list;
    } catch (error: any) {
      setScheduledError(error?.message ?? 'Failed to load scheduled captures');
      return [];
    } finally {
      setScheduledLoading(false);
    }
  }, [userId]);

  const synchronizeFromCalendar = useCallback(async () => {
    if (!userId) return;
    try {
      await syncCaptureEvents();
    } catch (error) {
      console.log('sync-captures error', error);
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    (async () => {
      await synchronizeFromCalendar();
      await Promise.all([loadPending(), loadScheduled(), refreshCalendarHealth()]);
    })();
  }, [loadPending, loadScheduled, refreshCalendarHealth, synchronizeFromCalendar, userId]);

  useEffect(() => {
    if (userId) return;
    setCalendarHealth(null);
    setCalendarHealthError(null);
  }, [userId]);

  const onRefresh = useCallback(async () => {
    if (!userId) return;
    setRefreshing(true);
    try {
      await synchronizeFromCalendar();
      await Promise.all([loadPending(), loadScheduled(), refreshCalendarHealth()]);
    } catch (error) {
      console.log('refresh sync error', error);
    } finally {
      setRefreshing(false);
    }
  }, [loadPending, loadScheduled, refreshCalendarHealth, synchronizeFromCalendar, userId]);

  const scheduleTopCapture = useCallback(
    async (
      captureId?: string,
      mode: 'schedule' | 'reschedule' = 'schedule',
      options?: ScheduleOptions,
    ) => {
      if (!userId) return null;
      const targetId = captureId ?? pending[0]?.id;
      if (!targetId) return null;
      if (autoSchedulingRef.current) return null;
      autoSchedulingRef.current = true;
      try {
        setScheduling(true);
        const response = await invokeScheduleCapture(targetId, mode, {
          timezone,
          timezoneOffsetMinutes,
          ...(options ?? {}),
        });
        await Promise.all([loadPending(), loadScheduled()]);
        if (response?.planSummary) {
          setRecentPlan(response.planSummary);
        }
        await refreshCalendarHealth();
        if (response) {
          console.log('schedule-capture response payload', response);
        }
        return response;
      } catch (error: any) {
        console.log('schedule-capture error', error);
        let message = extractScheduleError(error);
        // Try to extract JSON error payload from FunctionsHttpError
        try {
          const ctx = (error as any)?.context;
          if (ctx && typeof ctx.json === 'function') {
            const payload = await ctx.json();
            console.log('schedule-capture response payload', payload);
            if (payload?.error) message = String(payload.error);
            if (payload?.reason === 'no_slot' && payload?.deadline) {
              message = `${message} (no legal slot before ${payload.deadline})`;
            }
            if (payload?.reason === 'slot_exceeds_deadline' && payload?.slot?.end && payload?.deadline) {
              message = `${message} (slot ${payload.slot.end} > deadline ${payload.deadline})`;
            }
          }
        } catch {}
        Alert.alert('Scheduling failed', message);
        if (message?.toLowerCase().includes('google calendar not linked')) {
          refreshCalendarHealth();
        }
        return null;
      } finally {
        setScheduling(false);
        autoSchedulingRef.current = false;
      }
    },
    [loadPending, loadScheduled, pending, refreshCalendarHealth, timezone, timezoneOffsetMinutes, userId],
  );

  const scheduleEntireQueue = useCallback(async () => {
    if (!userId) return null;
    if (autoSchedulingRef.current) return null;
    autoSchedulingRef.current = true;
    try {
      setScheduling(true);
      // Fetch the latest pending list (ranked)
      const queue = await loadPending();
      let scheduledCount = 0;
      for (const cap of queue) {
        try {
          const resp = await invokeScheduleCapture(cap.id, 'schedule', {
            timezone,
            timezoneOffsetMinutes,
          });
          if (resp) {
            console.log('schedule-capture response payload', resp);
          }
          let scheduled = !resp?.decision;

          // If server returns a conflict decision with a suggestion, try suggested slot first
          const suggestion = resp?.decision?.suggestion ?? null;
          if (!scheduled && suggestion) {
            const follow = await invokeScheduleCapture(cap.id, 'schedule', {
              preferredStart: suggestion.start,
              preferredEnd: suggestion.end,
              timezone,
              timezoneOffsetMinutes,
            });
            scheduled = !follow?.decision;
            // If still not scheduled, allow overlap with suggested slot
            if (!scheduled) {
              const overlapFollow = await invokeScheduleCapture(cap.id, 'schedule', {
                preferredStart: suggestion.start,
                preferredEnd: suggestion.end,
                allowOverlap: true,
                timezone,
                timezoneOffsetMinutes,
              });
              scheduled = !overlapFollow?.decision;
            }
          }

          // If no suggestion or still not scheduled, attempt overlap without a preferred slot
          if (!scheduled && !suggestion) {
            const overlapResp = await invokeScheduleCapture(cap.id, 'schedule', {
              allowOverlap: true,
              timezone,
              timezoneOffsetMinutes,
            });
            scheduled = !overlapResp?.decision;
          }

          if (scheduled) scheduledCount += 1;
          // Refresh lists incrementally to keep busy intervals consistent server-side
          await Promise.all([loadPending(), loadScheduled()]);
        } catch (e: any) {
          // Skip problematic capture; continue with the rest
          console.log('queue scheduling error', cap.id, e);
          try {
            const ctx = (e as any)?.context;
            if (ctx && typeof ctx.json === 'function') {
              const payload = await ctx.json();
              console.log('queue scheduling response payload', cap.id, payload);
            }
          } catch {}
          continue;
        }
      }
      await refreshCalendarHealth();
      return scheduledCount;
    } finally {
      setScheduling(false);
      autoSchedulingRef.current = false;
    }
  }, [loadPending, loadScheduled, refreshCalendarHealth, timezone, timezoneOffsetMinutes, userId]);

  const finalizeCapture = useCallback(
    async (
      content: string,
      estimatedMinutes: number | null,
      selectedImportance: number,
      parseResult: ParseTaskResponse | null,
    ) => {
      if (!userId) {
        throw new Error('Sign in required');
      }

      const constraint = deriveConstraintData(content, parseResult, estimatedMinutes);

      // Prefer LLM-provided importance if available
      const extraction = parseResult?.structured?.extraction as any | null;
      const llmUrgency: number | null = extraction?.importance?.urgency ?? null;
      const llmImpact: number | null = extraction?.importance?.impact ?? null;
      const llmCompositeImportance =
        llmUrgency != null || llmImpact != null
          ? Math.max(1, Math.round(((llmUrgency ?? 0) * 0.6 + (llmImpact ?? 0) * 0.4)))
          : selectedImportance;
      // Map LLM 1–5 scale to DB 1–3 scale to satisfy capture_entries_importance_check
      const mappedImportance =
        llmCompositeImportance <= 2 ? 1 : llmCompositeImportance >= 5 ? 3 : 2;

      // Persist rich facets in scheduling_notes for server-side policy
      const schedulingNotes = extraction
        ? JSON.stringify({ importance: extraction.importance ?? null, flexibility: extraction.flexibility ?? null })
        : null;

      const created = await addCapture(
        {
          content,
          estimatedMinutes,
          importance: mappedImportance,
          urgency: llmUrgency,
          impact: llmImpact,
          reschedulePenalty: extraction?.importance?.reschedule_penalty ?? null,
          blocking: extraction?.importance?.blocking ?? null,
          cannotOverlap: extraction?.flexibility?.cannot_overlap ?? null,
          startFlexibility: extraction?.flexibility?.start_flexibility ?? null,
          durationFlexibility: extraction?.flexibility?.duration_flexibility ?? null,
          minChunkMinutes: extraction?.flexibility?.min_chunk_minutes ?? null,
          maxSplits: extraction?.flexibility?.max_splits ?? null,
          extractionKind: extraction?.kind ?? null,
          timePrefTimeOfDay: extraction?.time_preferences?.time_of_day ?? null,
          timePrefDay: extraction?.time_preferences?.day ?? null,
          importanceRationale: extraction?.importance?.rationale ?? null,
          schedulingNotes,
          constraintType: constraint.constraintType,
          constraintTime: constraint.constraintTime,
          constraintEnd: constraint.constraintEnd,
          constraintDate: constraint.constraintDate,
          originalTargetTime: constraint.originalTargetTime,
          deadlineAt: constraint.deadlineAt,
          windowStart: constraint.windowStart,
          windowEnd: constraint.windowEnd,
          startTargetAt: constraint.startTargetAt,
          isSoftStart: constraint.isSoftStart,
          externalityScore: constraint.externalityScore,
          taskTypeHint: constraint.taskTypeHint,
        },
        userId,
      );

      setIdea('');
      setMinutesInput('');
      setImportance(2);
      setPendingCapture(null);

      await loadPending();
      return created;
    },
    [loadPending, userId],
  );

  const handleReconnectCalendar = useCallback(() => {
    connectGoogleCalendar().catch((error) => {
      console.log('google connect error', error);
      Alert.alert('Reconnect failed', 'Unable to open Google sign-in right now. Please try again.');
    });
  }, []);

  const dismissPlanSummary = useCallback(() => {
    setRecentPlan(null);
  }, []);

  const handlePlanUndo = useCallback(async () => {
    if (!recentPlan || undoingPlan) return;
    setUndoingPlan(true);
    try {
      await undoPlan(recentPlan.id);
      setRecentPlan(null);
      await Promise.all([loadPending(), loadScheduled()]);
    } catch (error) {
      Alert.alert('Undo failed', extractScheduleError(error));
    } finally {
      setUndoingPlan(false);
    }
  }, [loadPending, loadScheduled, recentPlan, undoingPlan]);

  const handleLockCapture = useCallback(
    async (captureId: string) => {
      if (lockingCaptureId) return;
      setLockingCaptureId(captureId);
      try {
        await lockCaptureWindow(captureId);
        await loadScheduled();
      } catch (error) {
        Alert.alert('Lock failed', extractScheduleError(error));
      } finally {
        setLockingCaptureId(null);
      }
    },
    [loadScheduled, lockingCaptureId],
  );

  const attemptSchedule = useCallback(
    async (captureId: string) => {
      const response = await scheduleTopCapture(captureId, 'schedule');
      const decision = response?.decision;
      if (decision?.type === 'preferred_conflict') {
        const message = formatConflictMessage(decision);
        Alert.alert('Scheduling conflict', message, [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Overlap anyway',
            onPress: () =>
              scheduleTopCapture(captureId, 'schedule', {
                allowOverlap: true,
              }),
          },
          {
            text: 'Let DiaGuru decide',
            onPress: () => scheduleTopCapture(captureId, 'schedule'),
          },
        ]);
      }
      return response;
    },
    [scheduleTopCapture],
  );

  const handleFollowUpCancel = useCallback(() => {
    setFollowUpState(null);
    setFollowUpAnswer('');
    setPendingCapture(null);
    setSubmitting(false);
  }, []);

  const handleFollowUpSubmit = useCallback(async () => {
    if (!followUpState || !pendingCapture) return;
    const answer = followUpAnswer.trim();
    if (!answer) {
      Alert.alert('Need a response', 'Please answer the question so DiaGuru can schedule this.');
      return;
    }

    try {
      setSubmitting(true);

      let resolvedMinutes: number | null = null;
      const numericMatch = answer.match(/(\d+(?:\.\d+)?)/);
      if (numericMatch) {
        const numeric = Number(numericMatch[1]);
        if (!Number.isNaN(numeric) && numeric > 0) {
          resolvedMinutes = Math.round(numeric);
        }
      }

      if (resolvedMinutes === null) {
        Alert.alert(
          'Unable to parse answer',
          'Please reply with a number of minutes (for example, 45).',
        );
        setSubmitting(false);
        return;
      }

      const capture = await finalizeCapture(
        pendingCapture.baseContent,
        resolvedMinutes,
        pendingCapture.importance,
        null,
      );

      setFollowUpState(null);
      setFollowUpAnswer('');
      setPendingCapture(null);

      await attemptSchedule(capture.id);
    } catch (error: any) {
      Alert.alert('Save failed', error?.message ?? 'Could not save capture.');
    } finally {
      setSubmitting(false);
    }
  }, [attemptSchedule, finalizeCapture, followUpAnswer, followUpState, pendingCapture]);

  const handleAddCapture = useCallback(async () => {
    if (!userId) {
      Alert.alert('Sign in required', 'Please sign in to save ideas.');
      return;
    }

    const content = idea.trim();
    if (!content) {
      Alert.alert('Add something first', 'Tell DiaGuru what is on your mind before saving.');
      return;
    }

    const trimmedMinutes = minutesInput.trim();
    const hasMinutes = trimmedMinutes.length > 0;
    let resolvedMinutes: number | null = null;
    if (hasMinutes) {
      resolvedMinutes = Number(trimmedMinutes);
      if (Number.isNaN(resolvedMinutes) || resolvedMinutes <= 0) {
        Alert.alert('Check duration', 'Estimated minutes should be a positive number.');
        return;
      }
    }

    try {
      setSubmitting(true);
      setPendingCapture(null);
      setFollowUpState(null);
      setFollowUpAnswer('');

      const mode = await getAssistantModePreference();
      let parseResult: ParseTaskResponse | null = null;

      try {
        parseResult = await parseCapture({
          text: content,
          mode,
          timezone,
          now: new Date().toISOString(),
        });
      } catch (error) {
        if (!hasMinutes) {
          const message =
            error instanceof Error ? error.message : 'We could not infer the duration automatically.';
          Alert.alert('DeepSeek failed', message);

          setSubmitting(false);
          return;
        }
      }

      if (!hasMinutes) {
        const candidate = parseResult?.structured?.estimated_minutes;
        if (typeof candidate === 'number' && candidate > 0) {
          resolvedMinutes = candidate;
        } else if (parseResult?.follow_up) {
          setPendingCapture({
            baseContent: content,
            importance,
            appended: [],
            mode,
          });
          setFollowUpState({
            prompt: parseResult.follow_up.prompt,
            missing: parseResult.follow_up.missing ?? [],
          });
          setFollowUpAnswer('');
          setSubmitting(false);
          return;
        } else {
          Alert.alert(
            'DeepSeek failed',
            'DeepSeek did not provide a clarifying question in conversational strict mode.',
          );
          setSubmitting(false);
          return;
        }
      }

      if (resolvedMinutes === null) {
        Alert.alert('DeepSeek failed', 'DeepSeek could not infer a duration from your capture.');
        setSubmitting(false);
        return;
      }

      const created = await finalizeCapture(content, resolvedMinutes, importance, parseResult);
      await attemptSchedule(created.id);
    } catch (error: any) {
      Alert.alert('Save failed', error?.message ?? 'Could not save capture.');
    } finally {
      setSubmitting(false);
    }
  }, [attemptSchedule, finalizeCapture, idea, importance, minutesInput, timezone, userId]);

  const overdueScheduled = useMemo(
    () =>
      scheduled.filter(
        (capture) =>
          capture.status === 'scheduled' &&
          capture.planned_end &&
          new Date(capture.planned_end).getTime() <= Date.now(),
      ),
    [scheduled],
  );

  const upcomingScheduled = useMemo(
    () =>
      scheduled.filter(
        (capture) =>
          capture.status === 'scheduled' &&
          capture.planned_start &&
          new Date(capture.planned_start).getTime() > Date.now(),
      ),
    [scheduled],
  );

  const pendingPreview = useMemo(() => pending.slice(0, 3), [pending]);
  const queueExtras = Math.max(0, pending.length - pendingPreview.length);
  const overduePreview = useMemo(() => overdueScheduled.slice(0, 2), [overdueScheduled]);
  const upcomingPreview = useMemo(() => upcomingScheduled.slice(0, 3), [upcomingScheduled]);
  const followUpVisible = Boolean(followUpState);

  const handleCompletionAction = useCallback(
    async (capture: Capture, action: CaptureStatus | 'reschedule') => {
      if (!userId) return;
      setActionCaptureId(capture.id);
      try {
        if (action === 'completed') {
          await invokeCaptureCompletion(capture.id, 'complete');
        } else if (action === 'reschedule') {
          await invokeCaptureCompletion(capture.id, 'reschedule');
          // Immediately try to schedule this capture again
          await scheduleTopCapture(capture.id, 'schedule');
        }
        await Promise.all([loadPending(), loadScheduled()]);
      } catch (error: any) {
        Alert.alert('Action failed', error?.message ?? 'Unable to update scheduled item.');
      } finally {
        setActionCaptureId(null);
      }
    },
    [loadPending, loadScheduled, scheduleTopCapture, userId],
  );

  const captureForm = (
    <View style={styles.captureSection}>
      <Text style={styles.sectionTitle}>Today&apos;s capture</Text>
      <Text style={styles.sectionSubtext}>
        Offload what is on your mind. DiaGuru will schedule it around your day with buffers and no late
        nights.
      </Text>

      <TextInput
        value={idea}
        onChangeText={setIdea}
        placeholder="What needs your attention?"
        placeholderTextColor="#9CA3AF"
        multiline
        style={styles.ideaInput}
      />

      <View style={styles.formRow}>
        <View style={styles.formField}>
          <Text style={styles.fieldLabel}>Est. minutes</Text>
          <TextInput
            value={minutesInput}
            onChangeText={setMinutesInput}
            placeholder="30"
            placeholderTextColor="#9CA3AF"
            keyboardType="numeric"
            style={styles.numberInput}
          />
        </View>

        <View style={[styles.formField, { flex: 1 }]}>
          <Text style={styles.fieldLabel}>Importance</Text>
          <View style={styles.importanceRow}>
            {IMPORTANCE_LEVELS.map((level) => (
              <TouchableOpacity
                key={level.value}
                style={[
                  styles.importanceChip,
                  importance === level.value && styles.importanceChipActive,
                ]}
                onPress={() => setImportance(level.value)}
              >
                <Text
                  style={[
                    styles.importanceChipText,
                    importance === level.value && styles.importanceChipTextActive,
                  ]}
                >
                  {level.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </View>

      <TouchableOpacity
        style={[styles.primaryButton, submitting && styles.primaryButtonDisabled]}
        onPress={handleAddCapture}
        disabled={submitting}
      >
        <Text style={styles.primaryButtonText}>{submitting ? 'Saving...' : 'Save & auto-schedule'}</Text>
      </TouchableOpacity>

      {pendingLoading ? (
        <ActivityIndicator />
      ) : pendingError ? (
        <Text style={styles.errorText}>{pendingError}</Text>
      ) : pending.length === 0 ? (
        <Text style={styles.sectionSubtext}>You&apos;re clear for now. Add the next thing above.</Text>
      ) : (
        <View style={{ gap: 12 }}>
          <View style={styles.captureListHeader}>
            <Text style={styles.sectionSubtitle}>Queue (ranked)</Text>
            <TouchableOpacity
              disabled={scheduling || pending.length === 0}
              onPress={() => scheduleEntireQueue()}
              style={[
                styles.secondaryButton,
                (scheduling || pending.length === 0) && styles.primaryButtonDisabled,
              ]}
            >
              <Text
                style={[
                  styles.secondaryButtonText,
                  (scheduling || pending.length === 0) && styles.secondaryButtonTextDisabled,
                ]}
              >
                Re-run scheduling
              </Text>
            </TouchableOpacity>
          </View>
          {pendingPreview.map((capture, index) => (
            <CaptureCard key={capture.id} capture={capture} rank={index + 1} />
          ))}
          {queueExtras > 0 ? (
            <Text style={styles.sectionSubtext}>{`+${queueExtras} more waiting in the queue`}</Text>
          ) : null}
        </View>
      )}
    </View>
  );

  const scheduledSection = (
    <View style={styles.captureSection}>
      <Text style={styles.sectionTitle}>Scheduled by DiaGuru</Text>
      <Text style={styles.sectionSubtext}>
        DiaGuru keeps 30 minute buffers and won&apos;t book anything past 10pm. Confirm items once you
        finish so the system keeps learning.
      </Text>

      {scheduledLoading ? (
        <ActivityIndicator />
      ) : scheduledError ? (
        <Text style={styles.errorText}>{scheduledError}</Text>
      ) : scheduled.length === 0 ? (
        <Text style={styles.sectionSubtext}>No DiaGuru sessions on the calendar yet.</Text>
      ) : (
        <>
          {overdueScheduled.length > 0 && (
            <View style={{ gap: 12 }}>
              <Text style={styles.sectionSubtitle}>Needs check-in</Text>
              {overduePreview.map((capture) => (
                <ScheduledCard
                  key={capture.id}
                  capture={capture}
                  pendingAction={actionCaptureId === capture.id}
                  onComplete={() => handleCompletionAction(capture, 'completed')}
                  onReschedule={() => handleCompletionAction(capture, 'reschedule')}
                />
              ))}
              {overdueScheduled.length > overduePreview.length ? (
                <Text style={styles.sectionSubtext}>{`+${overdueScheduled.length - overduePreview.length} more awaiting confirmation`}</Text>
              ) : null}
            </View>
          )}

          {upcomingScheduled.length > 0 && (
            <View style={{ gap: 12 }}>
              <Text style={styles.sectionSubtitle}>Upcoming</Text>
              {upcomingPreview.map((capture) => (
                <ScheduledSummaryCard key={capture.id} capture={capture} />
              ))}
              {upcomingScheduled.length > upcomingPreview.length ? (
                <Text style={styles.sectionSubtext}>{`+${upcomingScheduled.length - upcomingPreview.length} more scheduled`}</Text>
              ) : null}
            </View>
          )}
        </>
      )}
    </View>
  );

  return (
    <>
      <SafeAreaView style={[styles.safeArea, { paddingTop: Math.max(insets.top, 16) }]}>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        >
          <CalendarHealthNotice
            health={calendarHealth}
            error={calendarHealthError}
            checking={calendarHealthChecking}
            onReconnect={handleReconnectCalendar}
            onRetry={refreshCalendarHealth}
          />
          {recentPlan && recentPlan.actions.length > 0 ? (
            <TodayChangedCard
              plan={recentPlan}
              onDismiss={dismissPlanSummary}
              onUndo={handlePlanUndo}
              undoing={undoingPlan}
              onLock={handleLockCapture}
              lockingCaptureId={lockingCaptureId}
            />
          ) : null}
          {captureForm}
          {scheduledSection}
        </ScrollView>
      </SafeAreaView>

      <Modal
        visible={followUpVisible}
        animationType="fade"
        transparent
        onRequestClose={handleFollowUpCancel}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.followUpBackdrop}
        >
          <View style={styles.followUpCard}>
            <Text style={styles.followUpTitle}>DeepSeek asks</Text>
            <Text style={styles.followUpPrompt}>{followUpState?.prompt ?? 'Please answer the assistant\u2019s question.'}</Text>
            {followUpState?.missing?.length ? (
              <Text style={styles.followUpHint}>Missing: {followUpState.missing.join(', ')}</Text>
            ) : null}
            <TextInput
              style={styles.followUpInput}
              value={followUpAnswer}
              onChangeText={setFollowUpAnswer}
              placeholder="Type your answer..."
              placeholderTextColor="#9CA3AF"
              autoFocus
              editable={!submitting}
            />
            <View style={styles.followUpActions}>
              <TouchableOpacity
                onPress={handleFollowUpCancel}
                style={styles.tertiaryButton}
                disabled={submitting}
              >
                <Text style={styles.tertiaryButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleFollowUpSubmit}
                style={[styles.confirmButton, submitting && styles.confirmButtonDisabled]}
                disabled={submitting}
              >
                <Text style={styles.confirmButtonText}>{submitting ? 'Saving...' : 'Send'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

function CaptureCard({ capture, rank }: { capture: Capture; rank: number }) {
  return (
    <View style={styles.captureCard}>
      <View style={styles.captureCardHeader}>
        <Text style={styles.captureRank}>{`#${rank}`}</Text>
        <Text style={[styles.captureTitle, styles.captureTitleFlex]}>{capture.content}</Text>
      </View>
      <Text style={styles.captureMeta}>
        {'Importance: ' + (IMPORTANCE_LEVELS.find((it) => it.value === capture.importance)?.label ?? 'Medium')}
        {capture.estimated_minutes ? ' · ~' + capture.estimated_minutes + ' min' : ''}
      </Text>
    </View>
  );
}

function ScheduledCard({
  capture,
  pendingAction,
  onComplete,
  onReschedule,
}: {
  capture: Capture;
  pendingAction: boolean;
  onComplete: () => void;
  onReschedule: () => void;
}) {
  const start = capture.planned_start ? new Date(capture.planned_start) : null;
  const end = capture.planned_end ? new Date(capture.planned_end) : null;

  return (
    <View style={[styles.captureCard, { borderColor: '#2563EB' }]}>
      <Text style={styles.captureTitle}>{capture.content}</Text>
      <Text style={styles.captureMeta}>
        {start ? start.toLocaleString() : 'Scheduled time unavailable'}
        {end ? ` -> ${end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
      </Text>
      <View style={styles.captureActions}>
        <TouchableOpacity
          style={[styles.primaryButton, { flex: 1 }, pendingAction && styles.primaryButtonDisabled]}
          onPress={onComplete}
          disabled={pendingAction}
        >
          <Text style={styles.primaryButtonText}>{pendingAction ? 'Updating...' : 'Completed'}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.secondaryButton, { flex: 1 }, pendingAction && styles.primaryButtonDisabled]}
          onPress={onReschedule}
          disabled={pendingAction}
        >
          <Text
            style={[
              styles.secondaryButtonText,
              pendingAction && styles.secondaryButtonTextDisabled,
            ]}
          >
            Reschedule
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function ScheduledSummaryCard({ capture }: { capture: Capture }) {
  const start = capture.planned_start ? new Date(capture.planned_start) : null;
  const end = capture.planned_end ? new Date(capture.planned_end) : null;
  return (
    <View style={styles.captureCard}>
      <Text style={styles.captureTitle}>{capture.content}</Text>
      <Text style={styles.captureMeta}>
        {start ? start.toLocaleString() : 'Scheduled time unavailable'}
        {end ? ` -> ${end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
      </Text>
    </View>
  );
}

type TodayChangedCardProps = {
  plan: PlanSummary;
  onDismiss: () => void;
  onUndo: () => void;
  undoing: boolean;
  onLock: (captureId: string) => void;
  lockingCaptureId: string | null;
};

function TodayChangedCard({
  plan,
  onDismiss,
  onUndo,
  undoing,
  onLock,
  lockingCaptureId,
}: TodayChangedCardProps) {
  return (
    <View style={styles.todayCard}>
      <View style={styles.todayCardHeader}>
        <Text style={styles.todayCardTitle}>Today changed</Text>
        <TouchableOpacity onPress={onDismiss}>
          <Text style={styles.todayCardDismiss}>Dismiss</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.todayCardSubtitle}>
        {`DiaGuru adjusted ${plan.actions.length} ${plan.actions.length === 1 ? 'session' : 'sessions'}.`}
      </Text>
      {plan.actions.map((action) => (
        <View key={action.actionId} style={styles.todayActionRow}>
          <Text style={styles.todayActionLabel}>{describePlanAction(action)}</Text>
          <TouchableOpacity
            style={[styles.todayLockButton, lockingCaptureId === action.captureId && styles.todayLockButtonDisabled]}
            onPress={() => onLock(action.captureId)}
            disabled={lockingCaptureId === action.captureId}
          >
            <Text style={styles.todayLockButtonText}>
              {lockingCaptureId === action.captureId ? 'Locking…' : 'Lock'}
            </Text>
          </TouchableOpacity>
        </View>
      ))}
      <View style={styles.todayCardButtons}>
        <TouchableOpacity style={styles.todaySecondaryButton} onPress={onDismiss}>
          <Text style={styles.todaySecondaryButtonText}>Got it</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.todayPrimaryButton, undoing && styles.todayPrimaryButtonDisabled]}
          onPress={onUndo}
          disabled={undoing}
        >
          <Text style={styles.todayPrimaryButtonText}>{undoing ? 'Undoing…' : 'Undo plan'}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function describePlanAction(action: PlanSummary['actions'][number]) {
  const timeText = formatPlanRange(action.nextStart, action.nextEnd);
  const previousText = formatPlanRange(action.previousStart, action.previousEnd);
  if (action.actionType === 'scheduled') {
    return `Scheduled “${action.content}” for ${timeText}`;
  }
  if (action.actionType === 'rescheduled') {
    return `Moved “${action.content}” to ${timeText}`;
  }
  return `Unscheduled “${action.content}” (was ${previousText})`;
}

function formatPlanRange(start: string | null, end: string | null) {
  if (!start) return 'unscheduled';
  const startText = formatPlanTime(start);
  const endText = end ? formatPlanTime(end) : '';
  return endText ? `${startText} → ${endText}` : startText;
}

function formatPlanTime(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'unknown time';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#F3F4F6' },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingBottom: 32, gap: 24 },
  todayCard: {
    backgroundColor: '#EEF2FF',
    borderRadius: 16,
    padding: 16,
    gap: 12,
  },
  todayCardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  todayCardTitle: { fontSize: 16, fontWeight: '700', color: '#111827' },
  todayCardDismiss: { color: '#64748B', fontWeight: '600' },
  todayCardSubtitle: { color: '#1F2937' },
  todayActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  todayActionLabel: { flex: 1, color: '#111827', fontSize: 14 },
  todayLockButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#C7D2FE',
  },
  todayLockButtonDisabled: { opacity: 0.5 },
  todayLockButtonText: { color: '#4338CA', fontWeight: '600', fontSize: 12 },
  todayCardButtons: { flexDirection: 'row', gap: 12, marginTop: 4 },
  todaySecondaryButton: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#CBD5F5',
    backgroundColor: '#fff',
  },
  todaySecondaryButtonText: { fontWeight: '600', color: '#1F2937' },
  todayPrimaryButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#4338CA',
    alignItems: 'center',
  },
  todayPrimaryButtonDisabled: { opacity: 0.5 },
  todayPrimaryButtonText: { color: '#fff', fontWeight: '700' },
  captureSection: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    gap: 16,
  },
  sectionTitle: { fontSize: 20, fontWeight: '700', color: '#111827' },
  sectionSubtext: { color: '#6B7280' },
  sectionSubtitle: { fontSize: 16, fontWeight: '700', color: '#111827' },
  ideaInput: {
    minHeight: 80,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 10,
    padding: 12,
    textAlignVertical: 'top',
    color: '#111827',
    backgroundColor: '#F9FAFB',
  },
  formRow: { flexDirection: 'row', gap: 12 },
  formField: { flex: 0.6, gap: 6 },
  fieldLabel: { fontWeight: '600', color: '#111827' },
  numberInput: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 10,
    padding: 10,
    color: '#111827',
    backgroundColor: '#F9FAFB',
  },
  importanceRow: { flexDirection: 'row', gap: 8 },
  importanceChip: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#d1d5db',
  },
  importanceChipActive: {
    backgroundColor: '#2563EB',
    borderColor: '#2563EB',
  },
  importanceChipText: { color: '#4B5563', fontWeight: '600' },
  importanceChipTextActive: { color: '#fff' },
  primaryButton: {
    backgroundColor: '#2563EB',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonDisabled: { opacity: 0.6 },
  primaryButtonText: { color: '#fff', fontWeight: '700' },
  secondaryButton: {
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#2563EB',
  },
  secondaryButtonText: { color: '#2563EB', fontWeight: '700' },
  secondaryButtonTextDisabled: { color: '#9CA3AF' },
  captureListHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  captureCard: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 12,
    padding: 14,
    gap: 6,
  },
  captureCardHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  captureRank: { fontSize: 14, fontWeight: '700', color: '#2563EB' },
  captureTitle: { fontSize: 16, fontWeight: '600', color: '#111827' },
  captureTitleFlex: { flex: 1 },
  captureMeta: { color: '#6B7280' },
  captureActions: { flexDirection: 'row', gap: 12, marginTop: 12 },
  card: {
    padding: 12,
    borderRadius: 12,
    backgroundColor: '#fff',
    elevation: 2,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    gap: 4,
  },
  title: { fontSize: 16, fontWeight: '600', marginBottom: 4, color: '#111' },
  time: { color: '#555' },
  errorText: { color: '#DC2626' },
  followUpBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(17, 24, 39, 0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  followUpCard: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 20,
    gap: 12,
  },
  followUpTitle: { fontSize: 18, fontWeight: '600', color: '#111827' },
  followUpPrompt: { color: '#374151' },
  followUpHint: { color: '#6B7280', fontSize: 12 },
  followUpInput: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    color: '#111827',
    backgroundColor: '#F9FAFB',
  },
  followUpActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12 },
  tertiaryButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    backgroundColor: '#fff',
  },
  tertiaryButtonText: { color: '#111827', fontWeight: '600' },
  confirmButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#2563EB',
  },
  confirmButtonDisabled: { opacity: 0.6 },
  confirmButtonText: { color: '#fff', fontWeight: '700' },
});






