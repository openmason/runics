import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QualityTracker } from './quality-tracker';
import type { QualityFeedback } from '../types';

describe('QualityTracker', () => {
  let mockPool: any;
  let tracker: QualityTracker;

  const mockFeedback: QualityFeedback = {
    searchEventId: 'event-123',
    skillId: 'skill-456',
    feedbackType: 'click',
    position: 1,
  };

  beforeEach(() => {
    mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };

    tracker = new QualityTracker(mockPool);
  });

  describe('recordFeedback', () => {
    it('should record feedback successfully', async () => {
      await tracker.recordFeedback(mockFeedback);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO quality_feedback'),
        [mockFeedback.searchEventId, mockFeedback.skillId, mockFeedback.feedbackType, mockFeedback.position]
      );
    });

    it('should handle database errors gracefully', async () => {
      mockPool.query.mockRejectedValue(new Error('DB error'));

      await expect(tracker.recordFeedback(mockFeedback)).resolves.toBeUndefined();
    });

    it('should record different feedback types', async () => {
      const feedbackTypes: Array<'click' | 'use' | 'dismiss'> = ['click', 'use', 'dismiss'];

      for (const type of feedbackTypes) {
        await tracker.recordFeedback({
          ...mockFeedback,
          feedbackType: type,
        });
      }

      expect(mockPool.query).toHaveBeenCalledTimes(3);
    });
  });

  describe('getTierDistribution', () => {
    it('should return tier distribution stats', async () => {
      mockPool.query.mockResolvedValue({
        rows: [
          { tier: '1', count: '100' },
          { tier: '2', count: '50' },
          { tier: '3', count: '10' },
        ],
      });

      const distribution = await tracker.getTierDistribution(24);

      expect(distribution.tier1).toBe(100);
      expect(distribution.tier2).toBe(50);
      expect(distribution.tier3).toBe(10);
    });

    it('should handle empty results', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      const distribution = await tracker.getTierDistribution(24);

      expect(distribution).toEqual({ tier1: 0, tier2: 0, tier3: 0 });
    });

    it('should handle errors gracefully', async () => {
      mockPool.query.mockRejectedValue(new Error('DB error'));

      const distribution = await tracker.getTierDistribution(24);

      expect(distribution).toEqual({ tier1: 0, tier2: 0, tier3: 0 });
    });
  });

  describe('getMatchSourceStats', () => {
    it('should return match source statistics', async () => {
      mockPool.query.mockResolvedValue({
        rows: [
          { match_source: 'vector', query_count: '80', avg_top_score: '0.85', use_count: '10' },
          { match_source: 'full_text', query_count: '20', avg_top_score: '0.70', use_count: '5' },
        ],
      });

      const stats = await tracker.getMatchSourceStats(24);

      expect(stats).toHaveLength(2);
      expect(stats[0].matchSource).toBe('vector');
      expect(stats[0].avgTopScore).toBe(0.85);
      expect(stats[0].useCount).toBe(10);
    });

    it('should handle empty results', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      const stats = await tracker.getMatchSourceStats(24);

      expect(stats).toEqual([]);
    });
  });

  describe('getLatencyPercentiles', () => {
    it('should return latency percentile stats', async () => {
      mockPool.query.mockResolvedValue({
        rows: [
          {
            p50: 100,
            p95: 300,
            p99: 500,
            p999: 800,
          },
        ],
      });

      const latency = await tracker.getLatencyPercentiles(24);

      expect(latency.p50).toBe(100);
      expect(latency.p95).toBe(300);
      expect(latency.p99).toBe(500);
      expect(latency.p999).toBe(800);
    });

    it('should handle errors gracefully', async () => {
      mockPool.query.mockRejectedValue(new Error('DB error'));

      const latency = await tracker.getLatencyPercentiles(24);

      expect(latency).toEqual({ p50: 0, p95: 0, p99: 0, p999: 0 });
    });
  });

  describe('getCostBreakdown', () => {
    it('should return cost breakdown', async () => {
      mockPool.query.mockResolvedValue({
        rows: [
          { tier: '1', embedding_cost: '0.5', llm_cost: '0.2' },
          { tier: '2', embedding_cost: '0.3', llm_cost: '0.1' },
          { tier: '3', embedding_cost: '0.2', llm_cost: '0.5' },
        ],
      });

      const costs = await tracker.getCostBreakdown(24);

      expect(costs.totalCost).toBeGreaterThan(0);
      expect(costs.embeddingCost).toBeGreaterThan(0);
      expect(costs.llmCost).toBeGreaterThan(0);
      expect(costs.byTier).toBeTruthy();
    });
  });

  describe('getFailedQueries', () => {
    it('should return failed queries', async () => {
      mockPool.query.mockResolvedValue({
        rows: [
          {
            query: 'test query',
            timestamp: new Date().toISOString(),
            tier: '3',
            top_score: 0.3,
            dismiss_count: '5',
          },
        ],
      });

      const failed = await tracker.getFailedQueries(24, 10);

      expect(failed).toHaveLength(1);
      expect(failed[0].query).toBe('test query');
      expect(failed[0].dismissCount).toBe(5);
    });

    it('should handle empty results', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      const failed = await tracker.getFailedQueries(24, 10);

      expect(failed).toEqual([]);
    });
  });

  describe('getTier3Patterns', () => {
    it('should return tier 3 pattern analysis', async () => {
      mockPool.query.mockResolvedValue({
        rows: [
          {
            query: 'complex query',
            frequency: '3',
            avg_top_score: '0.35',
            alternate_queries_used: ['alt1', 'alt2'],
          },
        ],
      });

      const patterns = await tracker.getTier3Patterns(24);

      expect(patterns).toHaveLength(1);
      expect(patterns[0].pattern).toBe('complex query');
      expect(patterns[0].frequency).toBe(3);
      expect(patterns[0].avgTopScore).toBe(0.35);
    });

    it('should handle empty results', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      const patterns = await tracker.getTier3Patterns(24);

      expect(patterns).toEqual([]);
    });

    it('should handle errors gracefully', async () => {
      mockPool.query.mockRejectedValue(new Error('DB error'));

      const patterns = await tracker.getTier3Patterns(24);

      expect(patterns).toEqual([]);
    });
  });

  describe('refreshSummary', () => {
    it('should refresh materialized view', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      await tracker.refreshSummary();

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('REFRESH MATERIALIZED VIEW')
      );
    });

    it('should throw on errors', async () => {
      mockPool.query.mockRejectedValue(new Error('Refresh failed'));

      await expect(tracker.refreshSummary()).rejects.toThrow('Refresh failed');
    });
  });
});
