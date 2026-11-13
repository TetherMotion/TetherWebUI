import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import {
  block,
  connectDashboard,
  dragWire,
  ensureConnected,
  freshPlcProject,
  newPou,
  openFreshIde,
  openPlcIde,
  paletteItem,
  pane,
  pin,
  projectJson,
  runCheck,
  setStSource,
} from './plc-helpers';

const FIXTURES = fileURLToPath(new URL('../test-fixtures', import.meta.url));

test.describe('TetherPLC IDE', () => {
  test('IDE connects to the ctl proxy and loads the library catalog', async ({ page }) => {
    await openFreshIde(page);
    await newPou(page, 'program');
    await pane(page, 'FBD');

    // /blocks catalog → palette groups per library file (TC2/TC3/tempctrl)
    const groups = page.locator('fbd-canvas .fbd-pgroup-name');
    await expect(groups.filter({ hasText: 'TC2' }).first()).toBeVisible({ timeout: 30_000 });
    await expect(groups.filter({ hasText: 'TC3' }).first()).toBeVisible();
    await expect(groups.filter({ hasText: 'TEMPCTRL' }).first()).toBeVisible();

    // Deploy pane reports the proxy reachable
    await pane(page, 'Deploy');
    await expect(page.locator('.plc-ctlbar')).toContainText('connected', { timeout: 15_000 });
  });

  test('POU kinds are created from the explorer', async ({ page }) => {
    await openFreshIde(page);
    await pane(page, 'Explorer');

    await newPou(page, 'program');
    await expect(page.locator('.plc-tree-pou', { hasText: 'POU1' })).toContainText('PRG');
    await newPou(page, 'function_block');
    await expect(page.locator('.plc-tree-pou', { hasText: 'POU2' })).toContainText('FB');
    await newPou(page, 'function');
    await expect(page.locator('.plc-tree-pou', { hasText: 'POU3' })).toContainText('FUN');

    const pouCount = await page.locator('.plc-tree-pou').count();
    expect(pouCount).toBe(3);
  });

  test('mouse drag wires blocks; undo and redo work', async ({ page }) => {
    await openFreshIde(page);
    await newPou(page, 'program');
    await pane(page, 'FBD');
    await page.waitForSelector('fbd-canvas svg', { timeout: 15_000 });

    // var-in (source, right-side out pin) → var-out (sink, left-side in pin)
    await page.locator('fbd-canvas .fbd-palette button[title*="variable input"]').click();
    await page.locator('fbd-canvas .fbd-palette button[title*="variable output"]').click();
    await expect(page.locator('fbd-canvas .fbd-block')).toHaveCount(2);

    const src = block(page, 'v0');
    const dst = block(page, 'v1');
    await dragWire(page, pin(src, 'out'), pin(dst, 'in'));

    await expect(page.locator('fbd-canvas .fbd-wire')).toHaveCount(1);
    let proj = await projectJson(page);
    expect(proj.fbd.pous[0].networks[0].wires).toHaveLength(1);

    // undo removes the wire, redo restores it
    await page.locator('fbd-canvas button[title="Undo (ctrl-z)"]').click();
    await expect(page.locator('fbd-canvas .fbd-wire')).toHaveCount(0);
    await page.locator('fbd-canvas button[title="Redo (ctrl-y)"]').click();
    await expect(page.locator('fbd-canvas .fbd-wire')).toHaveCount(1);
  });

  test('live typecheck flags an incompatible wire', async ({ page }) => {
    await openFreshIde(page);
    await newPou(page, 'program');
    await pane(page, 'FBD');
    await page.waitForSelector('fbd-canvas svg');

    // ADD produces a numeric value; TON.IN is BOOL — REAL→BOOL is not
    // convertible, so the canvas must flag the wire/pin live.
    await paletteItem(page, 'ADD').first().click();
    await paletteItem(page, 'TON').first().click();
    await expect(page.locator('fbd-canvas .fbd-block')).toHaveCount(2);

    const add = block(page, 'ADD');
    const ton = block(page, 'TON');
    await dragWire(page, pin(add, 'out'), pin(ton, 'in'));
    await expect(page.locator('fbd-canvas .fbd-wire')).toHaveCount(1);

    // status strip reports the inference issue count
    await expect(page.locator('fbd-canvas .fbd-status')).toContainText(/error/i, {
      timeout: 10_000,
    });
  });

  test('device wizard creates a mixed EK1110 DI+DO terminal', async ({ page }) => {
    await openFreshIde(page);
    await newPou(page, 'program');
    await pane(page, 'FBD');
    await page.waitForSelector('fbd-canvas svg');

    await paletteItem(page, 'EK1110').click();
    const dlg = page.locator('.fbd-devdlg');
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText('4× DO');
    await dlg.locator('button', { hasText: 'Add' }).click();

    const dev = block(page, 'EK1110');
    await expect(dev).toHaveCount(1);
    // 4 DI outputs + 4 DO inputs = 8 channel pins
    await expect(dev.locator('.fbd-pin')).toHaveCount(8);
    await expect(dev.locator('.fbd-pin.out')).toHaveCount(4);
    await expect(dev.locator('.fbd-pin.in')).toHaveCount(4);

    // channel table editor lists all eight with AT bindings (the header
    // row shares tbody — count data rows only)
    await dev.locator('.fbd-rect').click();
    const rows = page.locator('.fbd-devedit .fbd-devtbl tbody tr:has(td)');
    await expect(rows).toHaveCount(8);
    // AT bindings live in input values, not text — read them directly
    const ats = await page
      .locator('.fbd-devedit .fbd-devtbl td:nth-child(4) input')
      .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    expect(ats).toEqual([
      '%IX0.0', '%IX0.1', '%IX0.2', '%IX0.3',
      '%QX0.0', '%QX0.1', '%QX0.2', '%QX0.3',
    ]);
  });

  test('ST source compiles through the proxy; diagnostics navigate', async ({ page }) => {
    await openFreshIde(page);
    await newPou(page, 'program');
    await pane(page, 'ST');
    await page.waitForSelector('st-editor .cm-content', { timeout: 15_000 });

    await setStSource(
      page,
      'PROGRAM POU1\nVAR r : LREAL; END_VAR\nr := 1.5;\nEND_PROGRAM\n',
    );
    // change events are debounced ~400 ms
    await page.waitForTimeout(600);
    await runCheck(page);
    await expect(page.locator('.plc-status')).toContainText('check ok', { timeout: 30_000 });

    // break the source → real tplcc diagnostics land in the strip
    await setStSource(page, 'PROGRAM POU1\nVAR\nBROKEN := ;\nEND_PROGRAM\n');
    await page.waitForTimeout(600);
    await runCheck(page);
    const diag = page.locator('.plc-diag.error').first();
    await expect(diag).toBeVisible({ timeout: 30_000 });
    await expect(diag).toContainText('POU1.st');

    // clicking the diagnostic jumps to the ST pane
    await diag.click();
    await expect(page.locator('.plc-nav-btn.active')).toHaveText('ST');
    await expect(page.locator('st-editor .cm-content')).toBeVisible();
  });

  test('catalog block placement auto-attaches its library source', async ({ page }) => {
    await openFreshIde(page);
    await newPou(page, 'program');
    await pane(page, 'FBD');
    await page.waitForSelector('fbd-canvas svg');

    // place FB_AtcPid from the tempctrl catalog group
    await page.locator('fbd-canvas .fbd-palette-q').fill('AtcPid');
    const item = paletteItem(page, 'FB_AtcPid').first();
    await expect(item).toBeVisible({ timeout: 10_000 });
    await item.click();
    await expect(block(page, 'FB_AtcPid')).toHaveCount(1);

    // need-libsrc → /libsrc → source lands in stSources (Libraries tree)
    await pane(page, 'Explorer');
    await expect(page.locator('.plc-tree')).toContainText('atc_tempctrl', { timeout: 20_000 });

    // and the project still compiles through the proxy
    await pane(page, 'FBD');
    await runCheck(page);
    await expect(page.locator('.plc-status')).not.toContainText('check failed', {
      timeout: 30_000,
    });
  });

  test('curve editor attaches library, inserts profile, auto-wires, compiles', async ({ page }) => {
    await openFreshIde(page);
    await newPou(page, 'program');
    await pane(page, 'Curves');
    await page.waitForSelector('temp-curve', { timeout: 15_000 });

    // attach the Atc_TempCtrl library source via the file input
    await page.locator('.plc-main input[type="file"]').setInputFiles(
      `${FIXTURES}/atc_tempctrl.st`,
    );
    await expect(page.locator('.plc-main')).not.toContainText('FB_AtcProfile is not', {
      timeout: 10_000,
    });

    // insert the profile into the selected POU
    await page.locator('temp-curve button', { hasText: /insert into/ }).click();
    await pane(page, 'FBD');
    await expect(block(page, 'FB_AtcProfile')).toHaveCount(1);
    await expect(block(page, 'FB_AtcPid')).toHaveCount(1);
    // auto-wiring produced wires
    const proj = await projectJson(page);
    const net = proj.fbd.pous[0].networks[0];
    expect(net.wires.length).toBeGreaterThan(0);
    expect(net.blocks.length).toBeGreaterThanOrEqual(2);

    // the auto-wired project compiles clean through the real toolchain
    await runCheck(page);
    await expect(page.locator('.plc-status')).toContainText('check ok', { timeout: 60_000 });
  });

  test('project persists across reload', async ({ page }) => {
    await openFreshIde(page);
    await newPou(page, 'program');
    await pane(page, 'FBD');
    await page.waitForSelector('fbd-canvas svg');
    await page.locator('fbd-canvas .fbd-palette button[title*="variable input"]').click();
    await page.locator('fbd-canvas .fbd-palette button[title*="variable output"]').click();
    await dragWire(
      page,
      pin(block(page, 'v0'), 'out'),
      pin(block(page, 'v1'), 'in'),
    );
    await expect(page.locator('fbd-canvas .fbd-wire')).toHaveCount(1);

    await page.reload();
    await ensureConnected(page);
    await openPlcIde(page);
    await pane(page, 'FBD');
    await expect(block(page, 'v0')).toHaveCount(1);
    await expect(page.locator('fbd-canvas .fbd-wire')).toHaveCount(1);
  });

  test('watch, tasks and deploy panes render their surfaces', async ({ page }) => {
    await openFreshIde(page);
    await newPou(page, 'program');

    await pane(page, 'Tasks');
    await expect(page.locator('.plc-main')).toBeVisible();

    await pane(page, 'Watch');
    await expect(page.locator('.plc-main')).toBeVisible();

    await pane(page, 'Deploy');
    await expect(page.locator('.plc-ctlbar')).toContainText('connected', { timeout: 15_000 });
    await expect(page.locator('.plc-ops')).toBeVisible();
  });

  test('export .fbd.json downloads a valid project document', async ({ page }) => {
    await openFreshIde(page);
    await newPou(page, 'program');

    const download = page.waitForEvent('download');
    await page.locator('.plc-toolbar button', { hasText: 'Export .fbd.json' }).click();
    const file = await download;
    const path = await file.path();
    const { readFile } = await import('node:fs/promises');
    const doc = JSON.parse(await readFile(path, 'utf8'));
    expect(doc.schema).toBe('fbd.v1');
    expect(doc.pous).toHaveLength(1);
    expect(doc.pous[0].name).toBe('POU1');
  });
});
