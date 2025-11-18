import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ParseMode } from './capture';

const ASSISTANT_MODE_KEY = '@diaGuru.assistantMode';

export async function getAssistantModePreference(): Promise<ParseMode> {
  try {
    const stored = await AsyncStorage.getItem(ASSISTANT_MODE_KEY);
    if (stored === 'conversational_strict') {
      return 'conversational_strict';
    }
    if (stored === 'conversational' || stored === 'deterministic') {
      return 'conversational_strict';
    }
  } catch (error) {
    console.log('assistant mode read failed', error);
  }
  return 'conversational_strict';
}

export async function setAssistantModePreference(mode: ParseMode) {
  try {
    await AsyncStorage.setItem(ASSISTANT_MODE_KEY, mode);
  } catch (error) {
    console.log('assistant mode write failed', error);
  }
}
