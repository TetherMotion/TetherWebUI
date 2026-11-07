import { expect, test, type Page } from '@playwright/test';

const WS_URL = 'ws://127.0.0.1:8099/tether-io';

/**
 * Connect through the board shell's Connection overlay and wait until the
 * status strip reports connected and the default Machine board's drive
 * cards have decoded all four simulated drive snapshots.
 */
async function connectAs(
  page: Page,
  role: 'observer' | 'operator' | 'technician' | 'admin',
): Promise<void> {
  await page.goto('/');
  await page.locator('button[title="Connection settings"]').click();
  await page.locator('#conn-url').fill(`${WS_URL}?role=${role}`);
  await page.locator('#conn-connect').click();
  await expect(page.locator('.status-strip')).toContainText('connected');
  await expect(page.locator('tile-drive-cards .drive-card')).toHaveCount(4);
}

async function openBoard(page: Page, title: string): Promise<void> {
  await page.locator('.board-tab', { hasText: title }).click();
}

/** Acquire the machine-scope motion lease from the authority tile. */
async function acquireLease(page: Page): Promise<void> {
  await openBoard(page, 'Motion');
  await page.locator('tile-authority [data-authority="acquire"]').click();
  await expect(page.locator('tile-authority .authority-status')).toContainText('Held');
}

/** Dispatch one gated command to a single axis through the command tile. */
async function dispatchCommand(page: Page, action: string, axis = 'sim-axis-x'): Promise<void> {
  await openBoard(page, 'Motion');
  const tile = page.locator('tile-command');
  await tile.locator(`input[data-target="${axis}"]`).check();
  await tile.locator('#command-action').selectOption({ label: action });
  await tile.locator('#command-submit').click();
}

/**
 * The example server keeps machine state across sessions, so a test that
 * needs an enabled drive enables it explicitly via the command tile rather
 * than assuming the fleet's power-on state.
 */
async function ensureEnabled(page: Page, name: string, axis = 'sim-axis-x'): Promise<void> {
  const pill = page.locator(`tile-drive-cards .drive-card[data-drive-name="${name}"] .drive-pill`);
  await openBoard(page, 'Machine');
  await expect(pill).not.toBeEmpty();
  if (!(await pill.textContent())?.includes('Enabled')) {
    await dispatchCommand(page, 'Enable', axis);
    await openBoard(page, 'Machine');
    await expect(pill).toContainText('Enabled', { timeout: 10_000 });
  }
  // Leave the operator on the Motion board, where the action tiles live.
  await openBoard(page, 'Motion');
}

test('shell renders built-in boards and lazy-loads their tiles', async ({ page }) => {
  await connectAs(page, 'observer');

  // Four built-in boards plus the new-board button.
  await expect(page.locator('.board-tab')).toHaveCount(5);
  await expect(page.locator('board-view tile-frame').first()).toBeVisible();

  // Machine board tiles are mounted custom elements, not placeholders.
  await expect(page.locator('tile-machine-state')).toHaveCount(1);
  await expect(page.locator('tile-drive-cards .drive-card')).toHaveCount(4);
  await expect(page.locator('tile-alarm-list')).toHaveCount(1);
  await expect(page.locator('tile-event-timeline')).toHaveCount(1);

  // Switching boards swaps the tile set.
  await openBoard(page, 'Motion');
  await expect(page.locator('tile-authority')).toHaveCount(1);
  await expect(page.locator('tile-jog')).toHaveCount(1);
  await expect(page.locator('tile-command')).toHaveCount(1);
  await expect(page.locator('tile-homing')).toHaveCount(1);
  await expect(page.locator('tile-operations')).toHaveCount(1);
});

test('edit mode adds a tile from the gallery', async ({ page }) => {
  await connectAs(page, 'operator');
  const frames = page.locator('board-view tile-frame');
  const before = await frames.count();

  await page.locator('.chip-btn', { hasText: 'Edit' }).click();
  await page.locator('.gallery-fab').click();
  await page.locator('.gallery-item', { hasText: 'Value' }).first().click();

  await expect(frames).toHaveCount(before + 1);
  // The display module lazy-loads on first use.
  await expect(page.locator('board-view tile-value')).toHaveCount(1);
});

test('drive cards render interpreted state, not raw tables', async ({ page }) => {
  await connectAs(page, 'operator');

  const cards = page.locator('tile-drive-cards .drive-card');
  await expect(cards.first().locator('.drive-pill')).not.toBeEmpty();
  await expect(cards.first().locator('.drive-interp')).not.toBeEmpty();
  // Only genuinely abnormal drives get a chip — the simulated fleet seeds Z
  // with the CiA 402 warning bit, so exactly one chip is expected.
  const anomalies = cards.locator('.drive-anomaly');
  await expect(anomalies).toHaveCount(1);
  await expect(anomalies.first()).toContainText('statusword warning bit set');
  const zCard = page.locator('tile-drive-cards .drive-card[data-drive-name="Z"]');
  await expect(zCard.locator('.drive-pill')).toContainText('Warning');
});

test('expanding a drive card reveals raw snapshot fields and statusword bits', async ({ page }) => {
  await connectAs(page, 'operator');

  const card = page.locator('tile-drive-cards .drive-card').first();
  await card.locator('.drive-card-head').click();
  await expect(card.locator('.drive-detail')).toBeVisible();
  await expect(card.locator('.drive-detail')).toContainText('Statusword');
  await expect(card.locator('.drive-detail')).toContainText('EtherCAT AL');
  await expect(card.locator('.bit-table')).toBeVisible();
});

test('catalog explorer lists the full CiA 402 object dictionary per axis', async ({ page }) => {
  await connectAs(page, 'operator');
  await page.locator('button[title="Explore"]').click();

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
  await ensureEnabled(page, 'X');

  await dispatchCommand(page, 'Disable');
  await openBoard(page, 'Machine');
  const pill = page.locator('tile-drive-cards .drive-card[data-drive-name="X"] .drive-pill');
  await expect(pill).not.toContainText('Enabled', { timeout: 10_000 });

  await dispatchCommand(page, 'Enable');
  await openBoard(page, 'Machine');
  await expect(pill).toContainText('Enabled', { timeout: 10_000 });
});

test('hold-to-run jog dispatches JogStart and JogStop', async ({ page }) => {
  await connectAs(page, 'operator');
  await acquireLease(page);
  // JogStart is only permitted from OperationEnabled — the server enforces it.
  await ensureEnabled(page, 'X');

  const jog = page.locator('tile-jog .jog-btn[data-jog-axis="sim-axis-x"][data-jog-dir="1"]');
  await expect(jog).toBeEnabled();
  // A real press/release: the tile binds pointerdown/pointerup, not click.
  await jog.hover();
  await page.mouse.down();
  await page.mouse.up();

  const ops = page.locator('tile-operations #operations-table-body');
  await expect(ops).toContainText(/Jog|jog/i, { timeout: 15_000 });
});

test('guided homing prepares, homes, and marks the axis referenced', async ({ page }) => {
  await connectAs(page, 'operator');
  await acquireLease(page);
  // HomeStart is permitted from SwitchedOn/OperationEnabled only.
  await ensureEnabled(page, 'X');

  const homing = page.locator('tile-homing #homing-panel');
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
  await openBoard(page, 'Service');

  const sdo = page.locator('tile-sdo-inspector');
  await sdo.locator('#sdo-index').fill('6041');
  await sdo.locator('#sdo-subindex').fill('00');
  await sdo.locator('#sdo-read').click();
  await expect(sdo.locator('#sdo-panel .config-ok')).toContainText('Transfer complete');
});

test('SDO list enumerates the simulated object table', async ({ page }) => {
  await connectAs(page, 'technician');
  await openBoard(page, 'Service');

  const sdo = page.locator('tile-sdo-inspector');
  await sdo.locator('#sdo-list').click();
  const sdoTable = sdo.locator('#sdo-panel .drive-table tbody');
  await expect(sdoTable).toContainText('0x6041');
  await expect(sdoTable).toContainText('0x607a');
});
