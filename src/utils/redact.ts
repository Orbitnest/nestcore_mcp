/**
 * Fields that must never reach the model: a project's JWT signing secret, its
 * database passwords, and the hashes / ciphertexts of its API keys. (The anon
 * and service_role keys themselves are returned on purpose by the key tools.)
 * The API already leaves these out; this is a second line of defence so an
 * older or misconfigured API can't put them in an agent's context.
 */
const SECRET_FIELD = /^(jwt_?secret|db_password(_encrypted)?|db_service_password(_encrypted)?|(anon|service_role)_key_(hash|encrypted)|encryption_key|decryption_key)$/i;

export function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_FIELD.test(k)) continue;
      out[k] = redactSecrets(v);
    }
    return out as T;
  }
  return value;
}
