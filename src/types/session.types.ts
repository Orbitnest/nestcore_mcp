export interface McpSession {
  userId: string | null;
  email: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiresAt: Date | null;

  currentProjectId: string | null;
  currentProjectSlug: string | null;

  schemaSnapshot: DatabaseSchema | null;
  projectMetadata: ProjectMetadata | null;

  apiUrl: string;
  safetyEnabled: boolean;
}

export interface DatabaseSchema {
  tables: TableMetadata[];
  functions: FunctionMetadata[];
  policies: PolicyMetadata[];
  lastUpdated: Date;
}

export interface TableMetadata {
  tableName: string;
  schemaName: string;
  columns: ColumnInfo[];
  constraints: ConstraintInfo[];
  indexes: IndexInfo[];
  rlsEnabled: boolean;
  isAuthTable: boolean;
  estimatedRows?: number;
}

export interface ColumnInfo {
  columnName: string;
  dataType: string;
  isNullable: boolean;
  defaultValue: string | null;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  references: { table: string; column: string } | null;
}

export interface ConstraintInfo {
  name: string;
  type: string;
  definition: string;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  isUnique: boolean;
}

export interface FunctionMetadata {
  name: string;
  language: string;
  returnType: string;
  arguments: string;
}

export interface PolicyMetadata {
  policyName: string;
  tableName: string;
  command: string;
  roles: string[];
  using: string | null;
  withCheck: string | null;
}

export interface ProjectMetadata {
  id: string;
  name: string;
  slug: string;
  dbName: string;
  createdAt: string;
  settings?: Record<string, unknown>;
}

/**
 * `.orbitnest/config.json`, shared with the OrbitNest CLI. Canonical shape;
 * CLI <= 0.5 wrote `slug` instead of `projectSlug`, so readers accept both.
 */
export interface WorkspaceConfig {
  projectId: string;
  projectSlug?: string;
  name?: string;
  apiUrl?: string;
}

/** `~/.orbitnest/credentials.json`, shared with the CLI (which also stores `apiUrl`). */
export interface StoredCredentials {
  apiUrl?: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  // Optional: legacy credential files (pre-`user` field) omit this. Readers
  // must tolerate its absence and fall back to the JWT payload.
  user?: {
    id: string;
    email: string;
  };
}
