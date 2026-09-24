/**
 * Usage counts.
 *
 * Answers "is anyone actually using this?" and nothing more: per day, how many
 * shares were created and how many recipients connected to one. Two numbers.
 *
 * Deliberately blunt, in the same spirit as crawlers.ts:
 *
 * - The record functions take no arguments, so there is nothing to attach to
 *   a count - no address, no slug, no file name or size - and nothing can be
 *   passed in by accident later.
 * - Nothing is logged when an event happens. A day's totals are written once,
 *   after the day is over, so the log's timestamps say nothing about when
 *   anyone used it and cannot be lined up against a proxy's access log.
 * - Only finished days are exposed in /healthz, for the same reason: a live
 *   counter polled every second would give away the timing of each share.
 *
 * Days are UTC. The counts live in memory; the daily log line is the record.
 */

interface DayCounts {
  date: string;
  shares: number;
  receives: number;
}

/** How many finished days /healthz reports. */
const KEEP_DAYS = 30;

const today = (): string => new Date().toISOString().slice(0, 10);

let current: DayCounts = { date: today(), shares: 0, receives: 0 };
const finished: DayCounts[] = [];

function logDay(day: DayCounts, note = ''): void {
  console.log(`[usage] ${day.date}: ${day.shares} shares, ${day.receives} receives${note}`);
}

/** Closes the current day if the date has moved on since it started. */
function rollOver(): void {
  const now = today();
  if (current.date === now) return;
  logDay(current);
  finished.unshift(current);
  if (finished.length > KEEP_DAYS) finished.length = KEEP_DAYS;
  current = { date: now, shares: 0, receives: 0 };
}

/** A sender created a share. */
export function recordShare(): void {
  rollOver();
  current.shares += 1;
}

/** A recipient opened a share link and was connected to the sender. */
export function recordReceive(): void {
  rollOver();
  current.receives += 1;
}

/** Finished days only, newest first. */
export function usageSummary(): DayCounts[] {
  rollOver();
  return finished.map((d) => ({ ...d }));
}

/**
 * Writes today's partial totals, so a restart does not silently lose them.
 * Marked as partial so the numbers are not mistaken for a whole day.
 */
export function flushUsage(): void {
  if (current.shares > 0 || current.receives > 0) logDay(current, ' (partial, until restart)');
}

// A quiet day has no events to trigger the roll-over, so check hourly as well.
setInterval(rollOver, 60 * 60_000).unref();
