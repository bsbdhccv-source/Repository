const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');

// تهيئة Firebase باستخدام ملف serviceAccount.json الموجود في المستودع
const serviceAccount = require('./serviceAccount.json');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: "https://x-o-x-abfe6-default-rtdb.firebaseio.com"
    });
}

const app = express();
app.use(bodyParser.json());

// صفحة الفحص الرئيسية
app.get('/', (req, res) => {
    res.send('TEFLSY Lemon Webhook Server is live and connected to Firebase!');
});

// استقبال الـ Webhook من Lemon Squeezy
app.post('/webhook', async (req, res) => {
    try {
        const event = req.body;
        console.log('--- Received Lemon Squeezy Webhook ---');

        // قراءة نوع الحدث
        const eventName = event.meta ? event.meta.event_name : null;
        console.log('Event Name:', eventName);

        if (eventName === 'order_created') {
            // استخراج custom_data المسند في رابط الشراء
            const customData = event.meta ? event.meta.custom_data : null;
            const userId = customData ? customData.user_id : null; // سيحتوي على u_احمد

            console.log('Extracted User ID:', userId);

            if (userId) {
                const pointsToAdd = 100; // عدد النقاط المضافة للباقة

                // 1. زيادة نقاط الحساب في Firebase Realtime Database
                const userPointsRef = admin.database().ref(`users/${userId}/points`);
                await userPointsRef.transaction((currentPoints) => {
                    return (currentPoints || 0) + pointsToAdd;
                });
                console.log(`Successfully added ${pointsToAdd} points to user: ${userId}`);

                // 2. إضافة إشعار داخل قسم الإشعارات الخاص بالمستخدم في التطبيق
                const notificationRef = admin.database().ref(`users/${userId}/notifications`).push();
                await notificationRef.set({
                    title: 'تم شحن الرصيد بنجاح! 🎉',
                    message: `تمت إضافة ${pointsToAdd} نقطة إلى حسابك بنجاح.`,
                    timestamp: Date.now(),
                    read: false
                });
                console.log(`Notification created for user: ${userId}`);
            } else {
                console.log('Warning: user_id missing in custom_data');
            }
        }

        res.status(200).send({ status: 'success' });
    } catch (error) {
        console.error('Error handling webhook:', error);
        res.status(500).send('Internal Server Error');
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
