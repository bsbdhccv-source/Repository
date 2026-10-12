const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const app = express();

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

app.post('/webhook', express.raw({type: 'application/json'}), (request, response) => {
    const sig = request.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(request.body, sig, endpointSecret);
    } catch (err) {
        return response.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const customerEmail = session.customer_details.email;
        const paymentStatus = session.payment_status;

        if (paymentStatus === 'paid') {
            console.log(`تم الدفع بنجاح للعميل: ${customerEmail}`);
        }
    }

    response.status(200).json({received: true});
});

app.listen(process.env.PORT || 3000, () => {
    console.log('Webhook server is running...');
});
