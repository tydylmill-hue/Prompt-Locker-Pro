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
// POLICY MAPPING — Update these IDs
//--------------------------------------
const PRICE_TO_POLICY = {
  // MONTHLY
  "price_1ScuGLRquHlFdzqXS2hSNUcv": process.env.KEYGEN_POLICY_MONTHLY,
  // YEARLY
  "price_1ScuGzRquHlFdzqXDvyBSf7C": process.env.KEYGEN_POLICY_YEARLY,
  // LIFETIME
  "price_1ScuHrRquHlFdzqX1uokZ9eZ": process.env.KEYGEN_POLICY_LIFETIME,
};

//--------------------------------------
// MAIN WEBHOOK HANDLER
//--------------------------------------
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (error) {
    console.error("RAW BODY ERROR:", error);
    return res.status(400).send("Invalid body");
  }

  const signature = req.headers["stripe-signature"];
  let event;

  //--------------------------------------
  // VERIFY STRIPE SIGNATURE
  //--------------------------------------
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("SIGNATURE ERROR:", err.message);
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  //--------------------------------------
  // HANDLE CHECKOUT SESSION COMPLETED
  //--------------------------------------
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    console.log("Checkout Session Completed:", session.id);

    //--------------------------------------
    // Fetch line items from Stripe
    //--------------------------------------
    let lineItems;
    try {
      lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
        limit: 1,
      });
    } catch (err) {
      console.error("LINE ITEM FETCH ERROR:", err);
      return res.status(400).send("Unable to fetch line items");
    }

    //--------------------------------------
    // SAFELY RESOLVE PRICE ID
    //--------------------------------------
    const priceId =
      session.metadata?.price_id ||
      lineItems.data?.[0]?.price?.id;

    if (!priceId) {
      console.error("PRICE ID NOT FOUND:", { session, lineItems });
      return res.status(400).send("Missing price ID");
    }

    //--------------------------------------
    // MAP PRICE → POLICY
    //--------------------------------------
    const policyId = PRICE_TO_POLICY[priceId];

    if (!policyId) {
      console.error("No policy found for price ID:", priceId);
      return res.status(400).send(`No policy for price ${priceId}`);
    }

    //--------------------------------------
    // EMAIL LOOKUP
    //--------------------------------------
    const customerEmail = session.customer_details?.email;
    if (!customerEmail) {
      console.error("NO CUSTOMER EMAIL");
      return res.status(400).send("Missing customer email");
    }

    //--------------------------------------
    // CREATE KEYGEN LICENSE
    //--------------------------------------
    let licenseKey;

    try {
      const keygenRes = await fetch(
        `https://api.keygen.sh/v1/${process.env.KEYGEN_ACCOUNT_ID}/licenses`,
        {
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
    } catch (err) {
      console.error("KEYGEN REQUEST FAILED:", err);
      return res.status(500).send("Keygen license creation failed");
    }

    //--------------------------------------
    // SEND EMAIL WITH LICENSE KEY
    //--------------------------------------
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
        text: `Thank you for your purchase!\n\nYour license key:\n\n${licenseKey}\n\nKeep this key safe.`,
        html: `<p>Thank you for your purchase!</p>
               <p><strong>Your license key:</strong></p>
               <p style="font-size:20px;font-weight:bold;">${licenseKey}</p>
               <p>Keep this key safe.</p>`,
      });

      console.log("EMAIL SENT to", customerEmail);
    } catch (err) {
      console.error("EMAIL ERROR:", err);
    }

    //--------------------------------------
    // SUCCESS
    //--------------------------------------
    return res.status(200).send("Webhook processed");
  }

  //--------------------------------------
  // UNHANDLED EVENT TYPES
  //--------------------------------------
  return res.status(200).send("Event ignored");
}

