import { App, Tags } from 'aws-cdk-lib';
import { fileURLToPath } from 'node:url';
import { StandupLogStack } from '../lib/standuplog-stack.js';

try {
  process.loadEnvFile('.env');
} catch {
  // Missing .env is reported below.
}
const alertEmail = process.env.ALERT_EMAIL;
if (!alertEmail) {
  throw new Error('Set ALERT_EMAIL in infra/.env (see infra/.env.example)');
}

const senderEmail = process.env.SENDER_EMAIL;
if (!senderEmail) {
  throw new Error('Set SENDER_EMAIL in infra/.env to an address on an SES-verified domain');
}

const app = new App();
Tags.of(app).add('project', 'standuplog');
new StandupLogStack(app, 'StandupLogStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
  alertEmail,
  senderEmail,
  clientDistPath: fileURLToPath(new URL('../../client/dist', import.meta.url)),
});
