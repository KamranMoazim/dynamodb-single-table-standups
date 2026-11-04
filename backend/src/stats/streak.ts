import { addDays, weekdayOf } from '../lib/time.js';

export interface Stats {
  total: number;
  currentStreak: number;
  longestStreak: number;
  lastDate: string | null;
  lastWorkday: string | null;
}

export const EMPTY_STATS: Stats = {
  total: 0,
  currentStreak: 0,
  longestStreak: 0,
  lastDate: null,
  lastWorkday: null,
};

export function previousWorkday(date: string, workdays: number[]): string | null {
  for (let back = 1; back <= 7; back++) {
    const candidate = addDays(date, -back);
    if (workdays.includes(weekdayOf(candidate))) {
      return candidate;
    }
  }
  return null;
}

/*
 * A streak counts consecutive team workdays with a check-in; check-ins on other days
 * only add to the total. A date at or before lastDate is a replay or a late backfill
 * and changes nothing, which also makes stream retries safe.
 */
export function nextStats(previous: Stats, date: string, workdays: number[]): Stats | null {
  if (previous.lastDate && date <= previous.lastDate) {
    return null;
  }
  if (!workdays.includes(weekdayOf(date))) {
    return { ...previous, total: previous.total + 1, lastDate: date };
  }
  const continues =
    previous.lastWorkday !== null && previous.lastWorkday === previousWorkday(date, workdays);
  const currentStreak = continues ? previous.currentStreak + 1 : 1;
  return {
    total: previous.total + 1,
    currentStreak,
    longestStreak: Math.max(previous.longestStreak, currentStreak),
    lastDate: date,
    lastWorkday: date,
  };
}

export function displayedStreak(stats: Stats, today: string, workdays: number[]): number {
  if (!stats.lastWorkday) {
    return 0;
  }
  const latestDue = workdays.includes(weekdayOf(today)) ? today : previousWorkday(today, workdays);
  const alive =
    stats.lastWorkday === latestDue ||
    stats.lastWorkday === previousWorkday(latestDue ?? today, workdays);
  return alive ? stats.currentStreak : 0;
}
