import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './styles.css';
import './game.css';
import { sound } from './audio';
import { installChrome } from './chrome';
import { installCursors } from './cursors';

// Browsers only allow audio after a user gesture.
for (const ev of ['pointerdown', 'keydown'] as const) window.addEventListener(ev, () => sound.unlock());

installChrome();
installCursors();

createRoot(document.getElementById('root')!).render(<App />);
