import { WORKDAY, planWorkday, seededRandom } from '../src/plan.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, extra?: unknown): void {
  if (ok) {
    passed++;
  } else {
    failed++;
  }
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(extra)}`);
}

const random = seededRandom(42);
const days = Array.from({ length: 2000 }, () => planWorkday(random));
const average = (name: string) =>
  days.reduce((sum, day) => sum + day.filter((action) => action === name).length, 0) / days.length;

for (const [name, expected] of Object.entries(WORKDAY)) {
  const actual = average(name);
  check(`average ${name} near ${expected}`, Math.abs(actual - expected) < 0.05, actual);
}
check(
  'exactly one check-in per day',
  days.every((day) => day.filter((action) => action === 'checkin').length === 1),
);
check(
  'edits come after the check-in',
  days.every((day) => day.indexOf('edit') === -1 || day.indexOf('edit') > day.indexOf('checkin')),
);
const reads = ['home', 'team', 'feed', 'blockers', 'history', 'today'].reduce(
  (sum, name) => sum + WORKDAY[name as keyof typeof WORKDAY],
  0,
);
const writes = ['checkin', 'edit', 'comment', 'react', 'resolve'].reduce(
  (sum, name) => sum + WORKDAY[name as keyof typeof WORKDAY],
  0,
);
check('read heavy mix', reads / writes > 3, { reads, writes });
check(
  'same seed same plan',
  JSON.stringify(planWorkday(seededRandom(7))) === JSON.stringify(planWorkday(seededRandom(7))),
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
