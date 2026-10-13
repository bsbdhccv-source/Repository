/**
 * TEFLSY — Lemon Squeezy Webhook
 */
const express = require("express");
const crypto = require("crypto");
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

function loadEnvFile() {
  try {
    const p = path.join(__dirname, ".env");
    if (!fs.existsSync(p)) return;
    fs.readFileSync(p, "utf8").split("\n").forEach((line) => {
      const t = line.trim();
      if (!t || t.startsWith("#")) return;
      const i = t.indexOf("=");
      if (i < 1) return;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!process.env[k]) process.env[k] = v;
    });
  } catch (e) {}
}
loadEnvFile();

const PORT = parseInt(process.env.PORT || "3000", 10);
const LEMON_SECRET = (
  process.env.LEMON_WEBHOOK_SECRET ||
  process.env.WEBHOOK_SECRET ||
  process.env.STRIPE_WEBHOOK_SECRET ||
  ""
).trim();
const SKIP_SIG = String(process.env.SKIP_SIGNATURE_VERIFY || "") === "1";
const DB_URL = process.env.FIREBASE_DATABASE_URL || "https://x-o-x-abfe6-default-rtdb.firebaseio.com";

function initFirebase() {
  if (admin.apps.length) return;
  const filePath = process.env.FIREBASE_SERVICE_ACCOUNT || path.join(__dirname, "serviceAccount.json");
  if (!fs.existsSync(filePath)) {
    console.error("❌ serviceAccount.json مفقود");
    process.exit(1);
  }
  admin.initializeApp({
    credential: admin.credential.cert(require(filePath)),
    databaseURL: DB_URL
  });
  console.log("✅ Firebase Admin متصل");
}
initFirebase();
const db = admin.database();

const app = express();
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.type("html").send("<!DOCTYPE html><html lang=ar dir=rtl><body style='font-family:system-ui;background:#0f172a;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center'><div><h1>TEFLSY Lemon Webhook</h1><p>يعمل ✓</p><p>POST /webhook</p></div></body></html>");
});
app.get("/health", (req, res) => res.json({ ok: true, hasSecret: !!LEMON_SECRET, skipSig: SKIP_SIG }));

function verifyLemonSignature(rawBody, signature) {
  if (SKIP_SIG) {
    console.warn("⚠️ SKIP_SIGNATURE_VERIFY=1 — تم تخطي التحقق");
    return true;
  }
  if (!LEMON_SECRET) {
    console.warn("⚠️ لا يوجد LEMON_WEBHOOK_SECRET — تخطي التحقق (غير آمن)");
    return true;
  }
  if (!signature) {
    console.error("لا يوجد هيدر X-Signature");
    return false;
  }
  const hmac = crypto.createHmac("sha256", LEMON_SECRET);
  const digest = hmac.update(rawBody).digest("hex");
  const sig = String(signature).trim();
  try {
    const a = Buffer.from(digest, "utf8");
    const b = Buffer.from(sig, "utf8");
    if (a.length !== b.length) {
      console.error("طول التوقيع مختلف", a.length, b.length, "secretLen=", LEMON_SECRET.length);
      return false;
    }
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return digest === sig;
  }
}

function extractOrder(payload) {
  const meta = (payload && payload.meta) || {};
  const custom = meta.custom_data || meta.custom || {};
  const data = (payload && payload.data) || {};
  const attrs = data.attributes || {};

  let userCode = String(
    custom.user_id || custom.userId || custom.user_code || custom.userCode || custom.code || ""
  ).trim();
  let points = parseInt(custom.points || custom.point || custom.pts || "0", 10) || 0;
  const priceLabel = String(custom.price_label || custom.price || attrs.total_formatted || "").trim();
  const status = String(attrs.status || "").toLowerCase();
  const orderId = String(data.id || meta.event_id || "").trim();

  // أحياناً custom_data يكون نص JSON
  if (!userCode && typeof meta.custom_data === "string") {
    try {
      const c = JSON.parse(meta.custom_data);
      userCode = String(c.user_id || c.userId || c.user_code || c.userCode || "").trim();
      if (!points) points = parseInt(c.points || "0", 10) || 0;
    } catch (e) {}
  }

  return { userCode, points, priceLabel, status, orderId };
}

async function alreadyProcessed(orderId) {
  if (!orderId) return false;
  const key = String(orderId).replace(/[.#$\[\]\/]/g, "_");
  const snap = await db.ref("langAppLemonProcessed/" + key).once("value");
  return !!snap.val();
}

async function markProcessed(orderId, data) {
  if (!orderId) return;
  const key = String(orderId).replace(/[.#$\[\]\/]/g, "_");
  await db.ref("langAppLemonProcessed/" + key).set({ at: Date.now(), ...data });
}

async function creditPoints(order) {
  const { userCode, points, priceLabel, orderId } = order;
  if (!userCode) throw new Error("user_id مفقود في custom_data");
  if (!(points > 0)) throw new Error("points غير صالح: " + points);

  const userRef = db.ref("activationCodes/" + userCode);
  const userSnap = await userRef.once("value");
  if (!userSnap.exists()) throw new Error("المستخدم غير موجود: " + userCode);

  const tx = await userRef.child("points").transaction((cur) => (parseInt(cur, 10) || 0) + points);
  if (!tx.committed) throw new Error("فشل transaction");

  try {
    await userRef.child("pointsSources/purchase").transaction((cur) => (parseInt(cur, 10) || 0) + points);
  } catch (e) {}

  await userRef.child("pointsLog").push({
    amount: points,
    source: "purchase",
    reason: "Lemon Squeezy " + (priceLabel || ""),
    orderId: orderId || "",
    at: Date.now()
  });

  await db.ref("langAppPointBuyRequests").push({
    code: userCode,
    userName: (userSnap.val() && (userSnap.val().userName || userSnap.val().name)) || "",
    points,
    price: priceLabel || "",
    payMethod: "lemon",
    status: "auto_approved",
    auto: true,
    verified: true,
    lemonOrderId: orderId || "",
    createdAt: Date.now(),
    processedAt: Date.now()
  });

  await db.ref("langAppNotifications/" + userCode).push({
    type: "points",
    text: "✅ تم شحن ⭐" + points + " نقطة بعد تأكيد دفع Lemon Squeezy",
    createdAt: Date.now()
  });

  console.log("✅ شحن", points, "إلى", userCode, "order=", orderId);
}

app.post("/webhook", express.raw({ type: "*/*" }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");
  const sig = req.headers["x-signature"] || req.headers["x-signature"] || "";

  console.log("Webhook وارد | bodyLen=", raw.length, "| hasSig=", !!sig, "| secretLen=", LEMON_SECRET.length);

  if (!verifyLemonSignature(raw, sig)) {
    console.error("توقيع Lemon فاشل — تأكد من LEMON_WEBHOOK_SECRET في Render يطابق Signing secret في Lemon");
    return res.status(400).send("Invalid signature");
  }

  let payload;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch (e) {
    return res.status(400).send("Invalid JSON");
  }

  const eventName = (payload.meta && payload.meta.event_name) || payload.name || "";
  console.log("حدث:", eventName);

  try {
    if (String(eventName).indexOf("order") >= 0 || eventName === "order_created") {
      const order = extractOrder(payload);
      console.log("طلب:", JSON.stringify(order));

      if (order.status === "refunded" || order.status === "failed") {
        return res.json({ received: true, skipped: order.status });
      }

      if (await alreadyProcessed(order.orderId)) {
        console.log("مكرر:", order.orderId);
        return res.json({ received: true, duplicate: true });
      }

      if (!order.userCode || !(order.points > 0)) {
        console.error("بيانات ناقصة — custom_data يجب أن يحتوي user_id (أو user_code) و points");
        console.error("meta=", JSON.stringify(payload.meta || {}).slice(0, 500));
        await markProcessed(order.orderId || ("miss_" + Date.now()), { error: "missing_data", order });
        return res.json({ received: true, error: "missing_data" });
      }

      await creditPoints(order);
      await markProcessed(order.orderId, { ok: true, userCode: order.userCode, points: order.points });
    } else {
      console.log("حدث غير معالج:", eventName);
    }

    res.json({ received: true });
  } catch (e) {
    console.error("خطأ معالجة:", e);
    res.status(500).json({ error: e.message });
  }
});

app.use(express.json());
app.listen(PORT, () => {
  console.log("🚀 TEFLSY Lemon Webhook على المنفذ", PORT);
  console.log("   secret مضبوط؟", !!LEMON_SECRET, "len=", LEMON_SECRET.length, "skip=", SKIP_SIG);
});
