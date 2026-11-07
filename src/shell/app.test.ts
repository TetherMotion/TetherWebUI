import { describe, expect, it } from 'vitest';
import { DataHub } from '../data/hub';
import './app';
import type { TetherShell } from './app';
import '../tiles';

function makeHub(): DataHub {
  const hub = new DataHub();
  hub.connect = (() => Promise.resolve()) as typeof hub.connect;
  return hub;
}

describe('tether-shell', () => {
  it('renders the status strip and built-in board tabs', async () => {
    localStorage.clear();
    const shell = document.createElement('tether-shell') as TetherShell;
    shell.hub = makeHub();
    document.body.appendChild(shell);
    await shell.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
    expect(shell.querySelector('.status-strip')).toBeTruthy();
    expect(shell.querySelectorAll('.board-tab').length).toBeGreaterThanOrEqual(4);
    expect(shell.querySelector('board-view')).toBeTruthy();
    shell.remove();
  });

  it('adds a tile to the active board in edit mode', async () => {
    localStorage.clear();
    const shell = document.createElement('tether-shell') as TetherShell;
    shell.hub = makeHub();
    document.body.appendChild(shell);
    await shell.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
    shell.editing = true;
    await shell.updateComplete;
    const view = shell.querySelector('board-view') as unknown as {
      addTile: (type: string) => void;
      board?: { tiles: unknown[] };
    } | null;
    expect(view).toBeTruthy();
    const before = view!.board?.tiles.length ?? 0;
    view!.addTile('note');
    await shell.updateComplete;
    expect(view!.board?.tiles.length).toBe(before + 1);
    shell.remove();
  });
});
