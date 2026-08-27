// There was no ESLint configuration in this project, and no ESLint dependency.
// `npm run lint` ran `next lint`, which in Next 15.5 is deprecated and opens an
// INTERACTIVE codemod prompt -- so the lint script had never linted anything,
// and wiring it into CI unchanged would have hung the run. This makes it real.
//
// The rules are Next's own recommended set plus its TypeScript rules. The
// additions below are the ones this specific codebase needs, and each is here
// because of a defect that actually occurred, not on principle.
import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

const config = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'next-env.d.ts',
      // Standalone Node scripts, linted by their own runtime rather than by
      // Next's browser-oriented config.
      'scripts/**',
    ],
  },

  ...compat.extends('next/core-web-vitals', 'next/typescript'),

  {
    rules: {
      // F24: the parser silently discarded a minus sign, and the tests passed
      // either way because the assertions were conditional. An unused variable
      // is often the visible end of that same class of mistake -- a result
      // computed and then not checked.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],

      // §12.7 and TM16: decimals cross every boundary as text. `any` is how a
      // NUMERIC quietly becomes a JavaScript double despite the lint rule in
      // scripts/assert-no-float-arithmetic.mjs, which is name-directed and
      // cannot see through an untyped value.
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
];

export default config;
