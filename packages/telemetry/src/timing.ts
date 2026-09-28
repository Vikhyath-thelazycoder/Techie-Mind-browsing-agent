/** Monotonic latency measurement for the stage budget of spec §81 / master plan §43. */
export interface Span {
  readonly name: string;
  end(): number;
}

export function startSpan(name: string, clock: () => number = () => performance.now()): Span {
  const start = clock();
  let ended: number | null = null;
  return {
    name,
    end() {
      ended ??= clock() - start;
      return ended;
    },
  };
}

/** Nearest-rank percentile over recorded samples (P50/P95/P99 reporting). */
export function percentile(samples: readonly number[], p: number): number | null {
  if (samples.length === 0) return null;
  if (p < 0 || p > 100) throw new RangeError('percentile must be within [0, 100]');
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? null;
}
