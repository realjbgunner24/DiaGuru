jest.mock('expo-notifications', () => {
  const scheduleNotificationAsync = jest.fn(() => Promise.resolve('notif-id'));
  const cancelScheduledNotificationAsync = jest.fn(() => Promise.resolve());
  const setNotificationChannelAsync = jest.fn(() => Promise.resolve(undefined));
  return {
    setNotificationHandler: jest.fn(),
    getPermissionsAsync: jest.fn().mockResolvedValue({ granted: false, ios: { status: 0 } }),
    requestPermissionsAsync: jest.fn().mockResolvedValue({ granted: true, ios: { status: 0 } }),
    scheduleNotificationAsync,
    cancelScheduledNotificationAsync,
    setNotificationChannelAsync,
    AndroidImportance: { DEFAULT: 'DEFAULT' },
    SchedulableTriggerInputTypes: {
      TIME_INTERVAL: 'timeInterval',
      DATE: 'date',
    },
    IosAuthorizationStatus: { PROVISIONAL: 1 },
  };
});

jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));

// eslint-disable-next-line import/first
import {
  cancelScheduledNotification,
  requestNotificationPermission,
  scheduleIn,
  sendLocal,
} from '../notifications';

const Notifications = jest.requireMock('expo-notifications');

describe('notifications (android)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('ensures android channel is created and sendLocal uses immediate trigger', async () => {
    await sendLocal('Hello', 'World');
    expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith('default', {
      name: 'Default',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith({
      content: { title: 'Hello', body: 'World' },
      trigger: null,
    });
  });

  it('schedules time-interval notifications', async () => {
    await scheduleIn(5, 'T', 'B');
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith({
      content: { title: 'T', body: 'B' },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: 5 },
    });
  });

  it('requests permission when not already granted including provisional path', async () => {
    Notifications.getPermissionsAsync.mockResolvedValueOnce({ granted: false, ios: { status: 1 } });
    Notifications.requestPermissionsAsync.mockResolvedValueOnce({ granted: false, ios: { status: 1 } });
    const ok = await requestNotificationPermission();
    expect(ok).toBe(true);
  });

  it('cancels scheduled notification with valid id on android', async () => {
    await cancelScheduledNotification('id-1');
    expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith('id-1');
  });
});

