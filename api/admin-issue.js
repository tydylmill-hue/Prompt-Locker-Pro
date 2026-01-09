import nodemailer from "nodemailer";

function json(res, status, body) {
  res.status(status);
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

// 🔒 Ensure body parsing is NOT skipped
export const config = {
  api: {
    bodyParser: true,
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, { success: false, error: "Method not allowed" });
  }

  // 🔑 AUTH
  const secret = req.headers["x-admin-issue-secret"];
  if (!secret || secret !== process.env.ADMIN_ISSUE_SHARED_SECRET) {
    return json(res, 403, { success: false, error: "Forbidden" });
  }

  // 🔧 HARD PARSE BODY (NO TRUST IN req.body)
  let body = req.body;
  if (!body || typeof body !== "object") {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return json(res, 400, { success: false, error: "Invalid JSON body" });
    }
  }

  const { policyId, email, reason } = body;

  if (!policyId) {
    return json(res, 400, {
      success: false,
      error: "Missing policyId",
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
    return json(res, kgRes.status, {
      success: false,
      error: kgData?.errors?.[0]?.detail || "Keygen error",
    });
  }

  const licenseKey = kgData?.data?.attributes?.key;
  if (!licenseKey) {
    return json(res, 500, {
      success: false,
      error: "License key missing from Keygen response",
    });
  }

  // ✉️ EMAIL (OPTIONAL)
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

  return json(res, 200, {
    success: true,
    license_key: licenseKey,
    emailed: !!email,
  });
}
