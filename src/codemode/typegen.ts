/**
 * zod (v3) → TypeScript declaration emitter for Code Mode.
 *
 * Produces `declare namespace nestcore { namespace db { function getSchema(…): Promise<unknown>; } }`
 * from the registry, with a JSDoc comment per method (tool description) and
 * per parameter (`.describe()` text plus simple constraints). Tools declare no
 * output schemas, so every method returns `Promise<unknown>`.
 *
 * Deliberately small and dependency-free: it handles the zod constructs the
 * tool shapes use (and a few more) and falls back to `unknown`.
 */
import type { ZodRawShape, ZodTypeAny } from 'zod';
import type { ToolEntry } from './registry.js';
import { NAMESPACES } from './catalog.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDef = any;

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const key = (k: string) => (IDENT.test(k) ? k : JSON.stringify(k));

/** First `.describe()` text found while unwrapping optional/nullable/default/effects. */
function descriptionOf(schema: ZodTypeAny): string | undefined {
  let s: ZodTypeAny | undefined = schema;
  for (let i = 0; s && i < 8; i++) {
    if (s.description) return s.description;
    const def: AnyDef = s._def;
    s = def?.innerType ?? def?.schema ?? undefined;
  }
  return undefined;
}

/** Short constraint notes worth showing to a model (formats, ranges, defaults). */
function constraintsOf(schema: ZodTypeAny): string[] {
  const notes: string[] = [];
  let s: ZodTypeAny | undefined = schema;
  for (let i = 0; s && i < 8; i++) {
    const def: AnyDef = s._def;
    switch (def?.typeName) {
      case 'ZodDefault': {
        try {
          notes.push(`default ${JSON.stringify(def.defaultValue())}`);
        } catch {
          /* ignore */
        }
        break;
      }
      case 'ZodString':
        for (const c of def.checks ?? []) {
          if (c.kind === 'uuid' || c.kind === 'email' || c.kind === 'url' || c.kind === 'datetime') notes.push(c.kind);
          else if (c.kind === 'min' && c.value > 1) notes.push(`min length ${c.value}`);
          else if (c.kind === 'max') notes.push(`max length ${c.value}`);
          else if (c.kind === 'regex') notes.push(`pattern ${String(c.regex)}`);
        }
        break;
      case 'ZodNumber': {
        let min: number | undefined;
        let max: number | undefined;
        let int = false;
        for (const c of def.checks ?? []) {
          if (c.kind === 'int') int = true;
          else if (c.kind === 'min') min = c.value;
          else if (c.kind === 'max') max = c.value;
        }
        if (int) notes.push('integer');
        if (min !== undefined && max !== undefined) notes.push(`${min}..${max}`);
        else if (min !== undefined) notes.push(`>= ${min}`);
        else if (max !== undefined) notes.push(`<= ${max}`);
        break;
      }
      case 'ZodArray':
        if (def.minLength?.value) notes.push(`min ${def.minLength.value} items`);
        if (def.maxLength?.value) notes.push(`max ${def.maxLength.value} items`);
        break;
    }
    s = def?.innerType ?? def?.schema ?? undefined;
  }
  return notes;
}

function isOptional(schema: ZodTypeAny): boolean {
  try {
    return schema.isOptional();
  } catch {
    return false;
  }
}

function jsdoc(text: string, indent: string): string {
  const clean = text.replace(/\*\//g, '*\\/').trim();
  if (!clean) return '';
  const lines = clean.split(/\r?\n/);
  if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`;
  return `${indent}/**\n${lines.map((l) => `${indent} * ${l}`).join('\n')}\n${indent} */\n`;
}

function emitObject(shape: Record<string, ZodTypeAny>, indent: string, extra: string[] = []): string {
  const keys = Object.keys(shape);
  if (keys.length === 0 && extra.length === 0) return '{}';
  const inner = indent + '  ';
  const lines: string[] = [];
  for (const k of keys) {
    const s = shape[k];
    const doc = [descriptionOf(s), constraintsOf(s).join(', ')].filter(Boolean).join(' — ');
    lines.push(`${doc ? jsdoc(doc, inner) : ''}${inner}${key(k)}${isOptional(s) ? '?' : ''}: ${emitType(s, inner)};`);
  }
  for (const e of extra) lines.push(e.replace(/^/gm, inner));
  return `{\n${lines.join('\n')}\n${indent}}`;
}

/** TypeScript type text for one zod schema. */
export function emitType(schema: ZodTypeAny, indent = ''): string {
  const def: AnyDef = schema?._def;
  switch (def?.typeName) {
    case 'ZodString':
      return 'string';
    case 'ZodNumber':
      return 'number';
    case 'ZodBigInt':
      return 'bigint';
    case 'ZodBoolean':
      return 'boolean';
    case 'ZodDate':
      return 'string';
    case 'ZodNull':
      return 'null';
    case 'ZodUndefined':
    case 'ZodVoid':
      return 'undefined';
    case 'ZodAny':
      return 'any';
    case 'ZodUnknown':
      return 'unknown';
    case 'ZodNever':
      return 'never';
    case 'ZodLiteral':
      return JSON.stringify(def.value);
    case 'ZodEnum':
      return (def.values as unknown[]).map((v) => JSON.stringify(v)).join(' | ');
    case 'ZodNativeEnum': {
      const obj = def.values as Record<string, string | number>;
      // Numeric enums carry reverse mappings (value -> name); keep real values only.
      const vals = Object.keys(obj)
        .filter((k) => typeof obj[obj[k] as string] !== 'number')
        .map((k) => obj[k]);
      return [...new Set(vals)].map((v) => JSON.stringify(v)).join(' | ') || 'never';
    }
    case 'ZodArray': {
      const t = emitType(def.type, indent);
      return /^[\w.]+$/.test(t) ? `${t}[]` : `Array<${t}>`;
    }
    case 'ZodTuple':
      return `[${(def.items as ZodTypeAny[]).map((i) => emitType(i, indent)).join(', ')}]`;
    case 'ZodObject':
      return emitObject(def.shape(), indent);
    case 'ZodRecord':
      return `Record<string, ${emitType(def.valueType, indent)}>`;
    case 'ZodMap':
      return `Map<${emitType(def.keyType, indent)}, ${emitType(def.valueType, indent)}>`;
    case 'ZodSet':
      return `Set<${emitType(def.valueType, indent)}>`;
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion': {
      const opts: ZodTypeAny[] = Array.isArray(def.options) ? def.options : [...def.options.values()];
      return opts.map((o) => emitType(o, indent)).join(' | ');
    }
    case 'ZodIntersection':
      return `${emitType(def.left, indent)} & ${emitType(def.right, indent)}`;
    case 'ZodOptional':
      return emitType(def.innerType, indent);
    case 'ZodNullable':
      return `${emitType(def.innerType, indent)} | null`;
    case 'ZodDefault':
    case 'ZodCatch':
    case 'ZodReadonly':
      return emitType(def.innerType, indent);
    case 'ZodBranded':
      return emitType(def.type, indent);
    case 'ZodEffects':
      return emitType(def.schema, indent);
    case 'ZodPipeline':
      return emitType(def.in, indent);
    case 'ZodPromise':
      return `Promise<${emitType(def.type, indent)}>`;
    default:
      return 'unknown';
  }
}

/** The bridge-level `confirm` argument added to destructive tools that have no flag of their own. */
export const BRIDGE_CONFIRM_DOC =
  '/** Must be true to run this destructive method (not needed when the client shows a confirmation prompt). */\nconfirm?: true;';

/** One-line result hint, only when the description states one ("Returns …"). */
function resultHint(description: string): string | undefined {
  const m = /(?:^|[.!]\s+)(Returns?\b[^.]*\.)/.exec(description);
  return m ? m[1].trim().replace(/^Returns?\s+/, '') : undefined;
}

/**
 * Point tool-name references in descriptions ("call nestcore_get_credits") at
 * the Code Mode method (`nestcore.credits.get`). `nestcore_login` stays a tool.
 */
export function rewriteToolRefs(text: string, pathOf: (toolName: string) => string | undefined): string {
  return text.replace(/\bnestcore_[a-z0-9_]+\b/g, (name) => {
    const path = pathOf(name);
    return path ? `nestcore.${path}` : name;
  });
}

export function needsBridgeConfirm(entry: Pick<ToolEntry, 'cls' | 'confirmFlag'>): boolean {
  return entry.cls === 'destructive' && !entry.confirmFlag;
}

/** Declaration of one method (indented for its namespace block). */
export function emitMethod(
  entry: ToolEntry,
  indent = '    ',
  pathOf: (toolName: string) => string | undefined = () => undefined,
): string {
  const shape = entry.shape as ZodRawShape as Record<string, ZodTypeAny>;
  const extra = needsBridgeConfirm(entry) ? [BRIDGE_CONFIRM_DOC] : [];
  const noParams = Object.keys(shape).length === 0 && extra.length === 0;
  const allOptional = Object.values(shape).every(isOptional) && extra.length === 0;
  const params = emitObject(shape, indent, extra);
  const description = rewriteToolRefs(entry.description.trim(), pathOf);
  const docLines = [description,`@access ${entry.name === 'nestcore_execute_sql' ? 'read|write|destructive (per SQL)' : entry.cls}`];
  const hint = resultHint(description);
  if (hint) docLines.push(`@returns ${hint}`);
  const sig = noParams ? '()' : `(args${allOptional ? '?' : ''}: ${params})`;
  return `${jsdoc(docLines.join('\n'), indent)}${indent}function ${entry.method}${sig}: Promise<unknown>;`;
}

export interface Declarations {
  /** Full `declare namespace nestcore { … }` text for all given entries. */
  full: string;
  /** Per-path method declaration (without the namespace wrapper). */
  byPath: Map<string, string>;
  /** Namespace → method names, in display order. */
  namespaces: Map<string, string[]>;
}

/** Wrap per-namespace method declarations in the `nestcore` namespace. */
export function wrapDeclarations(groups: Map<string, string[]>): string {
  const blocks: string[] = [];
  for (const [ns, decls] of groups) {
    if (!decls.length) continue;
    blocks.push(`  namespace ${ns} {\n${decls.join('\n')}\n  }`);
  }
  return `declare namespace nestcore {\n${blocks.join('\n')}\n}`;
}

const nsOrder = (ns: string) => {
  const i = NAMESPACES.indexOf(ns);
  return i === -1 ? NAMESPACES.length : i;
};

/** Generate declarations for `entries` (generate once at startup and cache). */
export function generateDeclarations(entries: ToolEntry[]): Declarations {
  const sorted = [...entries].sort((a, b) => nsOrder(a.ns) - nsOrder(b.ns) || a.method.localeCompare(b.method));
  const byPath = new Map<string, string>();
  const groups = new Map<string, string[]>();
  const namespaces = new Map<string, string[]>();
  const pathByName = new Map(entries.map((e) => [e.name, e.path]));
  const pathOf = (name: string) => pathByName.get(name);
  for (const e of sorted) {
    const decl = emitMethod(e, '    ', pathOf);
    byPath.set(e.path, decl);
    if (!groups.has(e.ns)) groups.set(e.ns, []);
    groups.get(e.ns)!.push(decl);
    if (!namespaces.has(e.ns)) namespaces.set(e.ns, []);
    namespaces.get(e.ns)!.push(e.method);
  }
  return { full: wrapDeclarations(groups), byPath, namespaces };
}
