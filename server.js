const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 10000;

// تهيئة Firebase Admin SDK مع دعم المسار السري في Render أو الملف المحلي
let serviceAccount;
try {
  if (fs.existsSync('/etc/secrets/serviceAccount.json')) {
    serviceAccount = require('/etc/secrets/serviceAccount.json');
    console.log('تم تحميل ملف الاعتماد من مسار Secret Files في Render بنجاح.');
  } else if (fs.existsSync('./serviceAccount.json')) {
    serviceAccount = require('./serviceAccount.json');
    console.log('تم تحميل ملف الاعتماد من المجلد المحلي بنجاح.');
  } else {
    console.error('تحذير: لم يتم العثور على ملف serviceAccount.json!');
  }
} catch (error) {
  console.error('خطأ أثناء تحميل ملف الاعتماد:', error);
}

if (serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL || 'https://x-o-x-abfe6-default-rtdb.firebaseio.com/'
  });
  console.log('تم تهيئة اتصال Firebase بنجاح تام 🚀');
}

app.use(bodyParser.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

app.get('/', (req, res) => {
  console.log("تمت زيارة الصفحة الرئيسية للسيرفر");
  res.send('Teflsy Stripe & Lemon Squeezy Webhook Server is live! 🚀');
});

app.post('/webhook', async (req, res) => {
  try {
    console.log('--- تم استلام Webhook جديد من Lemon Squeezy ---');
    const event = req.body;
    const eventName = event && event.meta ? event.meta.event_name : null;
    console.log('حدث:', eventName);

    if (eventName === 'order_created') {
      const attributes = event.data && event.data.attributes ? event.data.attributes : {};
      const meta = event.meta || {};
      const customData = attributes.checkout_data && attributes.checkout_data.custom 
                          ? attributes.checkout_data.custom 
                          : (attributes.custom_data || meta.custom_data || {});

      // استخراج معرف المستخدم من الرابط
      let userId = customData.user_id || meta.user_id || attributes.passthrough || null;

      if (userId) {
        try {
          userId = decodeURIComponent(userId);
        } catch (e) {}
      }

      console.log('المعرف المستخرج (User ID):', userId);

      if (!userId) {
        console.log('تحذير: user_id غير موجود في بيانات الطلب');
        return res.status(200).send({ warning: 'user_id missing' });
      }

      let pointsToAdd = 90;
      if (customData.points) {
        pointsToAdd = parseInt(customData.points, 10) || 90;
      }

      const db = admin.database();
      let actualUserId = userId;
      
      const cleanUsername = userId.startsWith('@') ? userId.replace('@', '') : userId;

      // البحث في جميع المسارات المحتملة في قاعدة البيانات (بما فيها البادئة u_ وجداول userProgress)
      const possiblePaths = [
        `usernames/${cleanUsername}`,
        `usernames/u_${cleanUsername}`,
        `userProgress/${cleanUsername}`,
        `userProgress/u_${cleanUsername}`,
        `users/${cleanUsername}`
      ];

      for (const path of possiblePaths) {
        const snap = await db.ref(path).once('value');
        if (snap.exists()) {
          const val = snap.val();
          if (typeof val === 'string') {
            actualUserId = val;
            break;
          } else if (val && typeof val === 'object') {
            actualUserId = val.uid || val.userId || val.id || val.user_id || actualUserId;
            break;
          }
        }
      }

      console.log('المعرف الفعلي المستهدف (Target UID):', actualUserId);

      const userRef = db.ref(`users/${actualUserId}`);

      await userRef.transaction((currentData) => {
        if (currentData === null) {
          currentData = { points: pointsToAdd };
        } else {
          currentData.points = (currentData.points || 0) + pointsToAdd;
        }
        return currentData;
      });

      const notificationsRef = userRef.child('notifications').push();
      await notificationsRef.set({
        title: 'تم شحن النقاط بنجاح 🎉',
        body: `تم إضافة ${pointsToAdd} نقطة إلى حسابك بنجاح.`,
        timestamp: Date.now(),
        orderId: event.data.id || 'N/A'
      });

      console.log(`تم بنجاح إضافة ${pointsToAdd} نقطة وإرسال الإشعار للمستخدم تحت الـ UID: ${actualUserId}`);
    }

    res.status(200).send({ success: true });
  } catch (error) {
    console.error('خطأ أثناء معالجة الـ Webhook:', error);
    res.status(500).send({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
