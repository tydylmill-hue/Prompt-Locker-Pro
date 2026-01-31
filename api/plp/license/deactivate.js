
/**
 * /api/plp/license/deactivate
 *
 * Deactivates a machine tied to a license.
 * Requires:
 *  - key
 *  - installId (fingerprint)
 *
 * Environment Variables Required:
 *  KEYGEN_ACCOUNT_ID
 *  KEYGEN_ADMIN_API_KEY
 */

export default async function handler(req, res) {

  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({
      valid: false,
      error: "method_not_allowed"
    });
  }

  try {

    const { key, installId } = req.body || {};

    if (!key || !installId) {
      return res.status(400).json({
        valid: false,
        error: "missing_parameters"
      });
    }

    const ACCOUNT = process.env.KEYGEN_ACCOUNT_ID;
    const ADMIN_KEY = process.env.KEYGEN_ADMIN_API_KEY;

    // STEP 1 — Validate license to fetch ID
    const licenseRes = await fetch(
      `https://api.keygen.sh/v1/accounts/${ACCOUNT}/licenses/actions/validate-key`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
          "Authorization": `Bearer ${ADMIN_KEY}`
        },
        body: JSON.stringify({
          meta: {
            key
          }
        })
      }
    );

    const licenseData = await licenseRes.json();

    if (!licenseData?.data?.id) {
      return res.status(404).json({
        valid: false,
        error: "license_not_found"
      });
    }

    const licenseId = licenseData.data.id;

    // STEP 2 — Find machine by fingerprint
    const machineSearch = await fetch(
      `https://api.keygen.sh/v1/accounts/${ACCOUNT}/machines?filter[fingerprint]=${installId}`,
      {
        headers: {
          "Authorization": `Bearer ${ADMIN_KEY}`,
          "Content-Type": "application/vnd.api+json"
        }
      }
    );

    const machineData = await machineSearch.json();

    if (!machineData?.data?.length) {
      return res.status(404).json({
        valid: false,
        error: "machine_not_found"
      });
    }

    const machineId = machineData.data[0].id;

    // STEP 3 — Delete machine
    await fetch(
      `https://api.keygen.sh/v1/accounts/${ACCOUNT}/machines/${machineId}`,
      {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${ADMIN_KEY}`,
          "Content-Type": "application/vnd.api+json"
        }
      }
    );

    return res.status(200).json({
      valid: true,
      status: "deactivated",
      machineId
    });

  } catch (err) {

    return res.status(500).json({
      valid: false,
      error: "server_error",
      detail: err.message
    });
  }
}
