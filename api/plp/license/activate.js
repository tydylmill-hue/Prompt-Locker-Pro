// api/plp/license/activate.js
import {
  validateKey,
  extractLicenseInfo,
  mapStatusFromCode,
  policyNameFromId,
  cacheDurationForPolicy,
  getEnforcementMode,
  getGraceHours,
  findMachineByFingerprint,
  createMachine
} from './_utils/keygen.js';

import { json, badMethod, requireJson, safeString } from './_utils/http.js';

/**
 * POST /api/plp/license/activate
 * Body:
 * { key, installId, client?: { version?, browser? } }
 *
 * Behavior:
 * - validates key
 * - binds machine (creates machine using fingerprint=installId) if valid
 * - returns session payload (includes machineId, cacheDuration, enforcementMode)
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return badMethod(res);
  const body = requireJson(req) || {};

  const key = safeString(body.key);
  const installId = safeString(body.installId);

  if (!key) return json(res, 400, { valid: false, status: 'none', error: 'missing_key' });
  if (!installId) return json(res, 400, { valid: false, status: 'error', error: 'missing_installId' });

  const enforcementMode = getEnforcementMode();
  const graceHours = getGraceHours();

  // 1) Validate license key
  const v = await validateKey(key);
  if (!v.ok || !v.data) {
    return json(res, 502, { valid: false, status: 'error', enforcementMode, graceHours });
  }

  const info = extractLicenseInfo(v.data);
  const status = info.valid ? 'active' : mapStatusFromCode(info.code);

  if (!info.valid || !info.licenseId) {
    return json(res, 200, {
      valid: false,
      status,
      licenseId: info.licenseId,
      policyId: info.policyId,
      policyName: policyNameFromId(info.policyId),
      expiryDate: info.expiryDate,
      entitlements: { pro: false },
      cacheDuration: cacheDurationForPolicy(info.policyId),
      enforcementMode,
      graceHours
    });
  }

  // 2) Find or create machine by fingerprint (installId)
  // If create fails due to limits, return over_limit
  let machineId = null;

  // Try find existing machine for this fingerprint
  const found = await findMachineByFingerprint(installId);
  if (found.ok && found.data?.data?.length) {
    machineId = found.data.data[0]?.id || null;
  }

  if (!machineId) {
    const name = `PLP-${(body.client?.browser || 'browser').toString().slice(0,16)}`;
    const created = await createMachine({
      licenseId: info.licenseId,
      fingerprint: installId,
      name,
      platform: 'chrome-extension'
    });

    if (!created.ok) {
      // Keygen may return 422/409 for machine limit/uniqueness violations
      const http = created.status;
      // Treat common "limit reached" cases as over_limit (exact error details vary by Keygen config)
      if (http === 409 || http === 422) {
        return json(res, 200, {
          valid: false,
          status: 'over_limit',
          licenseId: info.licenseId,
          machineId: null,
          policyId: info.policyId,
          policyName: policyNameFromId(info.policyId),
          expiryDate: info.expiryDate,
          entitlements: { pro: false },
          cacheDuration: cacheDurationForPolicy(info.policyId),
          enforcementMode,
          graceHours
        });
      }

      return json(res, 502, {
        valid: false,
        status: 'error',
        licenseId: info.licenseId,
        machineId: null,
        enforcementMode,
        graceHours
      });
    }

    machineId = created.data?.data?.id || null;
  }

  return json(res, 200, {
    valid: true,
    status: 'active',
    licenseId: info.licenseId,
    machineId,
    policyId: info.policyId,
    policyName: policyNameFromId(info.policyId),
    expiryDate: info.expiryDate,
    entitlements: { pro: true },
    cacheDuration: cacheDurationForPolicy(info.policyId),
    enforcementMode,
    graceHours
  });
}
