import { useState } from 'react';
import { ActivityIndicator, Button, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import { supabase } from '../lib/supabase';

export default function TestDeepseekScreen() {
  const router = useRouter();
  const [mode, setMode] = useState<'clarify' | 'extract'>('clarify');
  const [content, setContent] = useState('Plan dentist appointment next Tuesday afternoon');
  const [timezone, setTimezone] = useState('UTC');
  const [neededText, setNeededText] = useState('estimated_minutes,datetime');
  const [reply, setReply] = useState<string | null>(null);
  const [parsed, setParsed] = useState<any | null>(null);
  const [rawText, setRawText] = useState<string | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const runTest = async () => {
    setLoading(true);
    setError(null);
    setReply(null);
    setParsed(null);
    setRawText(null);
    setLatency(null);
    setModel(null);
    try {
      const body: any = { mode, timezone };
      if (mode === 'clarify') {
        body.content = content;
        body.needed = neededText
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      } else if (mode === 'extract') {
        body.content = content;
      }

      const { data, error } = await supabase.functions.invoke('test-deepseek', { body });
      if (error) throw error;
      if (!data) {
        setError('No data from function');
      } else if (data.error) {
        setError(String(data.error));
      } else {
        if (data.mode === 'clarify') {
          setReply(String(data.clarifying_question ?? ''));
        } else if (data.mode === 'extract') {
          setParsed(data.parsed ?? null);
          if (typeof data.raw_text === 'string') setRawText(data.raw_text);
        } else if (data.mode === 'simple') {
          setReply(String(data.reply ?? ''));
        }
        if (typeof data.latency_ms === 'number') setLatency(data.latency_ms);
        if (typeof data.model === 'string') setModel(data.model);
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>DeepSeek Tester</Text>
        <Button title="Back" onPress={() => router.back()} />
      </View>

      <View style={styles.section}>
        <Text style={styles.label}>Mode</Text>
        <View style={styles.modeRow}>
          {(['clarify', 'extract'] as const).map((m) => {
            const active = mode === m;
            return (
              <TouchableOpacity key={m} style={[styles.chip, active && styles.chipActive]} onPress={() => setMode(m)}>
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{m}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <Text style={styles.label}>Prompt</Text>
        <TextInput
          value={content}
          onChangeText={setContent}
          placeholder="Type capture text (e.g., Schedule dinner with Sam tomorrow 7pm)"
          style={styles.input}
          multiline
        />

        <Text style={styles.label}>Timezone</Text>
        <TextInput value={timezone} onChangeText={setTimezone} placeholder="UTC" style={styles.inputSmall} />

        {mode === 'clarify' && (
          <>
            <Text style={styles.label}>Needed fields (comma-separated)</Text>
            <TextInput
              value={neededText}
              onChangeText={setNeededText}
              placeholder="estimated_minutes,datetime"
              style={styles.inputSmall}
            />
          </>
        )}

        <Button title={loading ? 'Running…' : 'Run Test'} onPress={runTest} disabled={loading || !content.trim()} />
      </View>

      <View style={styles.section}>
        {loading && (
          <View style={styles.centerRow}>
            <ActivityIndicator />
            <Text style={styles.muted}>Contacting DeepSeek…</Text>
          </View>
        )}
        {error && (
          <Text style={styles.error}>Error: {error}</Text>
        )}
        {!loading && !error && (reply || parsed || latency || model) && (
          <ScrollView style={styles.resultBox}>
            <Text style={styles.meta}>Model: {model ?? 'unknown'}</Text>
            <Text style={styles.meta}>Latency: {latency ?? '?'} ms</Text>
            {reply && <Text style={styles.result}>{reply}</Text>}
            {parsed && (
              <Text style={styles.result}>{JSON.stringify(parsed, null, 2)}</Text>
            )}
            {rawText && (
              <Text style={styles.meta}>Raw text: {rawText}</Text>
            )}
          </ScrollView>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, backgroundColor: '#FFF', gap: 16 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 20, fontWeight: '700', color: '#111827' },
  section: { gap: 12 },
  label: { fontWeight: '600', color: '#111827' },
  input: {
    minHeight: 100,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 8,
    padding: 12,
    textAlignVertical: 'top',
    backgroundColor: '#F9FAFB',
  },
  inputSmall: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 8,
    padding: 12,
    backgroundColor: '#F9FAFB',
  },
  centerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  muted: { color: '#6B7280' },
  resultBox: { borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 8, padding: 12, backgroundColor: '#F9FAFB' },
  meta: { color: '#6B7280', marginBottom: 4 },
  result: { color: '#111827', marginTop: 8 },
  error: { color: '#B91C1C', fontWeight: '600' },
  modeRow: { flexDirection: 'row', gap: 8 },
  chip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 999, backgroundColor: '#E5E7EB' },
  chipActive: { backgroundColor: '#2563EB' },
  chipText: { color: '#111827', fontWeight: '600' },
  chipTextActive: { color: '#FFF' },
});
