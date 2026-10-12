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
  res.send('Server is live! 🚀');
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

      // 1. البحث في المسارات المباشرة المحتملة
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

      // 2. البحث الذكي الشامل داخل مجلد users في حال لم يتم العثور عليه
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

      // 3. البحث الشامل داخل userProgress إذا لم يتم العثور عليه بعد
      if (!actualUserId) {
        const progressSnap = await db.ref('userProgress').once('value');
        if (progressSnap.exists()) {
          progressSnap.forEach((childSnap) => {
            const progData = childSnap.val();
            const key = childSnap.key;
            if (progData && typeof progData === 'object') {
              const pName = progData.username || progData.name || progData.userName || '';
              if (pName.toLowerCase() === cleanUsername.toLowerCase() || key.toLowerCase().includes(cleanUsername.toLowerCase())) {
                actualUserId = progData.uid || progData.userId || key;
              }
            }
          });
        }
      }

      // إذا لم يُعثر على مطابقة مطلقة، نستخدم المعرف المُمرر كملجأ أخير
      if (!actualUserId) {
        actualUserId = userId;
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

      console.log(`تم بنجاح إضافة ${pointsToAdd} نقطة وإرسال الإشعار للمستخدم تحت الـ UID الصحيح: ${actualUserId}`);
    }

    res.status(200).send({ success: true });
  } catch (error) {
    console.error('خطأ أثناء المعالجة:', error);
    res.status(500).send({ error: error.message });
  }
});

app.listen(PORT, () => { console.log(`Server is running on port ${PORT}`); });
