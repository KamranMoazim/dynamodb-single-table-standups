import type { DigestSummary } from '../email/templates.js';
import { addDays, weekdayOf } from '../lib/time.js';
import { displayedStreak, type Stats } from '../stats/streak.js';

export interface DigestInput {
  team: { teamId: string; name: string; workdays: number[] };
  members: { userId: string; name: string }[];
  dayItems: Record<string, any>[];
  openBlockers: DigestSummary['openBlockers'];
  statsByUser: Map<string, Stats>;
  weekEnd: string;
}

export function digestWeek(today: string): { weekStart: string; weekEnd: string } {
  const weekEnd = addDays(today, -1);
  return { weekStart: addDays(weekEnd, -6), weekEnd };
}

export function buildDigest(input: DigestInput): DigestSummary {
  const weekStart = addDays(input.weekEnd, -6);
  let standupDays = 0;
  for (let offset = 0; offset < 7; offset++) {
    if (input.team.workdays.includes(weekdayOf(addDays(weekStart, offset)))) {
      standupDays++;
    }
  }
  const checkins = input.dayItems.filter((item) => item.SK.split('#').length === 4);
  const posts = new Map<string, number>();
  for (const checkin of checkins) {
    posts.set(checkin.userId, (posts.get(checkin.userId) ?? 0) + 1);
  }
  const today = addDays(input.weekEnd, 1);
  return {
    teamId: input.team.teamId,
    teamName: input.team.name,
    weekStart,
    weekEnd: input.weekEnd,
    standupDays,
    members: input.members
      .map((member) => {
        const stats = input.statsByUser.get(member.userId);
        return {
          name: member.name,
          posts: posts.get(member.userId) ?? 0,
          streak: stats ? displayedStreak(stats, today, input.team.workdays) : 0,
        };
      })
      .sort((first, second) => second.posts - first.posts || first.name.localeCompare(second.name)),
    blockersRaised: checkins.filter((checkin) => checkin.blocker).length,
    blockersResolved: checkins.filter((checkin) => checkin.blocker && checkin.blockerResolvedBy)
      .length,
    openBlockers: input.openBlockers,
  };
}
