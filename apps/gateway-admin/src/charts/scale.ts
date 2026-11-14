// Axis maths for the charts. Pure functions, covered by unit tests.

/** A y-axis that ends on a round number with 2 to 5 evenly spaced ticks, starting at zero. */
export function niceScale(max: number, opts: { integer?: boolean; target?: number } = {}): { max: number; ticks: number[] } {
  const target = opts.target ?? 4;
  let m = Number.isFinite(max) && max > 0 ? max : 0;
  if (m === 0) m = opts.integer ? 4 : 1;
  const raw = m / target;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const frac = raw / pow;
  let step = (frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 2.5 ? 2.5 : frac <= 5 ? 5 : 10) * pow;
  if (opts.integer) step = Math.max(1, step === 2.5 ? 5 : Math.ceil(step - 1e-9));
  const top = Math.ceil(m / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { max: ticks[ticks.length - 1], ticks };
}

/** Axis label for a count: in full under 10,000, compact above. One style per axis. */
export function axisCount(v: number, axisMax: number): string {
  if (axisMax < 10_000) return Math.round(v * 100) / 100 === Math.round(v) ? Math.round(v).toLocaleString("en-US") : String(Math.round(v * 100) / 100);
  if (axisMax >= 1e6) return `${Math.round((v / 1e6) * 10) / 10}M`;
  return `${Math.round((v / 1e3) * 10) / 10}K`;
}
/** Axis label for milliseconds: "250 ms" or "1.5 s" depending on the axis, never mixed. */
export function axisMs(v: number, axisMax: number): string {
  if (axisMax >= 2000) return `${Math.round((v / 1000) * 100) / 100} s`;
  return `${Math.round(v * 100) / 100} ms`;
}

export type RangeKey = "15m" | "1h" | "6h" | "24h" | "7d" | "30d";
const TICK_SECONDS: Record<RangeKey, [number, number]> = {
  "15m": [300, 300], "1h": [900, 1800], "6h": [3600, 7200], "24h": [14400, 28800], "7d": [86400, 172800], "30d": [432000, 864000],
};

/** Which buckets get an x-axis label: the first bucket of every round local period (hour, day...),
 *  labelled with the round time itself. Works for half-hour time zones, where buckets never start on the hour. */
export function timeTicks(times: number[], range: RangeKey, wide: boolean, label: (ms: number) => string, tzOffsetMin = new Date().getTimezoneOffset()): { i: number; label: string }[] {
  const every = TICK_SECONDS[range][wide ? 0 : 1] * 1000;
  const shift = tzOffsetMin * 60_000;
  const out: { i: number; label: string }[] = [];
  times.forEach((t, i) => {
    const period = Math.floor((t - shift) / every);
    const starts = i === 0 ? (t - shift) % every === 0 : period !== Math.floor((times[i - 1] - shift) / every);
    if (starts) out.push({ i, label: label(period * every + shift) });
  });
  if (out.length >= 2) return out;
  // Too few round times in view: label the first, middle and last bucket instead.
  const n = times.length; if (!n) return [];
  const want = Math.min(n, 3); const res: { i: number; label: string }[] = [];
  for (let k = 0; k < want; k++) { const i = Math.round((k * (n - 1)) / Math.max(1, want - 1)); res.push({ i, label: label(times[i]) }); }
  return res.filter((x, k, a) => k === 0 || x.i !== a[k - 1].i);
}

/** Adds neighbouring buckets together so that columns stay wide enough to read on a narrow screen. */
export function mergeBuckets(values: (number | null)[], k: number): (number | null)[] {
  if (k <= 1) return values;
  const out: (number | null)[] = [];
  for (let i = 0; i < values.length; i += k) {
    let sum = 0; let any = false;
    for (let j = i; j < Math.min(values.length, i + k); j++) { const v = values[j]; if (v != null && Number.isFinite(v)) { sum += v; any = true; } }
    out.push(any ? sum : null);
  }
  return out;
}

/** A rectangle whose top corners are rounded (the data end); the baseline end stays square. */
export function topRoundedRect(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}
