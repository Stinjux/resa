import { existsSync } from 'node:fs';

export interface AppConfig {
  databaseUrl: string;
  host: string;
  port: number;
}

/** Charge apps/api/.env s'il existe (les variables déjà définies priment). */
function loadDotEnv(): void {
  const file = new URL('../.env', import.meta.url);
  if (existsSync(file)) process.loadEnvFile(file);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (env === process.env) loadDotEnv();
  return {
    databaseUrl: env.DATABASE_URL ?? 'postgres://resa:resa@localhost:5432/resa_dev',
    host: env.HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? 3000),
  };
}
