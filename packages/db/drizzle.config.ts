import {defineConfig} from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      'postgresql://fai:fai@localhost:5432/fai_control_plane'
  },
  strict: true,
  verbose: true
});
