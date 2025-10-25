import { useSupabaseSession } from '@/hooks/useSupabaseSession';
import { fetchUpcomingEvents, SimpleEvent } from '@/lib/calendar';
import {
  addCapture,
  Capture,
  CaptureStatus,
  invokeCaptureCompletion,
  invokeScheduleCapture,
  listCaptures,
  listScheduledCaptures,
  syncCaptureEvents,
} from '@/lib/capture';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
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

export default function HomeTab() {
  const { session } = useSupabaseSession();
  const userId = session?.user?.id ?? null;
  const insets = useSafeAreaInsets();

  const [idea, setIdea] = useState('');
  const [minutesInput, setMinutesInput] = useState('');
  const [importance, setImportance] = useState(2);
  const [submitting, setSubmitting] = useState(false);

  const [pending, setPending] = useState<Capture[]>([]);
  const [scheduled, setScheduled] = useState<Capture[]>([]);
  const [pendingLoading, setPendingLoading] = useState(true);
  const [scheduledLoading, setScheduledLoading] = useState(true);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [scheduledError, setScheduledError] = useState<string | null>(null);

  const [events, setEvents] = useState<SimpleEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsError, setEventsError] = useState<string | null>(null);

  const [refreshing, setRefreshing] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [actionCaptureId, setActionCaptureId] = useState<string | null>(null);

  const autoSchedulingRef = useRef(false);

  const loadEvents = useCallback(
    async (showSpinner: boolean) => {
      if (showSpinner) setEventsLoading(true);
      setEventsError(null);
      try {
        const list = await fetchUpcomingEvents(7);
        setEvents(list);
      } catch (error: any) {
        setEventsError(error?.message ?? 'Failed to load calendar events');
      } finally {
        if (showSpinner) {
          setEventsLoading(false);
        }
      }
    },
    [],
  );

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

  useEffect(() => {
    loadEvents(true);
  }, [loadEvents]);

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
      await Promise.all([loadPending(), loadScheduled()]);
    })();
  }, [loadPending, loadScheduled, synchronizeFromCalendar, userId]);

  const onRefresh = useCallback(async () => {
    if (!userId) return;
    setRefreshing(true);
    try {
      await synchronizeFromCalendar();
      await Promise.all([loadEvents(false), loadPending(), loadScheduled()]);
    } catch (error) {
      console.log('refresh sync error', error);
    } finally {
      setRefreshing(false);
    }
  }, [loadEvents, loadPending, loadScheduled, synchronizeFromCalendar, userId]);

  const scheduleTopCapture = useCallback(
    async (captureId?: string, mode: 'schedule' | 'reschedule' = 'schedule') => {
      if (!userId) return;
      const topId = captureId ?? pending[0]?.id;
      if (!topId) return;
      if (autoSchedulingRef.current) return;
      autoSchedulingRef.current = true;
      try {
        setScheduling(true);
        await invokeScheduleCapture(topId, mode);
        await Promise.all([loadPending(), loadScheduled(), loadEvents(false)]);
      } catch (error) {
        console.log('schedule-capture error', error);
        Alert.alert('Scheduling failed', extractScheduleError(error));
      } finally {
        setScheduling(false);
        autoSchedulingRef.current = false;
      }
    },
    [loadEvents, loadPending, loadScheduled, pending, userId],
  );

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
    let parsedMinutes: number | null = null;
    if (hasMinutes) {
      parsedMinutes = Number(trimmedMinutes);
      if (Number.isNaN(parsedMinutes) || parsedMinutes <= 0) {
        Alert.alert('Check duration', 'Estimated minutes should be a positive number.');
        return;
      }
    }

    try {
      setSubmitting(true);
      await addCapture(
        {
          content,
          estimatedMinutes: parsedMinutes,
          importance,
        },
        userId,
      );
      setIdea('');
      setMinutesInput('');
      setImportance(2);
      const updatedPending = await loadPending();
      await scheduleTopCapture(updatedPending[0]?.id);
    } catch (error: any) {
      Alert.alert('Save failed', error?.message ?? 'Could not save capture.');
    } finally {
      setSubmitting(false);
    }
  }, [idea, importance, loadPending, minutesInput, scheduleTopCapture, userId]);

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
  const overduePreview = useMemo(() => overdueScheduled.slice(0, 2), [overdueScheduled]);
  const upcomingPreview = useMemo(() => upcomingScheduled.slice(0, 3), [upcomingScheduled]);
  const eventsPreview = useMemo(() => events.slice(0, 5), [events]);

  const handleCompletionAction = useCallback(
    async (capture: Capture, action: CaptureStatus | 'reschedule') => {
      if (!userId) return;
      setActionCaptureId(capture.id);
      try {
        if (action === 'completed') {
          await invokeCaptureCompletion(capture.id, 'complete');
        } else if (action === 'reschedule') {
          await invokeCaptureCompletion(capture.id, 'reschedule');
        }
        await Promise.all([loadPending(), loadScheduled(), loadEvents(false)]);
      } catch (error: any) {
        Alert.alert('Action failed', error?.message ?? 'Unable to update scheduled item.');
      } finally {
        setActionCaptureId(null);
      }
    },
    [loadEvents, loadPending, loadScheduled, userId],
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
              onPress={() => scheduleTopCapture(undefined, 'reschedule')}
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
          {pendingPreview.map((capture) => (
            <CaptureCard key={capture.id} capture={capture} />
          ))}
          {pending.length > pendingPreview.length ? (
            <Text style={styles.sectionSubtext}>{`+${pending.length - pendingPreview.length} more waiting in the queue`}</Text>
          ) : null}
        </View>
      )}
    </View>
  );

  const scheduledSection = (
    <View style={styles.captureSection}>
      <Text style={styles.sectionTitle}>Scheduled by DiaGuru</Text>
      <Text style={styles.sectionSubtext}>
        DiaGuru keeps 30 minute buffers and won&apos;t book anything past 10pm. Confirm items once
        you finish so the system keeps learning.
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
            <View style={{ gap: 12, marginTop: overdueScheduled.length > 0 ? 16 : 0 }}>
              <Text style={styles.sectionSubtitle}>Upcoming</Text>
              {upcomingPreview.map((capture) => (
                <ScheduledSummaryCard key={capture.id} capture={capture} />
              ))}
              {upcomingScheduled.length > upcomingPreview.length ? (
                <Text style={styles.sectionSubtext}>{`+${upcomingScheduled.length - upcomingPreview.length} later this week`}</Text>
              ) : null}
            </View>
          )}
        </>
      )}
    </View>
  );

  const eventsContent = useMemo(() => {
    if (eventsLoading) return <ActivityIndicator />;
    if (eventsError) return <Text style={styles.errorText}>{eventsError}</Text>;
    if (eventsPreview.length === 0) {
      return <Text style={styles.sectionSubtext}>Nothing scheduled over the next seven days.</Text>;
    }

    return (
      <>
        {eventsPreview.map((event) => (
          <EventRow key={event.id} e={event} />
        ))}
        {events.length > eventsPreview.length ? (
          <Text style={styles.sectionSubtext}>{`+${events.length - eventsPreview.length} more events synced from Google`}</Text>
        ) : null}
      </>
    );
  }, [events, eventsError, eventsLoading, eventsPreview]);

  return (
    <SafeAreaView style={[styles.safeArea, { paddingTop: Math.max(insets.top, 16) }]}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {captureForm}
        {scheduledSection}

        <View style={styles.captureSection}>
          <Text style={styles.sectionTitle}>Upcoming calendar</Text>
          <Text style={styles.sectionSubtext}>
            DiaGuru tags its sessions with [DG]. External events stay untouched so your original plans remain.
          </Text>
          <View style={{ marginTop: 12, gap: 12 }}>{eventsContent}</View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function CaptureCard({ capture }: { capture: Capture }) {
  return (
    <View style={styles.captureCard}>
      <Text style={styles.captureTitle}>{capture.content}</Text>
      <Text style={styles.captureMeta}>
        {`Importance: ${IMPORTANCE_LEVELS.find((it) => it.value === capture.importance)?.label ?? 'Medium'}`}
        {capture.estimated_minutes ? ` · ~${capture.estimated_minutes} min` : ''}
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
        {end ? ` – ${end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
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
        {end ? ` – ${end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
      </Text>
    </View>
  );
}

function EventRow({ e }: { e: SimpleEvent }) {
  const start = e.start?.dateTime ?? e.start?.date;
  const end = e.end?.dateTime ?? e.end?.date;
  const isDiaGuru =
    e.extendedProperties?.private?.diaGuru === 'true' ||
    (e.summary ?? '').trim().startsWith('[DG]');

  return (
    <TouchableOpacity onPress={() => e.htmlLink && Linking.openURL(e.htmlLink)} style={styles.card}>
      <Text style={[styles.title, isDiaGuru && styles.diaGuruTitle]}>{e.summary ?? '(no title)'}</Text>
      <Text style={styles.time}>{`${start} -> ${end}`}</Text>
      {isDiaGuru && <Text style={styles.diaGuruTag}>DiaGuru scheduled</Text>}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#F3F4F6' },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingBottom: 32, gap: 24 },
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
  primaryButtonDisabled: {
    opacity: 0.6,
  },
  primaryButtonText: {
    color: '#fff',
    fontWeight: '700',
  },
  secondaryButton: {
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#2563EB',
  },
  secondaryButtonText: {
    color: '#2563EB',
    fontWeight: '700',
  },
  secondaryButtonTextDisabled: { color: '#9CA3AF' },
  captureListHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  captureCard: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 12,
    padding: 14,
    gap: 6,
  },
  captureTitle: { fontSize: 16, fontWeight: '600', color: '#111827' },
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
  diaGuruTitle: { color: '#2563EB' },
  diaGuruTag: { color: '#2563EB', fontSize: 12, fontWeight: '600' },
  errorText: { color: '#DC2626' },
});
