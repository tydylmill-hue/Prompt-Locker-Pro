import Stripe from "stripe";
import nodemailer from "nodemailer";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Stripe requires raw body
export const config = {
  api: { bodyParser: false },
};

// Collect raw body for Stripe signature validation
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Price → Policy mapping
const PRICE_TO_POLICY = {
  [process.env.STRIPE_PRICE_MONTHLY]: process.env.KEYGEN_POLICY_MONTHLY,
  [process.env.STRIPE_PRICE_YEARLY]: process.env.KEYGEN_POLICY_YEARLY,
  [process.env.STRIPE_PRICE_LIFETIME]: process.env.KEYGEN_POLICY_LIFETIME,
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (err) {
    console.error("RAW BODY ERROR:", err);
    return res.status(400).send("Invalid body");
  }

  // Stripe signature validation
  const signature = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("SIGNATURE ERROR:", err.message);
    return res.status(400).send(`Webhook signature error: ${err.message}`);
  }

  console.log("Stripe Event Received:", event.type);

  // Only process successful checkout
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    console.log("Processing Checkout Session:", session.id);

    // Fetch line items
    let lineItems;
    try {
      lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
        limit: 1,
      });
    } catch (err) {
      console.error("LINE ITEM FETCH ERROR:", err);
      return res.status(400).send("Unable to fetch line items");
    }

    const priceId =
      session.metadata?.price_id || lineItems.data?.[0]?.price?.id;

    if (!priceId) {
      console.error("PRICE ID NOT FOUND");
      return res.status(400).send("Missing price");
    }

    const policyId = PRICE_TO_POLICY[priceId];
    if (!policyId) {
      console.error("NO POLICY FOUND FOR PRICE:", priceId);
      return res.status(400).send("Invalid price mapping");
    }

    const customerEmail = session.customer_details?.email;
    if (!customerEmail) {
      console.error("NO CUSTOMER EMAIL");
      return res.status(400).send("Missing email");
    }

    //--------------------------------------------------
    // CREATE LICENSE VIA KEYGEN (CORRECT JSON FORMAT)
    //--------------------------------------------------

    const keygenUrl = `https://api.keygen.sh/v1/accounts/${process.env.KEYGEN_ACCOUNT_ID}/licenses`;

    console.log("Calling Keygen URL:", keygenUrl);

    let licenseKey;

    try {
      const keygenRes = await fetch(keygenUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.KEYGEN_API_TOKEN}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          data: {
            type: "licenses",
            attributes: {
              name: customerEmail,
            },
            relationships: {
              policy: {
                data: {
                  type: "policies",
                  id: policyId,
                },
              },
            },
          },
        }),
      });

      const keygenData = await keygenRes.json();

      if (!keygenRes.ok) {
        console.error("KEYGEN LICENSE ERROR:", keygenData);
        return res.status(400).send("Keygen license creation failed");
      }

      licenseKey = keygenData.data.attributes.key;
      console.log("LICENSE CREATED:", licenseKey);
    } catch (err) {
      console.error("KEYGEN REQUEST FAILED:", err);
      return res.status(500).send("Keygen API failure");
    }

    //--------------------------------------------------
    // SEND LICENSE EMAIL
    //--------------------------------------------------

    try {
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT),
        secure: false,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });

      await transporter.sendMail({
        from: `"Prompt Locker Pro" <${process.env.SMTP_FROM}>`,
        to: customerEmail,
        subject: "Your Prompt Locker Pro License Key",
        html: `
          <p>Thank you for your purchase!</p>
          <p><strong>Your license key:</strong></p>
          <p style="font-size: 22px; font-weight: bold;">${licenseKey}</p>
          <p>Enter this key inside Prompt Locker Pro to activate your license.</p>
        `,
      });

      console.log("EMAIL SENT:", customerEmail);
    } catch (err) {
      console.error("EMAIL ERROR:", err);
    }

    return res.status(200).send("Webhook processed");
  }

  return res.status(200).send("Event ignored");
}
