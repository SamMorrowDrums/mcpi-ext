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
  /**
   * Browses over all discovery operations.
   *
   * A run that only ever browses is enumerating the catalog one namespace at a
   * time — progressive discovery's shape without its substance. A ratio near 1
   * with few describes is the signature to look for.
   */
  readonly browseRatio: number;
  /** Total discovery operations, across all four verbs. */
  readonly discoveryOps: number;
}

export class DiscoveryTelemetry {
  private browse = 0;
  private list = 0;
  private search = 0;
  private describe = 0;
  private calls = 0;
  private blindCalls = 0;
  /** ref -> the schemaHash that was shown when it was described. */
  private readonly described = new Map<string, string>();

  recordBrowse(): void {
    this.browse += 1;
  }

  recordList(): void {
    this.list += 1;
  }

  recordSearch(): void {
    this.search += 1;
  }

  /**
   * Record a describe, remembering the exact schema the model was shown.
   *
   * The hash is kept so a later call can tell "you have seen this tool" apart
   * from "you have seen *this shape of* this tool" — arguments validated
   * against a schema that has since been replaced were never really checked.
   */
  recordDescribe(
    described: readonly { readonly ref: string; readonly schemaHash: string }[],
  ): void {
    this.describe += 1;
    for (const entry of described) this.described.set(entry.ref, entry.schemaHash);
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

  /** The schema hash this ref was described with, if it ever was. */
  describedSchemaHash(ref: string): string | undefined {
    return this.described.get(ref);
  }

  read(): DiscoveryFunnel {
    const discoveryOps = this.browse + this.list + this.search + this.describe;
    return {
      browse: this.browse,
      list: this.list,
      search: this.search,
      describe: this.describe,
      describedRefs: this.described.size,
      calls: this.calls,
      blindCalls: this.blindCalls,
      blindCallRate: this.calls === 0 ? 0 : this.blindCalls / this.calls,
      browseRatio: discoveryOps === 0 ? 0 : this.browse / discoveryOps,
      discoveryOps,
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
