import { HttpError } from '../src/lib/router.js';
import { renderReminder } from '../src/reminders/message.js';
import { planReminder } from '../src/reminders/plan.js';
import { parseCheckin } from '../src/routes/checkins.js';
import {
  isValidDate,
  isValidReminderTime,
  isValidTimeZone,
  localDate,
  reminderSlot,
  slotAt,
  weekdayOf,
} from '../src/lib/time.js';
import { parseTeamConfig } from '../src/routes/teams.js';
import { check, finish } from './helpers.js';

const winter = new Date('2026-01-15T12:00:00Z');
const summer = new Date('2026-07-15T12:00:00Z');

check('utc slot', reminderSlot('UTC', '09:00', winter) === 'REMIND#09:00');
check('new york winter', reminderSlot('America/New_York', '09:00', winter) === 'REMIND#14:00');
check('new york summer', reminderSlot('America/New_York', '09:00', summer) === 'REMIND#13:00');
check('karachi', reminderSlot('Asia/Karachi', '09:00', winter) === 'REMIND#04:00');
check('kolkata half hour', reminderSlot('Asia/Kolkata', '09:00', winter) === 'REMIND#03:30');
check('kathmandu quarter hour', reminderSlot('Asia/Kathmandu', '09:00', winter) === 'REMIND#03:15');
check(
  'auckland wraps to previous day',
  reminderSlot('Pacific/Auckland', '09:00', winter) === 'REMIND#20:00',
);
check(
  'los angeles wraps to next day',
  reminderSlot('America/Los_Angeles', '20:00', winter) === 'REMIND#04:00',
);
check('invalid zone', !isValidTimeZone('Mars/Base') && isValidTimeZone('Europe/Berlin'));
check(
  'reminder time on 15 minutes',
  isValidReminderTime('23:45') &&
    !isValidReminderTime('09:10') &&
    !isValidReminderTime('24:00') &&
    !isValidReminderTime('9:00'),
);

const valid = { questions: [' A ', 'B', 'C'], workdays: [5, 1, 3], reminderTime: '08:30' };
const rejects = (name: string, body: unknown) => {
  try {
    parseTeamConfig(body);
    check(name, false, 'accepted');
  } catch (error) {
    check(name, error instanceof HttpError && error.status === 400, error);
  }
};
const parsed = parseTeamConfig(valid);
check(
  'config trims and sorts',
  JSON.stringify(parsed) ===
    JSON.stringify({ questions: ['A', 'B', 'C'], workdays: [1, 3, 5], reminderTime: '08:30' }),
  parsed,
);
rejects('config needs 3 questions', { ...valid, questions: ['A', 'B'] });
rejects('config rejects blank question', { ...valid, questions: ['A', ' ', 'C'] });
rejects('config rejects long question', { ...valid, questions: ['A', 'B', 'x'.repeat(201)] });
rejects('config rejects day 7', { ...valid, workdays: [7] });
rejects('config rejects duplicate days', { ...valid, workdays: [1, 1] });
rejects('config rejects no days', { ...valid, workdays: [] });
rejects('config rejects odd time', { ...valid, reminderTime: '08:20' });
rejects('config rejects missing body', undefined);

const lateUtc = new Date('2026-11-04T22:30:00Z');
check('local date ahead of utc', localDate('Asia/Karachi', lateUtc) === '2026-11-05');
check(
  'local date behind utc',
  localDate('America/Los_Angeles', new Date('2026-11-05T03:00:00Z')) === '2026-11-04',
);
check('weekday of date', weekdayOf('2026-11-04') === 3 && weekdayOf('2026-11-08') === 0);
check(
  'valid date',
  isValidDate('2026-02-28') &&
    !isValidDate('2026-02-30') &&
    !isValidDate('2026-13-01') &&
    !isValidDate('2026-00-10') &&
    !isValidDate('2026-2-3') &&
    !isValidDate('x'),
);

const checkinRejects = (name: string, body: unknown) => {
  try {
    parseCheckin(body);
    check(name, false, 'accepted');
  } catch (error) {
    check(name, error instanceof HttpError && error.status === 400, error);
  }
};
const checkin = parseCheckin({ answers: [' did x ', '', 'none'], blocker: '  ' });
check(
  'checkin trims, blank blocker is null',
  JSON.stringify(checkin) === JSON.stringify({ answers: ['did x', '', 'none'], blocker: null }),
  checkin,
);
check(
  'checkin keeps blocker',
  parseCheckin({ answers: ['a', 'b', 'c'], blocker: ' waiting on API ' }).blocker ===
    'waiting on API',
);
checkinRejects('checkin needs 3 answers', { answers: ['a', 'b'] });
checkinRejects('checkin rejects all blank', { answers: [' ', '', ''] });
checkinRejects('checkin caps answer length', { answers: ['x'.repeat(1001), 'b', 'c'] });
checkinRejects('checkin caps blocker length', {
  answers: ['a', 'b', 'c'],
  blocker: 'x'.repeat(501),
});
checkinRejects('checkin rejects non-string blocker', { answers: ['a', 'b', 'c'], blocker: 5 });

check(
  'slot floors to 15 minutes',
  slotAt(new Date('2026-11-04T10:44:59Z')) === 'REMIND#10:30' &&
    slotAt(new Date('2026-11-04T10:45:00Z')) === 'REMIND#10:45',
);

const wednesday = new Date('2026-11-04T04:00:00Z');
const base = {
  slot: 'REMIND#04:00',
  now: wednesday,
  workdays: [1, 2, 3, 4, 5],
  reminderTime: '09:00',
  timezone: 'Asia/Karachi',
  email: 'a@example.com',
  hasCheckin: () => false,
};
let decision = planReminder(base);
check(
  'reminder due',
  decision.send &&
    decision.reason === 'due' &&
    decision.date === '2026-11-04' &&
    decision.correctSlot === 'REMIND#04:00',
  decision,
);
decision = planReminder({ ...base, workdays: [1, 2, 4, 5] });
check('no reminder on non workday', !decision.send && decision.reason === 'not_workday', decision);
decision = planReminder({ ...base, hasCheckin: (date) => date === '2026-11-04' });
check('no reminder after check-in', !decision.send && decision.reason === 'checked_in', decision);
decision = planReminder({ ...base, email: null });
check('no reminder without email', !decision.send && decision.reason === 'no_email', decision);
decision = planReminder({
  ...base,
  timezone: 'Pacific/Auckland',
  reminderTime: '08:00',
  workdays: [4],
  now: new Date('2026-11-04T19:00:00Z'),
  slot: 'REMIND#19:00',
});
check(
  'uses the member local date and weekday',
  decision.send && decision.date === '2026-11-05',
  decision,
);
decision = planReminder({
  ...base,
  timezone: 'America/New_York',
  now: new Date('2026-11-04T13:00:00Z'),
  slot: 'REMIND#13:00',
});
check(
  'stale slot after DST still sends and reports the fix',
  decision.send && decision.correctSlot === 'REMIND#14:00',
  decision,
);

const rendered = renderReminder(
  {
    to: 'a@example.com',
    name: '<Ana>',
    teamId: 't1',
    teamName: 'Core & Ops',
    date: '2026-11-04',
    questions: ['Q1?', 'Q2?', 'Q3?'],
  },
  'https://site.example',
);
check(
  'reminder email escapes html and links the team',
  rendered.subject === 'Standup for Core & Ops (2026-11-04)' &&
    rendered.html.includes('&#60;Ana&#62;') &&
    rendered.html.includes('Core &#38; Ops') &&
    rendered.text.includes('https://site.example/#/t/t1'),
  rendered,
);

finish();
