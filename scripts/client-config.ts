import { readFileSync, writeFileSync } from 'node:fs';

const outputs = JSON.parse(readFileSync('infra/cdk-outputs.json', 'utf8')).StandupLogStack;
const config = {
  region: outputs.Region,
  apiUrl: outputs.ApiUrl,
  userPoolId: outputs.UserPoolId,
  userPoolClientId: outputs.UserPoolClientId,
};
writeFileSync('client/public/config.json', JSON.stringify(config, null, 2) + '\n');
console.log('wrote client/public/config.json');
