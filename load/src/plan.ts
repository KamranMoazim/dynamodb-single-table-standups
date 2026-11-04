export type ActionName =
  | 'home'
  | 'team'
  | 'feed'
  | 'blockers'
  | 'history'
  | 'today'
  | 'checkin'
  | 'edit'
  | 'comment'
  | 'react'
  | 'resolve';

/*
 * Expected actions per user per workday. People read the feed far more than they
 * post, which is what makes the workload read-heavy. Fractions are probabilities.
 */
export const WORKDAY: Record<ActionName, number> = {
  home: 3,
  team: 2,
  feed: 6,
  blockers: 1,
  history: 0.3,
  today: 1,
  checkin: 1,
  edit: 0.2,
  comment: 0.8,
  react: 1.5,
  resolve: 0.1,
};

export function planWorkday(random: () => number): ActionName[] {
  const actions: ActionName[] = [];
  for (const [name, expected] of Object.entries(WORKDAY) as [ActionName, number][]) {
    const whole = Math.floor(expected);
    const count = whole + (random() < expected - whole ? 1 : 0);
    for (let index = 0; index < count; index++) {
      actions.push(name);
    }
  }
  for (let index = actions.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [actions[index], actions[swap]] = [actions[swap], actions[index]];
  }
  const checkinAt = actions.indexOf('checkin');
  const firstFollowUp = actions.findIndex((action) => action === 'edit');
  if (checkinAt > -1 && firstFollowUp > -1 && firstFollowUp < checkinAt) {
    [actions[checkinAt], actions[firstFollowUp]] = [actions[firstFollowUp], actions[checkinAt]];
  }
  return actions;
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}
