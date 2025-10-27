import * as Notifications from 'expo-notifications';

jest.mock('expo-notifications', () => {
  const scheduleNotificationAsync = jest.fn(() => Promise.resolve('notif-id'));
  const cancelScheduledNotificationAsync = jest.fn(() => Promise.resolve());
  return {
    setNotificationHandler: jest.fn(),
    getPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
    requestPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
    scheduleNotificationAsync,
    cancelScheduledNotificationAsync,
    setNotificationChannelAsync: jest.fn().mockResolvedValue(undefined),
    AndroidImportance: { DEFAULT: 'DEFAULT' },
    SchedulableTriggerInputTypes: {
      TIME_INTERVAL: 'timeInterval',
      DATE: 'date',
    },
  };
});

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

// eslint-disable-next-line import/first
import { cancelScheduledNotification, scheduleReminderAt } from '../notifications';

describe('notifications helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('schedules a date-triggered reminder for future times', async () => {
    const future = new Date(Date.now() + 60_000);
    await scheduleReminderAt(future, 'Title', 'Body');

    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith({
      content: { title: 'Title', body: 'Body' },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: future,
      },
    });
  });

  it('uses immediate trigger when date has already passed', async () => {
    const past = new Date(Date.now() - 60_000);
    await scheduleReminderAt(past, 'Late', 'Body');

    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith({
      content: { title: 'Late', body: 'Body' },
      trigger: null,
    });
  });

  it('ignores cancellation when id is falsy', async () => {
    await cancelScheduledNotification('');
    await cancelScheduledNotification(null as unknown as string);

    expect(Notifications.cancelScheduledNotificationAsync).not.toHaveBeenCalled();
  });

  it('cancels scheduled notifications when id provided', async () => {
    await cancelScheduledNotification('abc');

    expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith('abc');
  });
});
