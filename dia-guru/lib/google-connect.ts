import { supabase } from '@/lib/supabase';
import * as Linking from 'expo-linking';

export async function connectGoogleCalendar() {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.access_token) throw new Error('Not signed in');

  const clientId = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error('Missing EXPO_PUBLIC_GOOGLE_CLIENT_ID');

  const redirectUri =
    process.env.EXPO_PUBLIC_GOOGLE_REDIRECT_URI ??
    'https://wnjykvdliwjeeytbfeux.functions.supabase.co/oauth-cb';

  const params = new URLSearchParams({
    client_id: clientId,                                        // Google OAuth web client ID
    redirect_uri: redirectUri,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    state: session.access_token,                                // we verify this in the function
    scope: 'https://www.googleapis.com/auth/calendar.events',
  });

  await Linking.openURL(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
}
