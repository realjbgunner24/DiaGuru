import { Stack, Redirect } from 'expo-router';
import { AuthProvider, useAuth } from '@/providers/AuthProvider';

function Gate() {
  const { session, loading } = useAuth();
  if (loading) return null;
  return session ? <Stack screenOptions={{ headerShown: false }} /> : <Redirect href="/(auth)/sign-in" />;
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}
