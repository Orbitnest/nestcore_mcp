#!/usr/bin/env node
import { loadConfig } from './config.js';
import { setLogLevel, logger } from './utils/logger.js';
import { createServer, startStdioServer } from './server.js';
import type { SessionTracker } from './context/session-tracker.js';
import type { NestCoreClient } from './sdk/nestcore.client.js';

let _tracker: SessionTracker | null = null;
let _client: NestCoreClient | null = null;

// ── Graceful shutdown: auto-write session digest when the session ends ──────
// MCP hosts usually end a stdio server by closing its stdin (SIGTERM is never
// delivered on Windows). If the AI wrote decisions/tasks/events but never
// called nestcore_sync_memory, write an auto-generated digest so nothing is
// silently lost.
let _exiting = false;
async function autoSyncOnExit(reason: string) {
  if (_exiting) return;
  _exiting = true;
  if (!_tracker || !_client) return;
  const pid = _tracker.getProjectId();
  if (!pid || _tracker.pendingCount() === 0) return;
  try {
    logger.info(`[${reason}] Auto-syncing ${_tracker.pendingCount()} unsynced session writes…`);
    await _client.setProjectProfile(pid, { digest: _tracker.autoDigest() });
    logger.info(`[${reason}] Session digest written to project memory.`);
  } catch (err) {
    logger.warn(`[${reason}] Auto-sync failed — changes may be lost`, { err: String(err) });
  }
}

const shutdown = (reason: string) => { void autoSyncOnExit(reason).finally(() => process.exit(0)); };
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.stdin.on('end', () => shutdown('stdin closed'));
process.stdin.on('close', () => shutdown('stdin closed'));

async function main(): Promise<void> {
  try {
    const config = loadConfig();
    setLogLevel(config.logLevel);

    logger.info('Starting NestCore MCP Server...', {
      version: config.serverVersion,
      apiUrl: config.apiUrl,
    });

    const { server, tracker, apiClient } = await createServer(config);
    _tracker = tracker;
    _client = apiClient;

    await startStdioServer(server);
  } catch (error) {
    logger.error('Failed to start MCP server', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

main();
