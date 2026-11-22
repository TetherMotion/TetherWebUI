import { expect, test } from '@playwright/test';
import {
  act,
  connectDashboard,
  dismissTplPicker,
  freshPlcProject,
  pane,
} from './plc-helpers';

/**
 * Discovery card UX: the transport is chosen first (EtherCAT over UDP
 * vs raw NIC), then only the relevant fields render — raw mode shows a
 * NIC <select> fed by the backend's iface_list meta-op (sole physical
 * NIC auto-picked, Tether resolveInterface semantics) or a manual
 * fallback input; UDP mode shows peer/port.
 */

const buslink = (page: import('@playwright/test').Page) => page.locator('.plc-buslink');

test.describe('discovery card', () => {
  test('transport picker shows contextual fields with smart defaults', async ({
    page,
  }, testInfo) => {
    await freshPlcProject(page);
    await connectDashboard(page);
    await act(page, 'Configure');
    await dismissTplPicker(page);
    await pane(page, 'Discovery');

    const link = buslink(page);
    const udp = link.locator('.chip-btn', { hasText: 'EtherCAT/UDP' });
    const raw = link.locator('.chip-btn', { hasText: 'raw NIC' });
    await expect(udp).toBeVisible();
    await expect(raw).toBeVisible();

    // iface_list is async — wait for the fetch to settle (meta-ops
    // serialize through one backend worker, so it can queue behind
    // slower ops) before judging the transport default.
    await page.waitForFunction(
      () =>
        ((document.querySelector('tether-plc-ide') as { busLink?: string } | null)
          ?.busLink ?? '') !== '',
      undefined,
      { timeout: 15_000 },
    );
    // exactly one transport is active
    await expect(link.locator('.chip-btn.active')).toHaveCount(1);
    const defaultRaw = await raw.evaluate((b) => b.classList.contains('active'));

    // whichever transport won, its fields are the contextual ones
    if (defaultRaw) {
      // real NICs enumerated → select; none → manual input fallback
      const sel = link.locator('select.fbd-in');
      const manual = link.locator('input.fbd-in[placeholder="iface"]');
      expect((await sel.count()) + (await manual.count())).toBe(1);
      if (await sel.count()) await expect(sel.locator('option').first()).toBeAttached();
      expect(await link.locator('input[list="plc-bus-peers"]').count()).toBe(0);
    } else {
      await expect(link.locator('input[list="plc-bus-peers"]')).toBeVisible();
      await expect(link.locator('input[type="number"]')).toBeVisible();
      expect(await link.locator('select.fbd-in').count()).toBe(0);
    }
    await page.screenshot({ path: testInfo.outputPath(`discovery-${defaultRaw ? 'raw' : 'udp'}.png`) });

    // switch to UDP — peer/port fields replace the NIC widgets
    await udp.click();
    await expect(link.locator('input[list="plc-bus-peers"]')).toBeVisible();
    await expect(link.locator('input[type="number"]')).toBeVisible();
    expect(await link.locator('select.fbd-in').count()).toBe(0);
    await page.screenshot({ path: testInfo.outputPath('discovery-udp.png') });

    // switch to raw — peer/port gone; select or manual input appears
    await raw.click();
    expect(await link.locator('input[list="plc-bus-peers"]').count()).toBe(0);
    const sel = link.locator('select.fbd-in');
    const manual = link.locator('input.fbd-in[placeholder="iface"]');
    expect((await sel.count()) + (await manual.count())).toBe(1);
    await page.screenshot({ path: testInfo.outputPath('discovery-raw.png') });

    // 'other…' in the NIC select exposes the manual escape hatch
    if (await sel.count()) {
      await sel.selectOption('__custom');
      await expect(link.locator('input.fbd-in[placeholder="iface"]')).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('discovery-raw-custom.png') });
    }
  });
});
