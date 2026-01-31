// api/plp/license/verify.js
import {
  readLicense,
  readMachine,
  createMachine,
  findMachineByFingerprint,
  getEnforcementMode,
  getGraceHours,
  policyNameFromId,
  cacheDurationForPolicy
} from './_utils/keygen.js';

import { json, badMethod, requireJson, safeString } from './_utils/http.js';

/**
 * POST /api/plp/license/verify
 * Body:
 * { installId, licenseId, machineId }
 *
 * Behavior:
 * - reads license from Keygen
 * - enforcementMode controls machine requirements:
 *    off:  license validity only (no lockout for missing machine)
 *    soft: bind machine if missing (best migration step)
 *    strict: require machine bound and fingerprint match
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return badMethod(res);
  const body = requireJson(req) || {};

  const installId = safeString(body.installId);
  const licenseId = safeString(body.licenseId);
  const machineIdIn = safeString(body.machineId);

  const enforcementMode = getEnforcementMode();
  const graceHours = getGraceHours();

  if (!installId) return json(res, 400, { valid: false, status: 'error', error: 'missing_installId', enforcementMode, graceHours });
  if (!licenseId) return json(res, 400, { valid: false, status: 'none', error: 'missing_licenseId', enforcementMode, graceHours });

  // 1) Read license
  const lic = await readLicense(licenseId);
  if (!lic.ok || !lic.data?.data) {
    return json(res, 200, { valid: false, status: 'invalid', enforcementMode, graceHours });
  }

  const licData = lic.data.data;
  const licStatus = (licData.attributes?.status || '').toLowerCase(); // e.g. "active"
  const expiryDate = licData.attributes?.expiry ?? null;
  const policyId = licData.relationships?.policy?.data?.id || null;

  const isActive = licStatus === 'active';

  // If license isn't active, lock regardless of mode
  if (!isActive) {
    return json(res, 200, {
      valid: false,
      status: licStatus || 'invalid',
      licenseId,
      machineId: null,
      policyId,
      policyName: policyNameFromId(policyId),
      expiryDate,
      entitlements: { pro: false },
      cacheDuration: cacheDurationForPolicy(policyId),
      enforcementMode,
      graceHours
    });
  }

  // 2) Machine handling based on enforcementMode
  let machineId = machineIdIn || null;

  // Attempt to read provided machineId (if any)
  let machine = null;
  if (machineId) {
    const m = await readMachine(machineId);
    if (m.ok && m.data?.data) machine = m.data.data;
    else machineId = null;
  }

  // If missing machine, try lookup by fingerprint
  if (!machineId) {
    const found = await findMachineByFingerprint(installId);
    if (found.ok && found.data?.data?.length) {
      machineId = found.data.data[0]?.id || null;
      machine = found.data.data[0] || null;
    }
  }

  // enforcementMode: off -> do not require machine
  if (enforcementMode === 'off') {
    return json(res, 200, {
      valid: true,
      status: 'active',
      licenseId,
      machineId: machineId || null,
      policyId,
      policyName: policyNameFromId(policyId),
      expiryDate,
      entitlements: { pro: true },
      cacheDuration: cacheDurationForPolicy(policyId),
      enforcementMode,
      graceHours
    });
  }

  // enforcementMode: soft -> try to bind if missing
  if (enforcementMode === 'soft') {
    if (!machineId) {
      const created = await createMachine({
        licenseId,
        fingerprint: installId,
        name: 'PLP-browser',
        platform: 'chrome-extension'
      });

      if (created.ok) {
        machineId = created.data?.data?.id || null;
      } else {
        // In soft mode, don't hard lock for bind failures; still allow active.
        machineId = null;
      }
    }

    return json(res, 200, {
      valid: true,
      status: 'active',
      licenseId,
      machineId: machineId || null,
      policyId,
      policyName: policyNameFromId(policyId),
      expiryDate,
      entitlements: { pro: true },
      cacheDuration: cacheDurationForPolicy(policyId),
      enforcementMode,
      graceHours
    });
  }

  // enforcementMode: strict -> require machine and fingerprint match
  if (!machineId) {
    return json(res, 200, {
      valid: false,
      status: 'over_limit', // or "unactivated" – keeping simple + actionable
      licenseId,
      machineId: null,
      policyId,
      policyName: policyNameFromId(policyId),
      expiryDate,
      entitlements: { pro: false },
      cacheDuration: cacheDurationForPolicy(policyId),
      enforcementMode,
      graceHours
    });
  }

  // If we have machine object, verify fingerprint match if available
  const fp = machine?.attributes?.fingerprint || null;
  if (fp && fp !== installId) {
    return json(res, 200, {
      valid: false,
      status: 'over_limit',
      licenseId,
      machineId,
      policyId,
      policyName: policyNameFromId(policyId),
      expiryDate,
      entitlements: { pro: false },
      cacheDuration: cacheDurationForPolicy(policyId),
      enforcementMode,
      graceHours
    });
  }

  return json(res, 200, {
    valid: true,
    status: 'active',
    licenseId,
    machineId,
    policyId,
    policyName: policyNameFromId(policyId),
    expiryDate,
    entitlements: { pro: true },
    cacheDuration: cacheDurationForPolicy(policyId),
    enforcementMode,
    graceHours
  });
}
