export interface AppConfig {
  apiUrl: string;
  apiBasePath: string;
  serverName: string;
  serverVersion: string;
  logLevel: string;
  defaultProjectId: string | null;
  enableSqlGuard: boolean;
  blockAuthTableMutations: boolean;
  schemaCacheTtl: number;
  tokenRefreshThreshold: number;
}
