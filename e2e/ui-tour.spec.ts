import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  act,
  block,
  connectDashboard,
  dismissTplPicker,
  freshPlcProject,
  openPou,
  pane,
  pin,
} from './plc-helpers';


/**
 * UI tour — visual coverage of EVERY user-facing surface. Each screenshot
 * lands in the test's artifact dir (test-results/<test>/<name>.png), named
 * so a sort order matches the walk order. The point is completeness: every
 * dialog, drawer, overlay, pane, editor kind and option panel gets a frame
 * so UI regressions are reviewable as images, not just selector diffs.
 *
 * Reachability notes (found while enumerating):
 *  - the Settings overlay ('settings') has NO trigger in the shell — the
 *    only way to render it is poking the field, which this spec does via
 *    evaluate so it is still visually covered;
 *  - native window.prompt/confirm paths (rename, comment text, deploy
 *    confirm) can't be screenshotted and are covered by functional specs.
 */

const ide = (page: Page) => page.locator('tether-plc-ide');

async function shot(page: Page, info: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: info.outputPath(`${name}.png`) });
}

/** Boot + load the Temperature-cell template (devices + FBs + task). */
async function bootTemplateIde(page: Page): Promise<void> {
  await freshPlcProject(page);
  await connectDashboard(page);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await act(page, 'Program');
  const el = ide(page);
  await expect(el.locator('.plc-tpl-overlay')).toBeVisible({ timeout: 30_000 });
  await el.locator('.plc-tpl-card', { hasText: 'Temperature cell' }).click();
  await expect(el.locator('.plc-tpl-overlay')).toHaveCount(0);
  await expect(el.locator('.plc-workbench')).toBeVisible();
  await openPou(page, 'EK_PID');
  await expect(el.locator('fbd-canvas')).toBeVisible({ timeout: 15_000 });
}

test.describe('ui tour — shell chrome', () => {
  test('activities, overlays, drawers, palette, theme', async ({ page }, info) => {
    await freshPlcProject(page);
    await connectDashboard(page);
    await page.setViewportSize({ width: 1600, height: 1000 });

    // default activity is Program — IDE workbench + status strip
    const el = ide(page);
    await expect(el.locator('.plc-toolbar')).toBeVisible({ timeout: 30_000 });
    await dismissTplPicker(page);
    await shot(page, info, '01-program-activity');

    // Connection overlay — Server URL datalist, token, Connect/Disconnect
    await page.locator('button[title="Connection settings"]').click();
    await expect(page.locator('.overlay .overlay-panel')).toBeVisible();
    await shot(page, info, '02-connect-overlay');
    await page.keyboard.press('Escape');
    await expect(page.locator('.overlay')).toHaveCount(0);

    // Settings overlay — reachable only by poking shell state (no trigger)
    await page.evaluate(() => {
      const s = document.querySelector('tether-shell') as unknown as {
        overlay?: string;
        requestUpdate: () => void;
      };
      s.overlay = 'settings';
      s.requestUpdate();
    });
    await expect(page.locator('.overlay .overlay-panel')).toBeVisible();
    await expect(page.locator('.overlay-body.settings')).toBeVisible();
    await shot(page, info, '03-settings-overlay');
    await page.keyboard.press('Escape');
    await expect(page.locator('.overlay')).toHaveCount(0);

    // ⌘K jump-anywhere palette — full list, then filtered
    await page.locator('button[title^="Command palette"]').click();
    await expect(page.locator('.palette')).toBeVisible();
    await shot(page, info, '04-command-palette');
    await page.locator('.palette input').fill('debug');
    await shot(page, info, '05-command-palette-filtered');
    await page.keyboard.press('Escape');
    await expect(page.locator('.palette')).toHaveCount(0);

    // alarms drawer — tile-alarm-list mounts lazily inside
    await page.locator('.rail-btn[title="Alarms"]').click();
    await expect(page.locator('.drawer.alarms')).toBeVisible();
    await expect(page.locator('.drawer.alarms tile-alarm-list')).toHaveCount(1, {
      timeout: 15_000,
    });
    await shot(page, info, '06-alarms-drawer');
    await page.locator('.rail-btn[title="Alarms"]').click();

    // events drawer — tile-event-timeline
    await page.locator('.rail-btn[title="Events"]').click();
    await expect(page.locator('.drawer.events')).toBeVisible();
    await expect(page.locator('.drawer.events tile-event-timeline')).toHaveCount(1, {
      timeout: 15_000,
    });
    await shot(page, info, '07-events-drawer');
    await page.locator('.rail-btn[title="Events"]').click();

    // theme toggle — capture dark and light deterministically
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
    });
    await shot(page, info, '08-theme-dark');
    await page.locator('button[title="Theme"]').click();
    await expect(page.locator('html[data-theme="light"]')).toHaveCount(1);
    await shot(page, info, '09-theme-light');
  });
});

test.describe('ui tour — operate boards', () => {
  test('board tabs, picker, edit mode, gallery, tile config', async ({ page }, info) => {
    await freshPlcProject(page);
    await connectDashboard(page);
    await page.setViewportSize({ width: 1600, height: 1000 });
    /* the first-run picker lives inside the IDE — dismiss it while the
       Program activity still shows the IDE (Operate hides it). */
    const el = ide(page);
    await expect(el.locator('.plc-toolbar')).toBeVisible({ timeout: 30_000 });
    await dismissTplPicker(page);
    await act(page, 'Operate');
    await expect(page.locator('board-view')).toBeVisible();
    await expect(page.locator('tile-drive-cards .drive-card')).toHaveCount(4, {
      timeout: 20_000,
    });
    await shot(page, info, '10-operate-machine');

    for (const [tab, name] of [
      ['Motion', '11-operate-motion'],
      ['Analyze', '12-operate-analyze'],
      ['Service', '13-operate-service'],
    ] as const) {
      await page.locator('.board-tab', { hasText: tab }).click();
      await page.waitForTimeout(400);
      await shot(page, info, name);
    }

    // board-actions strip on the active (user-source) board
    await page.locator('.board-tab', { hasText: 'Machine' }).click();
    await shot(page, info, '14-board-actions');

    // "+ board" template picker overlay
    await page.locator('.board-tab.add').click();
    await expect(page.locator('.overlay .board-picker')).toBeVisible();
    await shot(page, info, '15-board-picker');

    /* the Auto (PLC) card needs live plc.* catalog entries — the sim
       machine has none, so it deterministically raises an error toast */
    await page.locator('.bp-card', { hasText: 'Auto (PLC)' }).click();
    await expect(page.locator('.overlay')).toHaveCount(0);
    await expect(page.locator('.toasts .toast').first()).toBeVisible();
    await shot(page, info, '15b-toast');

    // edit mode — grips, per-tile tools, resize handles
    await page.locator('.chip-btn', { hasText: 'Edit' }).click();
    await shot(page, info, '16-edit-mode');

    // add-tile gallery — every tile group + item
    await page.locator('.gallery-fab').click();
    await expect(page.locator('.gallery')).toBeVisible();
    await shot(page, info, '17-tile-gallery');

    // tile config popover — add a configurable tile, open its form
    await page.locator('.gallery-item', { hasText: 'Value' }).first().click();
    const frame = page.locator('board-view tile-frame').last();
    await frame.locator('button[title="Configure tile"]').click();
    await expect(frame.locator('.tile-config')).toBeVisible();
    await shot(page, info, '18-tile-config');
    await frame.locator('.cfg-actions button', { hasText: 'Cancel' }).click();

    /* scope FFT dialog — the builtin Analyze scope's 'motion' preset can't
       match the sim catalog names (drive.*.snapshot records), so add a
       fresh scope tile bound to the real sine_wave stream instead. */
    await page.locator('.gallery-fab').click();
    await page.locator('.gallery-item', { hasText: 'Scope' }).first().click();
    const scopeFrame = page.locator('board-view tile-frame', {
      has: page.locator('tile-scope'),
    });
    await scopeFrame.locator('button[title="Configure tile"]').click();
    await scopeFrame.locator('.tile-config textarea[name="cfg-signals"]').fill('sine_wave');
    await scopeFrame.locator('.tile-config input[name="cfg-fft"]').check();
    await scopeFrame.locator('.cfg-actions button.primary').click();
    await expect(scopeFrame.locator('.tile-config')).toHaveCount(0);
    /* let the stream ring fill (4+ samples or the FFT just toasts) */
    await expect(scopeFrame.locator('.live-dot')).toContainText('LIVE', { timeout: 15_000 });
    await page.waitForTimeout(1500);
    await scopeFrame.locator('button', { hasText: 'FFT' }).click();
    await expect(scopeFrame.locator('.scope-plot-overlay')).toBeVisible({ timeout: 15_000 });
    await shot(page, info, '19-scope-fft');
  });
});

test.describe('ui tour — ide dialogs', () => {
  test('template picker and history dialog', async ({ page }, info) => {
    await freshPlcProject(page);
    await connectDashboard(page);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await act(page, 'Program');
    const el = ide(page);

    // auto-opened on a fresh empty project — all template cards + footer
    await expect(el.locator('.plc-tpl-overlay')).toBeVisible({ timeout: 30_000 });
    await shot(page, info, '20-template-picker');

    await el.locator('.plc-tpl-card', { hasText: 'Temperature cell' }).click();
    await expect(el.locator('.plc-tpl-overlay')).toHaveCount(0);
    await expect(el.locator('.plc-workbench')).toBeVisible();
    await shot(page, info, '21-workbench-from-template');

    // History — snapshot list + "snapshot now"/"close" footer
    await el.locator('.plc-toolbar .chip-btn', { hasText: 'History' }).click();
    await expect(el.locator('.plc-tpl-overlay')).toBeVisible();
    await expect(el.locator('.plc-tpl-title')).toHaveText('Project history');
    await shot(page, info, '22-history-dialog');
    await el.locator('.plc-tpl-foot .chip-btn', { hasText: 'close' }).click();
    await expect(el.locator('.plc-tpl-overlay')).toHaveCount(0);

    // Templates… toolbar button re-opens the picker on demand
    await el.locator('.plc-toolbar .chip-btn', { hasText: 'Templates' }).click();
    await expect(el.locator('.plc-tpl-overlay')).toBeVisible();
    await shot(page, info, '23-template-picker-manual');
  });
});

test.describe('ui tour — program workbench', () => {
  test('editor kinds, globals, inspector, dock tabs', async ({ page }, info) => {
    await bootTemplateIde(page);
    const el = ide(page);

    // FBD editor on the template net (devices + wired FBs)
    await shot(page, info, '30-editor-fbd');

    for (const [kind, name, sel] of [
      ['ST', '31-editor-st', 'st-editor .cm-editor'],
      ['Curve', '32-editor-curve', 'temp-curve'],
      ['Tune', '33-editor-tune', 'temp-tune'],
    ] as const) {
      await el.locator('.plc-edkind .chip-btn', { hasText: kind }).click();
      await expect(el.locator(sel)).toBeVisible({ timeout: 15_000 });
      await shot(page, info, name);
    }

    // globals document tab
    await el.locator('.plc-tree-pou', { hasText: 'globals' }).click();
    await expect(el.locator('.plc-edbody')).toContainText('VAR_GLOBAL');
    await shot(page, info, '34-globals-tab');

    // back to the POU — inspector with the full properties editor
    await openPou(page, 'EK_PID');
    await shot(page, info, '35-inspector-open');
    await el.locator('.plc-tabs .chip-btn', { hasText: 'inspector' }).click();
    await shot(page, info, '36-inspector-collapsed');
    await el.locator('.plc-tabs .chip-btn', { hasText: 'inspector' }).click();

    // bottom dock — problems / watch / events
    for (const [tab, name] of [
      ['Problems', '37-dock-problems'],
      ['Watch', '38-dock-watch'],
      ['Events', '39-dock-events'],
    ] as const) {
      await el.locator('.plc-dock-tab', { hasText: tab }).click();
      await expect(el.locator('.plc-dock-body')).toBeVisible();
      await shot(page, info, name);
    }
  });
});

test.describe('ui tour — fbd canvas', () => {
  test('library, cast picker, device wizard, selection props', async ({ page }, info) => {
    await bootTemplateIde(page);

    // slim toolbar: library trigger + quick-place + probe + undo/redo
    await shot(page, info, '40-fbd-toolbar');

    // block-library dialog — search + categorized grid (incl. catalog libs)
    await page.locator('fbd-canvas .fbd-libbtn').click();
    await expect(page.locator('fbd-canvas .fbd-lib')).toBeVisible();
    await shot(page, info, '41-block-library');

    // filtered search state
    await page.locator('fbd-canvas .fbd-lib-q').fill('ton');
    await shot(page, info, '42-block-library-search');
    await page.locator('fbd-canvas .fbd-lib-q').fill('');

    // FROM→TO conversion picker via the Conversions tile
    await page.locator('fbd-canvas .fbd-lib-item', { hasText: 'Convert value' }).click();
    await expect(page.locator('fbd-canvas .fbd-lib-castdlg')).toBeVisible();
    await shot(page, info, '43-cast-picker');
    await page
      .locator('fbd-canvas .fbd-lib-castdlg .chip-btn', { hasText: '✕' })
      .first()
      .click();
    await expect(page.locator('fbd-canvas .fbd-lib')).toHaveCount(0);

    // "Add device / terminal" wizard — pick an EL terminal from Devices
    await page.locator('fbd-canvas .fbd-libbtn').click();
    await expect(page.locator('fbd-canvas .fbd-lib')).toBeVisible();
    await page.locator('fbd-canvas .fbd-lib-item', { hasText: 'EL1014 DI' }).click();
    await expect(page.locator('fbd-canvas .fbd-devdlg-box')).toBeVisible();
    await shot(page, info, '44-device-wizard');
    await page
      .locator('fbd-canvas .fbd-devdlg-btns .chip-btn', { hasText: 'Cancel' })
      .click();
    await expect(page.locator('fbd-canvas .fbd-devdlg-box')).toHaveCount(0);

    // selection properties bar — click a block, props + param editors show
    await block(page, 'FB_AtcPid').locator('.fbd-rect').click();
    await expect(page.locator('fbd-canvas .fbd-props')).toBeVisible();
    await shot(page, info, '45-selection-props');
  });

  test('wire-pick armed state, placing modes, ld network', async ({ page }, info) => {
    await bootTemplateIde(page);

    // drop a wire on empty canvas → wire-pick bar + auto-opened library
    const out = pin(block(page, 'FB_AtcPid'), 'out', 0);
    const svg = page.locator('fbd-canvas svg').last();
    const [o, s] = [await out.boundingBox(), await svg.boundingBox()];
    if (!o || !s) throw new Error('pin/canvas not visible');
    await page.mouse.move(o.x + o.width / 2, o.y + o.height / 2);
    await page.mouse.down();
    await page.mouse.move(s.x + s.width * 0.9, s.y + s.height * 0.85, { steps: 12 });
    await page.mouse.up();
    await expect(page.locator('fbd-canvas .fbd-wirepick')).toBeVisible({ timeout: 10_000 });
    await shot(page, info, '46-wire-pick');
    /* the drop armed the library dialog on top — Esc closes it (input has
       focus), then the pick bar's own ✕ disarms the catch. */
    await page.keyboard.press('Escape');
    await expect(page.locator('fbd-canvas .fbd-lib')).toHaveCount(0);
    await page.locator('fbd-canvas .fbd-wirepick .chip-btn').click();
    await expect(page.locator('fbd-canvas .fbd-wirepick')).toHaveCount(0);

    // placing mode — "note" arms a canvas-drop indicator in the status bar
    await page.locator('fbd-canvas .fbd-palette .chip-btn', { hasText: 'note' }).click();
    await expect(page.locator('fbd-canvas .fbd-status')).toContainText('placing');
    await shot(page, info, '47-placing-mode');
    await page.locator('fbd-canvas .fbd-palette .chip-btn', { hasText: 'note' }).click();

    // LD network — second net rendered by ld-canvas
    await page.locator('.plc-fbd-head .chip-btn', { hasText: '+ ld' }).click();
    await expect(page.locator('ld-canvas')).toBeVisible({ timeout: 15_000 });
    await shot(page, info, '48-ld-canvas');
  });
});

test.describe('ui tour — configure panes', () => {
  test('all eight configure sections', async ({ page }, info) => {
    await bootTemplateIde(page);
    await act(page, 'Configure');
    await page.setViewportSize({ width: 1600, height: 1000 });

    const shots: [string, string][] = [
      ['Project', '50-cfg-project'],
      ['Target', '51-cfg-target'],
      ['Discovery', '52-cfg-discovery'],
      ['I/O Map', '53-cfg-iomap'],
      ['Tasks', '54-cfg-tasks'],
      ['Libraries', '55-cfg-libraries'],
      ['Services', '56-cfg-services'],
    ];
    for (const [label, name] of shots) {
      await pane(page, label);
      await page.waitForTimeout(300);
      await shot(page, info, name);
    }

    // Commissioning mounts real tiles off the hub — wait for them
    await pane(page, 'Commissioning');
    await expect(ide(page).locator('tile-sdo-inspector')).toHaveCount(1, {
      timeout: 20_000,
    });
    await shot(page, info, '57-cfg-commissioning');
  });
});

test.describe('ui tour — debug panes', () => {
  test('all eight debug sections', async ({ page }, info) => {
    await bootTemplateIde(page);
    await act(page, 'Debug');
    await page.setViewportSize({ width: 1600, height: 1000 });

    for (const [label, name] of [
      ['Run', '60-dbg-run'],
      ['Tasks', '61-dbg-tasks'],
      ['Watch', '62-dbg-watch'],
      ['I/O Image', '63-dbg-ioimage'],
      ['Events & Alarms', '64-dbg-events-alarms'],
      ['Simulate', '65-dbg-simulate'],
    ] as const) {
      await pane(page, label);
      await page.waitForTimeout(300);
      await shot(page, info, name);
    }

    // Diagnostics + Explore mount real tiles off the hub
    await pane(page, 'Diagnostics');
    await expect(ide(page).locator('tile-machine-state')).toHaveCount(1, {
      timeout: 20_000,
    });
    await shot(page, info, '66-dbg-diagnostics');

    await pane(page, 'Explore');
    await expect(ide(page).locator('tile-catalog')).toHaveCount(1, {
      timeout: 20_000,
    });
    await expect(ide(page).locator('tile-catalog .catalog-row').first()).toBeVisible({
      timeout: 20_000,
    });
    await shot(page, info, '67-dbg-explore');
  });
});
