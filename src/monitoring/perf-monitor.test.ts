import { describe, it, expect, beforeEach } from 'vitest';
import { PerfMonitor } from './perf-monitor';

describe('PerfMonitor', () => {
  let monitor: PerfMonitor;

  beforeEach(() => {
    monitor = new PerfMonitor();
  });

  describe('mark', () => {
    it('should mark a point in time', () => {
      expect(() => monitor.mark('test-mark')).not.toThrow();
    });

    it('should allow marking multiple points', () => {
      monitor.mark('mark1');
      monitor.mark('mark2');
      monitor.mark('mark3');

      expect(() => monitor.mark('mark4')).not.toThrow();
    });
  });

  describe('since', () => {
    it('should return time since mark', () => {
      monitor.mark('test-mark');

      // Simulate some work
      const start = Date.now();
      while (Date.now() - start < 10) {
        // busy wait for ~10ms
      }

      const elapsed = monitor.since('test-mark');

      expect(elapsed).toBeGreaterThanOrEqual(10);
      expect(elapsed).toBeLessThan(100); // reasonable upper bound
    });

    it('should return time since start for unknown mark', () => {
      const elapsed = monitor.since('non-existent-mark');

      expect(elapsed).toBeGreaterThanOrEqual(0);
    });
  });

  describe('total', () => {
    it('should return total elapsed time', () => {
      const start = Date.now();
      while (Date.now() - start < 10) {
        // busy wait for ~10ms
      }

      const total = monitor.total();

      expect(total).toBeGreaterThanOrEqual(10);
    });
  });

  describe('between', () => {
    it('should measure time between two marks', () => {
      monitor.mark('mark1');

      const start = Date.now();
      while (Date.now() - start < 10) {
        // busy wait for ~10ms
      }

      monitor.mark('mark2');

      const elapsed = monitor.between('mark1', 'mark2');

      expect(elapsed).toBeGreaterThanOrEqual(10);
      expect(elapsed).toBeLessThan(100);
    });

    it('should return 0 for unknown marks', () => {
      expect(monitor.between('mark1', 'mark2')).toBe(0);

      monitor.mark('mark1');
      expect(monitor.between('mark1', 'unknown')).toBe(0);
    });
  });

  describe('toStructuredLog', () => {
    it('should generate structured log', () => {
      monitor.mark('cache_check');
      monitor.mark('vector_search');

      const log = monitor.toStructuredLog({ query: 'test query' });

      expect(log._type).toBe('search_perf');
      expect(log.totalMs).toBeGreaterThanOrEqual(0);
      expect(log.durations).toBeTruthy();
      expect(log.marks).toBeTruthy();
      expect(log.query).toBe('test query');
    });

    it('should include extra fields', () => {
      const log = monitor.toStructuredLog({
        custom: 'value',
        another: 123,
      });

      expect(log.custom).toBe('value');
      expect(log.another).toBe(123);
    });
  });

  describe('summary', () => {
    it('should return summary string', () => {
      monitor.mark('mark1');
      monitor.mark('mark2');

      const summary = monitor.summary();

      expect(summary).toContain('Total:');
      expect(summary).toContain('mark1:');
      expect(summary).toContain('mark2:');
    });
  });

  describe('reset', () => {
    it('should clear all marks', () => {
      monitor.mark('mark1');
      monitor.mark('mark2');

      monitor.reset();

      const summary = monitor.summary();
      expect(summary).toContain('Total: 0ms');
    });

    it('should allow marking after reset', () => {
      monitor.mark('mark1');
      monitor.reset();

      expect(() => monitor.mark('mark2')).not.toThrow();

      const elapsed = monitor.since('mark2');
      expect(elapsed).toBeGreaterThanOrEqual(0);
    });
  });

  describe('log', () => {
    it('should log to console', () => {
      // Just test that it doesn't throw
      expect(() => monitor.log({ test: 'value' })).not.toThrow();
    });
  });
});
