import { localDate, reminderSlot, weekdayOf } from '../lib/time.js';

export interface ReminderInput {
  slot: string;
  now: Date;
  workdays: number[];
  reminderTime: string;
  timezone: string;
  email: string | null;
  hasCheckin: (date: string) => boolean;
}

export interface ReminderDecision {
  send: boolean;
  reason: 'due' | 'not_workday' | 'checked_in' | 'no_email';
  date: string;
  correctSlot: string;
}

/*
 * A member is found by the slot stored on their item. After a DST change the stored
 * slot is an hour off; the reminder still goes out once (an hour early or late) and
 * correctSlot lets the caller move the item so later days are on time.
 */
export function planReminder(input: ReminderInput): ReminderDecision {
  const date = localDate(input.timezone, input.now);
  const correctSlot = reminderSlot(input.timezone, input.reminderTime, input.now);
  const decide = (send: boolean, reason: ReminderDecision['reason']) => ({
    send,
    reason,
    date,
    correctSlot,
  });
  if (!input.workdays.includes(weekdayOf(date))) {
    return decide(false, 'not_workday');
  }
  if (input.hasCheckin(date)) {
    return decide(false, 'checked_in');
  }
  if (!input.email) {
    return decide(false, 'no_email');
  }
  return decide(true, 'due');
}
