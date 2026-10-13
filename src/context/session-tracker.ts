/**
 * Tracks writes made during the current MCP session so we can:
 *   1. Remind the AI to sync at session end (via tool response footers)
 *   2. Auto-write a partial digest when the session ends (stdin close / SIGTERM / SIGINT)
 */
export interface TrackedWrite {
  kind: 'decision' | 'task' | 'event' | 'feature' | 'complete';
  summary: string;
  timestamp: string;
}

export class SessionTracker {
  private writes: TrackedWrite[] = [];
  private lastDigestAt: string | null = null;
  private projectId: string | null = null;

  setProject(id: string) {
    this.projectId = id;
  }

  getProjectId(): string | null {
    return this.projectId;
  }

  record(write: Omit<TrackedWrite, 'timestamp'>) {
    this.writes.push({ ...write, timestamp: new Date().toISOString() });
  }

  markSynced() {
    this.lastDigestAt = new Date().toISOString();
    this.writes = [];
  }

  /** Number of unsynced writes since last digest */
  pendingCount(): number {
    return this.writes.length;
  }

  /** A compact list of what was written this session */
  pendingSummary(): string {
    if (!this.writes.length) return 'No changes recorded this session.';
    const lines = this.writes.map((w) => `- [${w.kind}] ${w.summary}`);
    return lines.join('\n');
  }

  /**
   * Auto-digest written on shutdown, in the same structured shape as
   * orbitnest_sync_memory (`{ v:1, kind:'session_digest', ... }`) so Studio
   * renders it and it doesn't replace a structured digest with prose.
   */
  autoDigest(): string {
    // Bounded well under the API's 10,000-char digest limit.
    const done = this.writes.slice(-30).map((w) => ({ title: `[${w.kind}] ${w.summary}`.slice(0, 200) }));
    return JSON.stringify({
      v: 1,
      kind: 'session_digest',
      date: new Date().toISOString().slice(0, 10),
      title: 'Auto-saved session (ended before orbitnest_sync_memory)',
      summary:
        `The MCP session closed with ${this.writes.length} unsynced change(s).` +
        (this.lastDigestAt ? ` Previous digest written at ${this.lastDigestAt}.` : ''),
      done,
    });
  }

  /** Footer to append to tool responses when there are pending writes */
  reminderFooter(): string | null {
    const n = this.pendingCount();
    if (n === 0) return null;
    return `\n\n---\n[Memory] ${n} change${n === 1 ? '' : 's'} recorded this session. Call orbitnest_sync_memory before closing to persist them.`;
  }
}
