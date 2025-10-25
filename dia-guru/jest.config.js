const EXPO_MODULES = [
  '(jest-)?react-native',
  '@react-native(-community)?',
  '@react-navigation',
  'expo(nent)?',
  '@expo(nent)?/.*',
  'expo-modules-core',
  'react-native-reanimated',
  'react-native-gesture-handler',
  'react-native-screens',
  'react-native-safe-area-context',
  'react-native-url-polyfill',
  '@react-native-async-storage/async-storage',
  '@rneui',
  '@supabase',
  'lodash-es',
].join('|');

module.exports = {
  preset: 'jest-expo',
  setupFilesAfterEnv: ['@testing-library/jest-native/extend-expect'],
  transformIgnorePatterns: [`node_modules/(?!(${EXPO_MODULES})/)`],
  testPathIgnorePatterns: ['/node_modules/', '/android/', '/ios/', '<rootDir>/supabase/functions/'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
};
