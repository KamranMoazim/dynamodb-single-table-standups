import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { getOpenBlockers } from '../data/checkins.js';
import { getEmails, getTeamStats } from '../data/stats.js';
import { getTeamView } from '../data/teams.js';
import type { DigestMessage } from '../email/templates.js';
import { DIGEST_PK, teamPk } from '../lib/keys.js';
import { TABLE_NAME, documentClient } from '../lib/table.js';
import { buildDigest, digestWeek } from './summary.js';

const sqs = new SQSClient({});
const QUEUE_URL = process.env.QUEUE_URL!;

async function allTeamIds(): Promise<string[]> {
  const teamIds: string[] = [];
  let startKey: Record<string, any> | undefined;
  do {
    const page = await documentClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI3',
        KeyConditionExpression: 'GSI3PK = :pk',
        ExpressionAttributeValues: { ':pk': DIGEST_PK },
        ExclusiveStartKey: startKey,
      }),
    );
    teamIds.push(...(page.Items ?? []).map((item) => item.PK.slice('TEAM#'.length)));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return teamIds;
}

async function weekItems(
  teamId: string,
  weekStart: string,
  weekEnd: string,
): Promise<Record<string, any>[]> {
  const items: Record<string, any>[] = [];
  let startKey: Record<string, any> | undefined;
  do {
    const page = await documentClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :from AND :to',
        ExpressionAttributeValues: {
          ':pk': teamPk(teamId),
          ':from': `DAY#${weekStart}`,
          ':to': `DAY#${weekEnd}#~`,
        },
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...(page.Items ?? []));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return items;
}

export interface DigestResult {
  weekStart: string;
  weekEnd: string;
  teams: number;
  skippedQuiet: number;
  queued: number;
}

export async function handler(event: {
  scheduledTime?: string;
  teamIds?: string[];
}): Promise<DigestResult> {
  const today = (event.scheduledTime ? new Date(event.scheduledTime) : new Date())
    .toISOString()
    .slice(0, 10);
  const { weekStart, weekEnd } = digestWeek(today);
  const teamIds = event.teamIds ?? (await allTeamIds());
  const result: DigestResult = {
    weekStart,
    weekEnd,
    teams: teamIds.length,
    skippedQuiet: 0,
    queued: 0,
  };

  for (const teamId of teamIds) {
    const { team, members } = await getTeamView(teamId);
    const userIds = members.map((member) => member.userId);
    const [dayItems, openBlockers, statsByUser, emails] = await Promise.all([
      weekItems(teamId, weekStart, weekEnd),
      getOpenBlockers(teamId),
      getTeamStats(teamId, userIds),
      getEmails(userIds),
    ]);
    const summary = buildDigest({
      team: { teamId, name: team.name, workdays: team.workdays },
      members,
      dayItems,
      openBlockers: openBlockers.map(({ authorName, blocker, date }) => ({
        authorName,
        blocker: blocker ?? '',
        date,
      })),
      statsByUser,
      weekEnd,
    });
    if (
      summary.members.every((member) => member.posts === 0) &&
      summary.openBlockers.length === 0
    ) {
      result.skippedQuiet++;
      continue;
    }
    const messages: DigestMessage[] = members
      .filter((member) => emails.has(member.userId))
      .map((member) => ({
        ...summary,
        kind: 'digest',
        to: emails.get(member.userId)!,
        name: member.name,
      }));
    for (let start = 0; start < messages.length; start += 10) {
      const response = await sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: QUEUE_URL,
          Entries: messages.slice(start, start + 10).map((message, index) => ({
            Id: String(index),
            MessageBody: JSON.stringify(message),
          })),
        }),
      );
      result.queued += response.Successful?.length ?? 0;
    }
  }
  console.log(JSON.stringify(result));
  return result;
}
