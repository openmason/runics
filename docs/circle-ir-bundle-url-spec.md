# Circle-IR Feature Request: `bundle_url` Support

## Summary

Add a `bundle_url` field to `POST /api/analyze/skill` that allows Runics to pass a publicly-accessible URL to a downloadable zip archive containing a skill's source files. Circle-IR downloads the archive, extracts its contents, and runs the full analysis pipeline — SAST on code files, instruction analysis on markdown files, capability mismatch detection, and LLM verification.

This unlocks full security analysis for ~8,900 ClawHub community skills that currently can only be scanned via short metadata snippets (~1KB of description text).

---

## Problem

Today the skill analysis API supports two input modes:

| Mode | Field | What Circle-IR gets | Coverage |
|------|-------|---------------------|----------|
| A | `repo_url` | Full GitHub repo (git clone) | Full SAST + instruction analysis |
| B | `files` | Inline key-value map of filename to content | Limited by ~512KB total payload |

ClawHub skills don't have GitHub repos. Their source content — instruction documents, configuration files, and **executable code** — is packaged in small zip archives hosted at a public download URL. Currently Runics can only send ~1KB of metadata inline, which gives Circle-IR almost nothing to analyze.

### What's in these bundles

From a sample of 45 ClawHub skills:
- **44%** (20/45) have downloadable zip bundles
- **75%** of those bundles (15/20) contain **executable code files** (.py, .js, .ts, .sh)
- The rest contain instruction documents (.md) and configuration (.json, .yaml)

Real examples of code that needs SAST review:

| Skill | Code files | What they do |
|-------|-----------|-------------|
| `web-search` | `scripts/search.py` (18KB) | Web scraping via DuckDuckGo API |
| `sequential-thinking` | `scripts/sequential_think.py` (10KB) | Makes HTTP requests to OpenRouter API with API key handling |
| `ai-quant-trader` | 16 code files | Financial trading automation |
| `daily-game-news` | 9 code files | Web scraping and content aggregation |
| `clawbox-media-server` | 4 code files | Media server with file system access |

These code files may contain command injection, hardcoded credentials, unsafe HTTP handling, SQL injection, path traversal, and other vulnerabilities that only SAST can detect. Instruction-only analysis misses all of this.

---

## Proposed API Change

### Request Schema

Add one optional field to `CircleIRSkillAnalyzeRequest`:

```typescript
interface CircleIRSkillAnalyzeRequest {
  // Existing fields (unchanged)
  repo_url?: string;
  branch?: string;
  files?: Record<string, string>;
  skill_context: {
    name: string;
    description: string;
    source_registry: string;
    source_url?: string;
    execution_layer: string;
  };
  options?: {
    enable_sast?: boolean;
    enable_instruction_analysis?: boolean;
    enable_capability_mismatch?: boolean;
    enable_llm_verification?: boolean;
    max_files?: number;
    max_concurrent?: number;
  };

  // NEW
  bundle_url?: string;   // URL to a downloadable .zip archive
}
```

### Input Priority and Fallback

When multiple input fields are provided, Circle-IR uses this priority with automatic fallback:

```
repo_url  >  bundle_url  >  files  >  skill_context only
```

**Fallback rules:**

1. If `repo_url` is set → clone repo, analyze. Ignore `bundle_url` and `files`.
2. If `bundle_url` is set (no `repo_url`) → download zip and analyze.
   - If download succeeds (200) → extract and analyze bundle contents.
   - If download fails (404, timeout, error, corrupt zip) → **fall back to `files`** if provided.
3. If only `files` is set → analyze inline files (existing behavior).
4. If none of the above → analyze `skill_context` metadata only.

This fallback chain is important: **Runics will send both `bundle_url` AND `files` in the same request.** The `files` field contains lightweight metadata (description, agent summary, changelog) that serves as fallback content if the bundle download fails.

### Example Requests

**Typical ClawHub skill (bundle available):**

Runics sends both `bundle_url` and `files`. Circle-IR tries the bundle first. If the bundle download returns 200, Circle-IR ignores `files` and analyzes the extracted bundle. If it returns 404 or fails, Circle-IR falls back to analyzing `files`.

```json
{
  "bundle_url": "https://wry-manatee-359.convex.site/api/v1/download?slug=web-search",
  "files": {
    "DESCRIPTION.md": "Search the web using DuckDuckGo's API with various output formats.",
    "AGENT_INSTRUCTIONS.md": "Use this tool when you need to search the web...",
    "CHANGELOG.md": "Initial release: web search with text, news, images support"
  },
  "skill_context": {
    "name": "web-search",
    "description": "Search the web using DuckDuckGo's API with various output formats.",
    "source_registry": "clawhub",
    "source_url": "https://clawhub.ai/skills/web-search",
    "execution_layer": "worker"
  },
  "options": {
    "enable_sast": true,
    "enable_instruction_analysis": true,
    "enable_capability_mismatch": true,
    "enable_llm_verification": true
  }
}
```

**ClawHub skill (no bundle, `bundle_url` field omitted by Runics):**

```json
{
  "files": {
    "DESCRIPTION.md": "Manage Docker containers and images.",
    "CHANGELOG.md": "v1.2.0: Added Docker Compose support"
  },
  "skill_context": {
    "name": "docker-manager",
    "description": "Manage Docker containers and images.",
    "source_registry": "clawhub",
    "source_url": "https://clawhub.ai/skills/docker-manager",
    "execution_layer": "container"
  },
  "options": { ... }
}
```

---

## Bundle Download Specification

### URL Validation and SSRF Prevention

Circle-IR **must** validate `bundle_url` before making any HTTP request. Use a strict allowlist approach:

**Allowed host:** `wry-manatee-359.convex.site` (HTTPS only)

Validation rules:
1. Parse the URL. If parsing fails, reject and fall back to `files`.
2. Scheme must be `https`.
3. Host must exactly equal `wry-manatee-359.convex.site`.
4. Path must be `/api/v1/download`.
5. Reject any URL that does not match all three conditions above.
6. Do **not** follow redirects to a different host. If the response redirects to a host other than `wry-manatee-359.convex.site`, treat it as a download failure and fall back to `files`.

This prevents SSRF attacks where a malicious actor injects an internal or arbitrary URL as `bundle_url`. If Runics adds additional bundle hosts in the future, we will update this spec and coordinate the allowlist change.

**Implementation suggestion:** A simple function that validates before fetch:

```typescript
const ALLOWED_BUNDLE_HOSTS = ['wry-manatee-359.convex.site'];

function isAllowedBundleUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      ALLOWED_BUNDLE_HOSTS.includes(parsed.hostname) &&
      parsed.pathname === '/api/v1/download'
    );
  } catch {
    return false;
  }
}
```

### URL Format

All bundle URLs will follow this pattern:

```
https://wry-manatee-359.convex.site/api/v1/download?slug=<skill-slug>
```

This is a public endpoint. No authentication required.

### Successful Response (200)

| Header | Value |
|--------|-------|
| `Content-Type` | `application/zip` |
| `Content-Disposition` | `attachment; filename="<slug>-<version>.zip"` |

Typical response size: 5-50KB. Maximum observed: ~100KB.

### Archive Contents

Bundles contain a mix of **instruction documents** and **executable code**:

```
SKILL.md                          # Primary skill instructions (always present, 3-22KB)
_meta.json                        # Metadata: owner, slug, version, publishedAt
guides/setup.md                   # Optional guide documents
guides/advanced.md
HEARTBEAT.md                      # Optional heartbeat/health config
scripts/search.py                 # Executable code — NEEDS SAST
scripts/sequential_think.py       # Executable code — NEEDS SAST
src/index.ts                      # Executable code — NEEDS SAST
config.yaml                       # Configuration files
```

SKILL.md frontmatter often contains additional metadata:

```yaml
---
name: web-search
version: 1.0.0
description: AI-native web search
author: web-search
repository: https://github.com/owner/repo
keywords: [search, web, api]
license: MIT
---
```

### What code files look like in practice

Example: `sequential-thinking/scripts/sequential_think.py` contains:
- API key handling via environment variables
- HTTP requests to external APIs (OpenRouter)
- JSON parsing of untrusted input
- Dynamic code construction

Example: `web-search/scripts/search.py` contains:
- External library imports (`duckduckgo-search`)
- File I/O operations
- User input handling via argparse
- Network requests with configurable timeouts

These are exactly the patterns that SAST should scan for CWEs like command injection (CWE-77/78), hardcoded credentials (CWE-798), SSRF (CWE-918), path traversal (CWE-22), and insecure deserialization (CWE-502).

### Error Cases and What Circle-IR Should Do

| Scenario | HTTP Status | Circle-IR action |
|----------|-------------|------------------|
| Bundle exists | 200 | Extract zip, analyze all files |
| No bundle for this skill | 404 | **Fall back to `files`** if provided in request, otherwise analyze `skill_context` only |
| Rate limited | 429 | Retry with backoff using `ratelimit-reset` header |
| Server error | 5xx | Retry up to 2 times with exponential backoff |
| Download timeout (>15s) | N/A | Treat as failure, **fall back to `files`** |
| Corrupt/invalid zip | N/A | Treat as failure, **fall back to `files`** |
| Empty zip (no files) | N/A | Treat as failure, **fall back to `files`** |
| `bundle_url` is empty string | N/A | Skip bundle download, use `files` directly |
| `bundle_url` is not provided | N/A | Use `files` directly (existing behavior) |

In ALL failure cases, the job should still complete (not fail entirely). The fallback to `files` ensures Circle-IR always has something to analyze. The job response should indicate what happened:

```json
{
  "job_id": "...",
  "status": "completed",
  "metadata": {
    "bundle_download": "failed",
    "bundle_download_status": 404,
    "fallback_used": "inline_files"
  }
}
```

The `metadata` field is optional/informational — Runics won't parse it, but it's useful for debugging.

### Rate Limits

The download endpoint enforces **20 requests per minute** per IP.

Response headers:
```
ratelimit-limit: 20
ratelimit-remaining: <n>
ratelimit-reset: <seconds>
x-ratelimit-limit: 20
x-ratelimit-remaining: <n>
x-ratelimit-reset: <unix-timestamp>
```

Circle-IR should respect `ratelimit-remaining` and wait until `ratelimit-reset` before retrying on 429.

### Download Timeout

Recommended timeout: **15 seconds**. The endpoint typically responds in <1 second.

### Zip Size and File Count Limits

Circle-IR should enforce these hard limits during bundle download and extraction:

| Limit | Value | Rationale |
|-------|-------|-----------|
| **Max download size** | 500 KB | Largest observed bundle is ~100KB. 500KB gives 5x headroom. Reject before reading into memory if `Content-Length` exceeds this. |
| **Max total extracted size** | 400 KB | Sum of all extracted text file contents. Stop extracting when budget is exhausted. |
| **Max individual file size** | 256 KB | Skip any single file larger than this (report as `skip_reason: "too_large"` in `files_detail`). |
| **Max file count** | 50 | Maximum number of files to extract from the zip. Ignore files beyond this count. |

**How these interact with `options.max_files`:**

The `options.max_files` field in the request controls how many files Circle-IR **analyzes** (runs SAST/instruction analysis on), not how many it extracts. The extraction limits above apply first:

1. Extract up to 50 files from the zip, respecting the 400KB total budget and 256KB per-file limit.
2. All extracted files appear in `files_detail` (even if skipped/too_large).
3. If `options.max_files` is set (e.g., `max_files: 20`), Circle-IR analyzes only the first N files (by priority: code files first, then .md, then .json). Files beyond the `max_files` cap still appear in `files_detail` with `status: "skipped"` and `skip_reason: "max_files_exceeded"`.
4. If `options.max_files` is not set, analyze all extracted files.

**Zip bomb protection:**

If the zip decompresses to more than 400KB total or 50 files, stop extraction at the limit. Do not fail the job — analyze what was extracted and report the rest as skipped. This is a safety measure, not an error condition. Add `"extraction_truncated": true` to the job `metadata` if limits were hit.

---

## Expected Circle-IR Behavior

### Step 1: Download and Extract

1. **Validate `bundle_url`** against the SSRF allowlist (see "URL Validation and SSRF Prevention" above). If validation fails → fall back to `files`.
2. Check `Content-Length` header. If >500KB → reject, fall back to `files`.
3. Fetch the zip from `bundle_url` (15s timeout).
4. On failure (network error, non-200, corrupt zip) → fall back to `files` and continue to Step 2.
5. On success → extract files, preserving directory structure. Enforce limits: 50 files max, 400KB total extracted, 256KB per file.
6. **Do NOT pre-filter by known languages.** Every text file should enter the analysis pipeline. If a file's language is unknown or unsupported, it should still be recorded in the metrics (see Step 3). The set of languages in the wild is unpredictable — we need visibility into what's showing up so we can prioritize adding support.
7. Skip only: true binary files, OS metadata (`__MACOSX/`, `.DS_Store`), files >256KB individually (report as `skip_reason: "too_large"`).

### Step 2: Analyze

Run the full analysis pipeline on extracted files, same as a cloned repo. **Attempt analysis on every text file, regardless of whether the language is recognized.**

**SAST (on code files):**
- Scan code files for vulnerability patterns
- Known language targets: `.py`, `.ts`, `.js`, `.sh`, `.go`, `.rs`, `.java`, `.rb`, `.php`
- **Unknown/unsupported languages:** If a file has a text-like extension that Circle-IR doesn't have a SAST analyzer for (e.g., `.lua`, `.zig`, `.nim`, `.r`, `.pl`, custom extensions), do NOT silently skip it. Record it in `files_skipped` with the skip reason (see Step 3). This data is critical for us to know which languages to prioritize next.
- Key CWEs to detect in ClawHub skills:
  - CWE-77/78: Command injection (common in skills that shell out)
  - CWE-798: Hardcoded credentials (API keys in source)
  - CWE-918: SSRF (skills making HTTP requests to user-controlled URLs)
  - CWE-22: Path traversal (skills with file system access)
  - CWE-502: Insecure deserialization (skills parsing JSON/YAML from untrusted input)
  - CWE-312/321: Cleartext storage/transmission of sensitive data
  - CWE-79: XSS (skills generating HTML output)

**Instruction analysis (on .md files):**
- Analyze `SKILL.md` and guide files for prompt injection, unsafe instructions, social engineering, data exfiltration instructions
- SKILL.md is the primary file agents consume — any malicious instructions here directly affect agent behavior

**Capability mismatch:**
- Compare capabilities declared in `skill_context` against what the code actually does
- Example: skill claims "read-only web search" but code writes to filesystem
- **`_meta.json` is a code artifact for this phase.** It contains declared metadata (slug, version, keywords, execution_layer) that serves as capability claims. Compare these claims against actual behavior observed in code files. For example, `_meta.json` might declare `keywords: ["read-only"]` while `scripts/main.py` writes to the filesystem. Include `_meta.json` in `phases_run: ["capability_mismatch"]` when it contributes to the declared-vs-actual comparison.

**LLM verification:**
- Run on flagged findings as usual

### Step 3: Report — Per-File Metrics (Critical)

**This is the most important reporting requirement.** We need per-file detail on what happened during analysis so we can track coverage gaps and improve over time.

Return a `files_detail` array in the job status alongside the existing aggregate metrics:

```json
{
  "metrics": {
    "files_total": 5,
    "files_analyzed": 3,
    "files_failed": 0,
    "files_skipped": 2
  },
  "files_detail": [
    {
      "file": "SKILL.md",
      "size_bytes": 3002,
      "language": "markdown",
      "status": "analyzed",
      "phases_run": ["instruction_safety"]
    },
    {
      "file": "scripts/search.py",
      "size_bytes": 18342,
      "language": "python",
      "status": "analyzed",
      "phases_run": ["sast", "capability_mismatch"]
    },
    {
      "file": "scripts/helper.lua",
      "size_bytes": 4200,
      "language": "unknown",
      "status": "skipped",
      "skip_reason": "unsupported_language",
      "detected_extension": ".lua"
    },
    {
      "file": "_meta.json",
      "size_bytes": 131,
      "language": "json",
      "status": "analyzed",
      "phases_run": ["capability_mismatch"]
    },
    {
      "file": "data/model.bin",
      "size_bytes": 52000,
      "language": null,
      "status": "skipped",
      "skip_reason": "binary_file"
    }
  ]
}
```

**`status` values:**

| Status | Meaning |
|--------|---------|
| `analyzed` | File was processed by at least one analysis phase |
| `skipped` | File was seen but not analyzed (see `skip_reason`) |
| `failed` | Analysis was attempted but errored |

**`skip_reason` values:**

| Reason | Meaning | Why Runics needs this |
|--------|---------|----------------------|
| `unsupported_language` | File extension recognized as code but no analyzer available | Tells us which languages to add support for |
| `unknown_language` | File extension not recognized at all | Tells us about novel file types in the wild |
| `binary_file` | File detected as binary, not text | Expected, just for completeness |
| `too_large` | File exceeds size limit | May indicate we need to adjust limits |
| `parse_error` | File is text but couldn't be parsed | May indicate encoding issues or malformed files |
| `max_files_exceeded` | File was beyond the `options.max_files` analysis cap | Tells us if the cap is too low for some skills |

**`failed` should include error detail:**

```json
{
  "file": "scripts/broken.py",
  "size_bytes": 1200,
  "language": "python",
  "status": "failed",
  "error": "SyntaxError: unexpected token at line 42"
}
```

This per-file reporting lets Runics:
1. Track which languages are showing up across the ClawHub ecosystem
2. Measure what % of skill code is actually being analyzed vs skipped
3. Prioritize which language analyzers to request next
4. Detect trends (e.g., "200 skills have .lua files we're not scanning")
5. Surface per-skill coverage quality to users ("3/5 files analyzed, 2 skipped: unsupported language")

### Aggregate Metrics (existing, keep as-is)

The existing aggregate metrics should still be returned and should be consistent with `files_detail`:

```json
{
  "metrics": {
    "files_total": 5,
    "files_analyzed": 3,
    "files_failed": 0,
    "files_skipped": 2
  }
}
```

Where:
- `files_total` = total files extracted from bundle (excluding binary/OS metadata)
- `files_analyzed` = files where at least one analysis phase completed
- `files_failed` = files where analysis was attempted but errored
- `files_skipped` = files seen but not analyzed (language unsupported, etc.)
- Invariant: `files_total = files_analyzed + files_failed + files_skipped`

### Findings Format (existing, keep as-is)

Findings should reference filenames from inside the archive:

```json
{
  "file": "scripts/search.py",
  "line_start": 42,
  "description": "Potential SSRF: user-controlled URL passed to requests.get()"
}
```

---

## What Runics Will Send

Once Circle-IR supports `bundle_url`, Runics will send requests in these modes:

| Skill Source | Has Bundle? | What Runics sends |
|-------------|-------------|-------------------|
| GitHub | N/A | `repo_url` only |
| ClawHub | Yes (200) | `bundle_url` + `files` (as fallback) |
| ClawHub | No (404) | `files` only (metadata) |
| ClawHub | Unknown | `bundle_url` + `files` (Circle-IR tries bundle, falls back to files) |
| MCP Registry | N/A | `files` only (metadata) |

Runics may or may not probe the bundle URL before sending. If Runics doesn't probe, it sends `bundle_url` unconditionally for all ClawHub skills, and relies on Circle-IR's fallback behavior when the URL returns 404. The `files` field will always be present as fallback content.

---

## Acceptance Criteria

1. `POST /api/analyze/skill` accepts an optional `bundle_url` string field
2. When `bundle_url` is provided (without `repo_url`), Circle-IR downloads the zip, extracts files, and runs the full analysis pipeline
3. **SAST is run on code files** (.py, .ts, .js, .sh, etc.) extracted from the bundle — not just instruction analysis
4. **Instruction analysis is run on .md files** (especially SKILL.md) for prompt injection and unsafe patterns
5. Priority order: `repo_url` > `bundle_url` > `files` > `skill_context` only
6. **Fallback**: if `bundle_url` download fails (404, timeout, corrupt zip, empty string), Circle-IR falls back to `files` if provided — the job should still complete, not fail
7. **Per-file reporting**: every file extracted from the bundle appears in `files_detail` with its `status` (`analyzed`, `skipped`, `failed`), detected `language`, and `skip_reason` or `error` where applicable
8. **No silent skips**: files in unsupported/unknown languages must be reported as `skipped` with `skip_reason: "unsupported_language"` or `"unknown_language"` — never silently dropped
9. Aggregate metrics (`files_total`, `files_analyzed`, `files_skipped`, `files_failed`) are consistent with `files_detail` and satisfy the invariant `total = analyzed + skipped + failed`
10. Findings reference the correct filenames from inside the archive (e.g., `scripts/search.py:42`)
11. Rate limit headers from the download endpoint are respected (20 req/min)
12. All existing response formats (`/status`, `/findings`, `/skill-result`) are unchanged — `files_detail` is an additive field
13. **SSRF prevention**: `bundle_url` is validated against the allowlist (`wry-manatee-359.convex.site`, HTTPS, `/api/v1/download` path) before any HTTP request is made. Non-matching URLs are rejected and Circle-IR falls back to `files`.
14. **Size limits enforced**: Zip download rejected if >500KB. Individual files >256KB skipped. Total extraction stops at 400KB. File count capped at 50. None of these cause job failure — extraction continues with what fits.

---

## Testing Scenarios

Base URL: `https://wry-manatee-359.convex.site/api/v1/download`

### Bundle download scenarios

| Scenario | URL | Expected |
|----------|-----|----------|
| Instructions only (8 files, .md) | `...?slug=ohmyopenclaw` | 200, 19KB zip, SKILL.md + 6 guide .md files |
| Instructions only (2 files, .md) | `...?slug=browser-use` | 200, 22KB zip, large SKILL.md |
| Instructions + heartbeat (3 files) | `...?slug=deepclaw` | 200, 8KB zip, SKILL.md + HEARTBEAT.md |
| **Code + instructions (3 files)** | `...?slug=web-search` | 200, 32KB zip, SKILL.md + `scripts/search.py` (18KB Python) |
| **Code + instructions (3 files)** | `...?slug=sequential-thinking` | 200, 13KB zip, SKILL.md + `scripts/sequential_think.py` (10KB Python with API key handling) |
| No bundle exists | `...?slug=mcp-fetch` | 404 |
| No bundle exists | `...?slug=desktop-commander` | 404 |

### Analysis scenarios to verify

| Scenario | Skill | Expected behavior |
|----------|-------|-------------------|
| Python code with HTTP requests | `sequential-thinking` | SAST should flag hardcoded API patterns, HTTP request handling. `files_detail` shows `search.py` as `analyzed`, language `python`. |
| Python code with web scraping | `web-search` | SAST should analyze external library usage, input handling. `files_detail` shows all files with status. |
| Instruction-only bundle | `browser-use` | Instruction analysis on SKILL.md. `files_detail` shows SKILL.md as `analyzed` with `phases_run: ["instruction_safety"]`. |
| Bundle 404, fallback to files | `mcp-fetch` (with `files` in request) | Should analyze inline `files` content instead. Job completes, not fails. |
| Empty `bundle_url` string | (any, with `bundle_url: ""`) | Should skip bundle download, analyze `files`. |
| Bundle 404, no files provided | `mcp-fetch` (without `files`) | Should analyze `skill_context` metadata only. Job completes with 0 files. |

### Per-file reporting scenarios to verify

| Scenario | Expected `files_detail` behavior |
|----------|----------------------------------|
| Bundle with only `.md` and `.json` | All files `status: "analyzed"`, `language: "markdown"` / `"json"` |
| Bundle with `.py` code | Python files `status: "analyzed"`, `phases_run` includes `"sast"` |
| Bundle with unsupported language (e.g., `.lua`) | File appears with `status: "skipped"`, `skip_reason: "unsupported_language"`, `detected_extension: ".lua"` |
| Bundle with unknown extension (e.g., `.xyz`) | File appears with `status: "skipped"`, `skip_reason: "unknown_language"`, `detected_extension: ".xyz"` |
| Bundle with binary file (e.g., `.bin`) | File appears with `status: "skipped"`, `skip_reason: "binary_file"` |
| Bundle with file that fails parsing | File appears with `status: "failed"`, `error` field describes the failure |
| Aggregate metric invariant | `files_total == files_analyzed + files_skipped + files_failed` holds for every job |
| `max_files` cap exceeded | If `options.max_files: 2` and bundle has 5 text files, only 2 are `analyzed`, rest are `skipped` with `skip_reason: "max_files_exceeded"` |

### SSRF and size limit scenarios to verify

| Scenario | Expected behavior |
|----------|-------------------|
| `bundle_url` pointing to `http://wry-manatee-359.convex.site/...` (HTTP, not HTTPS) | Reject URL, fall back to `files` |
| `bundle_url` pointing to `https://evil.com/malicious.zip` | Reject URL, fall back to `files` |
| `bundle_url` pointing to `https://wry-manatee-359.convex.site/other/path` | Reject URL (wrong path), fall back to `files` |
| `bundle_url` pointing to `https://169.254.169.254/latest/meta-data` | Reject URL, fall back to `files` |
| Zip file with `Content-Length` > 500KB | Reject download before reading body, fall back to `files` |
| Zip that decompresses to > 400KB total | Extract files up to 400KB budget, skip the rest, `metadata.extraction_truncated: true` |
| Zip with > 50 files | Extract first 50 files, skip the rest, `metadata.extraction_truncated: true` |
| Zip containing a single 300KB file (exceeds 256KB per-file limit) | Skip the file with `skip_reason: "too_large"` in `files_detail` |
| Redirect from allowed host to `https://evil.com/payload.zip` | Do not follow cross-host redirect, treat as download failure, fall back to `files` |

---

## Known Issue: SAST Timeouts on JavaScript Files

**Observed:** 2026-03-11 during initial bundle_url testing.

When analyzing the `pets-browser` skill bundle (7 files extracted), 3 of 3 JavaScript files failed SAST with timeouts:

| File | Size | Language | Status | Error |
|------|------|----------|--------|-------|
| `src/index.js` | 96,296 bytes | javascript | failed | "SAST analysis timed out after 180 seconds" |
| `src/petfinder-api.js` | 20,139 bytes | javascript | failed | "SAST analysis timed out after 148 seconds" |
| `src/pet-browser.js` | 11,061 bytes | javascript | failed | "SAST analysis timed out after 155 seconds" |

All `.md` and `_meta.json` files in the same job analyzed successfully. The timeout appears specific to the SAST phase on JavaScript files in the 11-96KB range.

**Impact:** The skill received `scan_coverage: "code-partial"` instead of `"code-full"`, and 5 capability_mismatch findings were surfaced but no SAST findings from the JS code.

**Other skills tested without SAST timeout issues:**
- `command-creator` — markdown-only bundle, SAFE
- `douyin-to-photos` — markdown-only bundle, SAFE
- `anxiety` — markdown-only bundle, SAFE
- `btc-risk-radar` — Python code files analyzed successfully (SAST + capability_mismatch ran on all `.py` files)

**Suggested investigation:** The timeout seems to affect JavaScript specifically. Python files of similar size (in `btc-risk-radar`) completed SAST without issue. This may be a JS parser or taint analysis performance issue.
