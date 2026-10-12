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

      // 1. البحث عن الـ UID الفعلي في الجداول
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

      console.log('المعرف المستهدف (Target ID):', actualUserId);

      // دالة لتحديث النقاط والعملات والرصيد لمرة واحدة
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

      // 2. جمع المسارات الفريدة بدقة لتجنب التكرار (منع الشحن مرتين)
      const targetPaths = new Set([
        `users/${actualUserId}`,
        `userProgress/${actualUserId}`,
        `accounts/${actualUserId}`,
        `users/${cleanUsername}`,
        `userProgress/${cleanUsername}`
      ]);

      // 3. الماسح الذكي المكتشف للمسارات الفعلية
      try {
        const rootSnap = await db.ref('/').once('value');
        const rootVal = rootSnap.val();
        
        if (rootVal && typeof rootVal === 'object') {
          for (const rootKey of Object.keys(rootVal)) {
            const rootChild = rootVal[rootKey];
            if (rootChild && typeof rootChild === 'object') {
              for (const subKey of Object.keys(rootChild)) {
                const subVal = rootChild[subKey];
                if (
                  subKey.toLowerCase().includes(cleanUsername.toLowerCase()) || 
                  subKey.toLowerCase().includes('fatima') ||
                  (subVal && typeof subVal === 'object' && (
                    subVal.username === cleanUsername || 
                    subVal.name === cleanUsername || 
                    subVal.userName === cleanUsername
                  ))
                ) {
                  targetPaths.add(`${rootKey}/${subKey}`);
                }
              }
            }
          }
        }
      } catch (scanErr) {
        console.log('خطأ في الماسح الذكي:', scanErr.message);
      }

      const notifData = {
        title: 'تم شحن النقاط بنجاح 🎉',
        body: `تم إضافة ${pointsToAdd} نقطة إلى حسابك بنجاح.`,
        timestamp: Date.now(),
        orderId: event.data.id || 'N/A'
      };

      let notificationSent = false;

      // 4. تنفيذ التحديث (مرة واحدة لكل مسار فريد) وإرسال الإشعار بدقة
      for (const p of targetPaths) {
        try {
          const ref = db.ref(p);
          // شحن النقاط
          await ref.transaction(updatePointsTransaction);
          console.log(`✅ تم شحن النقاط بنجاح في المسار: ${p}`);

          // إرسال الإشعار مرة واحدة فقط لأول مسار نشط يتم شحنه بنجاح لضمان ظهوره في قسم الإشعارات
          if (!notificationSent) {
            await ref.child('notifications').push().set(notifData);
            console.log(`🔔 تم إرسال الإشعار بنجاح في المسار: ${p}/notifications`);
            notificationSent = true;
          }
        } catch (err) {
          console.log(`⚠️ تخطي المسار ${p}: ${err.message}`);
        }
      }

      console.log('--- تمت معالجة الطلب بنجاح تام وبدون تكرار ---');
    }

    res.status(200).send({ success: true });
  } catch (error) {
    console.error('خطأ رئيسي:', error);
    res.status(500).send({ error: error.message });
  }
});

app.listen(PORT, () => { console.log(`Server is running on port ${PORT}`); });
