import { fetchUpcomingEvents, SimpleEvent } from '@/lib/calendar';
import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

export default function HomeTab() {
  const [items, setItems] = useState<SimpleEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const ev = await fetchUpcomingEvents(7);
        setItems(ev);
      } catch (e: any) {
        setErr(e.message ?? 'Failed to load events');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <Center><ActivityIndicator /></Center>;
  if (err) return <Center><Text>{err}</Text></Center>;
  if (items.length === 0) return <Center><Text>No upcoming events</Text></Center>;

  return (
    <FlatList
      data={items}
      keyExtractor={(e) => e.id}
      contentContainerStyle={{ padding: 16 }}
      renderItem={({ item }) => <EventRow e={item} />}
    />
  );
}

function EventRow({ e }: { e: SimpleEvent }) {
  const start = e.start?.dateTime ?? e.start?.date;
  const end = e.end?.dateTime ?? e.end?.date;
  return (
    <TouchableOpacity onPress={() => e.htmlLink && Linking.openURL(e.htmlLink)} style={styles.card}>
      <Text style={styles.title}>{e.summary ?? '(no title)'}</Text>
      <Text style={styles.time}>{start} → {end}</Text>
    </TouchableOpacity>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <View style={{ flex:1, justifyContent:'center', alignItems:'center', padding: 24 }}>{children}</View>;
}

const styles = StyleSheet.create({
  card: { padding: 12, borderRadius: 12, backgroundColor: '#fff', marginBottom: 10, elevation: 2 },
  title: { fontSize: 16, fontWeight: '600', marginBottom: 4, color: '#111' },
  time: { color: '#555' },
});
