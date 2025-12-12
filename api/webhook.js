import Stripe from 'stripe';
import nodemailer from 'nodemailer';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const transporter = nodemailer.createTransport({
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
      // Create license in Keygen using REST API
      const keygenResponse = await fetch(`https://api.keygen.sh/v1/accounts/${process.env.KEYGEN_ACCOUNT_ID}/licenses`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.KEYGEN_ACCOUNT_TOKEN}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          data: {
            type: 'licenses',
            attributes: {
              name: name,
              email: email
            },
            relationships: {
              policy: {
                data: { type: 'policies', id: process.env.KEYGEN_POLICY_ID }
              }
            }
          }
        })
      });

      if (!keygenResponse.ok) {
        const errorText = await keygenResponse.text();
        throw new Error(`Keygen API error: ${keygenResponse.status} ${errorText}`);
      }

      const licenseData = await keygenResponse.json();
      const licenseKey = licenseData.data.attributes.key;

      // Send email
      await transporter.sendMail({
        from: process.env.SMTP_FROM,
        to: email,
        subject: 'Your Prompt Locker Pro License Key',
        text: `Thank you for your purchase!\n\nYour license key: ${licenseKey}\n\nKeep it safe.\n\nBest,\nPrompt Locker Team`,
        html: `<p>Thank you for your purchase!</p><p><strong>License key:</strong><br><code style="font-size:18px;">${licenseKey}</code></p><p>Keep it safe.</p>`
      });

      console.log(`Sent ${licenseKey} to ${email}`);
    } catch (err) {
      console.error(err);
      return res.status(500).send('Internal error');
    }
  }

  res.json({ received: true });
}
