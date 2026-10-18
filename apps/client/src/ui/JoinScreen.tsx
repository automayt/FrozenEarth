import { useState } from 'react';
import { connect, savedName } from '../net';
import { useStore } from '../store';

export function JoinScreen() {
  const s = useStore();
  const [name, setName] = useState(savedName());
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  // Opened by hand, or by the server saying the name is taken (someone else has it, or it's you on a new device).
  const [showCode, setShowCode] = useState(false);
  const taken = /name is taken/i.test(s.error);
  const busy = s.status === 'connecting';
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim()) connect(name.trim(), password || undefined, code.trim() || undefined);
  };
  return (
    <div className="join">
      <div className="frost" aria-hidden />
      <form className="join-card" onSubmit={submit}>
        <h1>
          Frozen<span>Earth</span>
        </h1>
        <p className="tagline">Winter is closing in from the edge of the world. Settle the outer band while it is still warm, and keep moving toward the center.</p>
        <label>
          Your name
          <input autoFocus value={name} maxLength={20} onChange={(e) => setName(e.target.value)} placeholder="e.g. Astrid" />
        </label>
        <label>
          Server password <span className="muted">(if the host set one)</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {s.error && <p className="error">{s.error}</p>}
        {showCode || taken ? (
          <label>
            Rejoin code <span className="muted">(to play your colony from this device)</span>
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste the code from your other device" spellCheck={false} autoComplete="off" />
          </label>
        ) : null}
        <button className="primary" disabled={busy || !name.trim()}>
          {busy ? 'Connecting…' : code.trim() ? 'Rejoin my colony' : 'Join world'}
        </button>
        <p className="muted small">
          Join with the same name later to return to your colony; a new name starts a new colony. On another device or browser you'll need your rejoin code (in the game: ? then "Play on another device").
          {!showCode && !taken && (
            <>
              {' '}
              <button type="button" className="link" onClick={() => setShowCode(true)}>
                I have a rejoin code
              </button>
            </>
          )}
        </p>
      </form>
    </div>
  );
}
