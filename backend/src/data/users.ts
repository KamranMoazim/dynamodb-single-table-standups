import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { META_SK, PROFILE_SK, memberSk, teamPk, userPk, workspacePk } from '../lib/keys.js';
import { HttpError } from '../lib/router.js';
import { TABLE_NAME, documentClient } from '../lib/table.js';
import { reminderSlot } from '../lib/time.js';

export interface Profile {
  name: string;
  timezone: string;
}

export interface UserHome {
  profile: Profile | null;
  workspaces: { workspaceId: string; name: string; role: 'owner' | 'member' }[];
  teams: { teamId: string; workspaceId: string; name: string }[];
}

export async function getUserHome(userId: string): Promise<UserHome> {
  const { Items = [] } = await documentClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': userPk(userId) },
    }),
  );
  const home: UserHome = { profile: null, workspaces: [], teams: [] };
  for (const item of Items) {
    if (item.SK === PROFILE_SK) {
      home.profile = { name: item.name, timezone: item.timezone };
    } else if (item.SK.startsWith('WS#')) {
      home.workspaces.push({ workspaceId: item.workspaceId, name: item.name, role: item.role });
    } else if (item.SK.startsWith('TEAM#')) {
      home.teams.push({ teamId: item.teamId, workspaceId: item.workspaceId, name: item.name });
    }
  }
  return home;
}

export async function getProfile(userId: string): Promise<Profile | null> {
  const { Item } = await documentClient.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: userPk(userId), SK: PROFILE_SK } }),
  );
  return Item ? { name: Item.name, timezone: Item.timezone } : null;
}

export async function requireProfile(userId: string): Promise<Profile> {
  const profile = await getProfile(userId);
  if (!profile) {
    throw new HttpError(409, 'profile_required', 'set your name and timezone first');
  }
  return profile;
}

/*
 * The name and timezone are copied onto every membership item so feeds and the
 * reminder index never need a join. Changing them rewrites those copies.
 */
export async function saveProfile(
  userId: string,
  email: string | null,
  profile: Profile,
): Promise<void> {
  await documentClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: userPk(userId),
        SK: PROFILE_SK,
        userId,
        email,
        ...profile,
        updatedAt: new Date().toISOString(),
      },
    }),
  );
  const home = await getUserHome(userId);
  for (const workspace of home.workspaces) {
    await documentClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: workspacePk(workspace.workspaceId), SK: memberSk(userId) },
        UpdateExpression: 'SET #name = :name',
        ExpressionAttributeNames: { '#name': 'name' },
        ExpressionAttributeValues: { ':name': profile.name },
      }),
    );
  }
  for (const team of home.teams) {
    const { Item: teamItem } = await documentClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: teamPk(team.teamId), SK: META_SK },
        ProjectionExpression: 'reminderTime',
      }),
    );
    if (!teamItem) {
      continue;
    }
    await documentClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: teamPk(team.teamId), SK: memberSk(userId) },
        UpdateExpression: 'SET #name = :name, #timezone = :timezone, GSI3PK = :slot',
        ExpressionAttributeNames: { '#name': 'name', '#timezone': 'timezone' },
        ExpressionAttributeValues: {
          ':name': profile.name,
          ':timezone': profile.timezone,
          ':slot': reminderSlot(profile.timezone, teamItem.reminderTime),
        },
      }),
    );
  }
}
