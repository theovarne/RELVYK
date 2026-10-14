import globals from 'globals';
export default [
  { ignores: ['public/**', 'node_modules/**', 'docs/**', 'figures/**'] },
  { files: ['**/*.js', '**/*.mjs'], languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.browser, ...globals.node } }, rules: {
    'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    'no-undef': 'error', 'no-eval': 'error', 'no-implied-eval': 'error', 'no-new-func': 'error',
    'no-constant-condition': ['error', { checkLoops: false }], 'no-unsafe-finally': 'error', 'valid-typeof': 'error', 'constructor-super': 'error', 'no-unreachable': 'error',
  } },
];
