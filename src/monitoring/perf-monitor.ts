// ══════════════════════════════════════════════════════════════════════════════
// PerfMonitor — Per-Request Timing & Structured Logging
// ══════════════════════════════════════════════════════════════════════════════
//
// Tracks timing for different stages of request processing.
// Outputs structured logs for Cloudflare Logpush / tail workers.
//
// Usage:
//   const perf = new PerfMonitor();
//   perf.mark('cache_check');
//   // ... do work ...
//   const cacheMs = perf.since('cache_check');
//   perf.mark('vector_search');
//   // ... etc ...
//   console.log(JSON.stringify(perf.toStructuredLog({ query: '...' })));
//
// ══════════════════════════════════════════════════════════════════════════════

export class PerfMonitor {
  private marks: Map<string, number> = new Map();
  private startTime: number;

  constructor() {
    this.startTime = Date.now();
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Mark a Point in Time
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Mark a labeled point in time.
   *
   * @param label - Label for this timing point (e.g., 'cache_check', 'vector_search')
   */
  mark(label: string): void {
    this.marks.set(label, Date.now());
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Measure Time Since Mark
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Get milliseconds since a marked point.
   *
   * @param label - Label to measure from
   * @returns Milliseconds since the mark (or since start if mark not found)
   */
  since(label: string): number {
    const markTime = this.marks.get(label);
    if (markTime === undefined) {
      return Date.now() - this.startTime;
    }
    return Date.now() - markTime;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Get Total Elapsed Time
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Get total elapsed time since monitor creation.
   *
   * @returns Milliseconds since start
   */
  total(): number {
    return Date.now() - this.startTime;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Get Time Between Two Marks
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Get milliseconds between two marks.
   *
   * @param fromLabel - Start mark
   * @param toLabel - End mark
   * @returns Milliseconds between marks (0 if either mark not found)
   */
  between(fromLabel: string, toLabel: string): number {
    const fromTime = this.marks.get(fromLabel);
    const toTime = this.marks.get(toLabel);

    if (fromTime === undefined || toTime === undefined) {
      return 0;
    }

    return toTime - fromTime;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Structured Log Output
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Generate structured log for Cloudflare Logpush.
   *
   * @param extra - Additional fields to include in log
   * @returns Structured log object ready for JSON.stringify()
   */
  toStructuredLog(extra?: Record<string, unknown>): Record<string, unknown> {
    // Convert marks to durations relative to previous mark
    const durations: Record<string, number> = {};
    const markEntries = Array.from(this.marks.entries()).sort((a, b) => a[1] - b[1]);

    let prevTime = this.startTime;
    for (const [label, time] of markEntries) {
      durations[label] = time - prevTime;
      prevTime = time;
    }

    return {
      _type: 'search_perf',
      totalMs: this.total(),
      durations,
      marks: Object.fromEntries(this.marks),
      ...extra,
    };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Convenience: Log to Console
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Log structured output to console.
   *
   * @param extra - Additional fields to include
   */
  log(extra?: Record<string, unknown>): void {
    console.log(JSON.stringify(this.toStructuredLog(extra)));
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Summary Stats
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Get human-readable summary of timings.
   * Useful for debugging and development.
   *
   * @returns Summary string
   */
  summary(): string {
    const lines = [`Total: ${this.total()}ms`];

    const markEntries = Array.from(this.marks.entries()).sort((a, b) => a[1] - b[1]);
    let prevTime = this.startTime;

    for (const [label, time] of markEntries) {
      const duration = time - prevTime;
      lines.push(`  ${label}: ${duration}ms`);
      prevTime = time;
    }

    return lines.join('\n');
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Reset (for reusing monitor across multiple operations)
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Reset all marks and start time.
   * Useful if reusing the same monitor instance.
   */
  reset(): void {
    this.marks.clear();
    this.startTime = Date.now();
  }
}
