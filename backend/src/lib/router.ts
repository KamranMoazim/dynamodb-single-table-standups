import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface ApiRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  userId: string | null;
  email: string | null;
}

export interface ApiResult {
  status: number;
  body: unknown;
}

export type RouteHandler = (request: ApiRequest) => Promise<ApiResult>;

export interface Route {
  method: string;
  pattern: string;
  handler: RouteHandler;
  auth: boolean;
}

export function requireString(body: unknown, field: string, max = 200): string {
  const value = (body as Record<string, unknown> | undefined)?.[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, 'bad_request', `${field} is required`);
  }
  if (value.length > max) {
    throw new HttpError(400, 'bad_request', `${field} is too long`);
  }
  return value.trim();
}

function matchPattern(pattern: string, path: string): Record<string, string> | null {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = path.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) {
    return null;
  }
  const params: Record<string, string> = {};
  for (let index = 0; index < patternParts.length; index++) {
    const patternPart = patternParts[index];
    const pathPart = decodeURIComponent(pathParts[index]);
    if (patternPart.startsWith(':')) {
      params[patternPart.slice(1)] = pathPart;
    } else if (patternPart !== pathPart) {
      return null;
    }
  }
  return params;
}

function parseBody(event: APIGatewayProxyEventV2WithJWTAuthorizer): unknown {
  if (!event.body) {
    return undefined;
  }
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'bad_request', 'body is not valid JSON');
  }
}

function respond(status: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export function createRouter(routes: Route[]) {
  return async (
    event: APIGatewayProxyEventV2WithJWTAuthorizer,
  ): Promise<APIGatewayProxyStructuredResultV2> => {
    const method = event.requestContext.http.method;
    const path = event.rawPath;
    try {
      const candidates = routes
        .map((route) => ({ route, params: matchPattern(route.pattern, path) }))
        .filter((candidate) => candidate.params !== null);
      if (candidates.length === 0) {
        throw new HttpError(404, 'not_found', `no route for ${path}`);
      }
      const matched = candidates.find((candidate) => candidate.route.method === method);
      if (!matched) {
        throw new HttpError(405, 'method_not_allowed', `${method} not allowed on ${path}`);
      }
      const claims = event.requestContext.authorizer?.jwt?.claims ?? {};
      const userId = typeof claims.sub === 'string' ? claims.sub : null;
      const email = typeof claims.email === 'string' ? claims.email : null;
      if (matched.route.auth && !userId) {
        throw new HttpError(401, 'unauthorized', 'sign in required');
      }
      const result = await matched.route.handler({
        method,
        path,
        params: matched.params!,
        query: (event.queryStringParameters ?? {}) as Record<string, string>,
        body: parseBody(event),
        userId,
        email,
      });
      return respond(result.status, result.body);
    } catch (error) {
      if (error instanceof HttpError) {
        return respond(error.status, { error: error.code, message: error.message, ...error.extra });
      }
      console.error(`${method} ${path} failed: ${(error as Error).message}`);
      return respond(500, { error: 'internal', message: 'internal error' });
    }
  };
}
