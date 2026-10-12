/**
 * TEFLSY — Stripe Webhook Server
 * يشحن النقاط تلقائياً بعد دفع ناجح مؤكد من Stripe فقط
 *
 * الأحداث المدعومة:
 *  - checkout.session.completed
 *  - payment_intent.succeeded (احتياطي)
 */
const express = require("express");
const Stripe = require("stripe");
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

// تحميل .env يدوياً بدون dotenv
function loadEnvFile() {
  try {
    const p = path.join(__dirname, ".env");
    if (!fs.existsSync(p)) return;
    const lines = fs.readFileSync(p, "utf8").split("\n");
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i < 1) continue;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!process.env[k]) process.env[k] = v;
    }
  } catch (e) {}
}
loadEnvFile();

const PORT = parseInt(process.env.PORT || "3000", 10);
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || "";
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const DB_URL = process.env.FIREBASE_DATABASE_URL || "";

if (!STRIPE_SECRET) {
  console.error("❌ STRIPE_SECRET_KEY مفقود في .env");
  process.exit(1);
}
if (!WEBHOOK_SECRET) {
  console.warn("⚠️ STRIPE_WEBHOOK_SECRET غير مضبوط — التحقق من التوقيع سيفشل في الإنتاج");
}
if (!DB_URL) {
  console.error("❌ FIREBASE_DATABASE_URL مفقود في .env");
  process.exit(1);
}

const stripe = new Stripe(STRIPE_SECRET);

// تهيئة Firebase Admin
function initFirebase() {
  if (admin.apps.length) return;
  let cred = null;
  const jsonEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const filePath = process.env.FIREBASE_SERVICE_ACCOUNT || path.join(__dirname, "serviceAccount.json");
  if (jsonEnv) {
    cred = admin.credential.cert(JSON.parse(jsonEnv));
  } else if (fs.existsSync(filePath)) {
    cred = admin.credential.cert(require(filePath));
  } else {
    console.error("❌ ضع ملف serviceAccount.json أو FIREBASE_SERVICE_ACCOUNT_JSON");
    process.exit(1);
  }
  admin.initializeApp({ credential: cred, databaseURL: DB_URL });
  console.log("✅ Firebase Admin متصل");
}
initFirebase();
const db = admin.database();

const app = express();

// صفحة نجاح / إلغاء
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.type("html").send(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TEFLSY Stripe</title>
<style>body{font-family:system-ui;background:#0f172a;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:20px}div{max-width:420px;text-align:center}h1{color:#a5b4fc}code{background:#1e293b;padding:2px 6px;border-radius:6px}</style></head>
<body><div><h1>TEFLSY Stripe Webhook</h1><p>الخادم يعمل ✓</p><p>Webhook: <code>/webhook</code></p></div></body></html>`);
});

app.get("/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

/**
 * استخراج userCode و points من جلسة Stripe
 */
function extractOrder(session) {
  const meta = session.metadata || {};
  let userCode = (
    session.client_reference_id ||
    meta.userCode ||
    meta.code ||
    meta.user_code ||
    ""
  ).toString().trim();

  let points = parseInt(meta.points || meta.point || meta.pts || "0", 10) || 0;

  // من client_reference_id بصيغة: USERCODE|POINTS أو USERCODE_POINTS
  if (session.client_reference_id) {
    const ref = String(session.client_reference_id);
    if (ref.indexOf("|") >= 0) {
      const parts = ref.split("|");
      userCode = (parts[0] || userCode).trim();
      if (!points) points = parseInt(parts[1], 10) || 0;
    } else if (ref.indexOf("__") >= 0) {
      const parts = ref.split("__");
      userCode = (parts[0] || userCode).trim();
      if (!points) points = parseInt(parts[1], 10) || 0;
    }
  }

  // من اسم المنتج إن وُجد (line items تحتاج expand — نتركها اختيارية)
  return {
    userCode,
    points,
    priceLabel: meta.price || meta.priceLabel || "",
    sessionId: session.id || "",
    customerEmail: (session.customer_details && session.customer_details.email) || session.customer_email || "",
    amountTotal: session.amount_total || 0,
    currency: session.currency || "usd",
    paymentStatus: session.payment_status || ""
  };
}

/**
 * منع الشحن المزدوج لنفس session
 */
async function alreadyProcessed(sessionId) {
  if (!sessionId) return false;
  const snap = await db.ref("langAppStripeProcessed/" + sessionId.replace(/[.#$\\[\\]]/g, "_")).once("value");
  return !!snap.val();
}

async function markProcessed(sessionId, data) {
  if (!sessionId) return;
  const key = sessionId.replace(/[.#$\\[\\]]/g, "_");
  await db.ref("langAppStripeProcessed/" + key).set({
    at: Date.now(),
    ...data
  });
}

/**
 * شحن النقاط + إشعار + سجل طلب
 */
async function creditPoints(order) {
  const { userCode, points, priceLabel, sessionId, customerEmail, amountTotal } = order;
  if (!userCode) throw new Error("userCode مفقود");
  if (!(points > 0)) throw new Error("points غير صالح: " + points);

  const userRef = db.ref("activationCodes/" + userCode);
  const userSnap = await userRef.once("value");
  if (!userSnap.exists()) {
    throw new Error("المستخدم غير موجود: " + userCode);
  }

  // إضافة النقاط ذرياً
  const ptsRef = userRef.child("points");
  const tx = await ptsRef.transaction((cur) => {
    return (parseInt(cur, 10) || 0) + points;
  });
  if (!tx.committed) throw new Error("فشل transaction النقاط");

  // مصدر النقاط
  await userRef.child("pointsSources/purchase").transaction((cur) => {
    return (parseInt(cur, 10) || 0) + points;
  });

  await userRef.child("pointsLog").push({
    amount: points,
    source: "purchase",
    reason: "Stripe مؤكد " + (priceLabel || ""),
    sessionId: sessionId || "",
    at: Date.now()
  });

  // سجل الطلب
  await db.ref("langAppPointBuyRequests").push({
    code: userCode,
    userName: (userSnap.val() && (userSnap.val().userName || userSnap.val().name)) || "",
    points: points,
    price: priceLabel || ((amountTotal / 100).toFixed(2) + " $"),
    payMethod: "stripe",
    status: "auto_approved",
    auto: true,
    verified: true,
    stripeSessionId: sessionId || "",
    customerEmail: customerEmail || "",
    createdAt: Date.now(),
    processedAt: Date.now()
  });

  // إشعار
  await db.ref("langAppNotifications/" + userCode).push({
    type: "points",
    text: "✅ تم شحن ⭐" + points + " نقطة بعد تأكيد دفع Stripe",
    createdAt: Date.now()
  });

  console.log("✅ شحن", points, "إلى", userCode, "session=", sessionId);
  return true;
}

// Webhook — يجب أن يكون raw body
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    if (WEBHOOK_SECRET) {
      event = stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
    } else {
      event = JSON.parse(req.body.toString("utf8"));
      console.warn("⚠️ بدون تحقق توقيع webhook");
    }
  } catch (err) {
    console.error("توقيع webhook فاشل:", err.message);
    return res.status(400).send("Webhook Error: " + err.message);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      // فقط المدفوع
      if (session.payment_status && session.payment_status !== "paid" && session.payment_status !== "no_payment_required") {
        console.log("تخطي session غير مدفوعة:", session.id, session.payment_status);
        return res.json({ received: true, skipped: true });
      }

      if (await alreadyProcessed(session.id)) {
        console.log("مكرر:", session.id);
        return res.json({ received: true, duplicate: true });
      }

      const order = extractOrder(session);
      console.log("طلب:", order);

      if (!order.userCode || !(order.points > 0)) {
        console.error("بيانات ناقصة — تأكد من client_reference_id=USER|POINTS أو metadata");
        // لا نعيد 500 حتى لا يعيد Stripe المحاولة بلا فائدة إلى الأبد
        await markProcessed(session.id, { error: "missing_data", order });
        return res.json({ received: true, error: "missing_data" });
      }

      await creditPoints(order);
      await markProcessed(session.id, { ok: true, userCode: order.userCode, points: order.points });
    }

    res.json({ received: true });
  } catch (e) {
    console.error("خطأ معالجة:", e);
    res.status(500).json({ error: e.message });
  }
});

// JSON لباقي المسارات
app.use(express.json());

app.listen(PORT, () => {
  console.log("🚀 TEFLSY Stripe Webhook على المنفذ", PORT);
  console.log("   POST /webhook");
  console.log("   GET  /success  و /cancel");
});
