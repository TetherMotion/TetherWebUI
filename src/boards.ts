/**
 * Boards entry point — the Lit tile-host UI.
 * main.ts (the legacy monolith) remains for reference; the served app is
 * tether-shell driven by a shared DataHub.
 */
import './style.css';
import './boards.css';
import './components';
import { DataHub } from './data/hub';
import './shell/app';
import type { TetherShell } from './shell/app';

const savedTheme = localStorage.getItem('tether-theme');
document.documentElement.dataset.theme =
  savedTheme === 'dark' || (!savedTheme && matchMedia('(prefers-color-scheme: dark)').matches)
    ? 'dark'
    : 'light';

const hub = new DataHub();
const shell = document.createElement('tether-shell') as TetherShell;
shell.hub = hub;
document.body.appendChild(shell);
