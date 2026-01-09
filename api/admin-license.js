/**
 * Vercel Serverless Function: /api/admin-license
 * Receives: { email, license, reason, source }
 * Sends an email using existing SMTP_* env vars (already set in your Vercel project)
 *
 * SECURITY:
 *  - If ADMIN_LICENSE_SECRET is set in Vercel env, this endpoint requires header:
 *      X-Admin-Secret: <ADMIN_LICENSE_SECRET>
 *  - CORS is restricted to your domains.
 */
import nodemailer from "nodemailer";

const ALLOWED_ORIGINS = new Set([
  "https://promptlockerpro.com",
  "https://www.promptlockerpro.com",
]);

function setCors(res, origin) {
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Secret");
}

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  setCors(res, origin);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== "POST") {
    return json(res, 405, { success: false, error: "Method not allowed" });
  }

  // Optional shared-secret auth
  const expected = process.env.ADMIN_LICENSE_SECRET;
  if (expected && expected.trim() !== "") {
    const got = req.headers["x-admin-secret"];
    if (!got || String(got) !== expected) {
      return json(res, 403, { success: false, error: "Forbidden" });
    }
  }

  const { email, license, reason } = req.body || {};
  if (!email || !license) {
    return json(res, 400, { success: false, error: "Missing email or license" });
  }

  // Build transporter from your existing Vercel env vars
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || user;

  if (!host || !user || !pass || !from) {
    return json(res, 500, { success: false, error: "SMTP env vars missing" });
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });

  const subject = "Your Prompt Locker Pro License Key";
  const text =
`Here is your Prompt Locker Pro license key:

${license}

Reason: ${reason || "admin_issue"}

If you did not request this, please ignore this email.`;

  try {
    await transporter.sendMail({
      from,
      to: email,
      subject,
      text,
    });

    return json(res, 200, { success: true });
  } catch (err) {
    return json(res, 500, { success: false, error: err?.message || "Email send failed" });
  }
}
