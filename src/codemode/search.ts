/**
 * Code Mode `search`: deterministic keyword ranking over the registry.
 *
 * Score per query word (stemmed): namespace hit (name or synonym) > method-word
 * hit > prefix > substring > description word, plus a small bias toward the
 * class a verb implies ("list" → read, "delete" → destructive). Ties break by
 * path so the order never changes between runs.
 */
import type { ToolEntry } from './registry.js';
import { SEARCH_HINTS } from './catalog.js';
import { wrapDeclarations } from './typegen.js';

export const SEARCH_MAX_LIMIT = 10;
export const SEARCH_DEFAULT_LIMIT = 6;

const STOPWORDS = new Set(
  'a an the of for to in on at my all and or with from by me i how do does what which is are be each every per this that these those it its into via can please'.split(' '),
);

/** Very small stemmer: plurals only (policies→policy, buckets→bucket, statuses→status). */
export function stem(word: string): string {
  const w = word.toLowerCase();
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(sses|shes|ches|xes|uses)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

/** Split identifiers and prose into lowercase words (camelCase, snake_case, punctuation). */
export function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Words that point at a namespace without naming it. */
const NS_SYNONYMS: Record<string, string[]> = {
  auth: ['signin', 'login', 'signup', 'profile', 'account', 'sign', 'logout', 'signout'],
  projects: ['project', 'key', 'apikey', 'debug', 'health', 'eligibility'],
  db: ['database', 'table', 'sql', 'row', 'column', 'schema', 'postgres', 'postgresql', 'extension', 'connection', 'record'],
  rls: ['policy', 'row-level', 'rowlevel'],
  functions: ['function', 'edge', 'env', 'environment', 'variable', 'serverless'],
  jobs: ['job', 'cron', 'schedule', 'scheduled', 'background'],
  storage: ['bucket', 'file', 'upload', 'download', 'object', 'blob'],
  logs: ['log', 'slow'],
  analytics: ['event', 'funnel', 'retention', 'crash', 'screen', 'metric', 'performance'],
  migrations: ['migration', 'migrate'],
  branches: ['branch', 'promote', 'development', 'dev', 'staging'],
  admins: ['admin', 'team', 'member', 'teammate'],
  smtp: ['email', 'mail'],
  authSecurity: ['password', 'lockout', 'security', 'brute'],
  ai: ['llm', 'model', 'trace', 'gateway', 'usage'],
  embeddings: ['embedding', 'vector', 'collection', 'pgvector', 'semantic'],
  memory: ['decision', 'task', 'feature', 'context', 'intelligence', 'digest', 'todo', 'milestone'],
  webhooks: ['webhook', 'hook'],
  sms: ['twilio', 'phone', 'text'],
  realtime: ['subscribe', 'subscription', 'broadcast', 'channel', 'stream'],
  credits: ['credit', 'billing', 'balance', 'cap', 'pay', 'payment'],
  dashboard: ['stat', 'activity'],
};

const READ_VERBS = new Set(['list', 'get', 'show', 'find', 'count', 'fetch', 'read', 'view', 'check', 'top', 'see', 'inspect', 'describe', 'status', 'browse', 'search']);
const WRITE_VERBS = new Set(['create', 'add', 'insert', 'update', 'set', 'enable', 'make', 'new', 'change', 'edit', 'write', 'upload', 'trigger', 'send', 'configure']);
const DESTRUCTIVE_VERBS = new Set(['delete', 'remove', 'drop', 'revoke', 'reset', 'destroy', 'purge', 'rotate', 'wipe']);

interface Indexed {
  entry: ToolEntry;
  nsName: string;
  nsStems: Set<string>;
  methodRaw: string[];
  methodStems: string[];
  methodLower: string;
  toolStems: Set<string>;
  hintStems: Set<string>;
  descStems: Set<string>;
}

export interface SearchMatch {
  path: string;
  tool: string;
  cls: string;
  score: number;
}

export class SearchIndex {
  private readonly items: Indexed[];

  constructor(entries: ToolEntry[]) {
    this.items = entries.map((entry) => {
      const methodRaw = words(entry.method);
      const synonyms = (NS_SYNONYMS[entry.ns] ?? []).map(stem);
      return {
        entry,
        nsName: entry.ns.toLowerCase(),
        nsStems: new Set([...words(entry.ns).map(stem), stem(entry.ns), ...synonyms]),
        methodRaw,
        methodStems: methodRaw.map(stem),
        methodLower: entry.method.toLowerCase(),
        toolStems: new Set(words(entry.name.replace(/^nestcore_/, '')).map(stem)),
        hintStems: new Set(words(SEARCH_HINTS[entry.name] ?? '').map(stem)),
        descStems: new Set(words(entry.description).filter((w) => !STOPWORDS.has(w)).map(stem)),
      };
    });
  }

  search(query: string, limit = SEARCH_DEFAULT_LIMIT): SearchMatch[] {
    const n = Math.max(1, Math.min(SEARCH_MAX_LIMIT, Math.floor(limit) || SEARCH_DEFAULT_LIMIT));
    const raw = words(query).filter((w) => !STOPWORDS.has(w));
    if (raw.length === 0) return [];
    const compact = query.toLowerCase().replace(/[^a-z0-9.]/g, '');
    const hasRead = raw.some((w) => READ_VERBS.has(w));
    const hasWrite = raw.some((w) => WRITE_VERBS.has(w));
    const hasDestructive = raw.some((w) => DESTRUCTIVE_VERBS.has(w));

    const scored: SearchMatch[] = [];
    for (const it of this.items) {
      let score = 0;
      let covered = 0;
      for (const qr of raw) {
        const qs = stem(qr);
        let s = 0;
        if (qr === it.nsName || it.nsStems.has(qs)) s += 10;

        let name = 0;
        const exactIdx = it.methodStems.indexOf(qs);
        if (exactIdx !== -1) name = it.methodRaw[exactIdx] === qr ? 10 : 8;
        else if (qs.length >= 3 && it.methodRaw.some((w) => w.startsWith(qs))) name = 5;
        else if (qs.length >= 3 && it.methodLower.includes(qs)) name = 3;
        if (it.toolStems.has(qs)) name = Math.max(name, 6);
        if (it.hintStems.has(qs)) name = Math.max(name, 6);
        s += name;

        if (it.descStems.has(qs)) s += 2;
        else if (qs.length >= 4 && [...it.descStems].some((w) => w.startsWith(qs))) s += 1;

        if (s > 0) covered++;
        score += s;
      }
      if (score === 0) continue;
      if (covered === raw.length && raw.length > 1) score += 4;

      const p = it.entry.path.toLowerCase();
      if (compact === p || compact === it.methodLower || compact === it.entry.name.replace(/_/g, '')) score += 30;

      const cls = it.entry.cls;
      if (hasRead && cls === 'read') score += 3;
      if (hasWrite && cls === 'write') score += 3;
      if (hasDestructive && cls === 'destructive') score += 3;
      if (!hasRead && !hasWrite && !hasDestructive && cls === 'read') score += 1;

      scored.push({ path: it.entry.path, tool: it.entry.name, cls: displayClass(it.entry), score });
    }

    scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return scored.slice(0, n);
  }
}

function displayClass(entry: ToolEntry): string {
  return entry.name === 'nestcore_execute_sql' ? 'read|write (per SQL)' : entry.cls;
}

/**
 * Text returned by the `search` tool: a summary line per match, then the
 * declaration slices for just those methods inside `declare namespace nestcore`.
 */
export function formatSearchResult(
  query: string,
  matches: SearchMatch[],
  declarationOf: (path: string) => string | undefined,
  namespaces: string[],
): string {
  if (matches.length === 0) {
    return [
      `// No methods match "${query}".`,
      `// Namespaces: ${namespaces.join(', ')}. Try a namespace name or a verb + noun, e.g. "list buckets".`,
    ].join('\n');
  }
  const groups = new Map<string, string[]>();
  for (const m of matches) {
    const ns = m.path.split('.')[0];
    const decl = declarationOf(m.path);
    if (!decl) continue;
    if (!groups.has(ns)) groups.set(ns, []);
    groups.get(ns)!.push(decl);
  }
  return [
    `// ${matches.length} match${matches.length === 1 ? '' : 'es'} for "${query}" — call inside execute as: await nestcore.<namespace>.<method>(args)`,
    ...matches.map((m) => `// ${m.path} (${m.cls})`),
    wrapDeclarations(groups),
  ].join('\n');
}
