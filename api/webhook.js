import Stripe from "stripe";
import nodemailer from "nodemailer";

// Stripe requires raw body parsing for webhooks on Vercel
export const config = {
  api: {
    bodyParser: false,
  },
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Utility to read raw request body on Vercel
async function getRawBody(req) {
  return await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", err => reject(err));
  });
}

// Keygen REST function (since SDK does NOT exist)
async function createKeygenLicense(email, name) {
  const accountId = process.env.KEYGEN_ACCOUNT_ID;
  const policyId = process.env.KEYGEN_POLICY_ID;
  const productId = process.env.KEYGEN_PRODUCT_ID;
  const token = process.env.KEYGEN_API_TOKEN;

  const response = await fetch(
    `https://api.keygen.sh/v1/accounts/${accountId}/licenses`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        data: {
          type: "licenses",
          attributes: {
            name: name || email,
          },
          relationships: {
            policy: {
              data: { type: "policies", id: policyId }
            },
            product: {
              data: { type: "products", id: productId }
            }
          }
        }
      })
    }
  );

  const json = await response.json();

  if (!json.data || !json.data.attributes || !json.data.attributes.key) {
    console.error("Keygen Error:", json);
    throw new Error("Failed to generate license key");
  }

  return json.data.attributes.key;
}

// Email transporter (FIXED name: createTransport)
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// Webhook handler
export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (err) {
    console.error("Error reading raw body:", err);
    return res.status(400).send("Invalid body");
  }

  const signature = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature error:", err.message);
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  // Handle purchase event
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const email = session.customer_details?.email;
    const name = session.customer_details?.name || "Customer";

    if (!email) {
      console.error("No email found in session");
      return res.status(400).send("Missing email");
    }

    try {
      // Generate Keygen license
      const licenseKey = await createKeygenLicense(email, name);

      // Send email
      await transporter.sendMail({
        from: process.env.SMTP_FROM,
        to: email,
        subject: "Your Prompt Locker Pro License Key",
        text: `Thank you for your purchase!\n\nYour license key:\n${licenseKey}\n\nKeep this safe.\n\nPrompt Locker Pro Team`,
        html: `
          <p>Thank you for your purchase!</p>
          <p>Your license key:</p>
          <p><code style="font-size: 18px;">${licenseKey}</code></p>
          <p>Keep this key safe.</p>
          <p>– Prompt Locker Pro Team</p>
        `
      });

      console.log(`License sent to ${email}: ${licenseKey}`);
    } catch (err) {
      console.error("ERROR while processing checkout:", err);
      return res.status(500).send("Internal server error");
    }
  }

  return res.json({ received: true });
}
