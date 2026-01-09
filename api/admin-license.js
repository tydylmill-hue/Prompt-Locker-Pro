import nodemailer from "nodemailer";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  const { email, license } = req.body;

  if (!email || !license) {
    return res.status(400).json({
      success: false,
      error: "Missing email or license",
    });
  }

  try {
    // SAME SMTP SETUP AS webhook.js
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      secure: process.env.SMTP_SECURE === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    await transporter.sendMail({
      from: `"Prompt Locker Pro" <${process.env.SMTP_FROM}>`,
      to: email,
      subject: "Your Prompt Locker Pro License Key",
      html: `
        <p>Hello,</p>
        <p>A license has been issued to you for <strong>Prompt Locker Pro</strong>.</p>
        <p><strong>Your license key:</strong></p>
        <p style="font-size:22px;font-weight:bold;">${license}</p>
        <p>Enter this key inside Prompt Locker Pro to activate.</p>
      `,
    });

    console.log("ADMIN LICENSE EMAIL SENT:", email);

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("ADMIN EMAIL ERROR:", err);
    return res.status(500).json({
      success: false,
      error: "Failed to send email",
    });
  }
}
