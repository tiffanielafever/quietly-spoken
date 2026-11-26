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
    return new Response('Server is missing its Stripe key', { status: 500 });
  }
  try {
    const stripe = new Stripe(key);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      success_url: `${SITE}/studio?checkout=success`,
      cancel_url: `${SITE}/studio?checkout=cancel`,
    });
    return Response.redirect(session.url!, 303);
  } catch (err) {
    console.error('Checkout error', err);
    return new Response('Could not start checkout', { status: 500 });
  }
}
