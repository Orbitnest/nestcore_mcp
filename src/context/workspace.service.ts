import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WorkspaceConfig } from '../types/session.types.js';
import { logger } from '../utils/logger.js';

const CONFIG_DIR = '.orbitnest';
const CONFIG_FILE = 'config.json';

export class WorkspaceService {
  private config: WorkspaceConfig | null = null;
  private configPath: string | null = null;

  async detectWorkspace(startDir?: string): Promise<WorkspaceConfig | null> {
    const start = startDir || process.cwd();
    let current = start;

    while (true) {
      const configPath = path.join(current, CONFIG_DIR, CONFIG_FILE);
      if (fs.existsSync(configPath)) {
        try {
          const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          if (raw?.projectId) {
            // The CLI (<= 0.5) wrote `slug`; the canonical key is `projectSlug`.
            this.config = { ...raw, projectSlug: raw.projectSlug ?? raw.slug } as WorkspaceConfig;
            this.configPath = configPath;
            logger.info('Workspace config detected', { path: configPath, projectId: this.config.projectId });
            return this.config;
          }
        } catch (err) {
          logger.warn('Failed to parse workspace config', { path: configPath, error: String(err) });
        }
      }

      const parent = path.dirname(current);
      if (parent === current) break; // reached root
      current = parent;
    }

    logger.debug('No workspace config found');
    return null;
  }

  getConfig(): WorkspaceConfig | null {
    return this.config;
  }

  /**
   * Persist the active project into the workspace file the CLI linked (found by
   * detectWorkspace). Without one, nothing is written: the MCP's cwd is often
   * `/` or System32 under desktop hosts, and a stray `.orbitnest/` there would
   * shadow configs or fail with EACCES. Returns the path written, or null.
   */
  saveWorkspaceConfig(config: WorkspaceConfig): string | null {
    if (!this.configPath) return null;
    try {
      const { slug: _legacy, ...existing } = (this.config ?? {}) as WorkspaceConfig & { slug?: string };
      const merged: WorkspaceConfig = { ...existing, ...config };
      fs.writeFileSync(this.configPath, JSON.stringify(merged, null, 2));
      this.config = merged;
      logger.info('Workspace config saved', { path: this.configPath });
      return this.configPath;
    } catch (err) {
      logger.warn('Could not save workspace config', { path: this.configPath, error: String(err) });
      return null;
    }
  }
}
