import { buildDigest, digestWeek } from '../src/digest/summary.js';
import { renderDigest } from '../src/email/templates.js';
import {
  EMPTY_STATS,
  displayedStreak,
  nextStats,
  previousWorkday,
  type Stats,
} from '../src/stats/streak.js';
import { check, finish } from './helpers.js';

const WEEKDAYS = [1, 2, 3, 4, 5];
const apply = (dates: string[], workdays = WEEKDAYS) =>
  dates.reduce<Stats>((stats, date) => nextStats(stats, date, workdays) ?? stats, EMPTY_STATS);

check('previous workday skips weekend', previousWorkday('2026-11-09', WEEKDAYS) === '2026-11-06');
check('previous workday mid week', previousWorkday('2026-11-04', WEEKDAYS) === '2026-11-03');
check('previous workday with no workdays', previousWorkday('2026-11-04', []) === null);

let stats = apply(['2026-11-02']);
check(
  'first check-in starts a streak',
  stats.total === 1 && stats.currentStreak === 1 && stats.longestStreak === 1,
  stats,
);

stats = apply(['2026-11-05', '2026-11-06', '2026-11-09']);
check('streak carries over the weekend', stats.currentStreak === 3, stats);

stats = apply(['2026-11-02', '2026-11-03', '2026-11-05']);
check(
  'missed workday resets streak',
  stats.currentStreak === 1 && stats.longestStreak === 2 && stats.total === 3,
  stats,
);

stats = apply(['2026-11-06', '2026-11-07', '2026-11-09']);
check(
  'weekend check-in counts but keeps streak',
  stats.total === 3 && stats.currentStreak === 2,
  stats,
);

stats = apply(['2026-11-04', '2026-11-07', '2026-11-09']);
check('weekend check-in does not bridge a missed Friday', stats.currentStreak === 1, stats);

stats = apply(['2026-11-02', '2026-11-04'], [1, 3, 5]);
check('team workdays define the streak', stats.currentStreak === 2, stats);

const replay = nextStats(apply(['2026-11-04']), '2026-11-04', WEEKDAYS);
check('replayed check-in is ignored', replay === null);
check(
  'late backfill is ignored',
  nextStats(apply(['2026-11-04']), '2026-11-02', WEEKDAYS) === null,
);

const thursday = apply(['2026-11-04', '2026-11-05']);
check(
  'displayed streak alive on the same day',
  displayedStreak(thursday, '2026-11-05', WEEKDAYS) === 2,
);
check(
  'displayed streak alive before posting today',
  displayedStreak(thursday, '2026-11-06', WEEKDAYS) === 2,
);
check(
  'displayed streak broken after a missed day',
  displayedStreak(thursday, '2026-11-09', WEEKDAYS) === 0,
);
const friday = apply(['2026-11-05', '2026-11-06']);
check(
  'displayed streak alive over the weekend',
  displayedStreak(friday, '2026-11-08', WEEKDAYS) === 2 &&
    displayedStreak(friday, '2026-11-09', WEEKDAYS) === 2,
);

const week = digestWeek('2026-11-09');
check(
  'digest covers the previous 7 days',
  week.weekStart === '2026-11-02' && week.weekEnd === '2026-11-08',
  week,
);

const checkin = (userId: string, date: string, extra: Record<string, unknown> = {}) => ({
  SK: `DAY#${date}#USER#${userId}`,
  userId,
  date,
  ...extra,
});
const summary = buildDigest({
  team: { teamId: 't1', name: 'Core', workdays: WEEKDAYS },
  members: [
    { userId: 'a', name: 'Ana' },
    { userId: 'b', name: 'Ben' },
    { userId: 'c', name: 'Cy' },
  ],
  dayItems: [
    checkin('a', '2026-11-02'),
    checkin('a', '2026-11-03', { blocker: 'API down', blockerResolvedBy: 'b' }),
    { SK: 'DAY#2026-11-03#USER#a#C#2026-11-03T10:00:00Z#x', text: 'comment' },
    { SK: 'DAY#2026-11-03#USER#a#R#tada#b', emoji: 'tada' },
    checkin('b', '2026-11-04', { blocker: 'Waiting on QA' }),
  ],
  openBlockers: [{ authorName: 'Ben', blocker: 'Waiting on QA', date: '2026-11-04' }],
  statsByUser: new Map([['a', apply(['2026-11-05', '2026-11-06'])]]),
  weekEnd: '2026-11-08',
});
check(
  'digest counts check-ins, not comments or reactions',
  summary.standupDays === 5 &&
    summary.members.map((member) => `${member.name}:${member.posts}:${member.streak}`).join(',') ===
      'Ana:2:2,Ben:1:0,Cy:0:0',
  summary,
);
check(
  'digest blocker counts',
  summary.blockersRaised === 2 &&
    summary.blockersResolved === 1 &&
    summary.openBlockers.length === 1,
  summary,
);

const email = renderDigest(
  { ...summary, kind: 'digest', to: 'a@example.com', name: 'Ana' },
  'https://site.example',
);
check(
  'digest email',
  email.subject === 'Core weekly digest (2026-11-02 to 2026-11-08)' &&
    email.text.includes('Ana: 2 of 5 days, streak 2') &&
    email.text.includes('Ben (2026-11-04): Waiting on QA') &&
    email.html.includes('https://site.example/#/t/t1'),
  email.text,
);

finish();
