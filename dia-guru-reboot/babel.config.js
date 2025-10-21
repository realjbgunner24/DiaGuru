module.exports = {
  presets: ['babel-preset-expo'],
  plugins: [
    'expo-router/babel',
    ['module-resolver', { root: ['.'], alias: { '@': './src' } }],
    'react-native-reanimated/plugin', // MUST be last
  ],
};
