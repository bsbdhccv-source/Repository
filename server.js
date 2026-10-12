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

      // البحث عن المعرف في كافة المسارات المحتملة
      let userId = customData.user_id || meta.user_id || attributes.passthrough || null;

      if (userId) {
        try {
          userId = decodeURIComponent(userId);
        } catch (e) {
          // في حال عدم الحاجة للفك
        }
      }

      console.log('المعرف المستخرج (User ID):', userId);

      if (!userId) {
        console.log('تحذير: user_id غير موجود في بيانات الطلب');
        return res.status(200).send({ warning: 'user_id missing but webhook received' });
      }

      let pointsToAdd = 90;
      if (customData.points) {
        pointsToAdd = parseInt(customData.points, 10) || 90;
      }

      const db = admin.database();
      let actualUserId = userId;
      
      // تنظيف الاسم من الرمز @ إن وجد للبحث في جدول usernames
      const cleanUsername = userId.startsWith('@') ? userId.replace('@', '') : userId;

      // البحث في جدول usernames لمعرفة الـ UID الحقيقي
      const usernameRef = db.ref(`usernames/${cleanUsername}`);
      const usernameSnap = await usernameRef.once('value');

      if (usernameSnap.exists()) {
        const val = usernameSnap.val();
        if (typeof val === 'string') {
          actualUserId = val;
        } else if (val && typeof val === 'object') {
          actualUserId = val.uid || val.userId || val.id || actualUserId;
        }
      } else {
        // تجربة البحث مع الرمز @ مباشرة في حال كان مخزناً هكذا
        const usernameRefAt = db.ref(`usernames/${userId}`);
        const usernameSnapAt = await usernameRefAt.once('value');
        if (usernameSnapAt.exists()) {
          const val = usernameSnapAt.val();
          if (typeof val === 'string') {
            actualUserId = val;
          } else if (val && typeof val === 'object') {
            actualUserId = val.uid || val.userId || val.id || actualUserId;
          }
        }
      }

      console.log('المعرف الفعلي (Target UID):', actualUserId);

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
