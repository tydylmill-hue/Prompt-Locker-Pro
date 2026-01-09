import nodemailer from "nodemailer";

/**
 * 🔒 IMPORTANT:
 * Disable Next.js body parsing completely.
 * We will parse the raw stream ourselves.
 */
export const config = {
  api: {
    bodyParser: false,
  },
};

function json(res, status, body) {
  res.status(status);
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) throw new Error("Empty body");
  return JSON.parse(raw);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, { success: false, error: "Method not allowed" });
  }

  // 🔑 AUTH HEADER
  const secret = req.headers["x-admin-issue-secret"];
  if (!secret || secret !== process.env.ADMIN_ISSUE_SHARED_SECRET) {
    return json(res, 403, { success: false, error: "Forbidden" });
  }

  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    return json(res, 400, {
      success: false,
      error: "Invalid JSON body",
    });
  }

  const { policyId, email, reason } = body || {};

  if (!policyId) {
    return json(res, 400, {
      success: false,
      error: "Missing policyId",
    });
  }

  // 🔑 KEYGEN LICENSE CREATE
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

  const kgData = await kgRes.json().catch(() => null);

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
      error: "License key missing",
    });
  }

  // ✉️ EMAIL (ONLY AFTER LICENSE SUCCESS)
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
