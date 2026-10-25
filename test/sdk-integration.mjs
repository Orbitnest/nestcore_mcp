/**
 * Full SDK integration test — imports the REAL compiled NestCoreClient and
 * exercises every method against the live API using a throwaway project that
 * is deleted at the end. Goal: catch contract drift (wrong body envelope,
 * wrong field names, wrong route) of the kind we just fixed.
 *
 *   EMAIL=you@example.com PASSWORD=*** node test/sdk-integration.mjs
 *
 * Classification per call:
 *   PASS  - 2xx
 *   FAIL  - contract error (400 "should not be empty"/"property X"/validation,
 *           404 route not found) -> a real SDK<->API mismatch
 *   INFO  - other error (business logic: empty analytics, bad fn code, no SMTP)
 */
import { NestCoreClient } from '../dist/sdk/nestcore.client.js';

const API = process.env.API || 'https://api.nestcore.io';
const EMAIL = process.env.EMAIL || 'ali@orbitnest.io';
const PASSWORD = process.env.PASSWORD;
if (!PASSWORD) { console.error('Set PASSWORD env var'); process.exit(2); }

const results = [];
const CONTRACT_HINTS = [
  'should not be empty', 'must be', 'should not exist', 'property ',
  'cannot post', 'cannot get', 'cannot put', 'cannot delete', 'cannot patch',
  'not found - cannot', 'validation failed', 'must be a', 'must not',
  'data object cannot be empty', 'array cannot be empty',
];

function classify(err) {
  const msg = String(err?.message ?? err).toLowerCase();
  const status = err?.status ?? err?.statusCode;
  if (status === 404 && /cannot (post|get|put|delete|patch)/.test(msg)) return 'FAIL';
  if (status === 400 && CONTRACT_HINTS.some((h) => msg.includes(h))) return 'FAIL';
  return 'INFO';
}

async function run(name, fn) {
  try {
    const out = await fn();
    results.push({ name, verdict: 'PASS', detail: '2xx' });
    return out;
  } catch (err) {
    const verdict = classify(err);
    results.push({ name, verdict, detail: `${err?.status ?? ''} ${String(err?.message ?? err).slice(0, 120)}`.trim() });
    return null;
  }
}

async function main() {
  const client = new NestCoreClient({ apiUrl: API, accessToken: '' });

  // ── Auth ──
  const auth = await run('signin', () => client.signin(EMAIL, PASSWORD));
  const token = auth && (auth.data?.access_token ?? auth.access_token);
  if (!token) { console.error('Could not obtain token; aborting.'); process.exit(3); }
  client.setAccessToken(token);

  const profile = await run('getProfile', () => client.getProfile());
  const selfId = profile && (profile.data?.id ?? profile.id);
  await run('getDashboardStats', () => client.getDashboardStats());
  await run('getDashboardActivity', () => client.getDashboardActivity());
  await run('listProjects', () => client.listProjects());
  await run('getAdminProjects', () => client.getAdminProjects());
  await run('listAdmins', () => client.listAdmins());

  // ── Admin reads + invite ──
  // inviteAdmin is the real "add admin" flow (no direct create-with-password
  // endpoint exists). It may INFO if SMTP/SES is down (the invite rolls back).
  await run('inviteAdmin', () => client.inviteAdmin('sdk-selftest-admin@nestcore.local'));
  // Read-only admin lookup against our own id. We intentionally do NOT test
  // updateAdmin / deleteAdmin / updateAdminPassword here — the only available
  // target is the signed-in super admin and mutating it would be destructive.
  if (selfId) await run('getAdmin(self)', () => client.getAdmin(selfId));

  // ── Project lifecycle (throwaway) ──
  // Clean any leftover from a prior run.
  const existing = (await client.listProjects().catch(() => [])) || [];
  const list = Array.isArray(existing) ? existing : (existing.data ?? existing.projects ?? []);
  for (const p of list) {
    if (p && (p.name === 'orbit-sdk-selftest' || p.slug === 'orbit-sdk-selftest')) {
      await client.deleteProject(p.id).catch(() => {});
    }
  }

  const proj = await run('createProject', () => client.createProject({ name: 'orbit-sdk-selftest', description: 'SDK contract self-test' }));
  const project = proj && (proj.data ?? proj);
  const pid = project?.id;
  const slug = project?.slug;
  if (!pid) {
    console.error('createProject did not return an id — cannot continue project tests.');
  } else {
    try {
      await run('getProject', () => client.getProject(pid));
      await run('getProjectStats', () => client.getProjectStats(pid));
      await run('getProjectHealth', () => client.getProjectHealth(pid));
      await run('getProjectOverview', () => client.getProjectOverview(pid));
      await run('getProjectActivity', () => client.getProjectActivity(pid, 5));
      await run('updateProject', () => client.updateProject(pid, { settings: { selftest: true } }));
      await run('toggleDebugMode', () => client.toggleDebugMode(pid, true));
      await run('createProjectApiKeys', () => client.createProjectApiKeys(pid, { name: 'selftest' }));
      await run('getProjectApiKeys', () => client.getProjectApiKeys(pid));

      // ── Database ──
      await run('executeSql(create table)', () => client.executeSql(pid, 'CREATE TABLE IF NOT EXISTS items (id serial primary key, name text, meta jsonb)'));
      await run('listTables', () => client.listTables(pid));
      await run('getTableMetadata', () => client.getTableMetadata(pid, 'items'));
      await run('getTableData', () => client.getTableData(pid, 'items', { limit: 5 }));
      const ins = await run('insertRow', () => client.insertRow(pid, 'items', { name: 'a', meta: { x: 1 } }));
      const rowId = ins && (ins.data?.[0]?.id ?? ins.data?.id);
      if (rowId) {
        await run('updateRow', () => client.updateRow(pid, 'items', String(rowId), { name: 'b', meta: { x: 2 } }));
        await run('deleteRow', () => client.deleteRow(pid, 'items', String(rowId)));
      }
      await run('bulkInsert', () => client.bulkInsert(pid, 'items', [{ name: 'c' }, { name: 'd' }]));
      await run('bulkUpdate', () => client.bulkUpdate(pid, 'items', [{ where: { name: 'c' }, data: { meta: { y: 1 } } }]));
      await run('bulkDelete', () => client.bulkDelete(pid, 'items', [{ name: 'd' }]));
      await run('getSqlHistory', () => client.getSqlHistory(pid, { limit: 5 }));

      // ── RLS ──
      await run('enableRls', () => client.enableRls(pid, 'items'));
      await run('getRlsStatus', () => client.getRlsStatus(pid, 'items'));
      await run('createPolicy', () => client.createPolicy(pid, 'items', { policyName: 'p_all', command: 'SELECT', using: 'true' }));
      await run('listPolicies', () => client.listPolicies(pid, 'items'));
      await run('deletePolicy', () => client.deletePolicy(pid, 'items', 'p_all'));
      await run('disableRls', () => client.disableRls(pid, 'items'));

      // ── Edge Functions ──
      const fnCode = 'export default async function handler(req) { return new Response(JSON.stringify({ ok: true })); }';
      await run('createFunction', () => client.createFunction(pid, { name: 'selftest_fn', sourceCode: fnCode, description: 'x' }));
      await run('updateFunction', () => client.updateFunction(pid, 'selftest_fn', { description: 'y' }));
      await run('listFunctions', () => client.listFunctions(pid));
      await run('getFunction', () => client.getFunction(pid, 'selftest_fn'));
      await run('invokeFunction', () => client.invokeFunction(pid, 'selftest_fn', {}));
      await run('getFunctionLogs', () => client.getFunctionLogs(pid, 'selftest_fn', { limit: 5 }));
      await run('deleteFunction', () => client.deleteFunction(pid, 'selftest_fn'));

      // ── Background Jobs ──
      const jobCode = 'export default async function job() { return { done: true }; }';
      await run('createJob', () => client.createJob(pid, { name: 'selftest_job', sourceCode: jobCode, schedule: '0 0 * * *' }));
      await run('updateJob', () => client.updateJob(pid, 'selftest_job', { description: 'z' }));
      await run('listJobs', () => client.listJobs(pid));
      await run('getJob', () => client.getJob(pid, 'selftest_job'));
      await run('triggerJob', () => client.triggerJob(pid, 'selftest_job'));
      await run('getJobRuns', () => client.getJobRuns(pid, 'selftest_job', { limit: 5 }));
      await run('deleteJob', () => client.deleteJob(pid, 'selftest_job'));

      // ── Env vars ──
      await run('createEnvVariable', () => client.createEnvVariable(pid, { key: 'SELFTEST_VAR', value: 'v1' }));
      await run('getEnvVariables', () => client.getEnvVariables(pid));
      await run('updateEnvVariable', () => client.updateEnvVariable(pid, 'SELFTEST_VAR', { value: 'v2' }));
      await run('deleteEnvVariable', () => client.deleteEnvVariable(pid, 'SELFTEST_VAR'));

      // ── Realtime ──
      await run('enableRealtimeTable', () => client.enableRealtimeTable(pid, { table: 'items' }));
      await run('listRealtimeTables', () => client.listRealtimeTables(pid));
      await run('broadcastRealtime', () => client.broadcastRealtime(pid, { channel: 'c', event: 'e', payload: { a: 1 } }));
      await run('disableRealtimeTable', () => client.disableRealtimeTable(pid, 'public', 'items'));

      // ── Admin Storage (projectId) ──
      await run('adminCreateBucket', () => client.adminCreateBucket(pid, { name: 'selftest', public: true }));
      await run('adminListBuckets', () => client.adminListBuckets(pid));
      await run('adminUploadFile', () => client.adminUploadFile(pid, 'selftest', { filePath: 'hello.txt', fileContent: Buffer.from('hi').toString('base64'), contentType: 'text/plain' }));
      await run('adminListFiles', () => client.adminListFiles(pid, 'selftest', { limit: 5 }));
      await run('adminGetBucketSize', () => client.adminGetBucketSize(pid, 'selftest'));
      await run('adminDeleteFiles', () => client.adminDeleteFiles(pid, 'selftest', ['hello.txt']));
      await run('adminDeleteBucket', () => client.adminDeleteBucket(pid, 'selftest'));

      // ── Storage (slug) ──
      if (slug) {
        await run('createBucket(slug)', () => client.createBucket(slug, 'selftest2', true));
        await run('listBuckets(slug)', () => client.listBuckets(slug));
        await run('uploadFile(slug)', () => client.uploadFile(slug, 'selftest2', { filePath: 'a.txt', fileContent: Buffer.from('hi').toString('base64'), contentType: 'text/plain' }));
        await run('listFiles(slug)', () => client.listFiles(slug, 'selftest2', { limit: 5 }));
        await run('getPublicUrl(slug)', () => client.getPublicUrl(slug, 'selftest2', 'a.txt'));
        await run('getBucketSize(slug)', () => client.getBucketSize(slug, 'selftest2'));
        await run('deleteFiles(slug)', () => client.deleteFiles(slug, 'selftest2', ['a.txt']));
        await run('deleteBucket(slug)', () => client.deleteBucket(slug, 'selftest2'));
      }

      // ── Analytics ──
      const tok = await run('createAnalyticsToken', () => client.createAnalyticsToken(pid, { name: 'selftest' }));
      const tokenId = tok && (tok.data?.id ?? tok.id ?? tok.token?.id);
      await run('listAnalyticsTokens', () => client.listAnalyticsTokens(pid));
      if (tokenId) {
        await run('updateAnalyticsToken', () => client.updateAnalyticsToken(pid, String(tokenId), { is_active: false }));
        await run('revokeAnalyticsToken', () => client.revokeAnalyticsToken(pid, String(tokenId)));
      }
      await run('getAnalyticsOverview', () => client.getAnalyticsOverview(pid, {}));
      await run('getAnalyticsEventTimeseries', () => client.getAnalyticsEventTimeseries(pid, {}));
      await run('getTopAnalyticsEvents', () => client.getTopAnalyticsEvents(pid, { limit: 5 }));
      await run('getTopAnalyticsScreens', () => client.getTopAnalyticsScreens(pid, { limit: 5 }));
      await run('getAnalyticsRetention', () => client.getAnalyticsRetention(pid, {}));
      await run('getAnalyticsFunnel', () => client.getAnalyticsFunnel(pid, { steps: ['app_open', 'purchase'] }));
      await run('getAnalyticsPerformance', () => client.getAnalyticsPerformance(pid, {}));
      await run('getAnalyticsCrashes', () => client.getAnalyticsCrashes(pid, {}));

      // ── SMTP ──
      await run('getSmtpSettings', () => client.getSmtpSettings(pid));
      await run('updateSmtpSettings', () => client.updateSmtpSettings(pid, { host: 'smtp.example.com', port: 587, username: 'u', password: 'p', fromEmail: 'a@b.com', fromName: 'X' }));
      await run('deleteSmtpSettings', () => client.deleteSmtpSettings(pid));

      // ── Logs ──
      await run('getLogs', () => client.getLogs(pid, { limit: 5 }));
      await run('getDatabaseLogs', () => client.getDatabaseLogs(pid, { limit: 5 }));
      await run('getSlowQueryLogs', () => client.getSlowQueryLogs(pid, { limit: 5 }));
      await run('getAuthLogs', () => client.getAuthLogs(pid, { limit: 5 }));
      await run('getEdgeFunctionLogs', () => client.getEdgeFunctionLogs(pid, { limit: 5 }));
      await run('exportLogs', () => client.exportLogs(pid, { format: 'json' }));
      await run('getLogStats', () => client.getLogStats(pid));
    } finally {
      await run('deleteProject(cleanup)', () => client.deleteProject(pid));
    }
  }

  // ── Report ──
  const pass = results.filter((r) => r.verdict === 'PASS').length;
  const info = results.filter((r) => r.verdict === 'INFO').length;
  const fail = results.filter((r) => r.verdict === 'FAIL').length;

  console.log('\n=== SDK INTEGRATION RESULTS ===');
  for (const r of results) {
    if (r.verdict !== 'PASS') console.log(`[${r.verdict}] ${r.name} :: ${r.detail}`);
  }
  console.log(`\nPASS ${pass}  |  INFO ${info} (non-contract errors, review)  |  FAIL ${fail} (contract mismatches)`);
  console.log('\nFULL LIST:');
  for (const r of results) console.log(`  ${r.verdict.padEnd(4)} ${r.name}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
