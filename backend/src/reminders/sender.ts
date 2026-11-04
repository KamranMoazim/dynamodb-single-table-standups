import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { renderReminder, type ReminderMessage } from './message.js';

const ses = new SESv2Client({});
const SENDER_EMAIL = process.env.SENDER_EMAIL!;
const SITE_URL = process.env.SITE_URL!;

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: SQSBatchResponse['batchItemFailures'] = [];
  for (const record of event.Records) {
    const message = JSON.parse(record.body) as ReminderMessage;
    const email = renderReminder(message, SITE_URL);
    try {
      await ses.send(
        new SendEmailCommand({
          FromEmailAddress: SENDER_EMAIL,
          Destination: { ToAddresses: [message.to] },
          Content: {
            Simple: {
              Subject: { Data: email.subject },
              Body: { Text: { Data: email.text }, Html: { Data: email.html } },
            },
          },
        }),
      );
      console.log(`sent reminder team=${message.teamId} date=${message.date}`);
    } catch (error) {
      console.error(`reminder failed team=${message.teamId}: ${(error as Error).name}`);
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}
