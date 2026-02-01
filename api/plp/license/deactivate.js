/**
 * /api/plp/license/deactivate
 *
 * Deactivates a machine tied to a license by:
 * 1) Detaching the machine from the license (frees the seat)
 * 2) Deleting the machine record (cleanup)
 *
 * Required body:
 *  - key
 *  - installId (machine fingerprint)
 */

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ valid: false, error: 'method_not_allowed' });
  }

  try {
    // Vercel-safe body parsing
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { key, installId } = body || {};

    if (!key || !installId) {
      return res.status(400).json({ valid: false, error: 'missing_parameters' });
    }

    const ACCOUNT = process.env.KEYGEN_ACCOUNT_ID;
    const ADMIN_KEY = process.env.KEYGEN_ADMIN_API_KEY;

    if (!ACCOUNT || !ADMIN_KEY) {
      return res.status(500).json({ valid: false, error: 'server_misconfigured' });
    }

    /* STEP 1 — Validate license to get licenseId */
    const licenseRes = await fetch(
      `https://api.keygen.sh/v1/accounts/${ACCOUNT}/licenses/actions/validate-key`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/vnd.api+json',
          'Authorization': `Bearer ${ADMIN_KEY}`
        },
        body: JSON.stringify({ meta: { key } })
      }
    );

    const licenseJson = await licenseRes.json();
    const licenseId = licenseJson?.data?.id;

    if (!licenseId) {
      return res.status(404).json({ valid: false, error: 'license_not_found' });
    }

    /* STEP 2 — Locate machine by fingerprint */
    const machineRes = await fetch(
      `https://api.keygen.sh/v1/accounts/${ACCOUNT}/machines?filter[fingerprint]=${encodeURIComponent(installId)}`,
      {
        headers: {
          'Authorization': `Bearer ${ADMIN_KEY}`,
          'Content-Type': 'application/vnd.api+json'
        }
      }
    );

    const machineJson = await machineRes.json();
    const machineId = machineJson?.data?.[0]?.id;

    if (!machineId) {
      return res.status(200).json({
        valid: true,
        status: 'already_deactivated'
      });
    }

    /* STEP 3 — Detach machine from license */
    await fetch(
      `https://api.keygen.sh/v1/accounts/${ACCOUNT}/licenses/${licenseId}/relationships/machines`,
      {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${ADMIN_KEY}`,
          'Content-Type': 'application/vnd.api+json'
        },
        body: JSON.stringify({
          data: [{ type: 'machines', id: machineId }]
        })
      }
    );

    /* STEP 4 — Delete machine record */
    await fetch(
      `https://api.keygen.sh/v1/accounts/${ACCOUNT}/machines/${machineId}`,
      {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${ADMIN_KEY}`,
          'Content-Type': 'application/vnd.api+json'
        }
      }
    );

    return res.status(200).json({
      valid: true,
      status: 'deactivated',
      machineId
    });

  } catch (err) {
    console.error('[DEACTIVATE_ERROR]', err);
    return res.status(500).json({
      valid: false,
      error: 'server_error',
      detail: err.message
    });
  }
}
