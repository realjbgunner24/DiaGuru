module.exports = {
  presets: ['babel-preset-expo'],
  plugins: [
    ['module-resolver', { root: ['.'], alias: { '@': './src' } }],
    'react-native-reanimated/plugin',
  ],
};