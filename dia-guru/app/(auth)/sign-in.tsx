// app/(auth)/sign-in.tsx
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import Auth from '../../components/Auth';
import { supabase } from '../../lib/supabase';

export default function SignIn() {
  const router = useRouter();

  useEffect(() => {
    let mounted = true;

    // If already signed in, skip auth screen
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!mounted) return;
      if (session) router.replace({ pathname: '/(tabs)' }); // or '/(tabs)/profile' if you prefer
    });

    // After clicking "Sign in", navigate when session arrives
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      if (s) router.replace({ pathname: '/(tabs)' }); // or '/(tabs)/profile'
    });

    return () => { mounted = false; sub.subscription.unsubscribe(); };
  }, [router]);

  return <Auth />;  // your existing component, unchanged
}

