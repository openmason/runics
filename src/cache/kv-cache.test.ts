import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SearchCache } from './kv-cache';
import type { FindSkillResponse } from '../types';

describe('SearchCache', () => {
  let mockKV: KVNamespace;
  let cache: SearchCache;

  const mockResponse: FindSkillResponse = {
    results: [
      {
        id: 'test-skill',
        name: 'Test Skill',
        slug: 'test-skill',
        version: '1.0.0',
        agentSummary: 'Test description',
        score: 0.9,
        matchSource: 'vector',
        trustScore: 0.9,
        verificationTier: 'unverified',
        trustBadge: null,
        status: 'published',
        executionLayer: 'local',
        capabilitiesRequired: [],
        skillType: 'atomic',
        runCount: 0,
        runtimeEnv: 'api',
        visibility: 'public',
        shareUrl: 'https://runics.net/skills/test-skill',
      },
    ],
    confidence: 'high',
    enriched: false,
    meta: {
      matchSources: ['vector'],
      tier: 1,
      latencyMs: 100,
      cacheHit: false,
      llmInvoked: false,
    },
  };

  beforeEach(() => {
    mockKV = {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
    } as any;

    cache = new SearchCache(mockKV, 120);
  });

  describe('get', () => {
    it('should return null on cache miss', async () => {
      vi.mocked(mockKV.get).mockResolvedValue(null as any);

      const result = await cache.get('test query', 'tenant-1', 'balanced');

      expect(result).toBeNull();
      expect(mockKV.get).toHaveBeenCalled();
    });

    it('should return cached result on cache hit', async () => {
      vi.mocked(mockKV.get).mockResolvedValue(JSON.stringify(mockResponse) as any);

      const result = await cache.get('test query', 'tenant-1', 'balanced');

      expect(result).toBeTruthy();
      expect(result?.results[0].name).toBe('Test Skill');
      expect(result?.meta.cacheHit).toBe(true);
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(mockKV.get).mockRejectedValue(new Error('KV error'));

      const result = await cache.get('test query', 'tenant-1', 'balanced');

      expect(result).toBeNull();
    });

    it('should normalize query (lowercase, trim)', async () => {
      vi.mocked(mockKV.get).mockResolvedValue(JSON.stringify(mockResponse) as any);

      await cache.get('  Test QUERY  ', 'tenant-1', 'balanced');
      await cache.get('test query', 'tenant-1', 'balanced');

      // Both calls should use the same normalized key (filter out revoked_slugs checks)
      const calls = vi.mocked(mockKV.get).mock.calls;
      const searchKeyCalls = calls.filter(([key]) => (key as unknown as string).startsWith('search:'));
      expect(searchKeyCalls.length).toBe(2);
      expect(searchKeyCalls[0][0]).toBe(searchKeyCalls[1][0]);
    });
  });

  describe('set', () => {
    it('should cache result with tier 1 TTL', async () => {
      await cache.set('test query', 'tenant-1', 'balanced', mockResponse, 1);

      expect(mockKV.put).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ expirationTtl: 120 })
      );
    });

    it('should cache result with tier 2/3 TTL (half of base)', async () => {
      await cache.set('test query', 'tenant-1', 'balanced', mockResponse, 2);

      expect(mockKV.put).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ expirationTtl: 60 })
      );
    });

    it('should remove enrichmentPromise before caching', async () => {
      const responseWithPromise: FindSkillResponse = {
        ...mockResponse,
        enrichmentPromise: Promise.resolve(mockResponse),
      };

      await cache.set('test query', 'tenant-1', 'balanced', responseWithPromise, 1);

      const cachedValue = vi.mocked(mockKV.put).mock.calls[0][1];
      const parsed = JSON.parse(cachedValue as string);

      expect(parsed.enrichmentPromise).toBeUndefined();
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(mockKV.put).mockRejectedValue(new Error('KV error'));

      await expect(
        cache.set('test query', 'tenant-1', 'balanced', mockResponse, 1)
      ).resolves.toBeUndefined();
    });
  });

  describe('invalidate', () => {
    it('should delete cache entry', async () => {
      await cache.invalidate('test query', 'tenant-1', 'balanced');

      expect(mockKV.delete).toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(mockKV.delete).mockRejectedValue(new Error('KV error'));

      await expect(
        cache.invalidate('test query', 'tenant-1', 'balanced')
      ).resolves.toBeUndefined();
    });
  });

  describe('clearAll', () => {
    it('should list and delete all search: keys', async () => {
      const mockKeys = [
        { name: 'search:abc123' },
        { name: 'search:def456' },
      ];

      vi.mocked(mockKV.list).mockResolvedValue({
        keys: mockKeys,
        list_complete: true,
        cacheStatus: null,
      });

      await cache.clearAll();

      expect(mockKV.list).toHaveBeenCalledWith({ prefix: 'search:' });
      expect(mockKV.delete).toHaveBeenCalledTimes(2);
      expect(mockKV.delete).toHaveBeenCalledWith('search:abc123');
      expect(mockKV.delete).toHaveBeenCalledWith('search:def456');
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(mockKV.list).mockRejectedValue(new Error('KV error'));

      await expect(cache.clearAll()).resolves.toBeUndefined();
    });
  });

  describe('key generation', () => {
    it('should generate consistent keys for same input', async () => {
      vi.mocked(mockKV.get).mockResolvedValue(null as any);

      await cache.get('test query', 'tenant-1', 'balanced');
      await cache.get('test query', 'tenant-1', 'balanced');

      const calls = vi.mocked(mockKV.get).mock.calls;
      expect(calls[0][0]).toBe(calls[1][0]);
    });

    it('should generate different keys for different queries', async () => {
      vi.mocked(mockKV.get).mockResolvedValue(null as any);

      await cache.get('query 1', 'tenant-1', 'balanced');
      await cache.get('query 2', 'tenant-1', 'balanced');

      const calls = vi.mocked(mockKV.get).mock.calls;
      expect(calls[0][0]).not.toBe(calls[1][0]);
    });

    it('should generate different keys for different tenants', async () => {
      vi.mocked(mockKV.get).mockResolvedValue(null as any);

      await cache.get('test query', 'tenant-1', 'balanced');
      await cache.get('test query', 'tenant-2', 'balanced');

      const calls = vi.mocked(mockKV.get).mock.calls;
      expect(calls[0][0]).not.toBe(calls[1][0]);
    });

    it('should generate different keys for different appetites', async () => {
      vi.mocked(mockKV.get).mockResolvedValue(null as any);

      await cache.get('test query', 'tenant-1', 'balanced');
      await cache.get('test query', 'tenant-1', 'conservative');

      const calls = vi.mocked(mockKV.get).mock.calls;
      expect(calls[0][0]).not.toBe(calls[1][0]);
    });
  });
});
