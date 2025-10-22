import React, { useState } from 'react';
import { SafeAreaView, View, Text, TextInput, Button, ActivityIndicator, Alert } from 'react-native';
import { useAuth } from '@/providers/AuthProvider';

export default function SignIn() {
  const { signIn, signUp } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const onSignIn = async () => {
    setBusy(true);
    const { error } = await signIn(email.trim(), password);
    setBusy(false);
    if (error) Alert.alert('Sign in failed', error);
  };

  const onCreate = async () => {
    setBusy(true);
    const { error } = await signUp(email.trim(), password);
    setBusy(false);
    if (error) Alert.alert('Sign up failed', error);
    else Alert.alert('Check your email', 'Confirm your email, then sign in.');
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#fff' }}>
      <View style={{ flex: 1, padding: 24, gap: 12, justifyContent: 'center' }}>
        <Text style={{ fontSize: 22, fontWeight: '600' }}>Welcome</Text>
        <TextInput placeholder="Email" autoCapitalize="none" keyboardType="email-address"
          value={email} onChangeText={setEmail} style={{ borderWidth: 1, padding: 10, borderRadius: 8 }} />
        <TextInput placeholder="Password" secureTextEntry value={password}
          onChangeText={setPassword} style={{ borderWidth: 1, padding: 10, borderRadius: 8 }} />
        {busy ? <ActivityIndicator /> : (
          <>
            <Button title="Sign In" onPress={onSignIn} />
            <Button title="Create Account" onPress={onCreate} />
          </>
        )}
      </View>
    </SafeAreaView>
  );
}
