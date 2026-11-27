import { useState } from 'react';
import { supabase } from '../supabaseClient';

export default function SubscribeButton() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubscribe() {
    setError('');
    setLoading(true);
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) {
      setError('Log in first.');
      setLoading(false);
      return;
    }

    const res = await fetch('/api/create-checkout-session', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json().catch(() => ({}));

    if (!res.ok || !body.url) {
      setError(body.error || 'Could not start checkout.');
      setLoading(false);
      return;
    }
    window.location.href = body.url;
  }

  return (
    <div>
      <button onClick={handleSubscribe} disabled={loading}>
        {loading ? 'Opening checkout…' : 'Subscribe'}
      </button>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
    </div>
  );
}
