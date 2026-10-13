import { readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { createHash } from 'crypto';
import { MigrationError, type MigrationFile } from './types.js';

const MIGRATION_FILE_RE = /^(\d+)[_-](.+)\.sql$/i;
// The whole line must be the marker (`-- migrate:down`, `-- down`, `--- DOWN ---`),
// so a comment like `-- Down-sampled …` stays in the up section (same as node_sdk).
const DOWN_MARKER_RE = /^\s*--+\s*(migrate:)?down\s*-*\s*$/i;

/** Split a migration into up (forward) and down (rollback) SQL. */
function splitUpDown(content: string): { up: string; down: string } {
  const lines = content.split(/\r?\n/);
  const idx = lines.findIndex((l) => DOWN_MARKER_RE.test(l));
  if (idx === -1) return { up: content, down: '' };
  return { up: lines.slice(0, idx).join('\n'), down: lines.slice(idx + 1).join('\n') };
}

/** Discovers and orders migration files on disk; computes content checksums. */
export class MigrationScanner {
  private readonly dir: string;

  constructor(dir = 'migrations') {
    this.dir = resolve(dir);
  }

  get directory(): string {
    return this.dir;
  }

  scan(): MigrationFile[] {
    let entries: string[];
    try {
      entries = readdirSync(this.dir);
    } catch (e) {
      throw new MigrationError(
        `Cannot read migrations directory "${this.dir}": ${(e as Error).message}`,
      );
    }

    const files = entries
      .filter((f) => f.toLowerCase().endsWith('.sql'))
      .map((f) => this.read(f))
      .filter((m): m is MigrationFile => m !== null)
      .sort((a, b) =>
        a.migrationId.localeCompare(b.migrationId, undefined, { numeric: true, sensitivity: 'base' }),
      );

    const seen = new Set<string>();
    for (const m of files) {
      if (seen.has(m.migrationId)) {
        throw new MigrationError(
          `Duplicate migration id "${m.migrationId}" — every file must have a unique numeric prefix.`,
        );
      }
      seen.add(m.migrationId);
    }
    return files;
  }

  private read(filename: string): MigrationFile | null {
    const match = MIGRATION_FILE_RE.exec(filename);
    if (!match) return null;
    const path = join(this.dir, filename);
    const content = readFileSync(path, 'utf8');
    const { up, down } = splitUpDown(content);
    return {
      migrationId: match[1],
      name: filename,
      path,
      content,
      up,
      down,
      checksum: createHash('sha256').update(content, 'utf8').digest('hex'),
    };
  }
}
