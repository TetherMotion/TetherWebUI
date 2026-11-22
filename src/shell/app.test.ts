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

const activity = (shell: Element, label: string) =>
  [...shell.querySelectorAll<HTMLButtonElement>('.rail-act')].find(
    (b) => b.textContent?.trim() === label,
  )!;

describe('tether-shell', () => {
  it('renders the status strip and the activity bar', async () => {
    localStorage.clear();
    const shell = document.createElement('tether-shell') as TetherShell;
    shell.hub = makeHub();
    document.body.appendChild(shell);
    await shell.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
    expect(shell.querySelector('.status-strip')).toBeTruthy();
    for (const label of ['Configure', 'Program', 'Debug', 'Operate'])
      expect(activity(shell, label)).toBeTruthy();
    shell.remove();
  });

  it('hosts the PLC IDE under the Program activity; boards under Operate', async () => {
    localStorage.clear();
    const shell = document.createElement('tether-shell') as TetherShell;
    shell.hub = makeHub();
    document.body.appendChild(shell);
    await shell.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
    // default activity is program — the IDE is mounted already (it
    // lazy-imports, so wait for the upgrade before probing shadow DOM)
    await customElements.whenDefined('tether-plc-ide');
    const ide = shell.querySelector('tether-plc-ide');
    expect(ide).toBeTruthy();
    await (ide as unknown as { updateComplete: Promise<boolean> }).updateComplete;
    expect(ide!.querySelector('.plc-ide')).toBeTruthy();
    // Program renders the workbench (explorer + tabs + inspector), not nav
    expect(ide!.querySelectorAll('.plc-nav-btn').length).toBe(0);
    expect(ide!.querySelector('.plc-workbench')).toBeTruthy();
    expect(shell.querySelector('board-view')).toBeFalsy();
    // Operate shows the board tabs + board grid
    activity(shell, 'Operate').click();
    await shell.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
    expect(shell.querySelectorAll('.board-tab').length).toBeGreaterThanOrEqual(4);
    expect(shell.querySelector('board-view')).toBeTruthy();
    expect(shell.querySelector<HTMLElement>('tether-plc-ide')!.hidden).toBe(true);
    shell.remove();
  });

  it('adds a tile to the active board in edit mode', async () => {
    localStorage.clear();
    const shell = document.createElement('tether-shell') as TetherShell;
    shell.hub = makeHub();
    document.body.appendChild(shell);
    await shell.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
    activity(shell, 'Operate').click();
    await shell.updateComplete;
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
