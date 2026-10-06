import { expect, test, type Page } from '@playwright/test';

const WS_URL = 'ws://127.0.0.1:8099/tether-io';

/**
 * Connect with the development role selector (?role=) and wait until the
 * typed machine profile has decoded all four simulated drive snapshots.
 */
async function connectAs(
  page: Page,
  role: 'observer' | 'operator' | 'technician' | 'admin',
): Promise<void> {
  await page.goto('/');
  await page.locator('#url').fill(`${WS_URL}?role=${role}`);
  await page.locator('#connect').click();
  await expect(page.locator('#status')).toContainText('Connected');
  await expect(page.locator('#drive-state-widgets .drive-card')).toHaveCount(4);
}

async function openView(page: Page, view: string): Promise<void> {
  await page.locator(`button[data-view="${view}"]`).click();
}

/** Acquire the machine-scope motion lease. */
async function acquireLease(page: Page): Promise<void> {
  await openView(page, 'motion');
  await page.locator('[data-authority="acquire"]').click();
  await expect(page.locator('.authority-status')).toContainText('Held');
}

/**
 * Dispatch one gated command to a single axis through the motion page and wait
 * for the server receipt. The example server keeps its machine state across
 * sessions, so a test that needs an enabled drive must enable it explicitly
 * rather than assuming the fleet's power-on state.
 */
async function dispatchCommand(page: Page, action: string, axis = 'sim-axis-x'): Promise<void> {
  await openView(page, 'motion');
  await page.locator(`input[data-target="${axis}"]`).check();
  await page.locator('#command-action').selectOption({ label: action });
  await page.locator('#command-submit').click();
  await expect(page.locator('.command-receipt').last()).toContainText('Accepted');
}

/**
 * Bring an axis to OperationEnabled, skipping the command when it already is:
 * `Enable` is (correctly) not advertised for an enabled drive, so blindly
 * re-enabling would assert on a legitimate rejection.
 */
async function ensureEnabled(page: Page, name: string, axis = 'sim-axis-x'): Promise<void> {
  const pill = page.locator(`#drive-card-list .drive-card[data-drive-name="${name}"] .drive-pill`);
  const openDrives = async () => {
    await openView(page, 'drives');
    await expect(pill).not.toBeEmpty();
  };
  await openDrives();
  if (!(await pill.textContent())?.includes('Enabled')) {
    await dispatchCommand(page, 'Enable', axis);
    await openDrives();
    await expect(pill).toContainText('Enabled', { timeout: 10_000 });
  }
  // Leave the operator where the caller expects to continue working.
  await openView(page, 'motion');
}

test('drive cards render interpreted state, not raw tables', async ({ page }) => {
  await connectAs(page, 'operator');
  await openView(page, 'drives');

  const cards = page.locator('#drive-card-list .drive-card');
  await expect(cards).toHaveCount(4);
  // Every card interprets the snapshot: a status pill plus a situation line.
  await expect(cards.first().locator('.drive-pill')).not.toBeEmpty();
  await expect(cards.first().locator('.drive-interp')).not.toBeEmpty();
  // Only genuinely abnormal drives get a chip. The simulated fleet seeds Z
  // with the CiA 402 warning bit (SimulatedCiA402Fleet.hpp), so exactly one
  // chip is expected — and it names the condition rather than dumping values.
  const anomalies = cards.locator('.drive-anomaly');
  await expect(anomalies).toHaveCount(1);
  await expect(anomalies.first()).toContainText('statusword warning bit set');
  const zCard = page.locator('#drive-card-list .drive-card[data-drive-name="Z"]');
  await expect(zCard.locator('.drive-pill')).toContainText('Warning');
  // Nominal drives carry no chip at all.
  const xCard = page.locator('#drive-card-list .drive-card[data-drive-name="X"]');
  await expect(xCard.locator('.drive-anomaly')).toHaveCount(0);
  // AL state must not appear in the compact header for an OP bus.
  await expect(cards.first().locator('.drive-card-head')).not.toContainText('OP');
});

test('expanding a drive card reveals raw snapshot fields and statusword bits', async ({ page }) => {
  await connectAs(page, 'operator');
  await openView(page, 'drives');

  const card = page.locator('#drive-card-list .drive-card').first();
  await card.locator('.drive-card-head').click();
  await expect(card.locator('.drive-detail')).toBeVisible();
  await expect(card.locator('.drive-detail')).toContainText('Statusword');
  await expect(card.locator('.drive-detail')).toContainText('EtherCAT AL');
  await expect(card.locator('.bit-table')).toBeVisible();
});

test('Explore lists the full CiA 402 object dictionary per axis', async ({ page }) => {
  await connectAs(page, 'operator');
  await openView(page, 'explore');

  const filter = page.locator('.catalog-filter');
  await filter.fill('sdo.sim-axis-x.');
  // 11 OD objects are registered per simulated axis.
  await expect(page.locator('.catalog-row')).toHaveCount(11);
  await expect(page.locator('.catalog-row', { hasText: 'sdo.sim-axis-x.6040_00' })).toHaveCount(1);
  await expect(page.locator('.catalog-row', { hasText: 'sdo.sim-axis-x.6041_00' })).toHaveCount(1);

  await filter.fill('sdo.');
  await expect(page.locator('.catalog-row')).toHaveCount(44);
});

test('acquire lease and dispatch disable then enable on an axis', async ({ page }) => {
  await connectAs(page, 'operator');
  await acquireLease(page);
  // Machine state survives across sessions on the example server, so start
  // from a known state rather than assuming the power-on default.
  await ensureEnabled(page, 'X');

  await dispatchCommand(page, 'Disable');
  await openView(page, 'drives');
  const pill = page.locator('#drive-card-list .drive-card[data-drive-name="X"] .drive-pill');
  await expect(pill).not.toContainText('Enabled', { timeout: 10_000 });

  await dispatchCommand(page, 'Enable');
  await openView(page, 'drives');
  await expect(pill).toContainText('Enabled', { timeout: 10_000 });
});

test('hold-to-run jog dispatches JogStart and JogStop', async ({ page }) => {
  await connectAs(page, 'operator');
  await acquireLease(page);
  // JogStart is only permitted from OperationEnabled — the server enforces it.
  await ensureEnabled(page, 'X');

  const jog = page.locator('.jog-btn[data-jog-axis="sim-axis-x"][data-jog-dir="1"]');
  await expect(jog).toBeEnabled();
  // A real press/release: the panel binds pointerdown/pointerup, not click.
  await jog.hover();
  await page.mouse.down();
  await page.mouse.up();

  const ops = page.locator('#operations-table-body');
  await page.locator('#operations-refresh').click();
  await expect(ops).toContainText(/Jog|jog/i);
});

test('guided homing prepares, homes, and marks the axis referenced', async ({ page }) => {
  await connectAs(page, 'operator');
  await acquireLease(page);
  // HomeStart is permitted from SwitchedOn/OperationEnabled only.
  await ensureEnabled(page, 'X');

  const homing = page.locator('#homing-panel');
  await expect(homing.locator('.homing-row')).toHaveCount(3); // X, Y, Z support homing

  await homing.locator('[data-home-axis="sim-axis-x"][data-home-step="prepare"]').click();
  await expect(homing.locator('.homing-step').first()).toContainText('Step 2');

  await homing.locator('[data-home-axis="sim-axis-x"][data-home-step="start"]').click();
  await expect(homing.locator('.homing-state').first()).toContainText('Referenced', {
    timeout: 30_000,
  });
});

test('SDO inspector reads the statusword over the mailbox backend', async ({ page }) => {
  await connectAs(page, 'technician');
  await openView(page, 'commissioning');

  await page.locator('#sdo-index').fill('6041');
  await page.locator('#sdo-subindex').fill('00');
  await page.locator('#sdo-read').click();
  await expect(page.locator('#sdo-panel .config-ok')).toContainText('Transfer complete');
});

test('SDO list enumerates the simulated object table', async ({ page }) => {
  await connectAs(page, 'technician');
  await openView(page, 'commissioning');

  await page.locator('#sdo-list').click();
  const sdoTable = page.locator('#sdo-panel .drive-table tbody');
  await expect(sdoTable).toContainText('0x6041');
  await expect(sdoTable).toContainText('0x607a');
});
