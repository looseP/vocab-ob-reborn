/**
 * Timezone utilities — matches v1's Asia/Shanghai-based day boundary.
 *
 * v1 uses Intl.DateTimeFormat with DISPLAY_TIMEZONE to compute "today"
 * for streak calculations and session-day cutoffs. v2 must match this
 * to avoid streak regressions for non-UTC users.
 *
 * The DB stores timestamps in UTC (timestamptz). All "day key" comparisons
 * must convert to the display timezone before extracting the date.
 */

/** The timezone used for all user-facing date calculations. */
export const DISPLAY_TIMEZONE = "Asia/Shanghai";

/**
 * Get today's date key (YYYY-MM-DD) in the display timezone.
 * Matches v1's startOfTodayIso().slice(0, 10) behavior.
 */
export function todayKeyInDisplayTz(): string {
  return dayKeyInDisplayTz(new Date());
}

/**
 * Convert a UTC timestamp to a date key in the display timezone.
 * @param iso - ISO 8601 timestamp (UTC) or Date object
 * @returns YYYY-MM-DD in display timezone
 */
export function dayKeyInDisplayTz(iso: string | Date): string {
  const date = typeof iso === "string" ? new Date(iso) : iso;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DISPLAY_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;

  if (!year || !month || !day) {
    // Fallback: use UTC date if Intl fails
    return date.toISOString().slice(0, 10);
  }

  return `${year}-${month}-${day}`;
}

/**
 * Get the UTC ISO timestamp for the start of today in the display timezone.
 * E.g. if today is 2026-07-06 in Shanghai (UTC+8), this returns
 * 2026-07-05T16:00:00.000Z (midnight Shanghai = 16:00 UTC previous day).
 *
 * Matches v1's startOfTodayIso() behavior.
 */
export function startOfTodayIsoInDisplayTz(): string {
  const key = todayKeyInDisplayTz();
  // Shanghai is UTC+8, so midnight Shanghai = 00:00 - 08:00 = previous day 16:00 UTC
  // We reconstruct with +08:00 offset to get the correct UTC instant.
  return new Date(`${key}T00:00:00+08:00`).toISOString();
}
