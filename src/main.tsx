import { createRoot } from 'react-dom/client';
import './fonts';
import './styles.css';
import './components/canvas.css';
import './components/boards.css';
import App from './App';
import { useStore, currentLayout } from './store';
import { canvasRefs } from './render';
import { initTheme } from './theme';
import * as exporter from './exporter';

// Dev-only handle for poking at live state from devtools.
if (import.meta.env.DEV) (window as any).__spread = { useStore, currentLayout, canvasRefs, exporter };

initTheme();
createRoot(document.getElementById('root')!).render(<App />);
