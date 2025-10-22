import React, { useEffect } from 'react';
import { Stack, useRouter, useSegments, useRootNavigationState } from 'expo-router';
import { AuthProvider, useAuth } from '@/providers/AuthProvider';

function Gate() {
  const { session, loading } = useAuth();
  const router = useRouter();
  const segments = useSegments();               // e.g. ['auth','sign-in'] or ['(auth)','sign-in']
  const rootState = useRootNavigationState();   // ensures router is mounted

  useEffect(() => {
    if (loading) return;
    if (!rootState?.key) return;                // 👈 wait for router to be ready

    const root = segments[0];
    const inAuth = root === 'auth' || root === '(auth)';

    if (!session && !inAuth) router.replace('/auth/sign-in');
    else if (session && inAuth) router.replace('/');
  }, [loading, session, segments, rootState?.key, router]);

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: '#fff' }, // 👈 kill black background
      }}
    />
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}
