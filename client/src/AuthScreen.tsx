import { useState, type FormEvent } from 'react';
import { AuthError, confirmSignUp, resendCode, signIn, signUp } from './auth';
import { useAction } from './useAction';

type Mode = 'signIn' | 'signUp' | 'confirm';

export function AuthScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [mode, setMode] = useState<Mode>('signIn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  function submit(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      if (mode === 'signUp') {
        await signUp(email, password);
        setNotice(`We sent a code to ${email}.`);
        setMode('confirm');
        return;
      }
      if (mode === 'confirm') {
        await confirmSignUp(email, code);
      }
      try {
        await signIn(email, password);
      } catch (caught) {
        if (caught instanceof AuthError && caught.code === 'UserNotConfirmedException') {
          setNotice('Confirm your email first. Enter the code we sent you.');
          setMode('confirm');
          return;
        }
        throw caught;
      }
      onSignedIn();
    });
  }

  return (
    <main>
      <h1>StandupLog</h1>
      <p className="muted">Async standups for small teams.</p>
      <form className="card" onSubmit={submit}>
        <h2>
          {mode === 'signIn' ? 'Sign in' : mode === 'signUp' ? 'Create account' : 'Confirm email'}
        </h2>
        {notice && <p className="notice">{notice}</p>}
        <label>
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {mode === 'confirm' && (
          <label>
            Code from email
            <input
              required
              inputMode="numeric"
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
        )}
        {error && <p className="error-text">{error}</p>}
        <div className="row">
          <button disabled={busy}>
            {mode === 'signIn' ? 'Sign in' : mode === 'signUp' ? 'Sign up' : 'Confirm and sign in'}
          </button>
          {mode === 'signIn' && (
            <button type="button" className="secondary" onClick={() => setMode('signUp')}>
              Create account
            </button>
          )}
          {mode !== 'signIn' && (
            <button type="button" className="secondary" onClick={() => setMode('signIn')}>
              Back to sign in
            </button>
          )}
          {mode === 'confirm' && (
            <button
              type="button"
              className="secondary"
              disabled={busy || !email}
              onClick={() =>
                run(async () => {
                  await resendCode(email);
                  setNotice(`New code sent to ${email}.`);
                })
              }
            >
              Resend code
            </button>
          )}
        </div>
      </form>
    </main>
  );
}
