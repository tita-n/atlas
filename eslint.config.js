import { fileURLToPath, URL } from 'node:url';
import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

export default tseslint.config(
  {
    // The sandbox-matrix harness is a standalone bundle of .mjs scripts with
    // its own runtime and its own disable directives; it is not part of the
    // TypeScript package, and linting it under this config reports every
    // Node global as undefined. Excluded rather than patched: the harness is
    // committed as-is and is not this project's to restyle.
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'tools/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: projectRoot,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true },
      ],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // The portfolio page is browser JavaScript. Linting it with the default
    // (Node-ish) globals reported every `document` and `window` reference as
    // undefined, which is noise that trains people to ignore the linter.
    files: ['portfolio/**/*.js'],
    languageOptions: {
      globals: {
        document: 'readonly',
        window: 'readonly',
        localStorage: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        IntersectionObserver: 'readonly',
      },
    },
  },
  prettier,
);
