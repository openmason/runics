import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/**',
        'dist/**',
        '.wrangler/**',
        'scripts/**',
        'src/db/schema.ts',
        'src/types.ts',
        '**/*.config.ts',
        '**/*.d.ts',
        // Integration-heavy files (tested via eval suite and integration tests)
        'src/index.ts', // Main Hono API - requires full integration test
        'src/providers/pgvector-provider.ts', // Database provider - requires DB setup
        'src/providers/search-provider.ts', // Interface definition only
        'src/eval/runner.ts', // Eval suite runner - integration test
        'src/ingestion/embed-pipeline.ts', // Embedding pipeline - requires Workers AI
      ],
      thresholds: {
        lines: 75,
        functions: 75,
        branches: 75,
        statements: 75,
      },
    },
  },
});
