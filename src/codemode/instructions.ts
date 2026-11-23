/**
 * Server instructions for Code Mode. They ride along on every request, so they
 * stay small: how to use search/execute, and the memory workflow.
 */
import type { McpMode } from '../types/config.types.js';

export function codeModeInstructions(mode: McpMode, allowWrites: boolean): string {
  const lines = [
    'NestCore backend + persistent project memory (Project Intelligence), via Code Mode:',
    '  search  — find API methods; returns TypeScript signatures (`nestcore.<namespace>.<method>`).',
    '  execute — run a JavaScript snippet (async function body) that calls them: `return await nestcore.db.getSchema({})`.',
    'Do several steps in ONE execute (loop, filter, aggregate) and return only what you need. Pull context on demand; never assume it is loaded.',
    'Not signed in (error code AUTH_ERROR)? Call the nestcore_login tool, then retry.',
    '',
    'SESSION START: if no project is set, execute `return await nestcore.projects.list({})`, then `nestcore.projects.setActive({ projectId })`.',
    'Then load memory ONCE: execute `return await nestcore.memory.getProjectContext({})` (profile, open tasks, decisions, recent events).',
  ];
  if (allowWrites) {
    lines.push(
      '',
      'DURING THE SESSION, write as things happen (not batched at the end):',
      '  nestcore.memory.addDecision — an architectural/product decision',
      '  nestcore.memory.addTask     — a follow-up / TODO',
      '  nestcore.memory.addEvent    — a deploy / bug / milestone',
      '  nestcore.memory.search      — recall anything not in the loaded context',
      '',
      "SESSION END: call nestcore.memory.sync once with a digest (what was done, decisions, blockers, what's next) plus any unsaved decisions/tasks/events. Keep the digest concise. Memory is only persisted when you call a method.",
    );
  } else {
    lines.push('', 'Writes are disabled on this server (NESTCORE_MCP_ALLOW_WRITES=false): read methods and read-only SQL only.');
  }
  if (mode === 'both') {
    lines.push('', 'The direct nestcore_* tools are also available; prefer execute for multi-step work.');
  }
  return lines.join('\n');
}

/** Closing lines of the `nestcore_load_project` prompt. */
export function loadProjectPromptFooter(codeMode: boolean): string[] {
  if (!codeMode) {
    return [
      'You are now oriented. Proceed with the session keeping these constraints, decisions, and tasks in mind.',
      'At the end of the session, call nestcore_sync_memory with a structured digest plus any unsaved decisions, tasks and events.',
    ];
  }
  return [
    'You are now oriented. Proceed with the session keeping these constraints, decisions, and tasks in mind.',
    'Use `search` to find NestCore methods and `execute` to call them, e.g. `return await nestcore.memory.getProjectContext({ detail: true })`.',
    'At the end of the session, execute nestcore.memory.sync({ ... }) with a structured digest plus any unsaved decisions, tasks and events.',
  ];
}
