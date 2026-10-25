import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { logger } from '../utils/logger.js';
import type { StoredCredentials } from '../types/session.types.js';

const CREDENTIALS_DIR = path.join(os.homedir(), '.nestcore');
const CREDENTIALS_FILE = path.join(CREDENTIALS_DIR, 'credentials.json');
// Pre-rename location: read when the new file is absent, and kept in sync while it
// exists so an older CLI/MCP sharing it never replays a rotated refresh token.
const LEGACY_CREDENTIALS_FILE = path.join(os.homedir(), '.orbitnest', 'credentials.json');
// Advisory lock shared with the NestCore CLI — serialises refresh-token
// rotation across processes (the API revokes every session of the admin when a
// consumed refresh token is replayed).
const CREDENTIALS_LOCK = path.join(CREDENTIALS_DIR, 'credentials.lock');

export function loadCredentials(): StoredCredentials | null {
  try {
    const file = [CREDENTIALS_FILE, LEGACY_CREDENTIALS_FILE].find((f) => fs.existsSync(f));
    if (!file) {
      logger.debug('No credentials file found');
      return null;
    }
    const raw = fs.readFileSync(file, 'utf-8');
    return JSON.parse(raw) as StoredCredentials;
  } catch (err) {
    logger.warn('Failed to load credentials', { error: String(err) });
    return null;
  }
}

function writeAtomic(file: string, body: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows can refuse the rename while another process has the file open.
    fs.writeFileSync(file, body, { mode: 0o600 });
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
  // `mode` only applies on creation — tighten a pre-existing wider file too.
  try { fs.chmodSync(file, 0o600); } catch { /* no-op on Windows */ }
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
    writeAtomic(CREDENTIALS_FILE, body);
    if (fs.existsSync(LEGACY_CREDENTIALS_FILE)) {
      try { writeAtomic(LEGACY_CREDENTIALS_FILE, body); } catch { /* best-effort */ }
    }
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
    // Clear the pre-rename file too, or it would be read back as a fallback.
    for (const file of [CREDENTIALS_FILE, LEGACY_CREDENTIALS_FILE]) {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        logger.info('Credentials cleared', { file });
      }
    }
  } catch (err) {
    logger.warn('Failed to clear credentials', { error: String(err) });
  }
}
