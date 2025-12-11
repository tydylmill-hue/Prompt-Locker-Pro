import Stripe from 'stripe';
import { Keygen } from 'keygen';
import nodemailer from 'nodemailer';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const keygen = new Keygen(process.env.KEYGEN_ACCOUNT_TOKEN);
const transporter = nodemailer.createTransporter({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_details.email;
    const name = session.customer_details.name || 'Customer';

    if (!email) return res.status(400).send('No email');

    try {
      // Auto-generate key via Keygen (their format)
      const license = await keygen.licenses.create({
        policy: process.env.KEYGEN_POLICY_ID,
        name: name,
        email: email,
        metadata: { stripe_session_id: session.id }
      });

      await transporter.sendMail({
        from: process.env.SMTP_FROM,
        to: email,
        subject: 'Your Prompt Locker Pro License Key',
        text: `Thank you!\n\nYour license key: ${license.key}\n\nKeep it safe.\n\nBest,\nPrompt Locker Team`,
        html: `<p>Thank you!</p><p><strong>License key:</strong><br><code style="font-size:18px;">${license.key}</code></p>`
      });

      console.log(`Sent ${license.key} to ${email}`);
    } catch (err) {
      console.error(err);
      return res.status(500).send('Internal error');
    }
  }

  res.json({ received: true });
}