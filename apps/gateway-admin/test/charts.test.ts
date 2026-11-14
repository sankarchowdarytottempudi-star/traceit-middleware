import { describe, it, expect } from "vitest";
import { niceScale, axisCount, axisMs, timeTicks, mergeBuckets, topRoundedRect } from "../src/charts/scale";
import { fmtMs, fmtPct, fmtInt, fmtCompact, share, plural, statusName, statusClass, txt, num, list, ago } from "../src/lib/text";

describe("niceScale", () => {
  it("ends on a round number at or above the data", () => {
    for (const max of [1, 3, 7, 12, 37, 99, 110, 527, 1234, 98765, 0.4, 2.3]) {
      const s = niceScale(max);
      expect(s.max).toBeGreaterThanOrEqual(max);
      expect(s.max).toBeLessThanOrEqual(max * 2.6);
      expect(s.ticks[0]).toBe(0);
      expect(s.ticks.length).toBeGreaterThanOrEqual(2);
      expect(s.ticks.length).toBeLessThanOrEqual(7);
    }
  });
  it("uses evenly spaced ticks", () => {
    const s = niceScale(527);
    const step = s.ticks[1] - s.ticks[0];
    s.ticks.forEach((t, i) => expect(t).toBeCloseTo(i * step, 6));
  });
  it("keeps whole numbers for counts", () => {
    for (const max of [1, 2, 3, 5, 7, 11]) niceScale(max, { integer: true }).ticks.forEach((t) => expect(Number.isInteger(t)).toBe(true));
  });
  it("still draws an axis when there is no data", () => {
    expect(niceScale(0, { integer: true }).max).toBeGreaterThan(0);
    expect(niceScale(Number.NaN).max).toBeGreaterThan(0);
  });
});

describe("axis labels", () => {
  it("writes small counts in full and large ones compactly", () => {
    expect(axisCount(1500, 2000)).toBe("1,500");
    expect(axisCount(15000, 20000)).toBe("15K");
    expect(axisCount(2500000, 4000000)).toBe("2.5M");
  });
  it("uses one unit for the whole millisecond axis", () => {
    expect(axisMs(250, 500)).toBe("250 ms");
    expect(axisMs(1500, 3000)).toBe("1.5 s");
    expect(axisMs(500, 3000)).toBe("0.5 s");
  });
});

describe("timeTicks", () => {
  const label = (ms: number) => new Date(ms).toISOString().slice(11, 16);
  const hour = 3600_000;
  it("labels round hours for a UTC reader", () => {
    const start = Date.UTC(2026, 10, 14, 9, 0, 0);
    const times = Array.from({ length: 72 }, (_, i) => start + i * 300_000); // 6 hours of 5-minute buckets
    const ticks = timeTicks(times, "6h", true, label, 0);
    expect(ticks.map((t) => t.label)).toEqual(["09:00", "10:00", "11:00", "12:00", "13:00", "14:00"]);
    expect(ticks[1].i).toBe(12);
  });
  it("labels round local times in a half-hour time zone", () => {
    // India is UTC+5:30: getTimezoneOffset() is -330. Hourly buckets start at :30 local time.
    const start = Date.UTC(2026, 10, 8, 0, 0, 0);
    const times = Array.from({ length: 168 }, (_, i) => start + i * hour);
    const ticks = timeTicks(times, "7d", true, (ms) => String(ms), -330);
    expect(ticks.length).toBeGreaterThanOrEqual(6);
    // every label is a local midnight: (ms + 5.5 h) is a whole number of days
    ticks.forEach((t) => expect((Number(t.label) + 330 * 60_000) % (24 * hour)).toBe(0));
  });
  it("uses fewer labels on a narrow chart", () => {
    const start = Date.UTC(2026, 10, 14, 0, 0, 0);
    const times = Array.from({ length: 96 }, (_, i) => start + i * 900_000);
    expect(timeTicks(times, "24h", false, label, 0).length).toBeLessThan(timeTicks(times, "24h", true, label, 0).length);
  });
  it("falls back to first, middle and last when no round time is in view", () => {
    const start = Date.UTC(2026, 10, 14, 9, 1, 0);
    const ticks = timeTicks([start, start + 30_000, start + 60_000, start + 90_000, start + 120_000], "15m", true, label, 0);
    expect(ticks.map((t) => t.i)).toEqual([0, 2, 4]);
    expect(timeTicks([], "1h", true, label, 0)).toEqual([]);
  });
});

describe("mergeBuckets", () => {
  it("adds neighbours together and keeps the total", () => {
    expect(mergeBuckets([1, 2, 3, 4, 5], 2)).toEqual([3, 7, 5]);
    expect(mergeBuckets([1, 2, 3], 1)).toEqual([1, 2, 3]);
  });
  it("keeps a gap when every merged bucket was empty", () => {
    expect(mergeBuckets([null, null, 4, null], 2)).toEqual([null, 4]);
  });
});

describe("topRoundedRect", () => {
  it("never rounds more than the bar allows", () => {
    expect(topRoundedRect(0, 0, 10, 1, 4)).toContain("Q0,0 1,0");
    expect(topRoundedRect(0, 0, 10, 0, 4)).not.toContain("NaN");
  });
});

describe("text helpers", () => {
  it("formats durations for a reader", () => {
    expect(fmtMs(null)).toBe("—");
    expect(fmtMs(0.4)).toBe("<1 ms");
    expect(fmtMs(42.4)).toBe("42 ms");
    expect(fmtMs(1240)).toBe("1.24 s");
  });
  it("formats counts and shares", () => {
    expect(fmtInt(12345.4)).toBe("12,345");
    expect(fmtCompact(1500)).toBe("1,500");
    expect(fmtCompact(12900)).toBe("12.9K");
    expect(share(1, 4)).toBe(25);
    expect(share(1, 0)).toBe(0);
    expect(fmtPct(0)).toBe("0%");
    expect(plural(1, "line")).toBe("1 line");
    expect(plural(2, "line")).toBe("2 lines");
  });
  it("names response codes and groups them into three classes", () => {
    expect(statusName(401)).toBeTruthy();
    expect(statusName(599)).toBe("Server error");
    expect([statusClass(204), statusClass(302), statusClass(404), statusClass(503)]).toEqual(["ok", "ok", "warn", "bad"]);
  });
  it("never renders objects or broken numbers from the backend", () => {
    expect(txt(undefined)).toBe("");
    expect(txt({ a: 1 })).not.toBe("[object Object]");
    expect(num("12")).toBe(12);
    expect(num("x", 7)).toBe(7);
    expect(list({ ok: true })).toEqual([]);
  });
  it("describes how long ago something happened", () => {
    const now = Date.UTC(2026, 10, 14, 12, 0, 0);
    expect(ago(null, now)).toBeTruthy();
    expect(ago(now - 90_000, now)).toMatch(/min/);
  });
});
