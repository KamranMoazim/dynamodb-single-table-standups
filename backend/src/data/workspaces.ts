import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { isConditionFailure } from '../lib/dynamo-errors.js';
import { newId, newInviteCode } from '../lib/ids.js';
import { META_SK, invitePk, memberSk, userPk, workspacePk, workspaceSk } from '../lib/keys.js';
import { HttpError } from '../lib/router.js';
import { TABLE_NAME, documentClient } from '../lib/table.js';
import type { Profile } from './users.js';

export type Role = 'owner' | 'member';

export interface Workspace {
  workspaceId: string;
  name: string;
  inviteCode: string;
  ownerId: string;
  createdAt: string;
}

export interface WorkspaceView {
  workspace: Workspace;
  members: { userId: string; name: string; role: Role; joinedAt: string }[];
  teams: { teamId: string; name: string }[];
}

export async function createWorkspace(
  userId: string,
  profile: Profile,
  name: string,
): Promise<Workspace> {
  const workspace: Workspace = {
    workspaceId: newId(),
    name,
    inviteCode: newInviteCode(),
    ownerId: userId,
    createdAt: new Date().toISOString(),
  };
  const workspaceKey = workspacePk(workspace.workspaceId);
  await documentClient.send(
    new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: TABLE_NAME, Item: { PK: workspaceKey, SK: META_SK, ...workspace } } },
        {
          Put: {
            TableName: TABLE_NAME,
            Item: {
              PK: workspaceKey,
              SK: memberSk(userId),
              userId,
              name: profile.name,
              role: 'owner',
              joinedAt: workspace.createdAt,
            },
          },
        },
        {
          Put: {
            TableName: TABLE_NAME,
            Item: {
              PK: userPk(userId),
              SK: workspaceSk(workspace.workspaceId),
              workspaceId: workspace.workspaceId,
              name,
              role: 'owner',
            },
          },
        },
        {
          Put: {
            TableName: TABLE_NAME,
            Item: {
              PK: invitePk(workspace.inviteCode),
              SK: META_SK,
              workspaceId: workspace.workspaceId,
            },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
      ],
    }),
  );
  return workspace;
}

export async function getWorkspaceView(
  workspaceId: string,
  userId: string,
): Promise<WorkspaceView> {
  const { Items = [] } = await documentClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': workspacePk(workspaceId) },
    }),
  );
  const meta = Items.find((item) => item.SK === META_SK);
  const members = Items.filter((item) => item.SK.startsWith('MEMBER#')).map((item) => ({
    userId: item.userId,
    name: item.name,
    role: item.role as Role,
    joinedAt: item.joinedAt,
  }));
  if (!meta || !members.some((member) => member.userId === userId)) {
    throw new HttpError(404, 'workspace_not_found', 'workspace not found');
  }
  return {
    workspace: {
      workspaceId: meta.workspaceId,
      name: meta.name,
      inviteCode: meta.inviteCode,
      ownerId: meta.ownerId,
      createdAt: meta.createdAt,
    },
    members,
    teams: Items.filter((item) => item.SK.startsWith('TEAM#')).map((item) => ({
      teamId: item.teamId,
      name: item.name,
    })),
  };
}

export async function getWorkspaceRole(workspaceId: string, userId: string): Promise<Role | null> {
  const { Item } = await documentClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: workspacePk(workspaceId), SK: memberSk(userId) },
      ProjectionExpression: '#role',
      ExpressionAttributeNames: { '#role': 'role' },
    }),
  );
  return (Item?.role as Role | undefined) ?? null;
}

export async function requireWorkspaceRole(
  workspaceId: string,
  userId: string,
  needed?: Role,
): Promise<Role> {
  const role = await getWorkspaceRole(workspaceId, userId);
  if (!role) {
    throw new HttpError(404, 'workspace_not_found', 'workspace not found');
  }
  if (needed === 'owner' && role !== 'owner') {
    throw new HttpError(403, 'forbidden', 'only the workspace owner can do this');
  }
  return role;
}

export async function joinByInvite(
  code: string,
  userId: string,
  profile: Profile,
): Promise<Workspace> {
  const { Item: invite } = await documentClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: invitePk(code.toUpperCase()), SK: META_SK },
    }),
  );
  if (!invite) {
    throw new HttpError(404, 'invite_not_found', 'invite code not found');
  }
  const { Item: meta } = await documentClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: workspacePk(invite.workspaceId), SK: META_SK },
    }),
  );
  if (!meta) {
    throw new HttpError(404, 'invite_not_found', 'invite code not found');
  }
  try {
    await documentClient.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: TABLE_NAME,
              Item: {
                PK: workspacePk(meta.workspaceId),
                SK: memberSk(userId),
                userId,
                name: profile.name,
                role: 'member',
                joinedAt: new Date().toISOString(),
              },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Put: {
              TableName: TABLE_NAME,
              Item: {
                PK: userPk(userId),
                SK: workspaceSk(meta.workspaceId),
                workspaceId: meta.workspaceId,
                name: meta.name,
                role: 'member',
              },
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (isConditionFailure(error)) {
      throw new HttpError(409, 'already_member', 'you are already in this workspace');
    }
    throw error;
  }
  return {
    workspaceId: meta.workspaceId,
    name: meta.name,
    inviteCode: meta.inviteCode,
    ownerId: meta.ownerId,
    createdAt: meta.createdAt,
  };
}
