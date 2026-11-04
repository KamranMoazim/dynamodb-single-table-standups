const REMINDER_TIME = /^([01]\d|2[0-3]):(00|15|30|45)$/;

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function isValidReminderTime(value: string): boolean {
  return REMINDER_TIME.test(value);
}

export function offsetMinutes(timeZone: string, at: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  const localAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
  );
  const atMinute = Math.floor(at.getTime() / 60_000) * 60_000;
  return Math.round((localAsUtc - atMinute) / 60_000);
}

// Uses the offset at `at`, so a DST change shifts reminders until the slot is recomputed.
export function reminderSlot(timeZone: string, reminderTime: string, at = new Date()): string {
  const [hours, minutes] = reminderTime.split(':').map(Number);
  const utcMinutes = (((hours * 60 + minutes - offsetMinutes(timeZone, at)) % 1440) + 1440) % 1440;
  const slotMinutes = utcMinutes - (utcMinutes % 15);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `REMIND#${pad(Math.floor(slotMinutes / 60))}:${pad(slotMinutes % 60)}`;
}
