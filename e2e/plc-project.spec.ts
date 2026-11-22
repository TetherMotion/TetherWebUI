import { test, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  act,
  freshPlcProject,
  connectDashboard,
  openPlcIde,
  pane,
  CTL_URL,
} from './plc-helpers';
import { readFileSync } from 'node:fs';

/* FBD-pane selection coverage: blank project guidance, template
   adoption, and project_open → manifest.ui hydration onto the canvas. */

const TEMPLATE_FBD = JSON.parse(
  readFileSync(new URL('../src/plc/templates/temperature-cell.fbd.json', import.meta.url), 'utf8'),
);

let projDir = '';
test.beforeAll(() => {
  projDir = mkdtempSync(join(tmpdir(), 'tplc-e2e-proj-'));
  mkdirSync(join(projDir, '.tplc'), { recursive: true });
  writeFileSync(
    join(projDir, '.tplc', 'project.json'),
    JSON.stringify({
      version: 1,
      name: 'e2e-fbd',
      ui: { fbd: TEMPLATE_FBD, stSources: {} },
    }),
  );
});
test.afterAll(() => {
  if (projDir) rmSync(projDir, { recursive: true, force: true });
});

test('blank project: FBD pane guides to +PRG; new POU renders canvas', async ({ page }) => {
  await freshPlcProject(page, CTL_URL);
  await connectDashboard(page);
  const ide = await openPlcIde(page); // dismisses picker w/ Blank

  await ide.locator('.plc-nav-btn', { hasText: 'FBD' }).click();
  await expect(ide.locator('.plc-main')).toContainText('+PRG');

  await ide.locator('.plc-nav-btn', { hasText: 'Explorer' }).click();
  await ide.locator('button', { hasText: '+PRG' }).click();
  await ide.locator('.plc-tree-pou', { hasText: 'PRG' }).click();
  await ide.locator('.plc-tree-net').first().click();
  await expect(ide.locator('fbd-canvas')).toHaveCount(1, { timeout: 10_000 });
});

test('template picker: chosen template lands on its first network', async ({ page }) => {
  await freshPlcProject(page, CTL_URL);
  await connectDashboard(page);
  const ide = page.locator('tether-plc-ide');
  await expect(ide.locator('.plc-toolbar')).toBeVisible({ timeout: 15_000 });
  await ide.locator('button.plc-tpl-card').first().click();
  await ide.locator('.plc-nav-btn', { hasText: 'FBD' }).click();
  await expect(ide.locator('fbd-canvas')).toHaveCount(1, { timeout: 10_000 });
});

test('project_open adopts manifest.ui; reload rehydrates it', async ({ page }) => {
  await freshPlcProject(page, CTL_URL);
  await connectDashboard(page);
  const ide = await openPlcIde(page);

  await act(page, 'Configure');
  await pane(page, 'Project');
  await ide.locator('input[placeholder="/path/to/project"]').fill(projDir);
  await ide.locator('button', { hasText: 'open' }).first().click();
  await expect(ide.locator('.plc-status')).toContainText('project opened', { timeout: 10_000 });

  await ide.locator('.plc-nav-btn', { hasText: 'FBD' }).click();
  await expect(ide.locator('fbd-canvas')).toHaveCount(1, { timeout: 10_000 });
  await expect(ide.locator('.plc-fbd-head')).toContainText('EK_PID');

  // wipe the local copy, then reload: only remote hydrate can restore
  // the document (proves manifest.ui → canvas, not localStorage)
  await page.evaluate(() => localStorage.removeItem('tether.plc.project.v1'));
  await page.reload();
  const ide2 = page.locator('tether-plc-ide');
  await expect(ide2.locator('.plc-toolbar')).toBeVisible({ timeout: 15_000 });
  await ide2.locator('.plc-nav-btn', { hasText: 'FBD' }).click();
  await expect(ide2.locator('fbd-canvas')).toHaveCount(1, { timeout: 15_000 });
  await expect(ide2.locator('.plc-fbd-head')).toContainText('EK_PID');
});
