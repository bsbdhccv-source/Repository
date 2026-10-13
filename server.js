const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 10000;

let serviceAccount;
try {
  if (fs.existsSync('/etc/secrets/serviceAccount.json')) {
    serviceAccount = require('/etc/secrets/serviceAccount.json');
    console.log('تم تحميل ملف الاعتماد من مسار Secret Files بنجاح.');
  } else if (fs.existsSync('./serviceAccount.json')) {
    serviceAccount = require('./serviceAccount.json');
  }
} catch (error) {
  console.error('خطأ في تحميل الاعتماد:', error);
}

if (serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL || 'https://x-o-x-abfe6-default-rtdb.firebaseio.com/'
  });
  console.log('تم تهيئة اتصال Firebase بنجاح تام 🚀');
}

app.use(bodyParser.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

app.get('/', (req, res) => {
  res.send('TEFLSY Webhook Server is live! 🚀');
});

app.post('/webhook', async (req, res) => {
  try {
    console.log('--- استلام Webhook جديد من Lemon Squeezy ---');
    const event = req.body;
    const eventName = event && event.meta ? event.meta.event_name : null;

    if (eventName === 'order_created') {
      const orderId = event.data && event.data.id ? String(event.data.id) : `order_${Date.now()}`;
      const attributes = event.data && event.data.attributes ? event.data.attributes : {};
      const meta = event.meta || {};
      const customData = attributes.checkout_data && attributes.checkout_data.custom 
                          ? attributes.checkout_data.custom 
                          : (attributes.custom_data || meta.custom_data || {});

      let rawUserId = customData.user_id || meta.user_id || attributes.passthrough || null;
      if (rawUserId) {
        try { rawUserId = decodeURIComponent(rawUserId); } catch (e) {}
      }

      console.log('المعرف المستخرج من رابط الشراء:', rawUserId);
      console.log('معرف الطلب (Order ID):', orderId);

      if (!rawUserId) return res.status(200).send({ warning: 'user_id missing' });

      let pointsToAdd = 90;
      if (customData.points) {
        pointsToAdd = parseInt(customData.points, 10) || 90;
      }

      const db = admin.database();
      const cleanUsername = rawUserId.startsWith('@') ? rawUserId.replace('@', '') : rawUserId;
      const withAtUsername = `@${cleanUsername}`;

      const targetCodes = new Set([cleanUsername, withAtUsername, rawUserId]);

      // 1. البحث في userNames بالصيغتين (مع @ وبدون @)
      const lookupUserNames = async (uName) => {
        try {
          const snap = await db.ref(`userNames/${uName}`).once('value');
          if (snap.exists()) {
            const val = snap.val();
            if (typeof val === 'string') targetCodes.add(val);
            else if (val && val.code) targetCodes.add(val.code);
          }
        } catch (e) {}
      };

      await lookupUserNames(cleanUsername);
      await lookupUserNames(withAtUsername);

      console.log('قائمة جميع الأكواد المستهدفة للحساب:', Array.from(targetCodes));

      const notifData = {
        title: 'تم شحن النقاط بنجاح 🎉',
        message: `تم إضافة ${pointsToAdd} نقطة إلى رصيدك بنجاح عبر عملية الشراء.`,
        body: `تم إضافة ${pointsToAdd} نقطة إلى رصيدك بنجاح عبر عملية الشراء.`,
        points: pointsToAdd,
        timestamp: Date.now(),
        orderId: orderId,
        read: false
      };

      // 2. تحديث النقاط والإشعارات في activationCodes لكافة الصيغ الفريدة
      for (const code of targetCodes) {
        try {
          const userRef = db.ref(`activationCodes/${code}`);
          
          // تحديث النقاط الرئيسية والأساسية
          await userRef.child('points').transaction((current) => (current || 0) + pointsToAdd);
          await userRef.child('weeklyPoints').transaction((current) => (current || 0) + pointsToAdd);
          await userRef.child('pointsSources/purchase').transaction((current) => (current || 0) + pointsToAdd);

          await userRef.child('pointsLog').push({
            amount: pointsToAdd,
            type: 'purchase_lemon_squeezy',
            orderId: orderId,
            timestamp: Date.now()
          });

          // إرسال الإشعارات بكل الطرق الممكنة للتطبيق
          await db.ref(`langAppNotifications/${code}`).push(notifData);
          await userRef.child('notifications').push(notifData);

          console.log(`✅ تم شحن النقاط وإرسال الإشعار بنجاح للكود: ${code}`);
        } catch (err) {
          console.log(`⚠️ خطأ عند الشحن للكود ${code}:`, err.message);
        }
      }

      // 3. تسجيل المعاملة لمنع التكرار
      await db.ref(`langAppLemonProcessed/${orderId}`).set({
        userCodes: Array.from(targetCodes),
        username: cleanUsername,
        points: pointsToAdd,
        processedAt: Date.now()
      });

      console.log('--- تمت معالجة الشحن والإشعارات بنجاح تام ---');
    }

    res.status(200).send({ success: true });
  } catch (error) {
    console.error('خطأ رئيسي أثناء معالجة الـ Webhook:', error);
    res.status(500).send({ error: error.message });
  }
});

app.listen(PORT, () => { console.log(`Server is running on port ${PORT}`); });
