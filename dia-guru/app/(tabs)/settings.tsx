import { useEffect, useState } from 'react';
import { Alert, Button, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { requestNotificationPermission, scheduleIn, sendLocal } from '../../lib/notifications';
import type { ParseMode } from '@/lib/capture';
import { getAssistantModePreference, setAssistantModePreference } from '@/lib/preferences';

export default function SettingsScreen() {
  const [status, setStatus] = useState<'unknown' | 'granted' | 'denied'>('unknown');
  const [assistantMode, setAssistantMode] = useState<ParseMode>('deterministic');
  const [modeLoading, setModeLoading] = useState(true);

  const ask = async () => {
    const ok = await requestNotificationPermission();
    setStatus(ok ? 'granted' : 'denied');
    Alert.alert(ok ? 'Notifications enabled' : 'Permission denied');
  };

  useEffect(() => {
    (async () => {
      const stored = await getAssistantModePreference();
      setAssistantMode(stored);
      setModeLoading(false);
    })();
  }, []);

  const changeMode = async (mode: ParseMode) => {
    setAssistantMode(mode);
    await setAssistantModePreference(mode);
  };

  return (
    <View style={styles.container}>
      <Text style={styles.header}>Settings</Text>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Assistant mode</Text>
        <Text style={styles.sectionSubtitle}>
          Deterministic mode keeps everything on device. Conversational mode asks one clarifying question using
          DeepSeek when details are missing.
        </Text>
        <View style={styles.modeRow}>
          {(['deterministic', 'conversational'] as ParseMode[]).map((mode) => {
            const active = assistantMode === mode;
            return (
              <TouchableOpacity
                key={mode}
                style={[styles.modeChip, active && styles.modeChipActive]}
                onPress={() => changeMode(mode)}
                disabled={modeLoading}
              >
                <Text style={[styles.modeChipText, active && styles.modeChipTextActive]}>
                  {mode === 'deterministic' ? 'Deterministic' : 'Conversational'}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
        <Text style={styles.modeStatus}>
          Current mode: {assistantMode === 'deterministic' ? 'Deterministic (form prompts)' : 'Conversational (asks once)'}
        </Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Notifications</Text>
        <View style={{ gap: 12 }}>
          <Button title="Request Notification Permission" onPress={ask} />
          <Button title="Send Test Notification" onPress={() => sendLocal('DiaGuru', 'Local test notification')} />
          <Button title="Schedule in 5 seconds" onPress={() => scheduleIn(5, 'DiaGuru', 'Scheduled test (5s)')} />
          <Text style={styles.helperText}>Permission: {status}</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, gap: 24, padding: 20, backgroundColor: '#FFF' },
  header: { fontSize: 22, fontWeight: '600', color: '#111827' },
  section: { gap: 12 },
  sectionTitle: { fontSize: 18, fontWeight: '600', color: '#111827' },
  sectionSubtitle: { color: '#6B7280' },
  modeRow: { flexDirection: 'row', gap: 12 },
  modeChip: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 999,
    backgroundColor: '#E5E7EB',
  },
  modeChipActive: { backgroundColor: '#2563EB' },
  modeChipText: { color: '#111827', fontWeight: '600' },
  modeChipTextActive: { color: '#FFF' },
  modeStatus: { color: '#374151', fontStyle: 'italic' },
  helperText: { color: '#6B7280' },
});
