import { Session } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';
import { ActivityIndicator } from 'react-native';
import Account from '../../components/Account';
import { supabase } from '../../lib/supabase';

export default function ProfileTab() {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session ?? null));
  }, []);

  if (!session?.user) return <ActivityIndicator />;
  return <Account session={session} />;
}
