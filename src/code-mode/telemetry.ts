/**
 * Discovery funnel counters.
 *
 * Exists so the progressive-discovery claim is measurable rather than asserted.
 * `blindCallRate` is the one that matters: a model that calls tools it never
 * described is not discovering progressively, it is guessing, and a design that
 * only *looks* progressive would otherwise pass unnoticed.
 *
 * Counters are incremented host-side, never from inside the sandbox, so a
 * compromised or merely creative script cannot forge its own metrics.
 */
export interface DiscoveryFunnel {
  readonly browse: number;
  readonly list: number;
  readonly search: number;
  readonly describe: number;
  readonly describedRefs: number;
  readonly calls: number;
  readonly blindCalls: number;
  /** Calls to tools never described in this session, over total calls. */
  readonly blindCallRate: number;
}

export class DiscoveryTelemetry {
  private browse = 0;
  private list = 0;
  private search = 0;
  private describe = 0;
  private calls = 0;
  private blindCalls = 0;
  private readonly described = new Set<string>();

  recordBrowse(): void {
    this.browse += 1;
  }

  recordList(): void {
    this.list += 1;
  }

  recordSearch(): void {
    this.search += 1;
  }

  /** Record a describe and remember which refs it licensed. */
  recordDescribe(refs: readonly string[]): void {
    this.describe += 1;
    for (const ref of refs) this.described.add(ref);
  }

  /** Record a dispatch, and whether it was preceded by a describe of that ref. */
  recordCall(ref: string): void {
    this.calls += 1;
    if (!this.described.has(ref)) this.blindCalls += 1;
  }

  /** Whether this ref has been described, and so may be called informed. */
  hasDescribed(ref: string): boolean {
    return this.described.has(ref);
  }

  read(): DiscoveryFunnel {
    return {
      browse: this.browse,
      list: this.list,
      search: this.search,
      describe: this.describe,
      describedRefs: this.described.size,
      calls: this.calls,
      blindCalls: this.blindCalls,
      blindCallRate: this.calls === 0 ? 0 : this.blindCalls / this.calls,
    };
  }

  reset(): void {
    this.browse = 0;
    this.list = 0;
    this.search = 0;
    this.describe = 0;
    this.calls = 0;
    this.blindCalls = 0;
    this.described.clear();
  }
}
