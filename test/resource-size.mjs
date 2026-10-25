/**
 * Regression guard: the project://context resource must stay tiny.
 *
 * A large project once serialized its FULL memory into this resource (~1.7M
 * tokens) and overflowed the model context on the first message. The resource
 * now emits only a compact summary via buildCompactSummary(). This test feeds
 * it a pathological, oversized context and asserts the output stays capped.
 *
 *   node test/resource-size.mjs
 */
import assert from 'node:assert';
import { buildCompactSummary } from '../dist/server.js';

const MAX = 4000;

// Pathological context: huge digest, 5000 tasks/decisions/events, long summary.
const big = (n, mk) => Array.from({ length: n }, (_, i) => mk(i));
const hugeCtx = {
  profile: {
    summary: 'X'.repeat(50_000),
    digest: 'Y'.repeat(500_000),
    stack: big(200, (i) => `tech-${i}`),
    digest_at: '2026-06-26T00:00:00.000Z',
    updated_at: '2026-06-26T00:00:00.000Z',
  },
  openTasks: big(5000, (i) => ({ id: i, title: 'T'.repeat(500), detail: 'D'.repeat(2000) })),
  activeDecisions: big(5000, (i) => ({ id: i, decision: 'Z'.repeat(2000) })),
  recentEvents: big(20, (i) => ({ id: i, summary: 'E'.repeat(2000) })),
  features: {
    planned: big(100, (i) => ({ id: i })),
    in_progress: big(100, (i) => ({ id: i })),
    released: big(100, (i) => ({ id: i })),
  },
};

const out = buildCompactSummary(hugeCtx, 'split_mate', MAX);
const text = JSON.stringify(out);

// 1. Output must be under the hard cap regardless of input size.
assert.ok(text.length <= MAX, `summary too large: ${text.length} > ${MAX}`);

// 2. It must never embed the full blobs.
assert.ok(!text.includes('Y'.repeat(1000)), 'digest leaked into summary');
assert.ok(!text.includes('D'.repeat(1000)), 'task detail leaked into summary');

// 3. It must still carry useful orientation: name, counts, and the pointer.
assert.strictEqual(out.project, 'split_mate');
assert.strictEqual(out.counts.openTasks, 5000);
assert.strictEqual(out.counts.features, 300);
assert.ok(String(out.note).includes('nestcore_get_project_context'));

// 4. Empty/missing context must not throw and stays tiny.
const empty = buildCompactSummary({}, 'p', MAX);
assert.ok(JSON.stringify(empty).length <= MAX);
assert.strictEqual(empty.counts.openTasks, 0);

console.log(`OK — compact summary ${text.length} bytes (cap ${MAX}); empty-ctx safe.`);
