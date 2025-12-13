import Stripe from "stripe";
import nodemailer from "nodemailer";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

//--------------------------------------
// Vercel must NOT parse the body
//--------------------------------------
export const config = {
  api: {
    bodyParser: false,
  },
};

//--------------------------------------
// RAW BODY READER (Required by Stripe)
//--------------------------------------
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

//--------------------------------------
// PRICE → POLICY MAP
//--------------------------------------
const PRICE_TO_POLICY = {
  "price_1ScuGLRquHlFdzqXS2hSNUcv": process.env.KEYGEN_POLICY_MONTHLY,
  "price_1ScuGzRquHlFdzqXDvyBSf7C": process.env.KEYGEN_POLICY_YEARLY,
  "price_1ScuHrRquHlFdzqX1uokZ9eZ": process.env.KEYGEN_POLICY_LIFETIME,
};

//--------------------------------------
// MAIN HANDLER
//--------------------------------------
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (error) {
    console.error("RAW BODY ERROR:", error);
    return res.status(400).send("Invalid body");
  }

  //--------------------------------------
  // VERIFY STRIPE SIGNATURE
  //--------------------------------------
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
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log("Stripe Event Received:", event.type);

  //--------------------------------------
  // HANDLE CHECKOUT SUCCESS
  //--------------------------------------
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
      return res.status(400).send("Cannot fetch line items");
    }

    // Determine price ID
    const priceId =
      session.metadata?.price_id ||
      lineItems.data?.[0]?.price?.id;

    if (!priceId) {
      console.error("NO PRICE ID FOUND:", { session, lineItems });
      return res.status(400).send("Missing price ID");
    }

    const policyId = PRICE_TO_POLICY[priceId];

    if (!policyId) {
      console.error("NO POLICY FOUND:", priceId);
      return res.status(400).send("Invalid price → No matching policy");
    }

    const customerEmail = session.customer_details?.email;

    if (!customerEmail) {
      console.error("NO EMAIL FOUND");
      return res.status(400).send("Missing customer email");
    }

    //--------------------------------------
    // CREATE KEYGEN LICENSE (VALID JSON API FORMAT)
    //--------------------------------------
    let licenseKey;

    const keygenURL = `https://api.keygen.sh/v1/${process.env.KEYGEN_ACCOUNT_ID}/licenses`;

    try {
      const response = await fetch(keygenURL, {
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

      const data = await response.json();

      if (!data?.data?.attributes?.key) {
        console.error("KEYGEN LICENSE ERROR:", data);
        return res.status(400).send("Keygen license creation failed");
      }

      licenseKey = data.data.attributes.key;
      console.log("LICENSE CREATED:", licenseKey);

    } catch (err) {
      console.error("KEYGEN REQUEST FAILED:", err);
      return res.status(500).send("Keygen request failed");
    }

    //--------------------------------------
    // SEND LICENSE EMAIL
    //--------------------------------------
    try {
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
        from: `"Prompt Locker Pro" <${process.env.SMTP_USER}>`,
        to: customerEmail,
        subject: "Your Prompt Locker Pro License Key",
        text: `Thank you for your purchase!\n\nYour license key:\n${licenseKey}`,
        html: `<p>Thank you for your purchase!</p>
               <p>Your license key:</p>
               <p style="font-size:20px;font-weight:bold">${licenseKey}</p>`,
      });

      console.log("EMAIL SENT:", customerEmail);
    } catch (err) {
      console.error("EMAIL ERROR:", err);
      // Do NOT fail the webhook just because email sending failed
    }

    return res.status(200).send("Webhook processed");
  }

  return res.status(200).send("Event ignored");
}
