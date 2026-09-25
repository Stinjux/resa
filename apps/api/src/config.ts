export interface AppConfig {
  databaseUrl: string;
  host: string;
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    databaseUrl: env.DATABASE_URL ?? 'postgres://resa:resa@localhost:5432/resa_dev',
    host: env.HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? 3000),
  };
}
