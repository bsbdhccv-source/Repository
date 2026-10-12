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

      console.log(`تم بنجاح إضافة ${pointsToAdd} نقطة وإرسال الإشعار للمستخدم: ${userId}`);
    }

    res.status(200).send({ success: true });
  } catch (error) {
    console.error('خطأ أثناء معالجة الـ Webhook:', error);
    res.status(500).send({ error: error.message });
  }
});
