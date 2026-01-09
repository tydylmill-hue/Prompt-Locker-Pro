import nodemailer from "nodemailer";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  // 🔐 AUTH
  const secret = req.headers["x-admin-issue-secret"];
  if (secret !== process.env.ADMIN_ISSUE_SHARED_SECRET) {
    return res.status(403).json({ success: false, error: "Forbidden" });
  }

  // ✅ VERCEL STANDARD: req.body IS ALREADY PARSED
  const { policyId, email, reason } = req.body || {};

  if (!policyId || typeof policyId !== "string") {
    return res.status(400).json({
      success: false,
      error: "Invalid policyId",
      received: req.body,
    });
  }

  // 🔑 CREATE LICENSE (KEYGEN)
  const kgRes = await fetch(
    `https://api.keygen.sh/v1/accounts/${process.env.KEYGEN_ACCOUNT_ID}/licenses`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/vnd.api+json",
        Accept: "application/vnd.api+json",
        Authorization: `Bearer ${process.env.KEYGEN_ADMIN_API_KEY}`,
      },
      body: JSON.stringify({
        data: {
          type: "licenses",
          attributes: {
            name: email ? `Admin Issue: ${email}` : "Admin Issue",
            metadata: { email, reason },
          },
          relationships: {
            policy: {
              data: { type: "policies", id: policyId },
            },
          },
        },
      }),
    }
  );

  const kgData = await kgRes.json();

  if (!kgRes.ok) {
    return res.status(kgRes.status).json({
      success: false,
      error: kgData?.errors?.[0]?.detail || "Keygen error",
    });
  }

  const licenseKey = kgData?.data?.attributes?.key;
  if (!licenseKey) {
    return res.status(500).json({
      success: false,
      error: "License key missing",
    });
  }

  // ✉️ EMAIL
  if (email) {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: email,
      subject: "Your Prompt Locker Pro License Key",
      text: `Here is your license key:\n\n${licenseKey}`,
    });
  }

  return res.status(200).json({
    success: true,
    license_key: licenseKey,
    emailed: Boolean(email),
  });
}
