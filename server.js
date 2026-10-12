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
  res.send('Webhook Server is live! 🚀');
});

// سجل لمنع تكرار معالجة نفس الطلب في حال أرسلته المنصة مرتين
const processedEvents = new Set();

app.post('/webhook', async (req, res) => {
  try {
    console.log('--- استلام Webhook جديد من Lemon Squeezy ---');
    const event = req.body;
    const eventId = event && event.data ? event.data.id : null;

    // منع التكرار إذا تم إرسال نفس الحدث مرتين
    if (eventId && processedEvents.has(eventId)) {
      console.log('⚠️ تم تجاهل طلب مكرر لنفس المعاملة (Event ID):', eventId);
      return res.status(200).send({ success: true, duplicated: true });
    }

    if (eventId) {
      processedEvents.add(eventId);
      // مسح المعرف من الذاكرة بعد ساعة لتفريغ المساحة
      setTimeout(() => processedEvents.delete(eventId), 3600000);
    }

    const eventName = event && event.meta ? event.meta.event_name : null;

    if (eventName === 'order_created') {
      const attributes = event.data && event.data.attributes ? event.data.attributes : {};
      const meta = event.meta || {};
      const customData = attributes.checkout_data && attributes.checkout_data.custom 
                          ? attributes.checkout_data.custom 
                          : (attributes.custom_data || meta.custom_data || {});

      let userId = customData.user_id || meta.user_id || attributes.passthrough || null;
      if (userId) {
        try { userId = decodeURIComponent(userId); } catch (e) {}
      }

      console.log('المعرف المستخرج من الرابط:', userId);
      if (!userId) return res.status(200).send({ warning: 'user_id missing' });

      let pointsToAdd = 90;
      if (customData.points) {
        pointsToAdd = parseInt(customData.points, 10) || 90;
      }

      const db = admin.database();
      let actualUserId = null;
      const cleanUsername = userId.startsWith('@') ? userId.replace('@', '') : userId;

      // البحث الذكي عن الـ UID الحقيقي (للعبة)
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

      if (!actualUserId) {
        actualUserId = userId;
      }

      console.log('معرف اللعبة (Game UID):', actualUserId);
      console.log('اسم مستخدم التطبيق (TEFLSY Username):', cleanUsername);

      // دالة تحديث النقاط لمرة واحدة بدقة
      const updatePointsTransaction = (currentData) => {
        if (currentData === null) {
          return { 
            points: pointsToAdd, 
            coins: pointsToAdd, 
            score: pointsToAdd,
            balance: pointsToAdd 
          };
        } else {
          currentData.points = (currentData.points || 0) + pointsToAdd;
          currentData.coins = (currentData.coins || 0) + pointsToAdd;
          currentData.score = (currentData.score || 0) + pointsToAdd;
          currentData.balance = (currentData.balance || 0) + pointsToAdd;
          return currentData;
        }
      };

      const notifData = {
        title: 'تم شحن النقاط بنجاح 🎉',
        body: `تم إضافة ${pointsToAdd} نقطة إلى حسابك بنجاح في تطبيق اللغات.`,
        timestamp: Date.now(),
        orderId: eventId || 'N/A'
      };

      // تحديد المسارات بدقة تامة وبدون تكرار باستخدام Set
      const targetPaths = new Set([
        `userProgress/${cleanUsername}`,
        `users/${cleanUsername}`,
        `userProgress/${actualUserId}`,
        `users/${actualUserId}`
      ]);

      // تنفيذ الشحن مرة واحدة لكل مسار فريد وإرسال الإشعار ليظهر في التطبيق
      for (const p of targetPaths) {
        try {
          const ref = db.ref(p);
          await ref.transaction(updatePointsTransaction);
          await ref.child('notifications').push().set(notifData);
          console.log(`✅ تم شحن النقاط وإرسال الإشعار بنجاح في المسار: ${p}`);
        } catch (err) {
          console.log(`⚠️ تخطي المسار ${p}: ${err.message}`);
        }
      }

      console.log('--- تمت معالجة الشحن والإشعارات بنجاح تام وبدون أي تكرار ---');
    }

    res.status(200).send({ success: true });
  } catch (error) {
    console.error('خطأ رئيسي:', error);
    res.status(500).send({ error: error.message });
  }
});

app.listen(PORT, () => { console.log(`Server is running on port ${PORT}`); });
