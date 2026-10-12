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
      
      // استخراج المعرف المخصص من طلب الشراء
      let userId = null;
      if (attributes.checkout_data && attributes.checkout_data.custom && attributes.checkout_data.custom.user_id) {
        userId = attributes.checkout_data.custom.user_id;
      } else if (attributes.custom_data && attributes.custom_data.user_id) {
        userId = attributes.custom_data.user_id;
      }

      // فك ترميز النص (مثل تحويل %40فاطمة إلى @فاطمة)
      if (userId) {
        try {
          userId = decodeURIComponent(userId);
        } catch (e) {
          // في حال فشل الفك يبقى كما هو
        }
      }

      console.log('المعرف المستخرج (User ID):', userId);

      if (!userId) {
        console.log('تحذير: user_id غير موجود في بيانات الطلب');
        return res.status(400).send({ error: 'user_id missing' });
      }

      // تحديد عدد النقاط (افتراضي 90 نقطة أو حسب البيانات المرسلة)
      let pointsToAdd = 90;
      if (attributes.custom_data && attributes.custom_data.points) {
        pointsToAdd = parseInt(attributes.custom_data.points, 10) || 90;
      }

      const db = admin.database();
      
      // البحث عن المسار في قاعدة البيانات (مع وعنوان @ أو بدونه لضمان المطابقة)
      let userRef = db.ref(`users/${userId}`);
      let snapshot = await userRef.once('value');

      if (!snapshot.exists() && userId.startsWith('@')) {
        const cleanUserId = userId.replace('@', '');
        const altRef = db.ref(`users/${cleanUserId}`);
        const altSnap = await altRef.once('value');
        if (altSnap.exists()) {
          userRef = altRef;
        }
      }

      // تحديث رصيد النقاط باستخدام Transaction
      await userRef.transaction((currentData) => {
        if (currentData === null) {
          currentData = { points: pointsToAdd };
        } else {
          currentData.points = (currentData.points || 0) + pointsToAdd;
        }
        return currentData;
      });

      // إضافة إشعار جديد لحساب المستخدم في قاعدة البيانات
      const notificationsRef = userRef.child('notifications').push();
      await notificationsRef.set({
        title: 'تم شحن النقاط بنجاح 🎉',
        body: `تم إضافة ${pointsToAdd} نقطة إلى حسابك بنجاح.`,
        timestamp: Date.now(),
        orderId: event.data.id || 'N/A'
      });

      console.log(`تم بنجاح إضافة ${pointsToAdd} نقطة وإرسال الإشعار للمستخدم: ${userId}`);
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
