import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { isConditionFailure } from '../lib/dynamo-errors.js';
import { newId } from '../lib/ids.js';
import {
  blockersPk,
  checkinSk,
  commentSk,
  dayPrefix,
  historySk,
  reactionSk,
  teamPk,
  userPk,
} from '../lib/keys.js';
import { HttpError } from '../lib/router.js';
import { TABLE_NAME, documentClient } from '../lib/table.js';

export const REACTIONS = ['thumbsup', 'tada', 'eyes', 'heart', 'pray'];

export interface CheckinInput {
  answers: string[];
  blocker: string | null;
}

export interface Checkin extends CheckinInput {
  teamId: string;
  userId: string;
  date: string;
  authorName: string;
  createdAt: string;
  updatedAt: string;
  blockerResolvedBy?: string;
  blockerResolvedAt?: string;
}

export interface Comment {
  commentId: string;
  byUserId: string;
  byName: string;
  text: string;
  createdAt: string;
}

export interface FeedEntry extends Checkin {
  comments: Comment[];
  reactions: Record<string, { userId: string; name: string }[]>;
}

function toCheckin(item: Record<string, any>): Checkin {
  return {
    teamId: item.teamId,
    userId: item.userId,
    date: item.date,
    authorName: item.authorName,
    answers: item.answers,
    blocker: item.blocker ?? null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(item.blockerResolvedBy
      ? { blockerResolvedBy: item.blockerResolvedBy, blockerResolvedAt: item.blockerResolvedAt }
      : {}),
  };
}

const blockerIndex = (teamId: string, date: string, userId: string) => ({
  GSI2PK: blockersPk(teamId),
  GSI2SK: checkinSk(date, userId),
});

export async function createCheckin(
  teamId: string,
  date: string,
  userId: string,
  authorName: string,
  input: CheckinInput,
): Promise<Checkin> {
  const now = new Date().toISOString();
  const checkin: Checkin = {
    teamId,
    userId,
    date,
    authorName,
    ...input,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await documentClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: teamPk(teamId),
          SK: checkinSk(date, userId),
          ...checkin,
          blocker: input.blocker ?? undefined,
          GSI1PK: userPk(userId),
          GSI1SK: historySk(date, teamId),
          ...(input.blocker ? blockerIndex(teamId, date, userId) : {}),
        },
        ConditionExpression: 'attribute_not_exists(SK)',
      }),
    );
  } catch (error) {
    if (isConditionFailure(error)) {
      throw new HttpError(
        409,
        'already_submitted',
        'you already checked in today; edit it instead',
      );
    }
    throw error;
  }
  return checkin;
}

export async function updateCheckin(
  teamId: string,
  date: string,
  userId: string,
  input: CheckinInput,
): Promise<Checkin> {
  const values: Record<string, unknown> = {
    ':answers': input.answers,
    ':updatedAt': new Date().toISOString(),
  };
  let expression = 'SET answers = :answers, updatedAt = :updatedAt';
  if (input.blocker) {
    Object.assign(values, {
      ':blocker': input.blocker,
      ':gsi2pk': blockersPk(teamId),
      ':gsi2sk': checkinSk(date, userId),
    });
    expression +=
      ', blocker = :blocker, GSI2PK = :gsi2pk, GSI2SK = :gsi2sk REMOVE blockerResolvedBy, blockerResolvedAt';
  } else {
    expression += ' REMOVE blocker, GSI2PK, GSI2SK, blockerResolvedBy, blockerResolvedAt';
  }
  try {
    const { Attributes } = await documentClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: teamPk(teamId), SK: checkinSk(date, userId) },
        UpdateExpression: expression,
        ExpressionAttributeValues: values,
        ConditionExpression: 'attribute_exists(SK)',
        ReturnValues: 'ALL_NEW',
      }),
    );
    return toCheckin(Attributes!);
  } catch (error) {
    if (isConditionFailure(error)) {
      throw new HttpError(404, 'checkin_not_found', 'no check-in for today yet');
    }
    throw error;
  }
}

export async function getCheckin(
  teamId: string,
  date: string,
  userId: string,
  consistent = false,
): Promise<Checkin | null> {
  const { Item } = await documentClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: teamPk(teamId), SK: checkinSk(date, userId) },
      ConsistentRead: consistent,
    }),
  );
  return Item ? toCheckin(Item) : null;
}

export async function requireCheckin(
  teamId: string,
  date: string,
  userId: string,
): Promise<Checkin> {
  const checkin = await getCheckin(teamId, date, userId);
  if (!checkin) {
    throw new HttpError(404, 'checkin_not_found', 'check-in not found');
  }
  return checkin;
}

export async function addComment(
  teamId: string,
  date: string,
  authorId: string,
  byUserId: string,
  byName: string,
  text: string,
): Promise<Comment> {
  const createdAt = new Date().toISOString();
  const commentId = `${createdAt}#${newId()}`;
  const comment: Comment = { commentId, byUserId, byName, text, createdAt };
  await documentClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: teamPk(teamId),
        SK: commentSk(date, authorId, commentId),
        kind: 'comment',
        ...comment,
      },
    }),
  );
  return comment;
}

export async function setReaction(
  teamId: string,
  date: string,
  authorId: string,
  emoji: string,
  byUserId: string,
  byName: string,
  on: boolean,
): Promise<void> {
  const key = { PK: teamPk(teamId), SK: reactionSk(date, authorId, emoji, byUserId) };
  if (on) {
    await documentClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: { ...key, kind: 'reaction', emoji, byUserId, byName },
      }),
    );
  } else {
    await documentClient.send(new DeleteCommand({ TableName: TABLE_NAME, Key: key }));
  }
}

export async function getFeed(teamId: string, date: string): Promise<FeedEntry[]> {
  const items: Record<string, any>[] = [];
  let startKey: Record<string, any> | undefined;
  do {
    const page = await documentClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: { ':pk': teamPk(teamId), ':prefix': dayPrefix(date) },
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...(page.Items ?? []));
    startKey = page.LastEvaluatedKey;
  } while (startKey);

  const entries = new Map<string, FeedEntry>();
  for (const item of items) {
    const [, , , authorId, kind] = item.SK.split('#');
    if (!kind) {
      entries.set(authorId, { ...toCheckin(item), comments: [], reactions: {} });
      continue;
    }
    const entry = entries.get(authorId);
    if (!entry) {
      continue;
    }
    if (kind === 'C') {
      entry.comments.push({
        commentId: item.commentId,
        byUserId: item.byUserId,
        byName: item.byName,
        text: item.text,
        createdAt: item.createdAt,
      });
    } else if (kind === 'R') {
      (entry.reactions[item.emoji] ??= []).push({ userId: item.byUserId, name: item.byName });
    }
  }
  return [...entries.values()].sort((first, second) =>
    first.createdAt.localeCompare(second.createdAt),
  );
}

export type HistoryEntry = Pick<
  Checkin,
  'teamId' | 'userId' | 'date' | 'authorName' | 'answers' | 'blocker'
>;

export async function getHistory(
  userId: string,
  cursor: string | undefined,
  limit = 20,
): Promise<{ checkins: HistoryEntry[]; nextCursor: string | null }> {
  let startKey: Record<string, any> | undefined;
  if (cursor) {
    try {
      startKey = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    } catch {
      throw new HttpError(400, 'bad_request', 'invalid cursor');
    }
    if (startKey?.GSI1PK !== userPk(userId)) {
      throw new HttpError(400, 'bad_request', 'invalid cursor');
    }
  }
  const { Items = [], LastEvaluatedKey } = await documentClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': userPk(userId) },
      ScanIndexForward: false,
      Limit: limit,
      ExclusiveStartKey: startKey,
    }),
  );
  return {
    checkins: Items.map((item) => ({
      teamId: item.teamId,
      userId: item.userId,
      date: item.date,
      authorName: item.authorName,
      answers: item.answers,
      blocker: item.blocker ?? null,
    })),
    nextCursor: LastEvaluatedKey
      ? Buffer.from(JSON.stringify(LastEvaluatedKey)).toString('base64url')
      : null,
  };
}

export async function getOpenBlockers(
  teamId: string,
): Promise<Pick<Checkin, 'userId' | 'date' | 'authorName' | 'blocker'>[]> {
  const { Items = [] } = await documentClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :pk',
      ExpressionAttributeValues: { ':pk': blockersPk(teamId) },
      ScanIndexForward: false,
    }),
  );
  return Items.map((item) => ({
    userId: item.userId,
    date: item.date,
    authorName: item.authorName,
    blocker: item.blocker,
  }));
}

export async function resolveBlocker(
  teamId: string,
  date: string,
  authorId: string,
  resolvedBy: string,
): Promise<void> {
  try {
    await documentClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: teamPk(teamId), SK: checkinSk(date, authorId) },
        UpdateExpression:
          'SET blockerResolvedBy = :by, blockerResolvedAt = :at REMOVE GSI2PK, GSI2SK',
        ExpressionAttributeValues: { ':by': resolvedBy, ':at': new Date().toISOString() },
        ConditionExpression: 'attribute_exists(GSI2PK)',
      }),
    );
  } catch (error) {
    if (isConditionFailure(error)) {
      throw new HttpError(409, 'not_open', 'no open blocker on that check-in');
    }
    throw error;
  }
}
