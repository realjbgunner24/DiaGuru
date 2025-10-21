import React from 'react';
import { View, Text, Button } from 'react-native';
import { useAuth } from '@/providers/AuthProvider';

export default function Home() {
  const { user, signOut } = useAuth();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
      <Text>Signed in as {user?.email}</Text>
      <Button title="Sign out" onPress={signOut} />
    </View>
  );
}
