export const userPk = (userId: string) => `USER#${userId}`;
export const workspacePk = (workspaceId: string) => `WS#${workspaceId}`;
export const invitePk = (code: string) => `INVITE#${code}`;
export const teamPk = (teamId: string) => `TEAM#${teamId}`;
export const memberSk = (userId: string) => `MEMBER#${userId}`;
export const workspaceSk = (workspaceId: string) => `WS#${workspaceId}`;
export const teamSk = (teamId: string) => `TEAM#${teamId}`;
export const reminderSk = (teamId: string, userId: string) => `TEAM#${teamId}#USER#${userId}`;
export const PROFILE_SK = 'PROFILE';
export const META_SK = 'META';
export const dayPrefix = (date: string) => `DAY#${date}#`;
export const checkinSk = (date: string, userId: string) => `DAY#${date}#USER#${userId}`;
export const commentSk = (date: string, userId: string, stamp: string) =>
  `${checkinSk(date, userId)}#C#${stamp}`;
export const reactionSk = (date: string, userId: string, emoji: string, byUserId: string) =>
  `${checkinSk(date, userId)}#R#${emoji}#${byUserId}`;
export const historySk = (date: string, teamId: string) => `DAY#${date}#TEAM#${teamId}`;
export const blockersPk = (teamId: string) => `BLOCKERS#${teamId}`;
export const statsSk = (teamId: string) => `STATS#${teamId}`;
export const DIGEST_PK = 'DIGEST';
