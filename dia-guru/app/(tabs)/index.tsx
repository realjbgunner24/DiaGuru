// app/(tabs)/index.tsx
import { Session } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';
import { View } from 'react-native';


import Account from '@/components/Account';
import Auth from '@/components/Auth';
import { supabase } from '@/lib/supabase';



export default function HomeTab() {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    let mounted = true;

    // initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!mounted) return;
      setSession(session ?? null);
    });

    // keep in sync with auth changes
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      if (!mounted) return;
      setSession(s ?? null);
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return (
    <View style={{ flex: 1 }}>
      {session?.user ? <Account key={session.user.id} session={session} /> : <Auth />}
    </View>
  );
}
