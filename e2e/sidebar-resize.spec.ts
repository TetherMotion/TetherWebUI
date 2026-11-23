import { expect, test } from '@playwright/test';
import { newPou, openFreshIde } from './plc-helpers';

/* Workbench layout: both sidebars must be interactively resizable and
   collapsible so the FBD editor keeps room to work. */

test.describe('workbench sidebars', () => {
  test('explorer and inspector resize, collapse, and reopen', async ({ page }, testInfo) => {
    await openFreshIde(page);
    const ide = page.locator('tether-plc-ide');
    await ide.locator('.plc-workbench').waitFor();
    await newPou(page, 'program');
    await expect(ide.locator('.plc-edbody')).toBeVisible();

    const side = page.locator('.plc-side');
    const insp = page.locator('.plc-insp');
    await expect(side).toBeVisible();
    await expect(insp).toBeVisible();

    const sideW0 = (await side.boundingBox())!.width;
    const editorW0 = (await page.locator('.plc-editor').boundingBox())!.width;

    // drag the explorer's right edge → sidebar grows, editor shrinks
    const handles = page.locator('.plc-rsz');
    await expect(handles).toHaveCount(2);
    const h = (await handles.first().boundingBox())!;
    await page.mouse.move(h.x + h.width / 2, h.y + 100);
    await page.mouse.down();
    await page.mouse.move(h.x + 140, h.y + 100, { steps: 8 });
    await page.mouse.up();
    const sideW1 = (await side.boundingBox())!.width;
    expect(sideW1).toBeGreaterThan(sideW0 + 80);

    // collapse the explorer → thin stub, editor wins the space
    await side.locator('.plc-side-hide').click();
    await expect(page.locator('.plc-side-col')).toHaveCount(1);
    const editorW1 = (await page.locator('.plc-editor').boundingBox())!.width;
    expect(editorW1).toBeGreaterThan(editorW0);

    // collapse the inspector too → second stub, even more editor room
    await insp.locator('.plc-side-hide').click();
    await expect(page.locator('.plc-side-col')).toHaveCount(2);
    const editorW2 = (await page.locator('.plc-editor').boundingBox())!.width;
    expect(editorW2).toBeGreaterThan(editorW1);
    await page.screenshot({ path: testInfo.outputPath('sidebars-collapsed.png') });

    // reopen both from the stubs
    await page.locator('.plc-side-col .plc-colbtn').first().click();
    await expect(page.locator('.plc-side')).toBeVisible();
    await page.locator('.plc-side-col .plc-colbtn').first().click();
    await expect(page.locator('.plc-insp')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('sidebars-resized.png') });

    // resized width persists across reload
    await page.reload();
    await page.locator('.rail-act', { hasText: 'Program' }).click();
    await page.locator('tether-plc-ide').locator('.plc-side').waitFor();
    const sideW2 = (await page.locator('.plc-side').boundingBox())!.width;
    expect(Math.abs(sideW2 - sideW1)).toBeLessThanOrEqual(2);
  });
});
