import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const PRICE_ID = 'price_1UfqvrGnhZt04oIRRxwZqBIb';
const SITE = 'https://www.quietlyspoken.app';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const key = process.env.STRIPE_SECRET_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key || !supabaseUrl || !serviceKey) {
    console.error('Checkout is missing server environment variables');
    return res.status(500).json({ error: 'Server is not configured' });
  }

  const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
  if (!token) return res.status(401).json({ error: 'Log in first' });

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData.user) {
    return res.status(401).json({ error: 'Log in first' });
  }
  const userId = userData.user.id;

  try {
    const stripe = new Stripe(key);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      client_reference_id: userId,
      subscription_data: { metadata: { supabase_user_id: userId } },
      success_url: `${SITE}/studio?checkout=success`,
      cancel_url: `${SITE}/studio?checkout=cancel`,
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Checkout error', err);
    return res.status(500).json({ error: 'Could not start checkout' });
  }
