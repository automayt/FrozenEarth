import { useState } from 'react';
import { connect, savedName } from '../net';
import { useStore } from '../store';

export function JoinScreen() {
  const s = useStore();
  const [name, setName] = useState(savedName());
  const [password, setPassword] = useState('');
  const busy = s.status === 'connecting';
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim()) connect(name.trim(), password || undefined);
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
        <button className="primary" disabled={busy || !name.trim()}>
          {busy ? 'Connecting…' : 'Join world'}
        </button>
        {s.error && <p className="error">{s.error}</p>}
        <p className="muted small">Join with the same name later to return to your colony. A new name starts a new colony.</p>
      </form>
    </div>
  );
}
