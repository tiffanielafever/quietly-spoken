import type { VercelRequest, VercelResponse } from '@vercel/node';
import Stripe from 'stripe';

const PRICE_ID = 'price_1UfqvrGnhZt04oIRRxwZqBIb';
const SITE = 'https://quietly-spoken.vercel.app';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.error('STRIPE_SECRET_KEY is not set');
    return res.status(500).json({ error: 'Server is missing its Stripe key' });
  }

  try {
    const stripe = new Stripe(key);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      success_url: `${SITE}/studio?checkout=success`,
      cancel_url: `${SITE}/studio?checkout=cancel`,
      managed_payments: { enabled: false },
    });
    return res.redirect(303, session.url!);
  } catch (err) {
    console.error('Checkout error', err);
    return res.status(500).json({ error: 'Could not start checkout' });
  }
export default function handler(req: any, res: any) {
  res.status(200).json({ ok: true });
}
