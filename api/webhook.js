import Stripe from "stripe";
import nodemailer from "nodemailer";

export const config = {
  api: {
    bodyParser: false,
  },
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Utility to read raw Stripe webhook body in Vercel
async function getRawBody(req) {
  return await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", err => reject(err));
  });
}

// Keygen REST API request
async function createKeygenLicense(email, name, policyId) {
  const accountId = process.env.KEYGEN_ACCOUNT_ID;
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
            policy: { data: { type: "policies", id: policyId }},
            product: { data: { type: "products", id: productId }}
          }
        }
      })
    }
  );

  const json = await response.json();

  if (!json.data?.attributes?.key) {
    console.error("Keygen error:", json);
    throw new Error("Keygen license creation failed");
  }

  return json.data.attributes.key;
}

// Nodemailer transporter
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// Map Stripe price → Keygen policy
function getPolicyForPrice(priceId) {
  switch (priceId) {

    case "price_1ScuGLRquHlFdzqXS2hSNUcv":  // Monthly
      return process.env.KEYGEN_POLICY_ID_MONTHLY;

    case "price_1ScuGzRquHlFdzqXDvyBSf7C":  // Yearly
      return process.env.KEYGEN_POLICY_ID_YEARLY;

    case "price_1ScuHrRquHlFdzqX1uokZ9eZ":  // Lifetime
      return process.env.KEYGEN_POLICY_ID_LIFETIME;

    default:
      throw new Error(`Unknown Stripe price ID: ${priceId}`);
  }
}

// Webhook handler
export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (err) {
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
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  // Only respond to completed checkout sessions
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    const email = session.customer_details?.email;
    const name = session.customer_details?.name || "Customer";

    // Stripe does NOT include price_id directly in session
    const priceId = session.metadata?.price_id ||
                    session.display_items?.[0]?.price?.id ||
                    session.line_items?.data?.[0]?.price?.id;

    if (!email) return res.status(400).send("Missing customer email");
    if (!priceId) return res.status(400).send("Missing price ID");

    try {
      // Determine correct Keygen policy
      const policyId = getPolicyForPrice(priceId);

      // Create license in Keygen
      const licenseKey = await createKeygenLicense(email, name, policyId);

      // Build plan label
      let planLabel = "Your License";
      if (priceId === "price_1ScuGLRquHlFdzqXS2hSNUcv") planLabel = "Your Monthly License";
      if (priceId === "price_1ScuGzRquHlFdzqXDvyBSf7C") planLabel = "Your Annual License";
      if (priceId === "price_1ScuHrRquHlFdzqX1uokZ9eZ") planLabel = "Your Lifetime License";

      // Send email
      await transporter.sendMail({
        from: process.env.SMTP_FROM,
        to: email,
        subject: `${planLabel} for Prompt Locker Pro`,
        html: `
          <p>Thank you for your purchase of Prompt Locker Pro!</p>
          <p>${planLabel}:</p>
          <p><strong style="font-size: 20px;">${licenseKey}</strong></p>
          <p>Enter this key inside Prompt Locker Pro to activate your license.</p>
          <p>Keep this key safe.</p>
          <p>- Prompt Locker Pro Team</p>
        `,
      });

      console.log(`Sent ${planLabel} to ${email}: ${licenseKey}`);

    } catch (err) {
      console.error("Processing error:", err);
      return res.status(500).send("License creation failed");
    }
  }

  return res.json({ received: true });
}
