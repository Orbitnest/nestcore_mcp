/**
 * Fields that must never reach the model: a project's JWT signing secret, its
 * database passwords, the hashes / ciphertexts of its API keys, and stored
 * integration credentials (SMTP password, Twilio auth token, webhook secret
 * ciphertext, password hashes). (The anon and service_role keys themselves are
 * returned on purpose by the key tools.) The API already leaves these out; this
 * is a second line of defence so an older or misconfigured API can't put them
 * in an agent's context.
 */
const SECRET_FIELD = /^(jwt_?secret|db_password(_encrypted)?|db_service_password(_encrypted)?|(anon|service_role)_key_(hash|encrypted)|encryption_key|decryption_key|smtp_password(_encrypted)?|smtp_user_encrypted|(twilio_)?auth_token(_encrypted)?|secret_encrypted|password_hash)$/i;

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

export const MASK = '********';

/**
 * Replace the password of a `scheme://user:password@host...` URL with
 * {@link MASK}. Strings without inline credentials are returned unchanged.
 */
export function maskCredentialUrl(value: string): string {
  return value.replace(/^([a-z][a-z0-9+.-]*:\/\/[^:@/?#\s]*:)([^@/?#\s]*)(@)/i, (_m, pre: string, pw: string, at: string) =>
    pw ? `${pre}${MASK}${at}` : `${pre}${at}`,
  );
}

const PASSWORD_FIELD = /^(password|pass|passwd|db_password)$/i;

/**
 * Mask database credentials in a connection descriptor (any depth): every
 * `password` field becomes {@link MASK} and every credential URL string has its
 * password masked. Does not mutate the input.
 */
export function maskConnectionSecrets<T>(value: T): T {
  if (typeof value === 'string') return maskCredentialUrl(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => maskConnectionSecrets(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = PASSWORD_FIELD.test(k) && typeof v === 'string' && v ? MASK : maskConnectionSecrets(v);
    }
    return out as T;
  }
  return value;
}
