import Stripe from "stripe";
import nodemailer from "nodemailer";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

//-----------------------------------------
// Vercel must NOT parse the body
//-----------------------------------------
export const config = {
  api: {
    bodyParser: false,
  },
};

//-----------------------------------------
// RAW BODY READER (Required by Stripe)
//-----------------------------------------
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

//-----------------------------------------
// PRICE → POLICY MAP
//-----------------------------------------
const PRICE_TO_POLICY = {
  "price_1ScuGLRquHlFdzqXS2hSNUcv": process.env.KEYGEN_POLICY_MONTHLY,
  "price_1ScuGzRquHlFdzqXDvyBSf7C": process.env.KEYGEN_POLICY_YEARLY,
  "price_1ScuHrRquHlFdzqX1uokZ9eZ": process.env.KEYGEN_POLICY_LIFETIME,
};

//-----------------------------------------
// SUCCESS EVENT TYPES (Stripe)
//-----------------------------------------
const CHECKOUT_SUCCESS_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
];

//-----------------------------------------
// WEBHOOK HANDLER
//-----------------------------------------
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (error) {
    console.error("RAW BODY PARSE ERROR:", error);
    return res.status(400).send("Invalid body");
  }

  const signature = req.headers["stripe-signature"];
  let event;

  //-----------------------------------------
  // STRIPE SIGNATURE CHECK
  //-----------------------------------------
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("SIGNATURE ERROR:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log("Stripe Event Received:", event.type);

  //-----------------------------------------
  // PROCESS CHECKOUT SUCCESS EVENTS
  //-----------------------------------------
  if (CHECKOUT_SUCCESS_EVENTS.includes(event.type)) {
    const session = event.data.object;

    console.log("Processing Session:", session.id);

    //-----------------------------------------
    // FETCH LINE ITEMS (NEEDED FOR PRICE ID)
    //-----------------------------------------
    let lineItems;
    try {
      lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
        limit: 1,
      });
    } catch (err) {
      console.error("LINE ITEM FETCH FAILED:", err);
      return res.status(400).send("Cannot fetch line items");
    }

    const priceId =
      session.metadata?.price_id ||
      lineItems.data?.[0]?.price?.id;

    if (!priceId) {
      console.error("PRICE ID NOT FOUND", { session, lineItems });
      return res.status(400).send("Missing price ID");
    }

    //-----------------------------------------
    // MAP PRICE → KEYGEN POLICY
    //-----------------------------------------
    const policyId = PRICE_TO_POLICY[priceId];

    if (!policyId) {
      console.error("NO POLICY MATCH FOR PRICE:", priceId);
      return res.status(400).send(`No policy for price ${priceId}`);
    }

    const customerEmail = session.customer_details?.email;

    if (!customerEmail) {
      console.error("CUSTOMER EMAIL MISSING");
      return res.status(400).send("Customer email missing");
    }

    //-----------------------------------------
    // CREATE KEYGEN LICENSE
    //-----------------------------------------
    let licenseKey;

    try {
      const keygenRes = await fetch(
        `https://api.keygen.sh/v1/${process.env.KEYGEN_ACCOUNT_ID}/licenses`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${process.env.KEYGEN_API_TOKEN}`,
            "Accept": "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            data: {
              type: "licenses",
              attributes: {
                policy: policyId,
                name: customerEmail,
              },
            },
          }),
        }
      );

      const keygenData = await keygenRes.json();

      if (!keygenData?.data?.attributes?.key) {
        console.error("KEYGEN LICENSE ERROR:", keygenData);
        return res.status(400).send("Keygen license creation failed");
      }

      licenseKey = keygenData.data.attributes.key;
      console.log("LICENSE CREATED:", licenseKey);

    } catch (err) {
      console.error("KEYGEN REQUEST FAILED:", err);
      return res.status(500).send("Keygen request failed");
    }

    //-----------------------------------------
    // SEND LICENSE EMAIL
    //-----------------------------------------
    try {
      const transporter = nodemailer.createTransport({
        host: "smtp.porkbun.com",
        port: 587,
        secure: false,
        auth: {
          user: process.env.EMAIL_SMTP_USER,
          pass: process.env.EMAIL_SMTP_PASS,
        },
      });

      await transporter.sendMail({
        from: `"Prompt Locker Pro" <${process.env.EMAIL_SMTP_USER}>`,
        to: customerEmail,
        subject: "Your Prompt Locker Pro License Key",
        html: `
            <p>Thank you for your purchase!</p>
            <p><strong>Your license key:</strong></p>
            <p style="font-size:22px;font-weight:bold;">${licenseKey}</p>
            <p>Please store it safely.</p>
          `,
      });

      console.log("EMAIL SENT TO:", customerEmail);
    } catch (err) {
      console.error("EMAIL ERROR:", err);
    }

    return res.status(200).send("Webhook processed");
  }

  //-----------------------------------------
  // UNHANDLED EVENTS
  //-----------------------------------------
  return res.status(200).send("Event ignored");
}
