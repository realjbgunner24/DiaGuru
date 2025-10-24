import { useState } from 'react';
import { Alert, Button, Text, View } from 'react-native';
import { requestNotificationPermission, scheduleIn, sendLocal } from '../../lib/notifications';

export default function SettingsScreen() {
  const [status, setStatus] = useState<'unknown' | 'granted' | 'denied'>('unknown');

  const ask = async () => {
    const ok = await requestNotificationPermission();
    setStatus(ok ? 'granted' : 'denied');
    Alert.alert(ok ? 'Notifications enabled' : 'Permission denied');
  };

  return (
    <View style={{ flex: 1, gap: 16, padding: 20, justifyContent: 'center', backgroundColor: '#FFF' }}>
      <Text style={{ fontSize: 22, fontWeight: '600', color: '#111827' }}>Settings</Text>
      <Button title="Request Notification Permission" onPress={ask} />
      <Button title="Send Test Notification" onPress={() => sendLocal('DiaGuru', 'Local test notification')} />
      <Button title="Schedule in 5 seconds" onPress={() => scheduleIn(5, 'DiaGuru', 'Scheduled test (5s)')} />
      <Text style={{ color: '#6B7280' }}>Permission: {status}</Text>
    </View>
  );
}
