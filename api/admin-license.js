export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const { policy, email, reason } = req.body;

  const POLICY_MAP = {
    trial: '6dcac539-ae20-43fd-b147-3d3b2ad8cc10',
    month: '28deb095-05bf-4027-aad3-a1e53a5d6029',
    year: 'd309d562-ad08-406a-8ad8-278751a949a6'
  };

  const policyId = POLICY_MAP[policy];

  if (!policyId) {
    return res.status(400).json({
      success: false,
      error: 'Unknown policy (no policyId and no matching policy constant)',
      received: { policy }
    });
  }

  try {
    const response = await fetch('https://api.keygen.sh/v1/licenses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/vnd.api+json',
        'Authorization': `Bearer ${process.env.KEYGEN_ADMIN_API_KEY}`
      },
      body: JSON.stringify({
        data: {
          type: 'licenses',
          relationships: {
            policy: {
              data: { type: 'policies', id: policyId }
            }
          },
          attributes: {
            metadata: {
              issued_by: 'admin',
              reason: reason || 'admin_issue',
              email: email || null
            }
          }
        }
      })
    });

    const json = await response.json();

    if (!response.ok) {
      return res.status(500).json({ success: false, error: json });
    }

    const licenseKey = json.data.attributes.key;

    return res.status(200).json({
      success: true,
      license: licenseKey
    });

  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
}
