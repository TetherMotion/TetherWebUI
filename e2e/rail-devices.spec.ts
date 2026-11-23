import { expect, test } from '@playwright/test';
import { act, freshPlcProject } from './plc-helpers';

/**
 * Rail layout + Devices entry e2e.
 *
 * Regression targets:
 *  - every rail button carries a label (rail-act-label) so Alarms /
 *    Events / Connect are no longer icon-only, and all buttons share
 *    the rail-act 60px column — no size mismatches.
 *  - "Devices" is a rail entry that opens the Devices workbench doc
 *    (bus tree, entities, terminal catalog) in the Program activity.
 */

async function dismissTplPicker(page: import('@playwright/test').Page): Promise<void> {
  const never = page.locator('.plc-tpl-foot .chip-btn', { hasText: "Don't show again" });
  if (await never.count()) {
    await never.click();
    await expect(page.locator('.plc-tpl-overlay')).toHaveCount(0);
  }
}

test.describe('rail + devices', () => {
  test('rail buttons are labeled and uniformly sized; Devices opens its doc', async ({ page }, testInfo) => {
    await freshPlcProject(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await dismissTplPicker(page);

    // every rail button exposes a text label — none are icon-only
    const labels = await page.locator('.rail .rail-act-label').allTextContents();
    expect(labels.map((s) => s.trim())).toEqual([
      'Configure', 'Program', 'Debug', 'Operate', 'Devices',
      'Alarms', 'Events', 'Connect',
    ]);

    // uniform width: every button sits on the same rail-act column
    const widths = await page.locator('.rail .rail-btn').evaluateAll((els) =>
      els.map((e) => Math.round(e.getBoundingClientRect().width)),
    );
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]).toBe(60);

    await page.screenshot({ path: testInfo.outputPath('rail.png') });

    // Devices rail entry → program activity + devices doc tab.
    // With no POUs the doc explains the empty state; a served workspace
    // that already has POUs (reused tplc-serve backend) skips straight
    // to the usable view — accept either.
    await page.locator('.rail-act', { hasText: 'Devices' }).click();
    await expect(page.locator('.plc-dev-doc')).toBeVisible();
    if (!(await page.locator('.plc-dev-doc select option').count())) {
      await expect(page.locator('.plc-dev-doc')).toContainText('no POU yet');
      await page.locator('.plc-tree-head .chip-btn', { hasText: '+PRG' }).click();
      // +PRG opens the new POU — switch back to the devices tab
      await page.locator('.plc-tab', { hasText: 'devices' }).click();
    }
    await expect(page.locator('.plc-dev-doc')).toContainText('terminal catalog');
    await expect(page.locator('.plc-dev-doc')).toContainText('entities');
    await expect(page.locator('.plc-dev-doc select option').first()).toBeAttached();
    await page.screenshot({ path: testInfo.outputPath('devices-doc.png') });

    // devices must NOT appear in the project tree — rail entry only
    await expect(page.locator('.plc-tree-pou', { hasText: 'devices' })).toHaveCount(0);
  });
});
