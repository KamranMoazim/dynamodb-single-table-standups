import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { planWorkday, seededRandom, type ActionName } from './plan.js';
import {
  apiCall,
  cognitoClient,
  inBatches,
  loadOutputs,
  readState,
  signIn,
  writeState,
  type SimTeam,
  type SimUser,
} from './shared.js';

const { values } = parseArgs({
  options: {
    rps: { type: 'string', default: '6' },
    minutes: { type: 'string', default: '5' },
    inflight: { type: 'string', default: '40' },
    seed: { type: 'string', default: '1' },
  },
});
const RPS = Number(values.rps);
const DURATION_MS = Number(values.minutes) * 60_000;
const MAX_INFLIGHT = Number(values.inflight);
const REACTIONS = ['thumbsup', 'tada', 'eyes', 'heart', 'pray'];
const WORDS =
  'api deploy review tests feed table index query cache bug fix docs design sync ship plan release metrics'.split(
    ' ',
  );

const outputs = loadOutputs();
const state = readState();
if (!state) {
  console.error('no load/state.json: run npm run seed first');
  process.exit(1);
}
const random = seededRandom(Number(values.seed));
const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
const sentence = (words: number) => Array.from({ length: words }, () => pick(WORDS)).join(' ');

const cognito = cognitoClient(outputs);
const tokens = new Map<string, { idToken: string; at: number }>();
async function tokenFor(user: SimUser): Promise<string> {
  const cached = tokens.get(user.userId);
  if (cached && Date.now() - cached.at < 50 * 60_000) {
    return cached.idToken;
  }
  const session = await signIn(cognito, outputs, user);
  user.refreshToken = session.refreshToken;
  tokens.set(user.userId, { idToken: session.idToken, at: Date.now() });
  return session.idToken;
}

const teamsByUser = new Map<string, SimTeam[]>();
for (const team of state.teams) {
  for (const memberId of team.memberIds) {
    teamsByUser.set(memberId, [...(teamsByUser.get(memberId) ?? []), team]);
  }
}
const activeUsers = state.users.filter((user) => teamsByUser.has(user.userId));
const plans = new Map<string, ActionName[]>();
const posted = new Set<string>();
const feedCache = new Map<string, { date: string; userId: string }[]>();
const blockerCache = new Map<string, { date: string; userId: string }[]>();

interface Sample {
  action: string;
  status: number;
  ms: number;
}
const samples: Sample[] = [];

async function perform(
  user: SimUser,
  action: ActionName,
): Promise<{ action: string; status: number }> {
  const token = await tokenFor(user);
  const team = pick(teamsByUser.get(user.userId)!);
  const base = `/teams/${team.teamId}`;
  const postedKey = `${user.userId}|${team.teamId}`;
  const answers = () => [sentence(12), sentence(10), random() < 0.3 ? sentence(6) : ''];
  const call = (method: string, path: string, body?: unknown) =>
    apiCall(outputs, method, path, token, body);

  switch (action) {
    case 'home':
      return { action, status: (await call('GET', '/me')).status };
    case 'team':
      return { action, status: (await call('GET', base)).status };
    case 'feed': {
      const response = await call('GET', `${base}/feed`);
      if (response.status === 200) {
        feedCache.set(
          team.teamId,
          response.body.checkins.map((entry: any) => ({ date: entry.date, userId: entry.userId })),
        );
      }
      return { action, status: response.status };
    }
    case 'blockers': {
      const response = await call('GET', `${base}/blockers`);
      if (response.status === 200) {
        blockerCache.set(
          team.teamId,
          response.body.blockers.map((entry: any) => ({ date: entry.date, userId: entry.userId })),
        );
      }
      return { action, status: response.status };
    }
    case 'history':
      return { action, status: (await call('GET', '/me/checkins')).status };
    case 'today':
      return { action, status: (await call('GET', `${base}/checkins/today`)).status };
    case 'checkin':
    case 'edit': {
      const body = { answers: answers(), blocker: random() < 0.15 ? sentence(5) : null };
      if (posted.has(postedKey)) {
        return {
          action: 'edit',
          status: (await call('PUT', `${base}/checkins/today`, body)).status,
        };
      }
      const response = await call('POST', `${base}/checkins`, body);
      if (response.status === 201 || response.status === 409) {
        posted.add(postedKey);
      }
      return { action: 'checkin', status: response.status };
    }
    case 'comment':
    case 'react': {
      const target = pick(feedCache.get(team.teamId) ?? []);
      if (!target) {
        return perform(user, 'feed');
      }
      const path = `${base}/checkins/${target.date}/${target.userId}`;
      const response =
        action === 'comment'
          ? await call('POST', `${path}/comments`, { text: sentence(8) })
          : await call('PUT', `${path}/reactions/${pick(REACTIONS)}`);
      return { action, status: response.status };
    }
    case 'resolve': {
      const target = pick(blockerCache.get(team.teamId) ?? []);
      if (!target) {
        return perform(user, 'blockers');
      }
      return {
        action,
        status: (await call('POST', `${base}/blockers/${target.date}/${target.userId}/resolve`))
          .status,
      };
    }
  }
}

function nextAction(user: SimUser): ActionName {
  let plan = plans.get(user.userId);
  if (!plan || plan.length === 0) {
    plan = planWorkday(random);
    plans.set(user.userId, plan);
  }
  return plan.shift()!;
}

console.log(`signing in ${activeUsers.length} users...`);
await inBatches(activeUsers, 10, async (user) => {
  await tokenFor(user);
});
writeState(state);

const startedAt = Date.now();
let inflight = 0;
let dropped = 0;
let lastReport = startedAt;
const pending: Promise<void>[] = [];
console.log(`running ${RPS} req/s for ${DURATION_MS / 60_000} min`);

while (Date.now() - startedAt < DURATION_MS) {
  const tickStart = Date.now();
  if (inflight >= MAX_INFLIGHT) {
    dropped++;
  } else {
    const user = pick(activeUsers);
    const action = nextAction(user);
    inflight++;
    const began = performance.now();
    pending.push(
      perform(user, action)
        .then((result) => {
          samples.push({ ...result, ms: performance.now() - began });
        })
        .catch((error: Error) => {
          samples.push({ action, status: 0, ms: performance.now() - began });
          console.error(`${action} threw ${error.name}`);
        })
        .finally(() => {
          inflight--;
        }),
    );
  }
  if (Date.now() - lastReport >= 60_000) {
    lastReport = Date.now();
    const minutes = (lastReport - startedAt) / 60_000;
    console.log(
      `${minutes.toFixed(0)} min: ${samples.length} requests, ${samples.filter((sample) => sample.status >= 500 || sample.status === 0).length} errors`,
    );
  }
  const wait = 1000 / RPS - (Date.now() - tickStart);
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}
await Promise.all(pending);
const endedAt = Date.now();
writeState(state);

const percentile = (values: number[], fraction: number) => {
  const sorted = [...values].sort((first, second) => first - second);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0);
};
const byAction: Record<string, Record<string, number>> = {};
for (const sample of samples) {
  byAction[sample.action] ??= {};
  byAction[sample.action][sample.status] = (byAction[sample.action][sample.status] ?? 0) + 1;
}
const unexpected = samples.filter(
  (sample) =>
    sample.status === 0 || sample.status >= 500 || sample.status === 401 || sample.status === 403,
);
const summary = {
  startedAt: new Date(startedAt).toISOString(),
  endedAt: new Date(endedAt).toISOString(),
  targetRps: RPS,
  actualRps: Number((samples.length / ((endedAt - startedAt) / 1000)).toFixed(2)),
  requests: samples.length,
  dropped,
  unexpected: unexpected.length,
  latencyMs: {
    p50: percentile(
      samples.map((sample) => sample.ms),
      0.5,
    ),
    p95: percentile(
      samples.map((sample) => sample.ms),
      0.95,
    ),
  },
  byAction,
};
mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
const file = new URL(
  `../results/run-${summary.startedAt.replace(/[:.]/g, '-')}.json`,
  import.meta.url,
);
writeFileSync(file, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
process.exit(unexpected.length ? 1 : 0);
