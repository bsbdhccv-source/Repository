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

app.post('/webhook', async (req, res) => {
  try {
    console.log('--- استلام Webhook جديد من Lemon Squeezy ---');
    const event = req.body;
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

      // البحث الذكي الشامل للـ UID الفعلي
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
        const usersSnap = await db.ref('users').once('value');
        if (usersSnap.exists()) {
          usersSnap.forEach((childSnap) => {
            const userData = childSnap.val();
            const key = childSnap.key;
            if (userData && typeof userData === 'object') {
              const uName = userData.username || userData.name || userData.userName || userData.displayName || '';
              if (uName.toLowerCase() === cleanUsername.toLowerCase() || uName.toLowerCase() === userId.toLowerCase()) {
                actualUserId = key;
              }
            }
          });
        }
      }

      if (!actualUserId) {
        actualUserId = userId;
      }

      console.log('المعرف الفعلي المستهدف (Target UID):', actualUserId);

      // دالة لتحديث النقاط والعملات
      const updatePointsTransaction = (currentData) => {
        if (currentData === null) {
          return { points: pointsToAdd, coins: pointsToAdd, score: pointsToAdd };
        } else {
          currentData.points = (currentData.points || 0) + pointsToAdd;
          currentData.coins = (currentData.coins || 0) + pointsToAdd;
          currentData.score = (currentData.score || 0) + pointsToAdd;
          return currentData;
        }
      };

      // قائمة شاملة لكافة المسارات المحتملة للعبة ولتطبيق langApp (سواء بالـ UID أو بالأسماء النصية مباشرة)
      const targetPaths = [
        `users/${actualUserId}`,
        `userProgress/${actualUserId}`,
        `langApp/users/${actualUserId}`,
        `langApp/userProgress/${actualUserId}`,
        `langApp/users/${cleanUsername}`,
        `langApp/users/@${cleanUsername}`,
        `langApp/users/${userId}`,
        `langApp/userProgress/${cleanUsername}`,
        `langApp/userProgress/@${cleanUsername}`,
        `langApp/userProgress/${userId}`
      ];

      const notifData = {
        title: 'تم شحن النقاط بنجاح 🎉',
        body: `تم إضافة ${pointsToAdd} نقطة إلى حسابك بنجاح.`,
        timestamp: Date.now(),
        orderId: event.data.id || 'N/A'
      };

      // تنفيذ التحديث وإرسال الإشعارات على جميع المسارات دفعة واحدة لضمان وصولها للتطبيق وللعبة
      for (const p of targetPaths) {
        const ref = db.ref(p);
        await ref.transaction(updatePointsTransaction);
        await ref.child('notifications').push().set(notifData);
      }

      console.log(`تم بنجاح شحن ${pointsToAdd} نقطة وتحديث كافة مسارات التطبيق واللعبة للمستخدم: ${actualUserId}`);
    }

    res.status(200).send({ success: true });
  } catch (error) {
    console.error('خطأ أثناء المعالجة:', error);
    res.status(500).send({ error: error.message });
  }
});

app.listen(PORT, () => { console.log(`Server is running on port ${PORT}`); });
