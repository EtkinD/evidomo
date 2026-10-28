import js from '@eslint/js';
import nextVitals from 'eslint-config-next/core-web-vitals';
import prettier from 'eslint-config-prettier/flat';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

const tsFiles = ['**/*.{ts,tsx,mts,cts}'];
const webDir = 'apps/web';

// eslint-config-next targets a single-app repo ("**/*" globs). Re-scope every object to the
// web workspace so React/Next rules never apply to the API, and drop its ignores-only object
// (covered by the global ignores below).
const nextForWeb = nextVitals
  .filter((config) => Object.keys(config).some((key) => key !== 'ignores'))
  .map((config) => ({
    ...config,
    files: (config.files ?? ['**/*.{js,jsx,mjs,ts,tsx,mts,cts}']).map((pattern) =>
      typeof pattern === 'string' ? `${webDir}/${pattern}` : pattern,
    ),
    settings: { ...config.settings, next: { rootDir: `${webDir}/` } },
  }));

export default defineConfig([
  globalIgnores([
    '**/node_modules/**',
    '**/.next/**',
    '**/out/**',
    '**/dist/**',
    '**/coverage/**',
    'playwright-report/**',
    'test-results/**',
    'apps/web/next-env.d.ts',
    'apps/api/drizzle/**',
    '.claude/worktrees/**',
  ]),

  js.configs.recommended,

  // Type-aware TypeScript rules for TS sources only; config .mjs files stay on plain JS rules.
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({ ...config, files: tsFiles })),
  {
    files: tsFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  ...nextForWeb,

  prettier,
]);
