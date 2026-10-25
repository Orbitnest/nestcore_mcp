import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/** Prefix of every tool this server registers. */
export const TOOL_PREFIX = 'nestcore_';
/** Prefix the tools had before the OrbitNest → NestCore rename. */
export const LEGACY_TOOL_PREFIX = 'orbitnest_';

/** Map a pre-rename `orbitnest_*` tool name to its `nestcore_*` name; other names pass through. */
export function toCurrentToolName(name: string): string {
  return name.startsWith(LEGACY_TOOL_PREFIX) ? TOOL_PREFIX + name.slice(LEGACY_TOOL_PREFIX.length) : name;
}

type IncomingHandler = NonNullable<Transport['onmessage']>;

/** Rewrite a `tools/call` request that names a legacy tool; every other message is returned as is. */
export function rewriteLegacyToolCall<T>(message: T): T {
  const msg = message as { method?: unknown; params?: { name?: unknown } };
  if (msg?.method !== 'tools/call' || typeof msg.params?.name !== 'string') return message;
  const name = toCurrentToolName(msg.params.name);
  if (name === msg.params.name) return message;
  return { ...msg, params: { ...msg.params, name } } as T;
}

/**
 * Make `transport` accept the old `orbitnest_*` tool names. `tools/list` only
 * returns the `nestcore_*` names; a `tools/call` for an old name (an MCP client
 * with a cached tool list) is routed to the renamed tool before the server sees it.
 */
export function withLegacyToolNames<T extends Transport>(transport: T): T {
  let handler: IncomingHandler | undefined;
  Object.defineProperty(transport, 'onmessage', {
    configurable: true,
    enumerable: true,
    get: () => handler,
    set: (fn: IncomingHandler | undefined) => {
      handler = fn
        ? (((message, extra) => fn(rewriteLegacyToolCall(message), extra)) as IncomingHandler)
        : undefined;
    },
  });
  return transport;
}
