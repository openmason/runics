// ══════════════════════════════════════════════════════════════════════════════
// Cognium Client — Scan Report Handler
// ══════════════════════════════════════════════════════════════════════════════
//
// Orchestrates: normalize findings → score → status → DB write → cascade → notify
// Called by poll-consumer.ts after fetching findings from Circle-IR.
//
// ══════════════════════════════════════════════════════════════════════════════

import { Pool } from '@neondatabase/serverless';
import type { Env } from '../types';
import type { ScanFinding, SkillRow, CircleIRJobStatus } from './types';
import { deriveWorstSeverity, isContentUnsafe } from './finding-mapper';
import { computeTrustScore, deriveStatus, deriveTier, buildRemediationMessage } from './scoring-policy';
import { cascadeStatusToComposites, repairCompositeStatus } from './composite-cascade';
import { triggerNotification } from './notification-trigger';

export async function applyScanReport(
  env: Env,
  pool: Pool,
  skill: SkillRow,
  findings: ScanFinding[],
  job: CircleIRJobStatus,
): Promise<void> {
  const worstSeverity = deriveWorstSeverity(findings);
  const contentUnsafe = isContentUnsafe(findings);

  // Content safety failure: absolute override
  if (contentUnsafe) {
    await pool.query(
      `UPDATE skills SET
        trust_score = 0.0,
        verification_tier = 'scanned',
        content_safety_passed = false,
        status = 'revoked',
        revoked_at = NOW(),
        revoked_reason = 'content_safety_failed',
        remediation_message = 'Revoked: skill contains instruction injection or prompt hijacking risk.',
        cognium_findings = $1,
        cognium_scanned_at = NOW(),
        scan_coverage = $2,
        updated_at = NOW()
      WHERE id = $3`,
      [
        JSON.stringify(findings),
        (job.metrics?.files_failed ?? 0) > 0 ? 'partial' : 'full',
        skill.id,
      ]
    );

    await cascadeStatusToComposites(pool, skill.id, 'revoked');
    await triggerNotification(env, skill.id, 'revoked', 'Content safety failure');
    return;
  }

  const trustScore = computeTrustScore(skill, findings);
  const newStatus = deriveStatus(worstSeverity);
  const tier = deriveTier(worstSeverity, trustScore);
  const worstFinding = findings.find(f => f.severity === worstSeverity);
  const remediationMessage = worstFinding ? buildRemediationMessage(worstFinding, skill) : null;

  await pool.query(
    `UPDATE skills SET
      trust_score = $1,
      verification_tier = $2,
      content_safety_passed = true,
      scan_coverage = $3,
      status = $4,
      revoked_at = CASE WHEN $4 = 'revoked' THEN NOW() ELSE NULL END,
      revoked_reason = CASE WHEN $4 = 'revoked' THEN $5 ELSE NULL END,
      remediation_message = $6,
      remediation_url = $7,
      cognium_findings = $8,
      cognium_scanned_at = NOW(),
      updated_at = NOW()
    WHERE id = $9`,
    [
      trustScore,
      tier,
      (job.metrics?.files_failed ?? 0) > 0 ? 'partial' : 'full',
      newStatus,
      worstFinding?.cweId ?? worstFinding?.title ?? null,
      remediationMessage,
      worstFinding?.remediationUrl ?? null,
      JSON.stringify(findings),
      skill.id,
    ]
  );

  if (newStatus === 'revoked' || newStatus === 'vulnerable') {
    await cascadeStatusToComposites(pool, skill.id, newStatus as 'revoked' | 'vulnerable');
  }

  // Repair composites if this skill was previously flagged and is now clean
  if (newStatus === 'published' && ['vulnerable', 'revoked'].includes(skill.status)) {
    await repairCompositeStatus(pool, skill.id);
  }

  if (newStatus === 'revoked') {
    await triggerNotification(env, skill.id, 'revoked', worstFinding?.cweId ?? worstFinding?.title);
  } else if (newStatus === 'vulnerable' && worstSeverity === 'HIGH') {
    await triggerNotification(env, skill.id, 'vulnerable', worstFinding?.cweId ?? worstFinding?.title);
  }
}

export async function markScanFailed(pool: Pool, skillId: string, reason: string): Promise<void> {
  await pool.query(
    `UPDATE skills SET
      verification_tier = 'unverified',
      cognium_scanned_at = NOW(),
      updated_at = NOW()
    WHERE id = $1`,
    [skillId]
  );
  console.error(`[COGNIUM] Scan failed for ${skillId}: ${reason}`);
}
