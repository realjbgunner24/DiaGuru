import { fireEvent, render } from '@testing-library/react-native';

import CalendarHealthNotice from '../CalendarHealthNotice';
import type { CalendarHealth } from '@/lib/google-connect';

const healthBase: CalendarHealth = {
  status: 'healthy',
  linked: true,
  needsReconnect: false,
  hasRefreshToken: true,
  expiresAt: '2025-10-26T10:00:00Z',
  expiresInSeconds: 3600,
  refreshed: false,
  checkedAt: '2025-10-25T00:00:00Z',
};

describe('CalendarHealthNotice', () => {
  const onReconnect = jest.fn();
  const onRetry = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders nothing when there is no warning or error', () => {
    const { toJSON } = render(
      <CalendarHealthNotice
        health={{ ...healthBase }}
        error={null}
        checking={false}
        onReconnect={onReconnect}
        onRetry={onRetry}
      />,
    );

    expect(toJSON()).toBeNull();
  });

  it('shows reconnect banner and triggers callbacks', () => {
    const { getByText } = render(
      <CalendarHealthNotice
        health={{ ...healthBase, status: 'needs_reconnect', needsReconnect: true }}
        error={null}
        checking={false}
        onReconnect={onReconnect}
        onRetry={onRetry}
      />,
    );

    expect(getByText('Reconnect Google Calendar')).toBeTruthy();
    fireEvent.press(getByText('Reconnect'));
    expect(onReconnect).toHaveBeenCalled();

    fireEvent.press(getByText('Check again'));
    expect(onRetry).toHaveBeenCalled();
  });

  it('renders error message with retry button', () => {
    const { getByText } = render(
      <CalendarHealthNotice
        health={null}
        error="Unable to fetch health"
        checking={false}
        onReconnect={onReconnect}
        onRetry={onRetry}
      />,
    );

    expect(getByText('Calendar check failed')).toBeTruthy();
    fireEvent.press(getByText('Try again'));
    expect(onRetry).toHaveBeenCalled();
  });
});
