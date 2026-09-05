/**
 * Pure scoring functions for Source Radar (epic E1).
 * No I/O here — unit-testable math only.
 * Weights are passed in so they can live in app_setting and be tuned.
 */

export interface Snapshot {
  capturedAt: Date;
  views: number;
}

/** Views per hour between two snapshots (or from publish time). */
export function viewsPerHour(a: Snapshot, b: Snapshot): number {
  const hours = (b.capturedAt.getTime() - a.capturedAt.getTime()) / 3_600_000;
  if (hours <= 0) return 0;
  return (b.views - a.views) / hours;
}

/** Acceleration: change of views/hour between consecutive intervals. */
export function acceleration(s1: Snapshot, s2: Snapshot, s3: Snapshot): number {
  return viewsPerHour(s2, s3) - viewsPerHour(s1, s2);
}

export interface TrendWeights {
  velocity: number;
  acceleration: number;
  baselineRatio: number;
}

/**
 * baselineRatio: current views at time T divided by the channel's
 * median views at the same age T (computed elsewhere from history).
 */
export function trendScore(
  vph: number,
  accel: number,
  baselineRatio: number,
  w: TrendWeights,
): number {
  // log-dampened to avoid mega-channels drowning everything
  const lv = Math.log10(Math.max(vph, 1));
  const la = Math.sign(accel) * Math.log10(Math.abs(accel) + 1);
  return w.velocity * lv + w.acceleration * la + w.baselineRatio * baselineRatio;
}
