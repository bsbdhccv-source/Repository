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
  res.send('LangApp TEFLSY Webhook Server is live! 🚀');
});

app.post('/webhook', async (req, res) => {
  try {
    console.log('--- استلام Webhook جديد من Lemon Squeezy ---');
    const event = req.body;
    const eventName = event && event.meta ? event.meta.event_name : null;

    if (eventName === 'order_created') {
      const orderId = event.data && event.data.id ? String(event.data.id) : null;
      const attributes = event.data && event.data.attributes ? event.data.attributes : {};
      const meta = event.meta || {};
      const customData = attributes.checkout_data && attributes.checkout_data.custom 
                          ? attributes.checkout_data.custom 
                          : (attributes.custom_data || meta.custom_data || {});

      let rawUserId = customData.user_id || meta.user_id || attributes.passthrough || null;
      if (rawUserId) {
        try { rawUserId = decodeURIComponent(rawUserId); } catch (e) {}
      }

      console.log('المعرف المستخرج من الرابط:', rawUserId);
      console.log('معرف الطلب (Order ID):', orderId);

      if (!rawUserId) return res.status(200).send({ warning: 'user_id missing' });

      const db = admin.database();

      // 1. فحص منع التكرار باستخدام المجلد الخاص بالمنصة في Firebase
      if (orderId) {
        const processedSnap = await db.ref(`langAppLemonProcessed/${orderId}`).once('value');
        if (processedSnap.exists()) {
          console.log(`⚠️ الطلب ${orderId} معالج سابقاً وموجود في langAppLemonProcessed! تم إلغاء التكرار.`);
          return res.status(200).send({ success: true, message: 'Already processed' });
        }
      }

      let pointsToAdd = 90;
      if (customData.points) {
        pointsToAdd = parseInt(customData.points, 10) || 90;
      }

      const cleanUsername = rawUserId.startsWith('@') ? rawUserId.replace('@', '') : rawUserId;
      let userCode = cleanUsername;

      // 2. البحث عن الكود الحقيقي للمستخدم من جدول userNames
      const userNameSnap = await db.ref(`userNames/${cleanUsername}`).once('value');
      if (userNameSnap.exists()) {
        const mappedCode = userNameSnap.val();
        if (typeof mappedCode === 'string') {
          userCode = mappedCode;
        } else if (mappedCode && mappedCode.code) {
          userCode = mappedCode.code;
        }
      }

      console.log('كود المستخدم في activationCodes:', userCode);

      // 3. شحن النقاط وتحديث الحساب في activationCodes لتطبيق TEFLSY
      const userRef = db.ref(`activationCodes/${userCode}`);
      const userSnap = await userRef.once('value');

      if (userSnap.exists()) {
        // تحديث النقاط الرئيسية
        await userRef.child('points').transaction((current) => (current || 0) + pointsToAdd);
        
        // تحديث نقاط الأسبوع
        await userRef.child('weeklyPoints').transaction((current) => (current || 0) + pointsToAdd);

        // إضافة سجل مصدر النقاط
        await userRef.child('pointsSources/purchase').transaction((current) => (current || 0) + pointsToAdd);

        // إضافة سجل في pointsLog
        await userRef.child('pointsLog').push({
          amount: pointsToAdd,
          type: 'purchase_lemon_squeezy',
          orderId: orderId || 'N/A',
          timestamp: Date.now()
        });

        console.log(`✅ تم تحديث نقاط تطبيق TEFLSY للحساب ${userCode} بـ ${pointsToAdd} نقطة.`);
      } else {
        // إنشاء السجل إن لم يكن موجوداً
        await userRef.child('points').set(pointsToAdd);
        console.log(`✅ تم إنشاء الحساب وشحن ${pointsToAdd} نقطة في activationCodes/${userCode}`);
      }

      // 4. إرسال الإشعار لتطبيق TEFLSY في langAppNotifications/{code}
      const notifData = {
        title: 'تم شحن النقاط بنجاح 🎉',
        message: `تم إضافة ${pointsToAdd} نقطة إلى حسابك بنجاح.`,
        body: `تم إضافة ${pointsToAdd} نقطة إلى حسابك بنجاح.`,
        points: pointsToAdd,
        timestamp: Date.now(),
        orderId: orderId || 'N/A',
        read: false
      };

      await db.ref(`langAppNotifications/${userCode}`).push(notifData);
      console.log(`🔔 تم إرسال الإشعار بنجاح إلى langAppNotifications/${userCode}`);

      // 5. شحن حساب اللعبة أيضاً (تحديث users و userProgress للـ UID أو الاسم)
      const gamePaths = [
        `users/${userCode}`,
        `userProgress/${userCode}`,
        `users/${cleanUsername}`,
        `userProgress/${cleanUsername}`
      ];
      for (const p of gamePaths) {
        try {
          await db.ref(p).child('points').transaction((c) => (c || 0) + pointsToAdd);
          await db.ref(p).child('notifications').push(notifData);
        } catch (e) {}
      }

      // 6. تسجيل الطلب في langAppLemonProcessed لمنع التكرار نهائياً في المستقبل
      if (orderId) {
        await db.ref(`langAppLemonProcessed/${orderId}`).set({
          userCode: userCode,
          username: cleanUsername,
          points: pointsToAdd,
          processedAt: Date.now()
        });
      }

      console.log('--- تمت معالجة العملية بالكامل بنجاح تام ---');
    }

    res.status(200).send({ success: true });
  } catch (error) {
    console.error('خطأ رئيسي في معالجة الـ Webhook:', error);
    res.status(500).send({ error: error.message });
  }
});

app.listen(PORT, () => { console.log(`Server is running on port ${PORT}`); });
