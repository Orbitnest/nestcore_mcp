import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { logger } from '../utils/logger.js';
import type { StoredCredentials } from '../types/session.types.js';

const CREDENTIALS_DIR = path.join(os.homedir(), '.orbitnest');
const CREDENTIALS_FILE = path.join(CREDENTIALS_DIR, 'credentials.json');
// Advisory lock shared with the OrbitNest CLI — serialises refresh-token
// rotation across processes (the API revokes every session of the admin when a
// consumed refresh token is replayed).
const CREDENTIALS_LOCK = path.join(CREDENTIALS_DIR, 'credentials.lock');

export function loadCredentials(): StoredCredentials | null {
  try {
    if (!fs.existsSync(CREDENTIALS_FILE)) {
      logger.debug('No credentials file found');
      return null;
    }
    const raw = fs.readFileSync(CREDENTIALS_FILE, 'utf-8');
    return JSON.parse(raw) as StoredCredentials;
  } catch (err) {
    logger.warn('Failed to load credentials', { error: String(err) });
    return null;
  }
}

/**
 * Merge into the existing file (keeps fields the CLI owns, e.g. `apiUrl`) and
 * write atomically (temp file + rename) so a concurrent reader never sees a
 * partial file.
 */
export function saveCredentials(credentials: StoredCredentials): void {
  try {
    fs.mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
    const body = JSON.stringify({ ...(loadCredentials() ?? {}), ...credentials }, null, 2);
    const tmp = `${CREDENTIALS_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    try {
      fs.renameSync(tmp, CREDENTIALS_FILE);
    } catch {
      // Windows can refuse the rename while another process has the file open.
      fs.writeFileSync(CREDENTIALS_FILE, body, { mode: 0o600 });
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
    // `mode` only applies on creation — tighten a pre-existing wider file too.
    try { fs.chmodSync(CREDENTIALS_FILE, 0o600); } catch { /* no-op on Windows */ }
    logger.info('Credentials saved');
  } catch (err) {
    logger.error('Failed to save credentials', { error: String(err) });
    throw err;
  }
}

/** Run `fn` while holding the cross-process credentials lock (shared with the CLI). */
export async function withCredentialsLock<T>(fn: () => Promise<T>): Promise<T> {
  fs.mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 90_000;
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = fs.openSync(CREDENTIALS_LOCK, 'wx');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // A holder that crashed leaves the lock behind; a refresh never takes 75s.
      try {
        if (Date.now() - fs.statSync(CREDENTIALS_LOCK).mtimeMs > 75_000) fs.unlinkSync(CREDENTIALS_LOCK);
      } catch { /* raced with the holder */ }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${CREDENTIALS_LOCK}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await fn();
  } finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(CREDENTIALS_LOCK); } catch { /* ignore */ }
  }
}

export function clearCredentials(): void {
  try {
    if (fs.existsSync(CREDENTIALS_FILE)) {
      fs.unlinkSync(CREDENTIALS_FILE);
      logger.info('Credentials cleared');
    }
  } catch (err) {
    logger.warn('Failed to clear credentials', { error: String(err) });
  }
}
