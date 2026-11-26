;
  }
import Stripe from 'stripe';

const PRICE_ID = 'price_1UfqvrGnhZt04oIRRxwZqBIb';
const SITE = 'https://www.quietlyspoken.app';

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    res.status(200).json({ url: session.url });
  }
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.error('STRIPE_SECRET_KEY is not set');
        res.status(500).json({ error: 'Server is missing its Stripe key' });
  }
    try {
    const stripe = new Stripe(key);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      success_url: `${SITE}/studio?checkout=success`,
      cancel_url: `${SITE}/studio?checkout=cancel`,
    });
    return res.redirect(303, session.url!);
  } catch (err) {
    console.error('Checkout error', err);
    return res.status(500).json({ error: 'Could not start checkout' });
  }
