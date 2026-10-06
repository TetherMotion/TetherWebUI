/**
 * Accessibility smoke checks (plan item 100): every rendered control must be
 * labelled, buttons need accessible names, and status outputs use live-region
 * roles. Runs under jsdom — no real browser required.
 */
import { describe, expect, it } from 'vitest';
import { renderCommissioning } from './commissioning';
import { renderPanels } from './panels';
import { renderRecipes } from './recipes';

function makeRoot(ids: string[]): HTMLElement {
  const root = document.createElement('div');
  for (const id of ids) {
    const panel = document.createElement('div');
    panel.id = id;
    root.appendChild(panel);
  }
  return root;
}

function accessibleName(element: Element): string {
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy)
    return labelledBy
      .split(/\s+/)
      .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? '')
      .join(' ');
  return (
    element.getAttribute('aria-label') ??
    element.closest('label')?.textContent ??
    element.textContent ??
    ''
  ).trim();
}

function assertControlsLabelled(root: HTMLElement): void {
  const unlabelled: string[] = [];
  root.querySelectorAll('input, select, textarea').forEach((input) => {
    if ((input as HTMLInputElement).type === 'hidden' || (input as HTMLInputElement).hidden) return;
    if (!accessibleName(input)) unlabelled.push(input.outerHTML.slice(0, 80));
  });
  root.querySelectorAll('button').forEach((button) => {
    if (!accessibleName(button)) unlabelled.push(button.outerHTML.slice(0, 80));
  });
  expect(unlabelled, `unlabelled controls: ${unlabelled.join('; ')}`).toEqual([]);
}

describe('accessibility smoke', () => {
  it('commissioning controls are all labelled', () => {
    const root = makeRoot([
      'capture-panel',
      'config-panel',
      'sdo-panel',
      'baseline-panel',
      'checklist-panel',
    ]);
    renderCommissioning(root, {
      captureAvailable: true,
      configAvailable: true,
      writableParams: [],
      triggerSignals: [],
      sdoAvailable: true,
      sdoSlave: 0,
      busy: false,
      baselineAvailable: true,
      checklistAvailable: true,
    });
    assertControlsLabelled(root);
    // Status output must be a live region for assistive tech.
    expect(root.querySelectorAll('[role="status"], [role="alertdialog"]').length)
      .toBeGreaterThan(0);
  });

  it('panels + recipes pages are labelled', () => {
    const root = makeRoot(['panels-panel', 'recipes-panel']);
    renderPanels(root, {
      profile: {
        name: 'test', version: '1', signatureHex: '00',
        panels: [
          { id: 'p', title: 'Panel', widgets: [
            { kind: 'bar', label: 'Temp', entry: 'x', min: 0, max: 100 },
            { kind: 'state', label: 'Mode', entry: 'y' },
          ] },
        ],
      },
      values: new Map([['x', 55]]),
      history: new Map([['x', [1, 2, 3]]]),
      unresolved: [],
      stale: false,
    });
    renderRecipes(root, {
      available: true,
      recipes: [{ name: 'r1', description: 'd', entryCount: 2 }],
      busy: false,
    });
    assertControlsLabelled(root);
    // Meter semantics for bar widgets.
    const meter = root.querySelector('[role="meter"]');
    expect(meter?.getAttribute('aria-valuenow')).toBe('55');
  });
});
