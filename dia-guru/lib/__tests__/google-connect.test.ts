import { connectGoogleCalendar, getCalendarHealth } from '../google-connect';

jest.mock('expo-linking', () => ({ openURL: jest.fn() }));

jest.mock('@/lib/supabase', () => {
  const invoke = jest.fn();
  const getSession = jest.fn();
  return {
    supabase: {
      functions: { invoke },
      auth: { getSession },
    },
  };
});

const { supabase } = jest.requireMock('@/lib/supabase') as {
  supabase: {
    functions: { invoke: jest.Mock };
    auth: { getSession: jest.Mock };
  };
};
const { openURL } = jest.requireMock('expo-linking') as { openURL: jest.Mock };

describe('google-connect helpers', () => {
  beforeEach(() => {
    supabase.functions.invoke.mockReset();
    supabase.auth.getSession.mockReset();
    openURL.mockReset();
  });

  it('fetches calendar health via Edge Function', async () => {
    const mockResponse = {
      status: 'healthy',
      linked: true,
      needsReconnect: false,
      hasRefreshToken: true,
      expiresAt: '2025-10-26T10:00:00Z',
      expiresInSeconds: 3600,
      refreshed: false,
      checkedAt: '2025-10-25T00:00:00Z',
    };
    supabase.functions.invoke.mockResolvedValue({ data: mockResponse, error: null });

    const result = await getCalendarHealth();

    expect(supabase.functions.invoke).toHaveBeenCalledWith('calendar-health');
    expect(result).toEqual(mockResponse);
  });

  it('throws when invoke reports an error', async () => {
    const error = { message: 'Network' };
    supabase.functions.invoke.mockResolvedValue({ data: null, error });

    await expect(getCalendarHealth()).rejects.toEqual(error);
  });

  it('throws when not signed in', async () => {
    supabase.auth.getSession.mockResolvedValue({ data: { session: null } });
    await expect(connectGoogleCalendar()).rejects.toThrow('Not signed in');
  });

  it('throws when missing EXPO_PUBLIC_GOOGLE_CLIENT_ID', async () => {
    supabase.auth.getSession.mockResolvedValue({ data: { session: { access_token: 't' } } });
    const prev = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID;
    delete process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID;
    try {
      await expect(connectGoogleCalendar()).rejects.toThrow('Missing EXPO_PUBLIC_GOOGLE_CLIENT_ID');
    } finally {
      if (prev) process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID = prev;
    }
  });

  it('opens Google OAuth URL with expected params', async () => {
    supabase.auth.getSession.mockResolvedValue({ data: { session: { access_token: 'user-jwt' } } });
    process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID = 'client-123';
    process.env.EXPO_PUBLIC_GOOGLE_REDIRECT_URI = 'https://example.com/cb';

    await connectGoogleCalendar();

    expect(openURL).toHaveBeenCalledTimes(1);
    const urlArg = String(openURL.mock.calls[0][0]);
    expect(urlArg).toContain('https://accounts.google.com/o/oauth2/v2/auth?');
    expect(urlArg).toContain('client_id=client-123');
    expect(urlArg).toContain('redirect_uri=https%3A%2F%2Fexample.com%2Fcb');
    expect(urlArg).toContain('response_type=code');
    expect(urlArg).toContain('access_type=offline');
    expect(urlArg).toContain('scope=');
    expect(urlArg).toContain('state=user-jwt');
  });
});
