import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { isConditionFailure } from '../lib/dynamo-errors.js';
import { newId } from '../lib/ids.js';
import {
  DIGEST_PK,
  META_SK,
  memberSk,
  reminderSk,
  teamPk,
  teamSk,
  userPk,
  workspacePk,
} from '../lib/keys.js';
import { HttpError } from '../lib/router.js';
import { TABLE_NAME, documentClient } from '../lib/table.js';
import { reminderSlot } from '../lib/time.js';
import type { Profile } from './users.js';

export const DEFAULT_QUESTIONS = [
  'What did you do yesterday?',
  'What will you do today?',
  'Any blockers?',
];
export const DEFAULT_WORKDAYS = [1, 2, 3, 4, 5];
export const DEFAULT_REMINDER_TIME = '09:00';

export interface TeamConfig {
  questions: string[];
  workdays: number[];
  reminderTime: string;
}

export interface Team extends TeamConfig {
  teamId: string;
  workspaceId: string;
  name: string;
  createdAt: string;
}

export interface TeamMember {
  userId: string;
  name: string;
  timezone: string;
  joinedAt: string;
}

function toTeam(item: Record<string, any>): Team {
  return {
    teamId: item.teamId,
    workspaceId: item.workspaceId,
    name: item.name,
    questions: item.questions,
    workdays: item.workdays,
    reminderTime: item.reminderTime,
    createdAt: item.createdAt,
  };
}

function memberPut(team: Team, userId: string, profile: Profile) {
  return {
    Put: {
      TableName: TABLE_NAME,
      Item: {
        PK: teamPk(team.teamId),
        SK: memberSk(userId),
        userId,
        name: profile.name,
        timezone: profile.timezone,
        joinedAt: new Date().toISOString(),
        GSI3PK: reminderSlot(profile.timezone, team.reminderTime),
        GSI3SK: reminderSk(team.teamId, userId),
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    },
  };
}

function userTeamPut(team: Team, userId: string) {
  return {
    Put: {
      TableName: TABLE_NAME,
      Item: {
        PK: userPk(userId),
        SK: teamSk(team.teamId),
        teamId: team.teamId,
        workspaceId: team.workspaceId,
        name: team.name,
      },
    },
  };
}

export async function createTeam(
  workspaceId: string,
  name: string,
  userId: string,
  profile: Profile,
): Promise<Team> {
  const team: Team = {
    teamId: newId(),
    workspaceId,
    name,
    questions: DEFAULT_QUESTIONS,
    workdays: DEFAULT_WORKDAYS,
    reminderTime: DEFAULT_REMINDER_TIME,
    createdAt: new Date().toISOString(),
  };
  await documentClient.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: TABLE_NAME,
            Item: {
              PK: teamPk(team.teamId),
              SK: META_SK,
              ...team,
              GSI3PK: DIGEST_PK,
              GSI3SK: teamSk(team.teamId),
            },
          },
        },
        {
          Put: {
            TableName: TABLE_NAME,
            Item: {
              PK: workspacePk(workspaceId),
              SK: teamSk(team.teamId),
              teamId: team.teamId,
              name,
            },
          },
        },
        memberPut(team, userId, profile),
        userTeamPut(team, userId),
      ],
    }),
  );
  return team;
}

export async function getTeam(teamId: string): Promise<Team> {
  const { Item } = await documentClient.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: teamPk(teamId), SK: META_SK } }),
  );
  if (!Item) {
    throw new HttpError(404, 'team_not_found', 'team not found');
  }
  return toTeam(Item);
}

// "MEMBER#..." and "META" sort after every "DAY#..." item, so this skips the feed.
export async function getTeamView(teamId: string): Promise<{ team: Team; members: TeamMember[] }> {
  const { Items = [] } = await documentClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND SK >= :from',
      ExpressionAttributeValues: { ':pk': teamPk(teamId), ':from': 'MEMBER#' },
    }),
  );
  const meta = Items.find((item) => item.SK === META_SK);
  if (!meta) {
    throw new HttpError(404, 'team_not_found', 'team not found');
  }
  const members = Items.filter((item) => item.SK.startsWith('MEMBER#')).map((item) => ({
    userId: item.userId,
    name: item.name,
    timezone: item.timezone,
    joinedAt: item.joinedAt,
  }));
  return { team: toTeam(meta), members };
}

export async function updateTeamConfig(teamId: string, config: TeamConfig): Promise<Team> {
  const { Attributes } = await documentClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: teamPk(teamId), SK: META_SK },
      UpdateExpression:
        'SET questions = :questions, workdays = :workdays, reminderTime = :reminderTime',
      ExpressionAttributeValues: {
        ':questions': config.questions,
        ':workdays': config.workdays,
        ':reminderTime': config.reminderTime,
      },
      ConditionExpression: 'attribute_exists(PK)',
      ReturnValues: 'ALL_NEW',
    }),
  );
  const { members } = await getTeamView(teamId);
  for (const member of members) {
    await documentClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: teamPk(teamId), SK: memberSk(member.userId) },
        UpdateExpression: 'SET GSI3PK = :slot',
        ExpressionAttributeValues: { ':slot': reminderSlot(member.timezone, config.reminderTime) },
      }),
    );
  }
  return toTeam(Attributes!);
}

export async function joinTeam(team: Team, userId: string, profile: Profile): Promise<void> {
  try {
    await documentClient.send(
      new TransactWriteCommand({
        TransactItems: [memberPut(team, userId, profile), userTeamPut(team, userId)],
      }),
    );
  } catch (error) {
    if (isConditionFailure(error)) {
      throw new HttpError(409, 'already_member', 'you are already in this team');
    }
    throw error;
  }
}

export async function removeTeamMember(teamId: string, userId: string): Promise<void> {
  try {
    await documentClient.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: TABLE_NAME,
              Key: { PK: teamPk(teamId), SK: memberSk(userId) },
              ConditionExpression: 'attribute_exists(PK)',
            },
          },
          { Delete: { TableName: TABLE_NAME, Key: { PK: userPk(userId), SK: teamSk(teamId) } } },
        ],
      }),
    );
  } catch (error) {
    if (isConditionFailure(error)) {
      throw new HttpError(404, 'not_a_member', 'that user is not in this team');
    }
    throw error;
  }
}

export async function isTeamMember(teamId: string, userId: string): Promise<boolean> {
  const { Item } = await documentClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: teamPk(teamId), SK: memberSk(userId) },
      ProjectionExpression: 'PK',
    }),
  );
  return Boolean(Item);
}
