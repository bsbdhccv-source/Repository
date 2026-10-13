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
      let targetCode = cleanUsername;

      // 1. البحث في جدول userNames أولاً للعثور على الكود المرتبط
      try {
        const userNameSnap = await db.ref(`userNames/${cleanUsername}`).once('value');
        if (userNameSnap.exists()) {
          const val = userNameSnap.val();
          if (typeof val === 'string') targetCode = val;
          else if (val && val.code) targetCode = val.code;
          console.log(`تم العثور على الكود عبر userNames: ${targetCode}`);
        }
      } catch (e) {
        console.log('ملاحظة: لم يتم العثور على مطابقة في userNames، سيتم استخدام الاسم مباشرة.');
      }

      // 2. التحقق من وجود الحساب في activationCodes أو بالاسم المباشر
      let finalAccountCode = targetCode;
      const directCheck = await db.ref(`activationCodes/${cleanUsername}`).once('value');
      if (directCheck.exists()) {
        finalAccountCode = cleanUsername;
      } else {
        const mappedCheck = await db.ref(`activationCodes/${targetCode}`).once('value');
        if (!mappedCheck.exists()) {
          // إذا لم يوجد، ننشئه بالاسم النظيف لضمان عدم ضياع الشحن
          finalAccountCode = cleanUsername;
        }
      }

      console.log('كود الحساب النهائي المستهدف في activationCodes:', finalAccountCode);

      // 3. شحن النقاط وتحديث الهيكلية بدقة في activationCodes/{code}
      const userRef = db.ref(`activationCodes/${finalAccountCode}`);

      // تحديث رصيد النقاط الرئيسي
      await userRef.child('points').transaction((current) => (current || 0) + pointsToAdd);

      // تحديث نقاط الصدارة الأسبوعية
      await userRef.child('weeklyPoints').transaction((current) => (current || 0) + pointsToAdd);

      // تسجيل مصدر الشراء
      await userRef.child('pointsSources/purchase').transaction((current) => (current || 0) + pointsToAdd);

      // إضافة سجل إلى pointsLog
      await userRef.child('pointsLog').push({
        amount: pointsToAdd,
        type: 'purchase_lemon_squeezy',
        orderId: orderId,
        timestamp: Date.now()
      });

      console.log(`✅ تم شحن ${pointsToAdd} نقطة بنجاح للحساب activationCodes/${finalAccountCode}`);

      // 4. إرسال الإشعار الداخلي ليظهر في قسم الإشعارات داخل تطبيق TEFLSY
      const notifData = {
        title: 'تم شحن النقاط بنجاح 🎉',
        message: `تم إضافة ${pointsToAdd} نقطة إلى رصيدك بنجاح عبر عملية الشراء.`,
        body: `تم إضافة ${pointsToAdd} نقطة إلى رصيدك بنجاح عبر عملية الشراء.`,
        points: pointsToAdd,
        timestamp: Date.now(),
        orderId: orderId,
        read: false
      };

      // إرسال الإشعار إلى المسار المخصص للإشعارات الداخلية في التطبيق
      await db.ref(`langAppNotifications/${finalAccountCode}`).push(notifData);
      // إرسال نسخة داخل مسار الحساب احتياطياً لضمان قراءتها بأي طريقة برمجية يتبعها التطبيق
      await userRef.child('notifications').push(notifData);

      console.log(`🔔 تم إرسال الإشعار الداخلي بنجاح لحساب: ${finalAccountCode}`);

      // 5. حفظ الطلب في سجل المعالجة لمنع تكراره لاحقاً للطلبات الحقيقية
      await db.ref(`langAppLemonProcessed/${orderId}`).set({
        userCode: finalAccountCode,
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
