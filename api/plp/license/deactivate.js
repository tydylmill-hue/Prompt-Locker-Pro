// api/plp/license/deactivate.js
import {
  getKeygenAccountId,
  keygenFetch,
  readMachine,
  findMachineByFingerprint
} from './_utils/keygen.js';

import { json, badMethod, requireJson, safeString } from './_utils/http.js';

/**
 * POST /api/plp/license/deactivate
 * Body:
 *   { installId, licenseId?, machineId? }
 *
 * Industry-trusted flow:
 * - Client (PLP) never sends Keygen admin credentials.
 * - Client sends stable identifiers (installId + machineId/licenseId) that were returned by /activate.
 * - Server:
 *    1) Resolves machineId (prefer body.machineId; fallback by fingerprint)
 *    2) Verifies fingerprint matches installId (prevents cross-device deactivation)
 *    3) Resolves licenseId (prefer body.licenseId; fallback from machine relationship)
 *    4) Detaches machine from license (frees seat)
 *    5) Deletes machine record (cleanup)
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return badMethod(res);

  const body = requireJson(req) || {};

  const installId = safeString(body.installId);
  const licenseIdIn = safeString(body.licenseId);
  const machineIdIn = safeString(body.machineId);

  if (!installId) return json(res, 400, { valid: false, status: 'error', error: 'missing_installId' });

  // Resolve machineId
  let machineId = machineIdIn || null;
  let machine = null;

  if (machineId) {
    const m = await readMachine(machineId);
    if (m.ok && m.data?.data) {
      machine = m.data.data;
    } else if (m.status === 404) {
      // Machine already gone => nothing to deactivate
      return json(res, 200, { valid: true, status: 'already_deactivated', machineId });
    } else {
      return json(res, 502, { valid: false, status: 'error', error: 'machine_read_failed' });
    }
  } else {
    // Fallback: find by fingerprint
    const found = await findMachineByFingerprint(installId);
    if (found.ok && found.data?.data?.length) {
      machineId = found.data.data[0]?.id || null;
      machine = found.data.data[0] || null;
    }
  }

  if (!machineId) {
    return json(res, 200, { valid: true, status: 'already_deactivated', machineId: null });
  }

  // Fingerprint guard (prevents cross-device / malicious deactivation)
  const fp = machine?.attributes?.fingerprint || null;
  if (fp && fp !== installId) {
    return json(res, 403, { valid: false, status: 'error', error: 'fingerprint_mismatch' });
  }

  // Resolve licenseId
  let licenseId = licenseIdIn || null;

  if (!licenseId) {
    const relLic = machine?.relationships?.license?.data?.id || null;
    if (relLic) licenseId = relLic;
  }

  if (!licenseId) {
    return json(res, 400, { valid: false, status: 'error', error: 'missing_licenseId' });
  }

  // 1) Detach machine from license (frees seat)
  const accountId = getKeygenAccountId();
  const detachPath = `/accounts/${accountId}/licenses/${licenseId}/relationships/machines`;

  const detach = await keygenFetch(detachPath, {
    method: 'DELETE',
    body: { data: [{ type: 'machines', id: machineId }] }
  });

  // Detach may 404 if license was removed; still continue with delete as cleanup.
  if (!detach.ok && detach.status !== 404 && detach.status !== 409) {
      return json(res, 502, { valid: false, status: 'error', error: 'detach_failed', http: detach.status });
}

  // 2) Delete machine record (cleanup)
  const delPath = `/accounts/${accountId}/machines/${machineId}`;
  const del = await keygenFetch(delPath, { method: 'DELETE' });

  // Treat 404 as already deleted
  if (!del.ok && del.status !== 404) {
      return json(res, 502, { valid: false, status: 'error', error: 'delete_failed', http: del.status });
}

  return json(res, 200, {
    valid: true,
    status: 'deactivated',
    licenseId,
    machineId
  });
}
