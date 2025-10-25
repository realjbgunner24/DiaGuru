import { useSupabaseSession } from '@/hooks/useSupabaseSession';
import { fetchUpcomingEvents, SimpleEvent } from '@/lib/calendar';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

const PREVIEW_WINDOW = 20;

export default function CalendarTab() {
  const { session } = useSupabaseSession();
  const userId = session?.user?.id ?? null;
  const insets = useSafeAreaInsets();

  const [events, setEvents] = useState<SimpleEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadEvents = useCallback(
    async (showSpinner: boolean) => {
      if (showSpinner) setEventsLoading(true);
      setEventsError(null);
      try {
        const list = await fetchUpcomingEvents(PREVIEW_WINDOW);
        setEvents(list);
      } catch (error: any) {
        setEventsError(error?.message ?? 'Failed to load calendar events');
      } finally {
        if (showSpinner) setEventsLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!userId) return;
    loadEvents(true);
  }, [loadEvents, userId]);

  const onRefresh = useCallback(async () => {
    if (!userId) return;
    setRefreshing(true);
    try {
      await loadEvents(false);
    } catch (error) {
      console.log('calendar refresh error', error);
    } finally {
      setRefreshing(false);
    }
  }, [loadEvents, userId]);

  const eventsContent = useMemo(() => {
    if (eventsLoading) return <ActivityIndicator />;
    if (eventsError) return <Text style={styles.errorText}>{eventsError}</Text>;
    if (events.length === 0) {
      return <Text style={styles.sectionSubtext}>Nothing scheduled in the next few days.</Text>;
    }

    return events.map((event) => <EventRow key={event.id} e={event} />);
  }, [events, eventsError, eventsLoading]);

  return (
    <SafeAreaView style={[styles.safeArea, { paddingTop: Math.max(insets.top, 16) }] }>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        <View style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>Upcoming calendar</Text>
          <Text style={styles.sectionSubtext}>
            DiaGuru tags its sessions with [DG]. External events stay untouched so your original plans remain.
          </Text>
          <View style={{ marginTop: 12, gap: 12 }}>{eventsContent}</View>
          <View style={styles.footer}>
            <TouchableOpacity onPress={() => Alert.alert('Coming soon', 'Calendar filters and quick actions are coming soon.') }>
              <Text style={styles.linkAction}>Calendar tips & actions</Text>
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function EventRow({ e }: { e: SimpleEvent }) {
  const start = e.start?.dateTime ?? e.start?.date;
  const end = e.end?.dateTime ?? e.end?.date;
  const isDiaGuru = e.extendedProperties?.private?.diaGuru === 'true' || (e.summary ?? '').trim().startsWith('[DG]');

  const startLabel = start
    ? new Date(start).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : 'Anytime';
  const endLabel = end ? new Date(end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

  return (
    <View style={styles.eventCard}>
      <View style={styles.eventHeader}>
        <Text style={[styles.eventTitle, isDiaGuru && styles.diaGuruTitle]} numberOfLines={2}>
          {e.summary ?? '(no title)'}
        </Text>
        {isDiaGuru ? <Text style={styles.eventBadge}>DG</Text> : null}
      </View>
      <Text style={styles.eventTime}>
        {startLabel}
        {endLabel ? `  ->  ${endLabel}` : ''}
      </Text>
      {isDiaGuru && <Text style={styles.diaGuruTag}>DiaGuru scheduled</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#F3F4F6' },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingBottom: 32, gap: 24 },
  sectionCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    gap: 16,
  },
  sectionTitle: { fontSize: 20, fontWeight: '700', color: '#111827' },
  sectionSubtext: { color: '#6B7280' },
  linkAction: { color: '#2563EB', fontWeight: '600' },
  footer: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: '#E5E7EB', paddingTop: 12 },
  eventCard: {
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#FFFFFF',
    gap: 6,
  },
  eventHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  eventTitle: { fontSize: 16, fontWeight: '600', color: '#111827', flex: 1, paddingRight: 8 },
  eventTime: { color: '#4B5563' },
  eventBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, backgroundColor: '#EEF2FF', color: '#2563EB', fontWeight: '700' },
  diaGuruTag: { color: '#2563EB', fontSize: 12, fontWeight: '600' },
  diaGuruTitle: { color: '#2563EB' },
  errorText: { color: '#DC2626' },
});
