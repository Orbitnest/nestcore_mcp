import type { ProjectMetadata } from '../types/session.types.js';
import { NestCoreClient } from '../sdk/nestcore.client.js';
import { logger } from '../utils/logger.js';

export class ProjectService {
  private apiClient: NestCoreClient;

  constructor(apiClient: NestCoreClient) {
    this.apiClient = apiClient;
  }

  async loadProject(projectId: string): Promise<ProjectMetadata> {
    logger.info('Loading project metadata', { projectId });
    const result = await this.apiClient.getProject(projectId);
    return {
      id: (result.id ?? result._id ?? projectId) as string,
      name: (result.name ?? '') as string,
      slug: (result.slug ?? '') as string,
      dbName: (result.db_name ?? result.dbName ?? '') as string,
      createdAt: (result.created_at ?? result.createdAt ?? '') as string,
      settings: (result.settings ?? undefined) as Record<string, unknown> | undefined,
    };
  }
}
