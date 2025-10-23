// app/(tabs)/index.tsx
import Account from '@/components/Account'; // adjust — you said no /ui
import Auth from '@/components/Auth';
import { useSupabaseSession } from '@/hooks/useSupabaseSession';
import { ActivityIndicator, View } from 'react-native';

export default function HomeTab() {
  const { session, ready } = useSupabaseSession();

  if (!ready) return <ActivityIndicator />;

  return (
    <View style={{ flex: 1 }}>
      {session?.user ? <Account key={session.user.id} session={session} /> : <Auth />}
    </View>
  );
}
