import { useEffect, useRef, useState } from 'react';
import { connect, hasToken, savedName } from '../net';
import { useStore } from '../store';
import { Frost } from './Frost';
import { drawName, joinMessage, joinTrouble, readLastDay } from './joinFlow';
import { SettingsSheet } from './SettingsSheet';
import { walkChoices } from './util';

type View = 'menu' | 'found' | 'code';

/** Attributes that keep password managers and autofill off the game's fields. */
const NOT_A_LOGIN = { autoComplete: 'off', autoCorrect: 'off', autoCapitalize: 'off', spellCheck: false, 'data-lpignore': 'true', 'data-1p-ignore': 'true', 'data-bwignore': 'true', 'data-form-type': 'other' } as const;

/**
 * The title screen: the world going cold behind a hanging standard, with the three ways in.
 * Every join goes through connect(); what comes back in store.error decides what to ask next.
 */
export function JoinScreen() {
  const s = useStore();
  const saved = savedName();
  const colony = saved && hasToken(saved) ? saved : '';
  const day = useRef(readLastDay()).current;
  const [view, setView] = useState<View>('menu');
  const [sheet, setSheet] = useState(false);
  const [name, setName] = useState(colony ? '' : saved);
  const [word, setWord] = useState('');
  const [code, setCode] = useState('');
  // The server asked: it's the only way to know a world has a password.
  const [locked, setLocked] = useState(false);
  const tried = useRef({ name: '', word: '' });
  const trouble = joinTrouble(s.error);
  const busy = s.status === 'connecting';
  const wordBox = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (trouble === 'password') {
      setLocked(true);
      // Continue can land here too: the question needs a form to be asked on.
      setView((v) => (v === 'menu' ? 'found' : v));
      setName((n) => n || tried.current.name);
      setTimeout(() => wordBox.current?.focus());
    } else if (trouble === 'name-taken') {
      setView('code');
      setName((n) => n || tried.current.name);
    }
  }, [trouble, s.error]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Nothing focused yet: the arrows still find the menu.
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && document.activeElement === document.body) {
        e.preventDefault();
        document.querySelector<HTMLButtonElement>('.standard .choice:not(:disabled), .standard input')?.focus();
      }
      if (e.key !== 'Escape' || busy) return;
      if (sheet) setSheet(false);
      else if (view !== 'menu') setView('menu');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheet, view, busy]);

  const go = (who: string, joinCode?: string) => {
    tried.current = { name: who, word };
    connect(who, word || undefined, joinCode);
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim() && !busy) go(name.trim(), code.trim() || undefined);
  };

  const returning = name.trim() && hasToken(name.trim());
  const message = joinMessage(s.error, !!tried.current.word);
  const nameField = (autoFocus: boolean) => (
    <input className="carved" name="fe-leader" value={name} maxLength={20} onChange={(e) => setName(e.target.value)} placeholder="Leader's name" aria-label="Leader's name" autoFocus={autoFocus} {...NOT_A_LOGIN} />
  );
  const note = message && (
    <p className="error" role="alert">
      {message}
    </p>
  );
  const wordField = locked && (
    <label className="gate">
      <span>The host locked this world. What's the password?</span>
      <input ref={wordBox} className="carved small" name="fe-world-word" value={word} onChange={(e) => setWord(e.target.value)} placeholder="Ask the host" {...NOT_A_LOGIN} />
    </label>
  );

  return (
    <div className="title-screen">
      <div className="title-art" />
      <Frost reach={0.2} creep={4.5} linger={0.2} />
      <div className="standard-hang">
        <div className="standard" role="group" aria-label="FrozenEarth">
          <h1 className="wordmark">FrozenEarth</h1>
          {view === 'menu' && (
            <>
              <p className="motto">Winter is closing in from the edge of the world.</p>
              <div className="choices" onKeyDown={walkChoices}>
                {colony && (
                  <button className="choice first" disabled={busy} onClick={() => go(colony)}>
                    {busy ? 'Connecting…' : 'Continue'}
                    <small>
                      {colony}
                      {day ? `, day ${day}` : ''}
                    </small>
                  </button>
                )}
                <button className={`choice ${colony ? '' : 'first'}`} disabled={busy} onClick={() => setView('found')}>
                  New colony
                </button>
                <button className="choice" disabled={busy} onClick={() => setView('code')}>
                  Join with a code
                </button>
                <button className="choice quiet" disabled={busy} onClick={() => setSheet(!sheet)} aria-expanded={sheet}>
                  Settings
                </button>
              </div>
            </>
          )}
          {view === 'found' && (
            <form className="naming" onSubmit={submit} autoComplete="off">
              <h2>Who leads them?</h2>
              {nameField(!locked)}
              <button type="button" className="link muted" onClick={() => setName(drawName(name))}>
                Draw a name
              </button>
              {wordField}
              {note}
              <button className="primary" disabled={busy || !name.trim()}>
                {busy ? 'Connecting…' : returning ? `Return to ${name.trim()}'s colony` : 'Start colony'}
              </button>
              <button type="button" className="link muted" disabled={busy} onClick={() => setView('menu')}>
                Back
              </button>
            </form>
          )}
          {view === 'code' && (
            <form className="naming" onSubmit={submit} autoComplete="off">
              <h2>Join with a code</h2>
              {nameField(true)}
              <input className="carved small" name="fe-rejoin" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Rejoin code" aria-label="Rejoin code" {...NOT_A_LOGIN} />
              <p className="fine">Your other device has the code: in the game press ? then Play on another device.</p>
              {wordField}
              {note}
              <button className="primary" disabled={busy || !name.trim()}>
                {busy ? 'Connecting…' : 'Rejoin my colony'}
              </button>
              <button type="button" className="link muted" disabled={busy} onClick={() => setView('menu')}>
                Back
              </button>
            </form>
          )}
          {view === 'menu' && note}
          {busy && s.error && (
            <button className="link muted" onClick={() => location.reload()}>
              Stop trying
            </button>
          )}
        </div>
      </div>
      {sheet && <SettingsSheet onClose={() => setSheet(false)} />}
    </div>
  );
}
