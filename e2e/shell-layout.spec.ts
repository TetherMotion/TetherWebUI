import { expect, test, type Page } from '@playwright/test';

/**
 * Shell layout regression: the activity switch must give the work area
 * real height on EVERY activity. Regression — .app was a fixed
 * 3-row grid (strip / 36px tabs / 1fr) but the tab bar only renders on
 * Operate, so on Configure/Program/Debug .body auto-placed into the
 * 36px row and the IDE collapsed to a sliver: the dashboard looked
 * empty and only the status strip was usable.
 *
 * Also pins the first-run template picker dismissal path and the
 * status-strip deep links (plc-navigate must re-render the shell).
 */

async function dismissTplPicker(page: Page): Promise<void> {
  const never = page.locator('.plc-tpl-foot .chip-btn', { hasText: "Don't show again" });
  if (await never.count()) {
    await never.click();
    await expect(page.locator('.plc-tpl-overlay')).toHaveCount(0);
  }
}

/** The work area must occupy most of the viewport on every activity. */
async function expectBodyFillsViewport(page: Page): Promise<void> {
  const vp = page.viewportSize()!;
  const body = await page.locator('.body').boundingBox();
  expect(body, '.body must be laid out').toBeTruthy();
  expect(body!.height).toBeGreaterThan(vp.height * 0.6);
  const content = await page.locator('.content').boundingBox();
  expect(content!.height).toBeGreaterThan(vp.height * 0.6);
}

async function rail(page: Page, label: string): Promise<void> {
  await page.locator('.rail-act', { hasText: label }).click();
  await page.waitForTimeout(300);
}

test.describe('shell layout', () => {
  test('work area fills the viewport on every activity', async ({ page }, testInfo) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await dismissTplPicker(page);

    // default activity is Program — IDE workbench, no board tab bar
    await expectBodyFillsViewport(page);
    await expect(page.locator('tether-plc-ide')).toBeVisible();
    await expect(page.locator('.plc-workbench')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('program.png') });

    await rail(page, 'Configure');
    await expectBodyFillsViewport(page);
    await expect(page.locator('.plc-nav')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('configure.png') });

    await rail(page, 'Debug');
    await expectBodyFillsViewport(page);
    await expect(page.locator('tether-plc-ide')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('debug.png') });

    await rail(page, 'Operate');
    await expectBodyFillsViewport(page);
    await expect(page.locator('board-view')).toBeVisible();
    await expect(page.locator('.board-tab').first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('operate.png') });
  });

  test('status-strip deep links navigate out of Operate', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await dismissTplPicker(page);
    await rail(page, 'Operate');
    await expect(page.locator('tether-plc-ide')).toBeHidden();

    // the workflow steps in the strip must bring the IDE back —
    // regression: plc-navigate never triggered a shell re-render
    await page.locator('.plc-step', { hasText: 'Debug' }).click();
    await expect(page.locator('tether-plc-ide')).toBeVisible();
    await expectBodyFillsViewport(page);
  });
});
