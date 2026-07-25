import {defineConfig, globalIgnores} from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

export default defineConfig([
  {
    settings: {
      next: {
        rootDir: 'apps/web/'
      }
    }
  },
  ...nextVitals,
  ...nextTypescript,
  globalIgnores([
    '**/.next/**',
    '**/dist/**',
    '**/coverage/**',
    '**/drizzle/meta/**',
    'artifacts/**'
  ])
]);
