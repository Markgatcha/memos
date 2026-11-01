/**
 * Resampling statistics for MemOS benchmarks.
 *
 * A benchmark number without an interval is an opinion. The concrete failure
 * this module exists to prevent: a LongMemEval run scored 92% on 25 questions
 * and that figure ended up in a results file that looks exactly like a
 * full-run result. Twenty-five samples of a Bernoulli variable carry roughly a
 * ±10pp interval — wider than most of the differences between competing memory
 * systems. Bootstrap the same data and the illusion disappears.
 *
 * All resampling is seeded and therefore reproducible: the same scores always
 * yield the same interval.
 */

/** Deterministic PRNG (mulberry32). Same seed ⇒ same interval, every run. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function (): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Interval {
  /** Point estimate (mean of `values`). */
  point: number;
  low: number;
  high: number;
  n: number;
  iterations: number;
  alpha: number;
}

export interface BootstrapOptions {
  iterations?: number;
  seed?: number;
  /** Confidence level; 0.05 ⇒ 95% interval. */
  alpha?: number;
}

/**
 * Percentile bootstrap CI for the mean of `values`.
 *
 * Degenerate inputs are handled explicitly rather than throwing, because a
 * benchmark reporting loop should print a wide interval, not crash halfway
 * through a two-hour run.
 */
export function bootstrapMeanCI(
  values: number[],
  opts: BootstrapOptions = {},
): Interval {
  const iterations = opts.iterations ?? 1000;
  const seed = opts.seed ?? 0;
  const alpha = opts.alpha ?? 0.05;
  const n = values.length;

  if (n === 0) {
    return { point: 0, low: 0, high: 0, n: 0, iterations, alpha };
  }
  if (n === 1) {
    return {
      point: values[0] ?? 0,
      low: values[0] ?? 0,
      high: values[0] ?? 0,
      n: 1,
      iterations,
      alpha,
    };
  }

  const rand = mulberry32(seed);
  const means = new Float64Array(iterations);
  let total = 0;
  for (const v of values) total += v;
  const point = total / n;

  for (let b = 0; b < iterations; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += values[Math.floor(rand() * n)] ?? 0;
    }
    means[b] = sum / n;
  }

  const sorted = Array.from(means).sort((a, b) => a - b);
  const lo = sorted[Math.floor((alpha / 2) * iterations)] ?? point;
  const hi = sorted[Math.floor((1 - alpha / 2) * iterations)] ?? point;

  return { point, low: lo, high: hi, n, iterations, alpha };
}

/** Convenience wrapper for 0/1 accuracy arrays. */
export function bootstrapAccuracyCI(
  scores: number[],
  opts: BootstrapOptions = {},
): Interval {
  return bootstrapMeanCI(scores, opts);
}

/**
 * Two-sided bootstrap test for paired differences.
 *
 * Use this to compare two arms of the SAME benchmark run (e.g. hybrid vs
 * memories-only) where each question produces a score in both arms. Pairing
 * removes question-difficulty variance, which is the dominant noise term.
 *
 * `a` and `b` must be the same length and aligned by question.
 */
export function pairedBootstrapDiff(
  a: number[],
  b: number[],
  opts: BootstrapOptions = {},
): {
  meanDiff: number;
  interval: Interval;
  /** Fraction of resamples where the difference is <= 0 (one-sided p). */
  pValueOneSided: number;
  significant: boolean;
} {
  const iterations = opts.iterations ?? 1000;
  const seed = opts.seed ?? 0;
  const alpha = opts.alpha ?? 0.05;
  const n = Math.min(a.length, b.length);

  if (n === 0) {
    return {
      meanDiff: 0,
      interval: { point: 0, low: 0, high: 0, n: 0, iterations, alpha },
      pValueOneSided: 1,
      significant: false,
    };
  }

  const diffs: number[] = [];
  for (let i = 0; i < n; i++) diffs.push((a[i] ?? 0) - (b[i] ?? 0));

  const rand = mulberry32(seed);
  let observed = 0;
  for (const d of diffs) observed += d;
  const meanDiff = observed / n;

  const resampled = new Float64Array(iterations);
  let leZero = 0;
  for (let b = 0; b < iterations; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += diffs[Math.floor(rand() * n)] ?? 0;
    const m = sum / n;
    resampled[b] = m;
    if (m <= 0) leZero++;
  }

  const sorted = Array.from(resampled).sort((x, y) => x - y);
  const pValueOneSided = leZero / iterations;

  return {
    meanDiff,
    interval: {
      point: meanDiff,
      low: sorted[Math.floor((alpha / 2) * iterations)] ?? meanDiff,
      high: sorted[Math.floor((1 - alpha / 2) * iterations)] ?? meanDiff,
      n,
      iterations,
      alpha,
    },
    pValueOneSided,
    significant: pValueOneSided < alpha,
  };
}

/** Format an interval as "83.2% [80.1–86.0]" (percentages). */
export function formatIntervalPct(iv: Interval): string {
  const p = (x: number): string => (x * 100).toFixed(1);
  return `${p(iv.point)}% [${p(iv.low)}–${p(iv.high)}]`;
}

/**
 * Minimum sample size for a headline claim. Below this the interval is wider
 * than the effects being argued about, so the report must say so out loud.
 */
export const MIN_HEADLINE_N = 100;

export function sampleSizeWarning(n: number): string | null {
  if (n >= MIN_HEADLINE_N) return null;
  const approx = (1.96 * Math.sqrt(0.25 / Math.max(n, 1)) * 100).toFixed(1);
  return (
    `n=${n} is below the ${MIN_HEADLINE_N}-question headline threshold; ` +
    `the approximate 95% interval half-width is ±${approx}pp. Do not publish ` +
    `this as a headline score.`
  );
}
