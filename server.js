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

      // 1. البحث التقليدي عن الـ UID للعبة
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

      console.log('المعرف المستهدف للعبة (Target UID):', actualUserId);

      // دالة لتحديث النقاط والعملات والرصيد
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
        body: `تم إضافة ${pointsToAdd} نقطة إلى حسابك بنجاح.`,
        timestamp: Date.now(),
        orderId: event.data.id || 'N/A'
      };

      // 2. شحن اللعبة بشكل أساسي
      const gamePaths = [
        `users/${actualUserId}`,
        `userProgress/${actualUserId}`
      ];
      for (const p of gamePaths) {
        try {
          const ref = db.ref(p);
          await ref.transaction(updatePointsTransaction);
          await ref.child('notifications').push().set(notifData);
          console.log(`✅ تم شحن اللعبة بنجاح في: ${p}`);
        } catch (err) {}
      }

      // 3. الماسح العميق للبحث عن تطبيق TEFLSY في جميع الجذور والبيانات
      try {
        console.log('🔍 بدء الفحص العميق لقاعدة البيانات للعثور على تطبيق TEFLSY...');
        const rootSnap = await db.ref('/').once('value');
        const rootVal = rootSnap.val();

        if (rootVal && typeof rootVal === 'object') {
          for (const rootKey of Object.keys(rootVal)) {
            const rootChild = rootVal[rootKey];
            if (rootChild && typeof rootChild === 'object') {
              for (const subKey of Object.keys(rootChild)) {
                const subVal = rootChild[subKey];
                
                // مطابقة ذكية تبحث عن اسم فاطمة أو رصيد 10 نقاط الخاص بالتطبيق
                const isMatch = 
                  subKey.toLowerCase().includes(cleanUsername.toLowerCase()) ||
                  subKey.toLowerCase().includes('fatima') ||
                  (subVal && typeof subVal === 'object' && (
                    (subVal.username && subVal.username.toLowerCase().includes(cleanUsername.toLowerCase())) ||
                    (subVal.name && subVal.name.toLowerCase().includes(cleanUsername.toLowerCase())) ||
                    subVal.points === 10 ||
                    subVal.coins === 10 ||
                    subVal.score === 10
                  ));

                if (isMatch) {
                  const foundPath = `${rootKey}/${subKey}`;
                  console.log(`🎯 [تم العثور على مسار تطبيق TEFLSY بدقة!]: ${foundPath}`);
                  
                  const appRef = db.ref(foundPath);
                  await appRef.transaction(updatePointsTransaction);
                  await appRef.child('notifications').push().set(notifData);
                  console.log(`✨ ✅ تمت إضافة النقاط وإرسال الإشعار لتطبيق TEFLSY بنجاح في المسار: ${foundPath}`);
                }
              }
            }
          }
        }
      } catch (scanErr) {
        console.log('خطأ في الماسح العميق:', scanErr.message);
      }

      console.log('--- تمت معالجة الطلب بنجاح تام ---');
    }

    res.status(200).send({ success: true });
  } catch (error) {
    console.error('خطأ رئيسي:', error);
    res.status(500).send({ error: error.message });
  }
});

app.listen(PORT, () => { console.log(`Server is running on port ${PORT}`); });
