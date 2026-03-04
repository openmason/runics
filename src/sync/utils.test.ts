import { describe, it, expect } from 'vitest';
import { slugify, sha256 } from './utils';

describe('slugify', () => {
  it('should convert name to lowercase slug', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('should replace non-alphanumeric characters with hyphens', () => {
    expect(slugify('foo/bar@baz')).toBe('foo-bar-baz');
  });

  it('should strip leading and trailing hyphens', () => {
    expect(slugify('--hello--')).toBe('hello');
  });

  it('should handle namespaced names', () => {
    expect(slugify('agency.lona/trading')).toBe('agency-lona-trading');
  });

  it('should truncate to 200 characters', () => {
    const longName = 'a'.repeat(250);
    expect(slugify(longName).length).toBe(200);
  });
});

describe('sha256', () => {
  it('should return a 64-character hex string', async () => {
    const hash = await sha256('test data');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it('should return consistent hashes for same input', async () => {
    const hash1 = await sha256('same input');
    const hash2 = await sha256('same input');
    expect(hash1).toBe(hash2);
  });

  it('should return different hashes for different input', async () => {
    const hash1 = await sha256('input A');
    const hash2 = await sha256('input B');
    expect(hash1).not.toBe(hash2);
  });
});
