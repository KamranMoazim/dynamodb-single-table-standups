export interface ReminderMessage {
  kind: 'reminder';
  to: string;
  name: string;
  teamId: string;
  teamName: string;
  date: string;
  questions: string[];
}

export interface DigestSummary {
  teamId: string;
  teamName: string;
  weekStart: string;
  weekEnd: string;
  standupDays: number;
  members: { name: string; posts: number; streak: number }[];
  blockersRaised: number;
  blockersResolved: number;
  openBlockers: { authorName: string; blocker: string; date: string }[];
}

export interface DigestMessage extends DigestSummary {
  kind: 'digest';
  to: string;
  name: string;
}

export type EmailMessage = ReminderMessage | DigestMessage;

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

const teamLink = (siteUrl: string, teamId: string) => `${siteUrl}/#/t/${teamId}`;

export function renderReminder(message: ReminderMessage, siteUrl: string): RenderedEmail {
  const link = teamLink(siteUrl, message.teamId);
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

export function renderDigest(message: DigestMessage, siteUrl: string): RenderedEmail {
  const link = teamLink(siteUrl, message.teamId);
  const subject = `${message.teamName} weekly digest (${message.weekStart} to ${message.weekEnd})`;
  const memberLine = (member: DigestSummary['members'][number]) =>
    `${member.name}: ${member.posts} of ${message.standupDays} days, streak ${member.streak}`;
  const blockerLine = (blocker: DigestSummary['openBlockers'][number]) =>
    `${blocker.authorName} (${blocker.date}): ${blocker.blocker}`;
  const text = [
    `Hi ${message.name},`,
    '',
    `Here is ${message.teamName}'s week, ${message.weekStart} to ${message.weekEnd}.`,
    '',
    'Check-ins:',
    ...message.members.map((member) => `- ${memberLine(member)}`),
    '',
    `Blockers raised: ${message.blockersRaised}, resolved: ${message.blockersResolved}`,
    ...(message.openBlockers.length
      ? ['Still open:', ...message.openBlockers.map((blocker) => `- ${blockerLine(blocker)}`)]
      : ['No open blockers.']),
    '',
    `Team page: ${link}`,
  ].join('\n');
  const list = (lines: string[]) =>
    `<ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`;
  const html = [
    `<p>Hi ${escapeHtml(message.name)},</p>`,
    `<p>Here is <strong>${escapeHtml(message.teamName)}</strong>'s week, ${message.weekStart} to ${message.weekEnd}.</p>`,
    '<h3>Check-ins</h3>',
    list(message.members.map(memberLine)),
    `<p>Blockers raised: ${message.blockersRaised}, resolved: ${message.blockersResolved}</p>`,
    message.openBlockers.length
      ? `<h3>Still open</h3>${list(message.openBlockers.map(blockerLine))}`
      : '<p>No open blockers.</p>',
    `<p><a href="${escapeHtml(link)}">Open the team page</a></p>`,
  ].join('');
  return { subject, text, html };
}

export function renderEmail(message: EmailMessage, siteUrl: string): RenderedEmail {
  return message.kind === 'digest'
    ? renderDigest(message, siteUrl)
    : renderReminder(message, siteUrl);
}
