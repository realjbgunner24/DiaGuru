module.exports = {
  root: true,
  extends: ['expo', 'expo/typescript'],
  plugins: ['jest'],
  env: {
    jest: true,
  },
  ignorePatterns: ['dist/**', 'build/**', 'coverage/**', 'node_modules/**', 'supabase/functions/**'],
  overrides: [
    {
      files: [
        'supabase/functions/**/*.ts',
        'supabase/functions/**/*.tsx',
        'supabase/functions/**/*.js',
      ],
      rules: {
        'import/no-unresolved': 'off',
      },
    },
  ],
  rules: {
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    'import/order': [
      'warn',
      {
        groups: [['builtin', 'external', 'internal'], ['parent', 'sibling', 'index']],
        'newlines-between': 'always',
      },
    ],
  },
};
