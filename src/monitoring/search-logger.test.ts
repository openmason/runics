import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SearchLogger } from './search-logger';
import type { SearchLogEntry } from '../types';

describe('SearchLogger', () => {
  let mockPool: any;
  let logger: SearchLogger;

  const mockLogEntry: SearchLogEntry = {
    query: 'test query',
    tenantId: 'test-tenant',
    appetite: 'balanced',
    tier: 1,
    cacheHit: false,
    topScore: 0.9,
    gapToSecond: 0.1,
    clusterDensity: 0.8,
    keywordHits: 3,
    resultCount: 5,
    matchSource: 'vector',
    resultSkillIds: ['skill-1', 'skill-2'],
    totalLatencyMs: 100,
    vectorSearchMs: 50,
    fullTextSearchMs: 30,
    fusionStrategy: 'rrf',
    llmInvoked: false,
    llmLatencyMs: undefined,
    llmModel: undefined,
    llmTokensUsed: undefined,
    embeddingCost: 0.001,
    llmCost: 0,
    alternateQueriesUsed: undefined,
    compositionDetected: false,
    generationHintReturned: false,
  };

  beforeEach(() => {
    mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: 'log-id-123' }] }),
    };

    logger = new SearchLogger(mockPool);
  });

  describe('log', () => {
    it('should log search event and return event ID', async () => {
      const eventId = await logger.log(mockLogEntry);

      expect(eventId).toBe('log-id-123');
      expect(mockPool.query).toHaveBeenCalled();
    });

    it('should return "log-failed" on database errors', async () => {
      mockPool.query.mockRejectedValue(new Error('DB error'));

      const eventId = await logger.log(mockLogEntry);

      expect(eventId).toBe('log-failed');
    });

    it('should handle missing optional fields', async () => {
      const minimalEntry: SearchLogEntry = {
        query: 'test',
        tenantId: 'tenant-1',
        appetite: 'balanced',
        tier: 1,
        cacheHit: false,
        topScore: 0.9,
        gapToSecond: 0.1,
        clusterDensity: 0.8,
        keywordHits: 0,
        resultCount: 1,
        matchSource: 'vector',
        resultSkillIds: ['skill-1'],
        totalLatencyMs: 100,
        vectorSearchMs: 50,
        fullTextSearchMs: 30,
        fusionStrategy: 'rrf',
        llmInvoked: false,
        llmLatencyMs: undefined,
        llmModel: undefined,
        llmTokensUsed: undefined,
        embeddingCost: 0.001,
        llmCost: 0,
        alternateQueriesUsed: undefined,
        compositionDetected: false,
        generationHintReturned: false,
      };

      const eventId = await logger.log(minimalEntry);
      expect(eventId).toBeTruthy();
    });

    it('should not throw on errors (fail gracefully)', async () => {
      mockPool.query.mockRejectedValue(new Error('Query error'));

      await expect(logger.log(mockLogEntry)).resolves.toBe('log-failed');
    });
  });

  describe('buildLogEntry', () => {
    it('should build a valid SearchLogEntry from params', () => {
      const params = {
        query: 'test query',
        tenantId: 'tenant-1',
        appetite: 'balanced' as const,
        tier: 1 as const,
        cacheHit: false,
        topScore: 0.9,
        gapToSecond: 0.1,
        clusterDensity: 0.8,
        keywordHits: 5,
        resultCount: 10,
        matchSource: 'vector',
        resultSkillIds: ['skill-1', 'skill-2'],
        totalLatencyMs: 100,
        vectorSearchMs: 50,
        fullTextSearchMs: 30,
        fusionStrategy: 'rrf',
        llmInvoked: false,
        embeddingCost: 0.001,
        llmCost: 0,
        alternateQueriesUsed: ['alt1', 'alt2'],
        compositionDetected: false,
        generationHintReturned: false,
      };

      const entry = logger.buildLogEntry(params);

      expect(entry.query).toBe('test query');
      expect(entry.tenantId).toBe('tenant-1');
      expect(entry.appetite).toBe('balanced');
      expect(entry.tier).toBe(1);
      expect(entry.topScore).toBe(0.9);
      expect(entry.alternateQueriesUsed).toEqual(['alt1', 'alt2']);
    });

    it('should build entry with minimal params', () => {
      const params = {
        query: 'minimal',
        tenantId: 'tenant-1',
        tier: 2 as const,
        cacheHit: true,
        resultCount: 5,
        resultSkillIds: ['skill-1'],
        totalLatencyMs: 50,
        llmInvoked: false,
        embeddingCost: 0.001,
        llmCost: 0,
        compositionDetected: false,
        generationHintReturned: false,
      };

      const entry = logger.buildLogEntry(params);

      expect(entry.query).toBe('minimal');
      expect(entry.tier).toBe(2);
      expect(entry.cacheHit).toBe(true);
      expect(entry.appetite).toBeUndefined();
      expect(entry.topScore).toBeUndefined();
    });
  });

  describe('estimateEmbeddingCost', () => {
    it('should estimate cost for short text', () => {
      const cost = logger.estimateEmbeddingCost(100);

      expect(cost).toBeGreaterThan(0);
      expect(cost).toBeLessThan(0.001);
    });

    it('should estimate higher cost for longer text', () => {
      const shortCost = logger.estimateEmbeddingCost(100);
      const longCost = logger.estimateEmbeddingCost(1000);

      expect(longCost).toBeGreaterThan(shortCost);
    });

    it('should return zero for empty text', () => {
      const cost = logger.estimateEmbeddingCost(0);

      expect(cost).toBe(0);
    });
  });

  describe('estimateLLMCost', () => {
    it('should estimate cost for token usage', () => {
      const cost = logger.estimateLLMCost(1000);

      expect(cost).toBeGreaterThan(0);
      expect(cost).toBe(0.00001); // 1000 / 1M * 0.01
    });

    it('should estimate higher cost for more tokens', () => {
      const lowCost = logger.estimateLLMCost(1000);
      const highCost = logger.estimateLLMCost(10000);

      expect(highCost).toBeGreaterThan(lowCost);
      expect(highCost).toBe(lowCost * 10);
    });

    it('should return zero for zero tokens', () => {
      const cost = logger.estimateLLMCost(0);

      expect(cost).toBe(0);
    });
  });
});
