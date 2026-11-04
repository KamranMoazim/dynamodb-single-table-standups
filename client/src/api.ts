import { loadConfig } from './config';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function apiCall<T>(
  method: string,
  path: string,
  options: { body?: unknown; token?: string } = {},
): Promise<T> {
  const { apiUrl } = await loadConfig();
  const response = await fetch(apiUrl + path, {
    method,
    headers: {
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(response.status, body.error ?? 'error', body.message ?? response.statusText);
  }
  return body as T;
}

export interface Health {
  ok: boolean;
  table: { name: string; status: string; indexes: string[] };
}
