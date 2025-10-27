import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true, shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false,
  }),
});

export async function requestNotificationPermission() {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted || current.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL) return true;
  const res = await Notifications.requestPermissionsAsync();
  return res.granted || res.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
}

async function ensureAndroidChannel() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('default', {
    name: 'Default', importance: Notifications.AndroidImportance.DEFAULT,
  });
}

export async function sendLocal(title: string, body: string) {
  await ensureAndroidChannel();
  return Notifications.scheduleNotificationAsync({
    content: { title, body }, trigger: null,
  });
}

export async function scheduleIn(seconds: number, title: string, body: string) {
  await ensureAndroidChannel();
  return Notifications.scheduleNotificationAsync({
    content: { title, body }, trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds },
  });
}

export async function scheduleReminderAt(date: Date, title: string, body: string) {
  await ensureAndroidChannel();
  const trigger: Notifications.DateTriggerInput | null = date.getTime() <= Date.now()
    ? null
    : { type: Notifications.SchedulableTriggerInputTypes.DATE, date };
  return Notifications.scheduleNotificationAsync({
    content: { title, body },
    trigger,
  });
}

export async function cancelScheduledNotification(id: string) {
  if (!id) return;
  try {
    await Notifications.cancelScheduledNotificationAsync(id);
  } catch (error) {
    console.log('cancel notification failed', error);
  }
}


