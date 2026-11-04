export interface ReminderMessage {
  to: string;
  name: string;
  teamId: string;
  teamName: string;
  date: string;
  questions: string[];
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

export function renderReminder(message: ReminderMessage, siteUrl: string) {
  const link = `${siteUrl}/#/t/${message.teamId}`;
  const subject = `Standup for ${message.teamName} (${message.date})`;
  const text = [
    `Hi ${message.name},`,
    '',
    `Time for your ${message.teamName} standup:`,
    ...message.questions.map((question) => `- ${question}`),
    '',
    `Check in here: ${link}`,
  ].join('\n');
  const html = [
    `<p>Hi ${escapeHtml(message.name)},</p>`,
    `<p>Time for your <strong>${escapeHtml(message.teamName)}</strong> standup:</p>`,
    `<ul>${message.questions.map((question) => `<li>${escapeHtml(question)}</li>`).join('')}</ul>`,
    `<p><a href="${escapeHtml(link)}">Check in</a></p>`,
  ].join('');
  return { subject, text, html };
}
