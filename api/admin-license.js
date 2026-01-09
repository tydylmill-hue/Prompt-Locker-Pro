/**
 * Vercel API Route: /api/admin-issue
 *
 * Purpose:
 *  - Create a Keygen license for a specific policyId (admin token)
 *  - Email the license key to the provided email (optional)
 *
 * Security:
 *  - Requires header: X-Admin-Issue-Secret
 *  - Must match process.env.ADMIN_ISSUE_SHARED_SECRET
 */

import nodemailer from "nodemailer";

function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function getHeader(req, name) {
  const key = Object.keys(req.headers || {}).find(
    (k) => k.toLowerCase() === name.toLowerCase()
  );
  return key ? req.headers[key] : undefined;
}

async function createKeygenLicense({ policyId, email, reason }) {
  const accountId = process.env.KEYGEN_ACCOUNT_ID;
  const adminKey = process.env.KEYGEN_ADMIN_API_KEY;

  if (!accountId || !adminKey) {
    throw new Error("Missing KEYGEN_ACCOUNT_ID or KEYGEN_ADMIN_API_KEY on Vercel");
  }

  const url = `https://api.keygen.sh/v1/accounts/${accountId}/licenses`;

  // Keygen JSON:API payload (policy determines product)
  const body = {
    data: {
      type: "licenses",
      attributes: {
        name: email ? `Admin Issue: ${email}` : "Admin Issue",
        metadata: {
          reason: reason || "admin_issue",
          email: email || "",
          issued_via: "vercel_admin_issue",
        },
      },
      relationships: {
        policy: {
          data: { type: "policies", id: policyId },
        },
      },
    },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/vnd.api+json",
      Accept: "application/vnd.api+json",
      Authorization: `Bearer ${adminKey}`,
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json().catch(() => null);

  if (!resp.ok) {
    const detail =
      data?.errors?.[0]?.detail ||
      data?.error ||
      `Keygen error (${resp.status})`;
    const meta = data?.meta?.id ? { requestId: data.meta.id } : undefined;
    const pointer = data?.errors?.[0]?.source?.pointer;
    throw new Error(
      pointer ? `${detail} (${pointer})` : detail + (meta ? ` [${meta.requestId}]` : "")
    );
  }

  const key = data?.data?.attributes?.key;
  if (!key) throw new Error("Keygen: license key missing from response");

  return { key, raw: data };
}

async function sendEmail({ to, licenseKey }) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || "587");
  const secure = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || user;

  if (!host || !user || !pass || !from) {
    throw new Error("Missing SMTP_* env vars on Vercel");
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });

  const subject = "Your Prompt Locker Pro License Key";
  const text =
`Thanks for using Prompt Locker Pro!

Here is your license key:

${licenseKey}

If you need help, reply to this email.`;

  await transporter.sendMail({
    from,
    to,
    subject,
    text,
  });
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== "POST") {
    return json(res, 405, { success: false, error: "Method not allowed" });
  }

  const secret = getHeader(req, "x-admin-issue-secret");
  if (!process.env.ADMIN_ISSUE_SHARED_SECRET) {
    return json(res, 500, { success: false, error: "Server missing ADMIN_ISSUE_SHARED_SECRET" });
  }
  if (!secret || secret !== process.env.ADMIN_ISSUE_SHARED_SECRET) {
    return json(res, 403, { success: false, error: "Forbidden" });
  }

  let body = req.body;
  if (!body) {
    // If Vercel didn't parse body (older runtimes), read it
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      body = null;
    }
  }

  const policyId = String(body?.policyId || "").trim();
  const email = String(body?.email || "").trim();
  const reason = String(body?.reason || "admin_issue").trim();

  if (!policyId) {
    return json(res, 400, { success: false, error: "Missing policyId" });
  }

  try {
    const { key } = await createKeygenLicense({ policyId, email, reason });

    let emailSent = false;
    if (email) {
      await sendEmail({ to: email, licenseKey: key });
      emailSent = true;
    }

    return json(res, 200, {
      success: true,
      license_key: key,
      email_sent: emailSent,
    });
  } catch (err) {
    return json(res, 500, {
      success: false,
      error: err?.message || "Unknown error",
    });
  }
}
