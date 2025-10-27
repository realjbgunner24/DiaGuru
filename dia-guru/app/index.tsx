// app/index.tsx (gate)
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { supabase } from '../lib/supabase';

export default function Index() {
  const router = useRouter();
  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!mounted) return;
      router.replace(session ? '/(tabs)' : '/(auth)/sign-in');
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      router.replace(s ? '/(tabs)' : '/(auth)/sign-in');
    });
    return () => sub.subscription.unsubscribe();
  }, [router]);

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator />
    </View>
  );
}
