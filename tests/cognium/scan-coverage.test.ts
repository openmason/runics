import { describe, it, expect } from 'vitest';
import { determineScanCoverage } from '../../src/cognium/scan-report-handler';
import type { SkillRow, CircleIRJobStatus } from '../../src/cognium/types';

function makeSkill(overrides?: Partial<SkillRow>): SkillRow {
  return {
    id: 'test-id',
    slug: 'test-skill',
    version: '1.0.0',
    name: 'Test Skill',
    description: 'A test skill',
    source: 'github',
    status: 'published',
    executionLayer: 'mcp-remote',
    ...overrides,
  };
}

function makeJob(overrides?: Partial<CircleIRJobStatus>): CircleIRJobStatus {
  return {
    job_id: 'test-job',
    status: 'completed',
    progress: 100,
    ...overrides,
  };
}

describe('determineScanCoverage', () => {
  it('should return code-full for skill with GitHub sourceUrl', () => {
    const skill = makeSkill({ sourceUrl: 'https://github.com/owner/repo' });
    expect(determineScanCoverage(skill, makeJob())).toBe('code-full');
  });

  it('should return code-full for skill with GitHub repositoryUrl', () => {
    const skill = makeSkill({ sourceUrl: null, repositoryUrl: 'https://github.com/owner/repo' });
    expect(determineScanCoverage(skill, makeJob())).toBe('code-full');
  });

  it('should return code-partial when files_failed > 0', () => {
    const skill = makeSkill({ sourceUrl: 'https://github.com/owner/repo' });
    const job = makeJob({
      metrics: { files_total: 10, files_analyzed: 8, files_failed: 2, files_skipped: 0 },
    });
    expect(determineScanCoverage(skill, job)).toBe('code-partial');
  });

  it('should return instructions-only when skillMd is present but no repo', () => {
    const skill = makeSkill({ sourceUrl: null, repositoryUrl: null, skillMd: '# Instructions' });
    expect(determineScanCoverage(skill, makeJob())).toBe('instructions-only');
  });

  it('should return instructions-only when schemaJson is present but no repo', () => {
    const skill = makeSkill({ sourceUrl: null, repositoryUrl: null, schemaJson: { type: 'object' } });
    expect(determineScanCoverage(skill, makeJob())).toBe('instructions-only');
  });

  it('should return instructions-only when r2BundleKey is present but no repo', () => {
    const skill = makeSkill({ sourceUrl: null, repositoryUrl: null, r2BundleKey: 'bundles/abc.zip' });
    expect(determineScanCoverage(skill, makeJob())).toBe('instructions-only');
  });

  it('should return metadata-only when no repo, no skillMd, no schema, no r2Bundle', () => {
    const skill = makeSkill({
      sourceUrl: null, repositoryUrl: null,
      skillMd: null, schemaJson: null, r2BundleKey: null,
    });
    expect(determineScanCoverage(skill, makeJob())).toBe('metadata-only');
  });

  it('should return code-full when job.metrics is undefined (GitHub repo)', () => {
    const skill = makeSkill({ sourceUrl: 'https://github.com/owner/repo' });
    const job = makeJob({ metrics: undefined });
    expect(determineScanCoverage(skill, job)).toBe('code-full');
  });

  it('should return code-full when job has no metrics property at all', () => {
    const skill = makeSkill({ sourceUrl: 'https://github.com/owner/repo' });
    const { metrics, ...jobWithoutMetrics } = makeJob();
    expect(determineScanCoverage(skill, jobWithoutMetrics as CircleIRJobStatus)).toBe('code-full');
  });

  it('should return code-full when files_failed is 0', () => {
    const skill = makeSkill({ sourceUrl: 'https://github.com/owner/repo' });
    const job = makeJob({
      metrics: { files_total: 5, files_analyzed: 5, files_failed: 0, files_skipped: 0 },
    });
    expect(determineScanCoverage(skill, job)).toBe('code-full');
  });
});
