import { expect, type Locator, type Page } from '@playwright/test';

export const WS_URL = 'ws://127.0.0.1:8099/tether-io';
/** ctl proxy spawned by playwright.config.ts webServer. */
export const CTL_URL = 'http://127.0.0.1:8089';

/**
 * Fresh PLC project + proxy endpoint, installed before app scripts run.
 * Must be called before page.goto().
 */
export async function freshPlcProject(page: Page, ctl = CTL_URL): Promise<void> {
  await page.addInitScript(
    ({ ctl }) => {
      localStorage.setItem('tether.plc.ctlUrl', ctl);
      /* wipe the project once per tab — sessionStorage survives reloads,
         so the persistence test's page.reload() keeps its document */
      if (!sessionStorage.getItem('__plcFresh')) {
        sessionStorage.setItem('__plcFresh', '1');
        localStorage.removeItem('tether.plc.project.v1');
      }
    },
    { ctl },
  );
}

/** Connect the dashboard shell over the simulated machine WebSocket. */
export async function connectDashboard(
  page: Page,
  role: 'observer' | 'operator' | 'technician' | 'admin' = 'operator',
): Promise<void> {
  await page.goto('/');
  await page.locator('button[title="Connection settings"]').click();
  await page.locator('#conn-url').fill(`${WS_URL}?role=${role}`);
  await page.locator('#conn-connect').click();
  await expect(page.locator('.status-strip')).toContainText('connected', { timeout: 20_000 });
}

/** (Re)connect if the strip doesn't already report connected. */
export async function ensureConnected(page: Page): Promise<void> {
  const strip = page.locator('.status-strip');
  if ((await strip.textContent())?.includes('connected')) return;
  await connectDashboard(page);
}

/** Open the TetherPLC board and wait for the IDE element. */
export async function openPlcIde(page: Page): Promise<Locator> {
  await page.locator('.board-tab', { hasText: 'TetherPLC' }).click();
  const ide = page.locator('tile-plc-ide tether-plc-ide');
  await expect(ide).toHaveCount(1, { timeout: 30_000 });
  return ide;
}

/** Full path: fresh project → connect → PLC IDE on the FBD-capable state. */
export async function openFreshIde(page: Page, ctl = CTL_URL): Promise<void> {
  await freshPlcProject(page, ctl);
  await connectDashboard(page);
  await openPlcIde(page);
}

/** Create a POU of the given kind via the explorer toolbar. */
export async function newPou(page: Page, kind: 'program' | 'function_block' | 'function'): Promise<void> {
  const label = { program: '+PRG', function_block: '+FB', function: '+FN' }[kind];
  await page.locator('.plc-nav-btn', { hasText: 'Explorer' }).click();
  await page.locator('.plc-tree-head button', { hasText: label }).click();
}

/** Switch IDE panes. */
export async function pane(page: Page, name: string): Promise<void> {
  await page.locator('.plc-nav-btn', { hasText: name }).click();
}

/** Palette button by visible label inside the FBD palette. */
export function paletteItem(page: Page, label: string): Locator {
  return page.locator('fbd-canvas .fbd-pitem', { hasText: label });
}

/** Block group on the canvas identified by its title text. */
export function block(page: Page, title: string): Locator {
  return page
    .locator('fbd-canvas .fbd-block')
    .filter({ has: page.locator('.fbd-title', { hasText: title }) });
}

/** n-th pin circle of a block ('in' | 'out'). */
export function pin(blockLoc: Locator, dir: 'in' | 'out', index = 0): Locator {
  return blockLoc.locator(`.fbd-pin.${dir}`).nth(index);
}

/** Drag an FBD wire from an out-pin to an in-pin with real mouse events. */
export async function dragWire(
  page: Page,
  from: Locator,
  to: Locator,
): Promise<void> {
  const s = await from.boundingBox();
  const d = await to.boundingBox();
  if (!s || !d) throw new Error('pin not visible — cannot drag wire');
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
  await page.mouse.down();
  await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2, { steps: 12 });
  await page.mouse.up();
}

/** Toolbar "check" — runs tplcc check through the ctl proxy. */
export async function runCheck(page: Page): Promise<void> {
  await page.locator('.plc-toolbar button', { hasText: 'check' }).click();
}

/** Read the project JSON persisted in localStorage. */
export async function projectJson(page: Page): Promise<any> {
  return page.evaluate(() => JSON.parse(localStorage.getItem('tether.plc.project.v1')!));
}

/** Replace the visible st-editor's document (CM dispatch emits `change`). */
export async function setStSource(page: Page, source: string): Promise<void> {
  await page.evaluate((src) => {
    const ed = document.querySelector('st-editor') as any;
    if (!ed?.view) throw new Error('st-editor not mounted');
    ed.view.dispatch({ changes: { from: 0, to: ed.view.state.doc.length, insert: src } });
  }, source);
}
