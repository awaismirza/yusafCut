/**
 * Timecode formatting helpers.
 *
 * Scribe stores everything in seconds internally. These helpers render
 * timecodes for the UI and parse user input.
 */

/** Format seconds → "HH:MM:SS.mmm" (or "MM:SS.mmm" if < 1 hour). */
export function formatTimecode(seconds: number, opts: { ms?: boolean } = {}): string {
  const sign = seconds < 0 ? "-" : "";
  const abs = Math.abs(seconds);
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const s = Math.floor(abs % 60);
  const ms = Math.floor((abs - Math.floor(abs)) * 1000);

  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const msStr = opts.ms === false ? "" : `.${pad(ms, 3)}`;

  if (h > 0) {
    return `${sign}${pad(h)}:${pad(m)}:${pad(s)}${msStr}`;
  }
  return `${sign}${pad(m)}:${pad(s)}${msStr}`;
}

/** Format seconds → short "1m 23s" / "2h 5m" — for human-friendly durations. */
export function formatDuration(seconds: number): string {
  const abs = Math.abs(seconds);
  if (abs < 60) return `${Math.round(abs)}s`;
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const s = Math.floor(abs % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (s === 0) return `${m}m`;
  return `${m}m ${s}s`;
}

/** Parse "MM:SS" / "HH:MM:SS" / "HH:MM:SS.mmm" → seconds. Returns NaN if invalid. */
export function parseTimecode(input: string): number {
  const m = input.trim().match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:\.(\d{1,3}))?$/);
  if (!m) return NaN;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = m[3] !== undefined ? Number(m[3]) : undefined;
  const ms = m[4] !== undefined ? Number(m[4].padEnd(3, "0")) : 0;

  let total: number;
  if (c !== undefined) {
    // HH:MM:SS
    total = a * 3600 + b * 60 + c;
  } else {
    // MM:SS
    total = a * 60 + b;
  }
  return total + ms / 1000;
}
