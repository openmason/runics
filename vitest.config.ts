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
        // Hono route handlers - require full HTTP integration test
        'src/authors/handler.ts',
        'src/publish/handler.ts',
        // Intelligence layer - requires Workers AI / LLM mocking
        'src/intelligence/confidence-gate.ts',
        'src/intelligence/deep-search.ts',
        'src/intelligence/composition-detector.ts',
        'src/intelligence/reranker.ts',
        // Middleware & queues - require KV / queue runtime
        'src/middleware/rate-limiter.ts',
        'src/queues/cognium-consumer.ts',
        'src/queues/embed-consumer.ts',
        // Sync - requires HTTP fetch / abstract base
        'src/sync/base-sync.ts',
        'src/sync/github.ts'
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
