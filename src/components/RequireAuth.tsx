import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import SubscribeButton from './SubscribeButton';

type Status = 'loading' | 'out' | 'no-subscription' | 'in';

export default function RequireAuth({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');

  async function check(session: { user: { id: string } } | null) {
    if (!session) {
      setStatus('out');
      return;
    }
    const { data, error } = await supabase
      .from('subscriptions')
      .select('status')
      .eq('user_id', session.user.id)
      .maybeSingle();

    if (error) {
      console.error('Subscription check failed', error);
      setStatus('no-subscription');
      return;
    }
    const active = data?.status === 'active' || data?.status === 'trialing';
    setStatus(active ? 'in' : 'no-subscription');
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => check(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      check(session);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  if (status === 'loading') return null;
  if (status === 'out') return <Navigate to="/login" replace />;
  if (status === 'no-subscription') {
    return (
      <div style={{ maxWidth: 560, margin: '80px auto', padding: '0 20px' }}>
        <h1>Subscribe to use the studio</h1>
        <p>An active subscription is needed to open the studio.</p>
        <SubscribeButton />
      </div>
    );
  }
  return <>{children}</>;
}