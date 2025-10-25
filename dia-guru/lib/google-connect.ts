import { supabase } from '@/lib/supabase';
import * as Linking from 'expo-linking';

export async function connectGoogleCalendar() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('Not signed in');

  const params = new URLSearchParams({
    client_id: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID!,       // your Web client ID
    redirect_uri: 'https://wnjykvdliwjeeytbfeux.functions.supabase.co/oauth-cb',
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    state: session.access_token,                                // 🔑 we verify this in the function
    scope: 'https://www.googleapis.com/auth/calendar.readonly',
  });

  await Linking.openURL(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
}
