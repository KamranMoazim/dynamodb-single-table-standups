import { readFileSync, writeFileSync } from 'node:fs';

const outputsUrl = new URL('../cdk-outputs.json', import.meta.url);
const configUrl = new URL('../../client/public/config.json', import.meta.url);

const outputs = JSON.parse(readFileSync(outputsUrl, 'utf8')).StandupLogStack;
const config = {
  region: outputs.Region,
  apiUrl: outputs.ApiUrl,
  userPoolId: outputs.UserPoolId,
  userPoolClientId: outputs.UserPoolClientId,
};
writeFileSync(configUrl, JSON.stringify(config, null, 2) + '\n');
console.log('wrote client/public/config.json');
