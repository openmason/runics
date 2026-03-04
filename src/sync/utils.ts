// ══════════════════════════════════════════════════════════════════════════════
// Sync Utilities — Shared helpers for sync pipelines
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Convert a name into a URL-safe slug.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 200);
}

/**
 * Compute SHA-256 hash of a string using Web Crypto API.
 */
export async function sha256(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
