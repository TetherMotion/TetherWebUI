import { expect, test, type Page } from '@playwright/test';
import { newPou, openFreshIde, pane, projectJson, setStSource } from './plc-helpers';

/** accept the next window.prompt/dialog with `text` */
async function acceptPrompt(page: Page, text: string): Promise<void> {
  page.once('dialog', (d) => void d.accept(text));
}

/** openPlcIde's picker dismissal is a one-shot count() — retry here in
    case the overlay rendered after the check. */
async function dismissPicker(page: Page): Promise<void> {
  const blank = page.locator('.plc-tpl-foot button', { hasText: 'Blank project' });
  for (let i = 0; i < 10; i++) {
    if (await blank.count()) { await blank.click(); return; }
    await page.waitForTimeout(200);
  }
}

test.describe('IDE editing features', () => {
  test('alarm rules designer builds the AlarmRules FBD program', async ({ page }) => {
    await openFreshIde(page);
    await dismissPicker(page);
    await pane(page, 'Alarms');

    await page.locator('button', { hasText: '+ rule' }).click();
    await page.locator('button', { hasText: '+ rule' }).click();
    await expect(page.locator('.plc-table input.plc-mapcell').first()).toBeVisible();

    await page.locator('button', { hasText: 'build AlarmRules' }).click();
    await expect(page.locator('fbd-canvas')).toBeVisible();

    const proj = await projectJson(page);
    const alarms = proj.fbd.pous.find((p: any) => p.name === 'AlarmRules');
    expect(alarms).toBeTruthy();
    const fbs = alarms.networks[0].blocks.filter((b: any) => b.type_ref === 'FB_AtcAlarm');
    expect(fbs).toHaveLength(2);
    // outputs exposed on the interface
    const names = alarms.interface.map((v: any) => v.name);
    expect(names).toContain('alarm1_ACT');
    expect(names).toContain('alarm2_UNACK');
    // persisted rules list
    expect(proj.alarms).toHaveLength(2);
    // task binds the program
    expect(JSON.stringify(proj.fbd.tasks)).toContain('p_alarms');
  });

  test('project history snapshots edits and restores them', async ({ page }) => {
    await openFreshIde(page);
    await dismissPicker(page);
    await newPou(page, 'program'); // save() auto-snapshots

    await page.locator('.plc-toolbar button', { hasText: 'History' }).click();
    const dialog = page.locator('.plc-tpl-dialog', { hasText: 'Project history' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.plc-tpl-card').first()).toBeVisible({ timeout: 10_000 });
    // auto-throttle means edits <30s apart don't snapshot — take a manual one
    await dialog.locator('button', { hasText: 'snapshot now' }).click();
    await page.locator('.plc-tpl-foot button', { hasText: 'close' }).click();

    // mutate: add a second POU (auto-snapshot may be throttled — the
    // manual snapshot still predates it)
    await newPou(page, 'function_block');
    const withTwo = await projectJson(page);
    const nTwo = withTwo.fbd.pous.length;

    await page.locator('.plc-toolbar button', { hasText: 'History' }).click();
    const cards = page.locator('.plc-tpl-dialog .plc-tpl-card');
    expect(await cards.count()).toBeGreaterThanOrEqual(1);
    // restore the OLDEST snapshot (last card) → back to one-POU project
    await cards.last().locator('button', { hasText: 'restore' }).click();
    await expect(page.locator('.plc-tpl-overlay')).toHaveCount(0);
    const restored = await projectJson(page);
    expect(restored.fbd.pous.length).toBeLessThan(nTwo);
  });

  test('FBD comment note places, renders and re-edits', async ({ page }) => {
    await openFreshIde(page);
    await dismissPicker(page);
    await newPou(page, 'program');
    await pane(page, 'FBD');

    await page.locator('fbd-canvas .chip-btn', { hasText: 'note' }).click();
    const svg = page.locator('fbd-canvas svg').first();
    const box = await svg.boundingBox();
    /* svg is ~700px tall — click near the top so the point is inside the
       720px viewport (elementFromPoint returns null below the fold) */
    const cx = box!.x + box!.width * 0.5;
    const cy = Math.min(box!.y + box!.height / 2, box!.y + 150);
    await acceptPrompt(page, 'overtemp interlock');
    await page.mouse.click(cx, cy);
    await expect(page.locator('fbd-canvas .fbd-note-text')).toHaveText('overtemp interlock');

    // double-click re-edits via prompt
    await acceptPrompt(page, 'updated note');
    await page.locator('fbd-canvas .fbd-note-g').dblclick();
    await expect(page.locator('fbd-canvas .fbd-note-text')).toHaveText('updated note');

    const proj = await projectJson(page);
    expect(JSON.stringify(proj)).toContain('updated note');
  });

  test('wire-end reconnect handles exist on drawn wires', async ({ page }) => {
    await openFreshIde(page);
    await dismissPicker(page);
    await newPou(page, 'program');
    await pane(page, 'FBD');

    // place two blocks via palette and wire them
    const { block, pin } = await import('./plc-helpers');
    await page.locator('fbd-canvas .fbd-pitem[title^="TON "]').click();
    await page.locator('fbd-canvas .fbd-pitem[title^="AND "]').click();

    const b1 = block(page, 'TON').first();
    const b2 = block(page, 'AND').first();
    const { dragWire } = await import('./plc-helpers');
    await dragWire(page, pin(b1, 'out', 0), pin(b2, 'in', 0));

    // select the wire — end handles render only for the selected wire
    const wire = page.locator('fbd-canvas polyline.fbd-line').first();
    const wb = await wire.boundingBox();
    await page.mouse.click(wb!.x + wb!.width / 2, wb!.y + wb!.height / 2);
    await expect(page.locator('fbd-canvas .fbd-wire-end').first()).toBeVisible();
    const n = await page.locator('fbd-canvas .fbd-wire-end').count();
    expect(n).toBeGreaterThanOrEqual(2);
  });

  test('LD editor: place contact, undo/redo, delete', async ({ page }) => {
    await openFreshIde(page);
    await dismissPicker(page);
    await newPou(page, 'program');
    await pane(page, 'FBD');
    await page.locator('button', { hasText: '+ ld' }).click();
    await expect(page.locator('ld-canvas')).toBeVisible();

    await page.locator('ld-canvas .chip-btn', { hasText: 'NO | |' }).click();
    const svg = page.locator('ld-canvas svg').first();
    const box = await svg.boundingBox();
    await page.mouse.click(box!.x + 120, box!.y + 120);

    let proj = await projectJson(page);
    const ldNet = proj.fbd.pous.flatMap((p: any) => p.networks).find((n: any) => n.kind === 'ld');
    expect(ldNet.blocks.length).toBe(1);

    // undo removes it, redo restores
    await page.locator('ld-canvas .chip-btn[title="Undo (ctrl-z)"]').click();
    proj = await projectJson(page);
    const ldNet2 = proj.fbd.pous.flatMap((p: any) => p.networks).find((n: any) => n.kind === 'ld');
    expect(ldNet2.blocks.length).toBe(0);
    await page.locator('ld-canvas .chip-btn[title="Redo (ctrl-y)"]').click();
    proj = await projectJson(page);
    const ldNet3 = proj.fbd.pous.flatMap((p: any) => p.networks).find((n: any) => n.kind === 'ld');
    expect(ldNet3.blocks.length).toBe(1);

    // delete: select the restored block programmatically (its <g> reports
    // a 0×0 client rect, so pixel-clicking is unreliable), then use the
    // toolbar delete button — the same path a user selection takes
    await page.evaluate(() => {
      const el = document.querySelector('ld-canvas') as any;
      const id = el.net?.blocks[0]?.id;
      if (id !== undefined) el.selIds = new Set([id]);
      el.requestUpdate();
    });
    await page.locator('ld-canvas .chip-btn', { hasText: 'delete' }).click();
    proj = await projectJson(page);
    const ldNet4 = proj.fbd.pous.flatMap((p: any) => p.networks).find((n: any) => n.kind === 'ld');
    expect(ldNet4.blocks.length).toBe(0);
  });

  test('ST rename (F2) rewrites the symbol project-wide', async ({ page }) => {
    await openFreshIde(page);
    await dismissPicker(page);
    await newPou(page, 'program');
    await pane(page, 'ST');

    const src = `PROGRAM Main\nVAR\n  x : INT;\n  y : INT;\nEND_VAR\nx := y + 1;\nEND_PROGRAM`;
    await setStSource(page, src);
    // st-editor debounces `change` — wait for the save to land
    await expect
      .poll(async () => {
        const p = await projectJson(page);
        return Object.keys(p.stSources ?? {}).length;
      })
      .toBeGreaterThan(0);

    // select the `y` usage word
    await page.evaluate(() => {
      const ed = document.querySelector('st-editor') as any;
      const idx = ed.view.state.doc.toString().lastIndexOf('y + 1');
      ed.view.dispatch({ selection: { anchor: idx } });
      ed.view.focus();
    });
    await acceptPrompt(page, 'z');
    await page.keyboard.press('F2');

    await expect
      .poll(async () => {
        const p = await projectJson(page);
        return p.stSources[Object.keys(p.stSources)[0] ?? ''] ?? '';
      })
      .toContain('z + 1');
  });

  test('deploy map: graphical channel grid round-trips to bridge text', async ({ page }) => {
    await openFreshIde(page);
    await dismissPicker(page);
    await pane(page, 'Deploy');

    await page.locator('button', { hasText: 'generate' }).click();
    await page.locator('button', { hasText: 'edit channels…' }).click();
    await expect(page.locator('.plc-mapgrid')).toBeVisible();

    await page.locator('.plc-mapgrid button', { hasText: '+ channel' }).click();
    await page.locator('.plc-mapgrid button', { hasText: '+ bind' }).click();
    const applyBtn = page.locator('.plc-mapgrid button', { hasText: 'apply to text' });
    if (await applyBtn.isEnabled()) await applyBtn.click();

    // textarea now holds serialized bridge text with the new channel
    const text = await page.locator('textarea.plc-mapedit').inputValue();
    expect(text).toContain('ch0');

    // save for deploy persists into the project
    await page.locator('button', { hasText: 'save for deploy' }).click();
    const proj = await projectJson(page);
    expect(proj.deployMap).toContain('ch0');
  });
});
