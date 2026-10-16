import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './styles.css';
import { sound } from './audio';

// Browsers only allow audio after a user gesture.
for (const ev of ['pointerdown', 'keydown'] as const) window.addEventListener(ev, () => sound.unlock());

createRoot(document.getElementById('root')!).render(<App />);
