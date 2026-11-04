export interface AppConfig {
  region: string;
  apiUrl: string;
  userPoolId: string;
  userPoolClientId: string;
}

let cached: Promise<AppConfig> | null = null;

export function loadConfig(): Promise<AppConfig> {
  if (!cached) {
    cached = fetch('/config.json').then((response) => {
      if (!response.ok) {
        throw new Error('config.json missing: deploy infra or run npm run client:config');
      }
      return response.json() as Promise<AppConfig>;
    });
  }
  return cached;
}
