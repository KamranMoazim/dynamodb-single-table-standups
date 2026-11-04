import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { HttpError, createRouter, type ApiRequest } from '../src/lib/router.js';
import { check, finish } from './helpers.js';

function event(
  method: string,
  path: string,
  options: { body?: string; base64?: boolean; claims?: Record<string, string> } = {},
): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    rawPath: path,
    body: options.body,
    isBase64Encoded: options.base64 ?? false,
    requestContext: {
      http: { method },
      authorizer: options.claims ? { jwt: { claims: options.claims, scopes: [] } } : undefined,
    },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

let seen: ApiRequest | null = null;
const router = createRouter([
  {
    method: 'GET',
    pattern: '/teams/:teamId/feed',
    auth: false,
    handler: async (request) => {
      seen = request;
      return { status: 200, body: { ok: true } };
    },
  },
  {
    method: 'GET',
    pattern: '/private',
    auth: true,
    handler: async () => ({ status: 200, body: {} }),
  },
  {
    method: 'POST',
    pattern: '/echo',
    auth: false,
    handler: async (request) => ({ status: 201, body: request.body }),
  },
  {
    method: 'GET',
    pattern: '/conflict',
    auth: false,
    handler: async () => {
      throw new HttpError(409, 'conflict', 'x');
    },
  },
  {
    method: 'GET',
    pattern: '/boom',
    auth: false,
    handler: async () => {
      throw new Error('boom');
    },
  },
]);
const parse = (result: { body?: string }) => JSON.parse(result.body ?? '{}');

let result = await router(event('GET', '/teams/t1/feed'));
check('matches params', result.statusCode === 200 && seen!.params.teamId === 't1', seen);

result = await router(event('GET', '/teams/t1/feed', { claims: { sub: 'u1', email: 'a@b.c' } }));
check('jwt claims mapped', seen!.userId === 'u1' && seen!.email === 'a@b.c', seen);

result = await router(event('GET', '/private'));
check(
  'auth route without claims',
  result.statusCode === 401 && parse(result).error === 'unauthorized',
  result,
);

result = await router(event('GET', '/nope'));
check('unknown path', result.statusCode === 404 && parse(result).error === 'not_found', result);

result = await router(event('POST', '/teams/t1/feed'));
check(
  'wrong method',
  result.statusCode === 405 && parse(result).error === 'method_not_allowed',
  result,
);

result = await router(event('POST', '/echo', { body: '{' }));
check('invalid json', result.statusCode === 400 && parse(result).error === 'bad_request', result);

result = await router(
  event('POST', '/echo', { body: Buffer.from('{"a":1}').toString('base64'), base64: true }),
);
check('base64 body', result.statusCode === 201 && parse(result).a === 1, result);

result = await router(event('GET', '/conflict'));
check(
  'http error',
  result.statusCode === 409 && parse(result).error === 'conflict' && parse(result).message === 'x',
  result,
);

result = await router(event('GET', '/boom'));
check(
  'unexpected error hidden',
  result.statusCode === 500 && parse(result).error === 'internal' && !result.body!.includes('boom'),
  result,
);

check('json content type', result.headers?.['content-type'] === 'application/json', result.headers);

finish();
