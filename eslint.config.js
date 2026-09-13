// ESLint 9 flat config. The repo had no config (the `lint` script was
// silently broken under ESLint 9, which dropped .eslintrc support), so CI
// could never lint. This restores a working, intentionally pragmatic
// ruleset for the React frontend in src/.
import js from '@eslint/js';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default [
  { ignores: ['dist/**', 'node_modules/**', 'public/**', 'project/**'] },
  // Server code (Vercel functions). Until this block existed, api/ was not
  // linted at all: a bare `model` variable that no longer existed in its
  // function shipped to production and silently turned every Ivy chat into
  // a canned reply, and two invoice endpoints called an unimported
  // badRequest(). no-undef is an error here on purpose - it fails CI.
  {
    files: ['api/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2021 },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      // Input sanitizers match control and zero-width characters on purpose.
      'no-control-regex': 'off',
      'no-irregular-whitespace': ['error', { skipRegExps: true, skipStrings: true, skipTemplates: true }],
    },
  },
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    plugins: { react, 'react-hooks': reactHooks },
    settings: { react: { version: 'detect' } },
    rules: {
      ...js.configs.recommended.rules,
      ...react.configs.flat.recommended.rules,
      // Hooks: rules-of-hooks is a real-bug guard (keep as error); the
      // dependency-array check is advisory (the code uses targeted disables).
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Automatic JSX runtime (Vite) - no need to import React for JSX.
      'react/react-in-jsx-scope': 'off',
      // We don't use prop-types.
      'react/prop-types': 'off',
      // Apostrophes/quotes in JSX text are fine - purely stylistic.
      'react/no-unescaped-entities': 'off',
      // Surface, don't block, on dead vars and intentional empty catches.
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
];
