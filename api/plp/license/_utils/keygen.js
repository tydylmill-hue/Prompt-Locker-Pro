// api/plp/license/_utils/keygen.js
export const KEYGEN_API_BASE = 'https://api.keygen.sh/v1';

export function getEnv(name, fallback = undefined) {
  const v = process.env[name];
  return (v === undefined || v === null || v === '') ? fallback : v;
}

export function getEnforcementMode() {
  const m = (getEnv('ENFORCEMENT_MODE', 'off') || 'off').toLowerCase();
  return (m === 'soft' || m === 'strict') ? m : 'off';
}

export function getGraceHours() {
  const raw = getEnv('GRACE_HOURS', '72');
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 72;
}

export function getKeygenAccountId() {
  const id = getEnv('KEYGEN_ACCOUNT_ID');
  if (!id) throw new Error('Missing KEYGEN_ACCOUNT_ID');
  return id;
}

export function getKeygenAdminToken() {
  // Prefer explicit admin key env, fallback to KEYGEN_API_TOKEN
  const t = getEnv('KEYGEN_ADMIN_API_KEY') || getEnv('KEYGEN_API_TOKEN');
  if (!t) throw new Error('Missing KEYGEN_ADMIN_API_KEY (or KEYGEN_API_TOKEN)');
  return t;
}

export function keygenHeaders() {
  return {
    'Accept': 'application/vnd.api+json',
    'Content-Type': 'application/vnd.api+json',
    'Authorization': `Bearer ${getKeygenAdminToken()}`
  };
}

export async function keygenFetch(path, { method = 'GET', body = undefined } = {}) {
  const url = `${KEYGEN_API_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: keygenHeaders(),
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* ignore */ }
  return { ok: res.ok, status: res.status, data };
}

// --- Keygen helpers ---

export async function validateKey(key) {
  const accountId = getKeygenAccountId();
  return keygenFetch(`/accounts/${accountId}/licenses/actions/validate-key`, {
    method: 'POST',
    body: { meta: { key } }
  });
}

export function extractLicenseInfo(validateRespJson) {
  // validate-key returns { meta: { valid, code }, data: { id, attributes, relationships... } }
  const data = validateRespJson?.data;
  const meta = validateRespJson?.meta;

  const valid = !!meta?.valid;
  const code = meta?.code || 'UNKNOWN';

  const licenseId = data?.id || null;
  const expiryDate = data?.attributes?.expiry ?? null;

  const policyId = data?.relationships?.policy?.data?.id || null;

  return { valid, code, licenseId, expiryDate, policyId };
}

export function mapStatusFromCode(code) {
  const c = String(code || '').toUpperCase();
  // Keygen meta.code examples: VALID, EXPIRED, SUSPENDED, NOT_FOUND, etc.
  if (c === 'VALID') return 'active';
  if (c === 'EXPIRED') return 'expired';
  if (c === 'SUSPENDED') return 'suspended';
  if (c === 'NOT_FOUND') return 'not_found';
  return 'invalid';
}

export function policyNameFromId(policyId) {
  const monthly = getEnv('KEYGEN_POLICY_MONTHLY');
  const yearly = getEnv('KEYGEN_POLICY_YEARLY');
  const lifetime = getEnv('KEYGEN_POLICY_LIFETIME');
  const trial = getEnv('KEYGEN_POLICY_TRIAL');

  if (policyId && monthly && policyId === monthly) return 'Monthly';
  if (policyId && yearly && policyId === yearly) return 'Annual';
  if (policyId && lifetime && policyId === lifetime) return 'Lifetime';
  if (policyId && trial && policyId === trial) return 'Trial';
  return 'Pro';
}

export function cacheDurationForPolicy(policyId) {
  // Matches your PLP TTL strategy (server-side hint to client)
  const monthly = getEnv('KEYGEN_POLICY_MONTHLY');
  const yearly = getEnv('KEYGEN_POLICY_YEARLY');
  const lifetime = getEnv('KEYGEN_POLICY_LIFETIME');
  const trial = getEnv('KEYGEN_POLICY_TRIAL');

  const H = 60 * 60 * 1000;
  if (policyId && trial && policyId === trial) return 12 * H;
  if (policyId && monthly && policyId === monthly) return 24 * H;
  if (policyId && yearly && policyId === yearly) return 72 * H;
  if (policyId && lifetime && policyId === lifetime) return 7 * 24 * H;
  return 1 * H;
}

export async function findMachineByFingerprint(fingerprint) {
  const accountId = getKeygenAccountId();
  // Keygen supports filters in JSON:API style. If your account differs, adjust here.
  const q = encodeURIComponent(fingerprint);
  const path = `/accounts/${accountId}/machines?filter[fingerprint]=${q}&page[size]=1`;
  return keygenFetch(path, { method: 'GET' });
}

export async function createMachine({ licenseId, fingerprint, name = 'PLP', platform = 'chrome-extension' }) {
  const accountId = getKeygenAccountId();
  const path = `/accounts/${accountId}/machines`;

  const body = {
    data: {
      type: 'machines',
      attributes: {
        fingerprint,
        name,
        platform
      },
      relationships: {
        license: { data: { type: 'licenses', id: licenseId } }
      }
    }
  };

  return keygenFetch(path, { method: 'POST', body });
}

export async function readMachine(machineId) {
  const accountId = getKeygenAccountId();
  return keygenFetch(`/accounts/${accountId}/machines/${machineId}`, { method: 'GET' });
}

export async function readLicense(licenseId) {
  const accountId = getKeygenAccountId();
  return keygenFetch(`/accounts/${accountId}/licenses/${licenseId}`, { method: 'GET' });
}
