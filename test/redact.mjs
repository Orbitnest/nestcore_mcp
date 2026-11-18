// redactSecrets keeps project secrets out of tool output (run after `npm run build`).
import assert from 'node:assert/strict';
import { redactSecrets } from '../dist/utils/redact.js';

const input = {
  id: 'p1',
  slug: 'shop',
  anon_key: 'eyJ.anon',
  service_role_key: 'eyJ.service',
  jwt_secret: 'plain',
  jwtSecret: 'plain',
  db_password_encrypted: 'enc',
  anon_key_hash: '$2b$',
  service_role_key_encrypted: 'enc',
  nested: { project: { jwt_secret: 'x', name: 'Shop' } },
  list: [{ jwt_secret: 'y', id: 'a' }],
};
const out = redactSecrets(input);
const text = JSON.stringify(out);
assert.ok(!/jwt_?secret|_encrypted|_hash/i.test(text), `secrets left: ${text}`);
assert.equal(out.anon_key, 'eyJ.anon');
assert.equal(out.service_role_key, 'eyJ.service');
assert.equal(out.nested.project.name, 'Shop');
assert.equal(out.list[0].id, 'a');
assert.equal(input.jwt_secret, 'plain', 'input must not be mutated');
console.log('OK — redaction checks passed.');
