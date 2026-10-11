import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const NODE_IO = [
  'fs', 'node:fs', 'fs/promises', 'node:fs/promises',
  'child_process', 'node:child_process',
].map((name) => ({
  name,
  message: 'Direct I/O is only allowed inside src/adapters. Use a port from src/ports.',
}));

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'templates/**', 'features/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      'no-console': 'error',
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'exit',
          message: 'Set process.exitCode in src/bin.ts instead of calling process.exit().',
        },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', fetch: 'readonly' } },
    rules: { 'no-console': 'off', 'no-restricted-properties': 'off' },
  },
  // Layering: core -> ports only. app -> core + ports. cli -> app + core + ports + adapters.
  {
    files: ['src/core/**/*.ts', 'src/errors/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: NODE_IO,
          patterns: [
            { group: ['**/adapters/**', '**/app/**', '**/cli/**'], message: 'core must not depend on outer layers.' },
          ],
        },
      ],
    },
  },
  {
    files: ['src/app/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: NODE_IO,
          patterns: [{ group: ['**/adapters/**', '**/cli/**'], message: 'app must not depend on adapters or cli.' }],
        },
      ],
    },
  },
  {
    files: ['src/cli/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { paths: NODE_IO }] },
  },
  { files: ['src/ports/**/*.ts'], rules: { 'no-restricted-imports': ['error', { paths: NODE_IO }] } },
);
