import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SessionService } from '../auth/session.service.js';
import { NestCoreClient } from '../sdk/nestcore.client.js';
import { SchemaService } from '../context/schema.service.js';
import { WorkspaceService } from '../context/workspace.service.js';
import { ProjectService } from '../context/project.service.js';
import { SessionTracker } from '../context/session-tracker.js';
import type { AppConfig } from '../types/config.types.js';

export interface ToolContext {
  session: SessionService;
  apiClient: NestCoreClient;
  schemaService: SchemaService;
  workspaceService: WorkspaceService;
  projectService: ProjectService;
  config: AppConfig;
  tracker: SessionTracker;
}

import { registerAuthTools } from './auth.tools.js';
import { registerProjectTools } from './project.tools.js';
import { registerDatabaseTools } from './database.tools.js';
import { registerRlsTools } from './rls.tools.js';
import { registerFunctionTools } from './function.tools.js';
import { registerStorageTools } from './storage.tools.js';
import { registerLoggingTools } from './logging.tools.js';
import { registerAdminTools } from './admin.tools.js';
import { registerSmtpTools } from './smtp.tools.js';
import { registerIntegrationTools } from './integrations.tools.js';
import { registerCreditTools } from './credits.tools.js';
import { registerDashboardTools } from './dashboard.tools.js';
import { registerBackgroundJobsTools } from './background-jobs.tools.js';
import { registerRealtimeTools } from './realtime.tools.js';
import { registerAnalyticsTools } from './analytics.tools.js';
import { registerMigrationTools } from './migration.tools.js';
import { registerBranchTools } from './branches.tools.js';
import { registerProjectIntelligenceTools } from './project-intelligence.tools.js';
import { registerProjectIntelligencePrompts } from '../prompts/project-intelligence.prompts.js';
import { ToolRegistry, recordingServer } from '../codemode/registry.js';

/**
 * Define every tool. Each one is recorded in the returned registry (the single
 * source of truth Code Mode generates types from and calls into); only tools
 * for which `expose(name)` is true are registered as direct MCP tools.
 */
export function registerAllTools(
  realServer: McpServer,
  ctx: ToolContext,
  expose: (name: string) => boolean = () => true,
): ToolRegistry {
  const registry = new ToolRegistry();
  const server = recordingServer(realServer, registry, expose);
  registerAuthTools(server, ctx);
  registerProjectTools(server, ctx);
  registerDatabaseTools(server, ctx);
  registerRlsTools(server, ctx);
  registerFunctionTools(server, ctx);
  registerBackgroundJobsTools(server, ctx);
  registerStorageTools(server, ctx);
  registerLoggingTools(server, ctx);
  registerAdminTools(server, ctx);
  registerSmtpTools(server, ctx);
  registerIntegrationTools(server, ctx);
  registerCreditTools(server, ctx);
  registerDashboardTools(server, ctx);
  registerRealtimeTools(server, ctx);
  registerAnalyticsTools(server, ctx);
  registerMigrationTools(server, ctx);
  registerBranchTools(server, ctx);
  registerProjectIntelligenceTools(server, ctx);
  registerProjectIntelligencePrompts(server, ctx);
  return registry;
}
