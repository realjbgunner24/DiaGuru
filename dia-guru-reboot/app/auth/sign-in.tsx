import React, { useState } from 'react';
import { View, Text, TextInput, Button, Alert } from 'react-native';
import { useAuth } from '@/providers/AuthProvider';

export default function SignIn() {
  const { signIn, signUp } = useAuth();
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  return (
    <View style={{ flex: 1, padding: 24, gap: 12, justifyContent: 'center' }}>
      <Text style={{ fontSize: 22, fontWeight: '600' }}>Welcome</Text>
      <TextInput placeholder="Email" autoCapitalize="none" keyboardType="email-address"
        value={email} onChangeText={setEmail} style={{ borderWidth: 1, padding: 10, borderRadius: 8 }} />
      <TextInput placeholder="Password" secureTextEntry value={password}
        onChangeText={setPassword} style={{ borderWidth: 1, padding: 10, borderRadius: 8 }} />
      <Button title="Sign In" onPress={async () => {
        const { error } = await signIn(email, password);
        if (error) Alert.alert('Error', error);
      }} />
      <Button title="Create Account" onPress={async () => {
        const { error } = await signUp(email, password);
        if (error) Alert.alert('Error', error);
      }} />
    </View>
  );
}
