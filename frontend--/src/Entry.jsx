import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from './api';
import { authClient, authEnabled } from './auth';

function messageFor(error, fallback) {
  return error?.message || fallback;
}

export default function Entry() {
  const navigate = useNavigate();
  const [view, setView] = useState('home');
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [verificationCode, setVerificationCode] = useState('');

  useEffect(() => {
    if (!authClient) return undefined;
    let active = true;
    authClient.getSession()
      .then(async ({ data, error: sessionError }) => {
        if (sessionError) throw sessionError;
        if (data?.session && data?.user) {
          api.clearSession();
          await api.getIdentity();
          if (active) navigate('/dashboard', { replace: true });
        }
      })
      .catch(() => { /* A missing/expired session leaves the visitor at the entry screen. */ });
    return () => { active = false; };
  }, [navigate]);

  const handleStartDemo = async () => {
    setIsBusy(true); setError(''); setNotice('');
    try {
      await api.createDemoSession();
      await api.getIdentity();
      navigate('/dashboard');
    } catch (err) {
      setError(messageFor(err, 'Could not start the demo.'));
    } finally { setIsBusy(false); }
  };

  const handleLogin = async (event) => {
    event.preventDefault(); setIsBusy(true); setError(''); setNotice('');
    try {
      if (!authClient) throw new Error('Neon Auth is not configured for this deployment yet.');
      const { error: authError } = await authClient.signIn.email({ email, password });
      if (authError) throw authError;
      api.clearSession();
      await api.getIdentity();
      navigate('/dashboard');
    } catch (err) {
      setError(messageFor(err, 'Could not sign in.'));
    } finally { setIsBusy(false); }
  };

  const handleRegister = async (event) => {
    event.preventDefault(); setIsBusy(true); setError(''); setNotice('');
    try {
      if (!authClient) throw new Error('Neon Auth is not configured for this deployment yet.');
      const { data, error: authError } = await authClient.signUp.email({
        name: displayName.trim() || email.split('@')[0] || 'Miroir Trader',
        email,
        password
      });
      if (authError) throw authError;
      api.clearSession();
      if (data?.user && data.user.emailVerified) {
        await api.getIdentity();
        navigate('/dashboard');
        return;
      }
      setView('verify');
      setNotice(`Enter the verification code sent to ${email}.`);
    } catch (err) {
      setError(messageFor(err, 'Could not create the account.'));
    } finally { setIsBusy(false); }
  };

  const handleVerify = async (event) => {
    event.preventDefault(); setIsBusy(true); setError(''); setNotice('');
    try {
      if (!authClient) throw new Error('Neon Auth is not configured for this deployment yet.');
      const { data, error: authError } = await authClient.emailOtp.verifyEmail({ email, otp: verificationCode.trim() });
      if (authError) throw authError;
      api.clearSession();
      if (data?.session) {
        await api.getIdentity();
        navigate('/dashboard');
      } else {
        setPassword('');
        setView('login');
        setNotice('Email verified. Sign in to continue.');
      }
    } catch (err) {
      setError(messageFor(err, 'Could not verify that code.'));
    } finally { setIsBusy(false); }
  };

  const handleResend = async () => {
    setIsBusy(true); setError(''); setNotice('');
    try {
      if (!authClient) throw new Error('Neon Auth is not configured for this deployment yet.');
      const { error: authError } = await authClient.emailOtp.sendVerificationOtp({ email, type: 'email-verification' });
      if (authError) throw authError;
      setNotice(`A new verification code was sent to ${email}.`);
    } catch (err) {
      setError(messageFor(err, 'Could not resend the verification code.'));
    } finally { setIsBusy(false); }
  };

  const title = view === 'register' ? 'Create your account' : view === 'login' ? 'Welcome back' : view === 'verify' ? 'Verify your email' : 'Miroir';

  return (
    <div className="min-h-screen bg-canvas flex flex-col relative overflow-hidden text-text-primary">
      <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] bg-brand-primary/10 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-brand-secondary/10 rounded-full blur-[120px] pointer-events-none" />

      <main className="flex-1 flex flex-col items-center justify-center p-6 z-10">
        <div className="w-full max-w-md glass-card p-8 shadow-2xl relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
          <div className="flex flex-col items-center text-center mb-8">
            <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-brand-primary to-brand-secondary flex items-center justify-center mb-4 shadow-lg shadow-brand-primary/20">
              <span className="material-symbols-outlined text-white" style={{ fontSize: '56px', fontVariationSettings: "'FILL' 0" }}>neurology</span>
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-white mb-2">{title}</h1>
            <p className="text-sm text-brand-primary font-medium tracking-wide">Review your execution.</p>
            {view === 'home' && <p className="text-xs text-text-secondary mt-3 leading-relaxed px-4">Miroir checks your evidence against your confirmed strategy rules. Demo uses sample data; verified Neon Auth accounts can connect Roqqu for read-only account data.</p>}
            {view === 'register' && <p className="text-xs text-text-secondary mt-3">Neon Auth sends a verification code to confirm your email.</p>}
            {view === 'verify' && <p className="text-xs text-text-secondary mt-3">Enter the one-time code sent to {email}.</p>}
          </div>

          {error && <div role="alert" className="mb-5 p-3 rounded-lg bg-adherence-broken/10 border border-adherence-broken/30 text-adherence-broken text-xs text-center">{error}</div>}
          {notice && <div role="status" className="mb-5 p-3 rounded-lg bg-brand-primary/10 border border-brand-primary/30 text-text-primary text-xs text-center">{notice}</div>}

          {view === 'home' && (
            <div className="space-y-3">
              <button onClick={handleStartDemo} disabled={isBusy} className="w-full py-4 rounded-xl bg-gradient-to-r from-brand-primary to-brand-secondary hover:opacity-90 text-white font-semibold text-sm transition-all flex items-center justify-center gap-2 shadow-lg shadow-brand-primary/25 disabled:opacity-70">
                {isBusy ? <><span className="material-symbols-outlined animate-spin text-[20px]">progress_activity</span>Starting…</> : <>Start Demo<span className="material-symbols-outlined text-[18px]">arrow_forward</span></>}
              </button>
              <button onClick={() => { setView('login'); setError(''); setNotice(''); }} disabled={!authEnabled} title={!authEnabled ? 'Set VITE_NEON_AUTH_URL to enable accounts' : undefined} className="w-full py-3 rounded-xl bg-surface-elevated border border-border-subtle hover:border-brand-primary text-white font-semibold text-sm transition-all disabled:opacity-50">Sign in</button>
              <button onClick={() => { setView('register'); setError(''); setNotice(''); }} disabled={!authEnabled} title={!authEnabled ? 'Set VITE_NEON_AUTH_URL to enable accounts' : undefined} className="w-full py-3 rounded-xl text-text-secondary hover:text-white text-sm transition-all disabled:opacity-50">Create a Miroir account</button>
              {!authEnabled && <p className="text-center text-[10px] text-text-tertiary">Account sign-in will be available when Neon Auth is connected.</p>}
            </div>
          )}

          {(view === 'login' || view === 'register') && (
            <form onSubmit={view === 'login' ? handleLogin : handleRegister} className="space-y-4">
              {view === 'register' && <label className="block text-xs text-text-secondary">Display name<input value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="name" maxLength={80} className="mt-2 w-full rounded-lg bg-[#0B0F19]/70 border border-border-subtle px-3 py-3 text-sm text-white outline-none focus:border-brand-primary" placeholder="Your name" /></label>}
              <label className="block text-xs text-text-secondary">Email<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" maxLength={254} className="mt-2 w-full rounded-lg bg-[#0B0F19]/70 border border-border-subtle px-3 py-3 text-sm text-white outline-none focus:border-brand-primary" placeholder="you@example.com" /></label>
              <label className="block text-xs text-text-secondary">Password<input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={view === 'login' ? 'current-password' : 'new-password'} minLength={view === 'register' ? 12 : undefined} maxLength={128} className="mt-2 w-full rounded-lg bg-[#0B0F19]/70 border border-border-subtle px-3 py-3 text-sm text-white outline-none focus:border-brand-primary" placeholder={view === 'register' ? 'At least 12 characters' : 'Your password'} /></label>
              <button type="submit" disabled={isBusy || !authEnabled} className="w-full py-3.5 rounded-xl bg-gradient-to-r from-brand-primary to-brand-secondary text-white font-semibold text-sm shadow-lg shadow-brand-primary/25 disabled:opacity-70">{isBusy ? 'Please wait…' : view === 'login' ? 'Sign in' : 'Create account'}</button>
              {view === 'login' && <button type="button" onClick={handleResend} disabled={isBusy || !email} className="w-full py-2 text-xs text-brand-primary hover:text-white disabled:opacity-50">Resend verification code</button>}
              <button type="button" onClick={() => { setView(view === 'login' ? 'register' : 'login'); setError(''); setNotice(''); }} className="w-full py-2 text-xs text-text-secondary hover:text-white">{view === 'login' ? 'New to Miroir? Create an account' : 'Already registered? Sign in'}</button>
            </form>
          )}

          {view === 'verify' && <form onSubmit={handleVerify} className="space-y-4">
            <label className="block text-xs text-text-secondary">Verification code<input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={verificationCode} onChange={(e) => setVerificationCode(e.target.value.replace(/\D/g, '').slice(0, 6))} className="mt-2 w-full rounded-lg bg-[#0B0F19]/70 border border-border-subtle px-3 py-3 text-center text-lg tracking-[0.5em] text-white outline-none focus:border-brand-primary" placeholder="000000" /></label>
            <button type="submit" disabled={isBusy || verificationCode.length !== 6} className="w-full py-3.5 rounded-xl bg-gradient-to-r from-brand-primary to-brand-secondary text-white font-semibold text-sm shadow-lg disabled:opacity-70">{isBusy ? 'Verifying…' : 'Verify email'}</button>
            <button type="button" onClick={handleResend} disabled={isBusy} className="w-full py-2 text-xs text-brand-primary hover:text-white disabled:opacity-50">Resend code</button>
          </form>}

          {view !== 'home' && <button onClick={() => { setView('home'); setError(''); setNotice(''); }} className="w-full mt-5 text-xs text-text-tertiary hover:text-white">Back to demo</button>}
          <div className="mt-8 text-center"><p className="text-[10px] text-text-tertiary">Demo sessions are separate from Neon accounts. Roqqu access is read-only and requires a verified email.</p></div>
        </div>
      </main>
    </div>
  );
}
