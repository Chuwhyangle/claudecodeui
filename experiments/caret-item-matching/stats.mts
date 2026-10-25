/** Percentile summaries shared by the replay and the annotation analysis. */

export type Percentiles = {
  count: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
};

export function percentile(values: readonly number[]): Percentiles {
  if (values.length === 0) {
    return { count: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0 };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  return {
    count: sorted.length,
    p50: at(0.5),
    p90: at(0.9),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1],
  };
}
