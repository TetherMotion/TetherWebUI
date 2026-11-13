import { expect, test, type Page } from '@playwright/test';
import {
  newPou,
  openFreshIde,
  pane,
  setStSource,
} from './plc-helpers';

/**
 * Live-runtime E2E: e2e/live-stack.sh runs a real tether-plc (pre-deployed
 * LiveDemo package, free-running counter) behind tplc-ctl-proxy on :8090.
 * These tests drive the IDE's Deploy pane so every button is a real ctl
 * round-trip: PROG_STATUS, PROG_START/STOP, TASK_SUSPEND/RESUME/STEP,
 * DEPLOY_BEGIN/CHUNK/COMMIT.
 *
 * The stack is only spawned when tether-plc + tplc-image + tplcc exist;
 * the beforeAll health probe skips the file otherwise. Tests are
 * name-agnostic and leave the program running so repeated runs against a
 * reused stack stay green (a previous run may have deployed POU1).
 */
const LIVE_CTL = 'http://127.0.0.1:8090';

let liveUp = false;
test.beforeAll(async () => {
  liveUp = await fetch(`${LIVE_CTL}/health`)
    .then((r) => r.ok)
    .catch(() => false);
});
test.beforeEach(() => {
  test.skip(!liveUp, 'live tether-plc stack not running (e2e/live-stack.sh)');
});

/** progTable heading: `program <name>` + state/cycles dim span. */
function progHead(page: Page) {
  return page.locator('.tile-scroll > h4').filter({ hasText: 'program ' });
}
/** the task table directly following the program heading */
function progTable(page: Page) {
  return progHead(page).locator('xpath=following-sibling::table[1]');
}
async function cyclesOf(page: Page): Promise<bigint> {
  const text = await progHead(page).locator('.plc-dim').textContent();
  const m = /(\d+) cycles/.exec(text ?? '');
  if (!m) throw new Error(`no cycles in status text: ${text}`);
  return BigInt(m[1]);
}
const refresh = (page: Page) =>
  page.locator('.plc-ctlbar button', { hasText: 'refresh' }).click();
/** poll-refresh until the program cycle counter moves past `prev` */
async function cyclesAdvance(page: Page, prev: bigint): Promise<void> {
  await expect
    .poll(
      async () => {
        await refresh(page);
        return cyclesOf(page);
      },
      { timeout: 15_000, intervals: [300, 600, 1000] },
    )
    .toBeGreaterThan(prev);
}
const progOps = (page: Page, name: string) =>
  page.locator('.plc-ops button', { hasText: name, exact: true });

/** open the IDE on Deploy with a program reported running (starts it if a
    previous test/run left it stopped) */
async function openDeploy(page: Page): Promise<void> {
  await openFreshIde(page, LIVE_CTL);
  await pane(page, 'Deploy');
  await expect(page.locator('.plc-ctlbar')).toContainText('connected', {
    timeout: 15_000,
  });
  await expect(progHead(page)).toBeVisible({ timeout: 15_000 });
  if ((await progHead(page).textContent())?.includes('stopped')) {
    await progOps(page, 'start').click();
    await expect(progHead(page)).toContainText('running', { timeout: 10_000 });
  }
}

test.describe('TetherPLC IDE — live runtime', () => {
  test('deploy pane shows the real running program; stop/start toggle it', async ({
    page,
  }) => {
    await openDeploy(page);
    await expect(progHead(page)).toContainText('running');

    // cycles must advance — proof the scan loop is live, not a cached reply
    const c1 = await cyclesOf(page);
    await cyclesAdvance(page, c1);

    // real PROG_STOP: state flips and cycles freeze
    await progOps(page, 'stop').click();
    await expect(progHead(page)).toContainText('stopped', { timeout: 10_000 });
    const frozen = await cyclesOf(page);
    await page.waitForTimeout(600);
    await refresh(page);
    expect(await cyclesOf(page)).toBe(frozen);

    // PROG_START resumes the scan loop
    await progOps(page, 'start').click();
    await expect(progHead(page)).toContainText('running', { timeout: 10_000 });
    await cyclesAdvance(page, frozen);
  });

  test('task suspend / step / resume drive the real scheduler', async ({ page }) => {
    await openDeploy(page);

    const table = progTable(page);
    const suspendBtn = table.locator('button', { hasText: 'suspend' }).first();
    test.skip(!(await suspendBtn.count()), 'program exposes no tasks');

    await suspendBtn.click();
    await expect(table.locator('tbody tr').first().locator('td').nth(1)).toHaveText(
      'susp',
      { timeout: 10_000 },
    );

    // single-step while suspended bumps the run counter (col 3 = runs)
    const runsCell = table.locator('tbody tr').first().locator('td').nth(3);
    const before = await runsCell.textContent();
    await table.locator('button', { hasText: 'step', exact: true }).first().click();
    await page.waitForTimeout(300);
    await refresh(page);
    expect(await runsCell.textContent()).not.toBe(before);

    await table.locator('button', { hasText: 'resume' }).first().click();
    await expect(
      table.locator('tbody tr').first().locator('td').nth(1),
    ).not.toHaveText('susp', { timeout: 10_000 });
    await expect(progHead(page)).toContainText('running');
  });

  test('build & deploy ships the project package to the live runtime', async ({
    page,
  }) => {
    await openFreshIde(page, LIVE_CTL);

    // real program through the ST pane: POU1.st must declare PROGRAM POU1
    await newPou(page, 'program');
    await pane(page, 'ST');
    await setStSource(
      page,
      [
        'PROGRAM POU1',
        'VAR',
        '    cnt : DINT := 0;',
        'END_VAR',
        'cnt := cnt + 1;',
        'END_PROGRAM',
      ].join('\n'),
    );

    await pane(page, 'Deploy');
    await progOps(page, 'build & deploy').click();
    await expect(page.locator('.plc-status')).toContainText('deployed', {
      timeout: 60_000,
    });

    // the runtime now reports the deployed program, running — leave it
    // running so a reused stack stays green for the other specs
    await expect(progHead(page)).toContainText('POU1', { timeout: 15_000 });
    await expect(progHead(page)).toContainText('running', { timeout: 15_000 });
    if ((await progHead(page).textContent())?.includes('stopped')) {
      await progOps(page, 'start').click();
      await expect(progHead(page)).toContainText('running', { timeout: 10_000 });
    }
    const c1 = await cyclesOf(page);
    await cyclesAdvance(page, c1);
  });

  test('debug plane: resolve/read/force drive live program memory', async ({
    page,
  }) => {
    await openDeploy(page);

    /* debugCard = the .plc-ops containing the symbol input */
    const dbgOps = page.locator('.plc-ops', {
      has: page.locator('input[placeholder*="symbol name"]'),
    });
    await expect(dbgOps).toBeVisible({ timeout: 15_000 });

    // resolve 'cnt' — LiveDemo's DINT counter at blob offset 0
    await dbgOps.locator('input[placeholder*="symbol name"]').fill('cnt');
    await dbgOps.locator('button', { hasText: 'resolve' }).click();
    await expect(dbgOps).toContainText('size 4B', { timeout: 10_000 });

    /* first .plc-dbg-hex is the symbol read-out (a second one exists
       for trace lines further down the card) */
    const hexOut = page.locator('.plc-dbg-hex').first();
    const hexText = () => hexOut.textContent().then((t) => (t ?? '').trim());
    const clickRead = () =>
      dbgOps.locator('button', { hasText: 'read', exact: true }).click();

    // the counter ticks every scan — two reads must differ. Wait for the
    // rendered text to actually change: toHaveText alone returns
    // immediately on the previous value.
    await clickRead();
    await expect(hexOut).toHaveText(/^[0-9a-f]{2}( [0-9a-f]{2})*$/, {
      timeout: 10_000,
    });
    const r1 = await hexText();
    await page.waitForTimeout(300);
    await clickRead();
    await expect.poll(hexText, { timeout: 10_000 }).not.toBe(r1);
    expect(await hexText()).not.toBe(r1);

    // force cnt := 0 — the image byte is pinned against the program's
    // cnt := cnt + 1 write, so reads keep returning 00 00 00 00
    await dbgOps.locator('input[placeholder*="07000000"]').fill('00000000');
    await dbgOps.locator('button', { hasText: 'force' }).click();
    await expect(page.locator('.plc-force-tag').first()).toContainText('00000000', {
      timeout: 10_000,
    });
    await page.waitForTimeout(300);
    await clickRead();
    await page.waitForTimeout(200);
    expect(await hexText()).toBe('00 00 00 00');
    await page.waitForTimeout(300);
    await clickRead();
    await page.waitForTimeout(200);
    expect(await hexText()).toBe('00 00 00 00');

    // clear all → the program owns the byte again; the counter resumes
    await page.locator('.plc-forces button', { hasText: 'clear all' }).click();
    await page.waitForTimeout(300);
    await clickRead();
    await expect.poll(hexText, { timeout: 10_000 }).not.toBe('00 00 00 00');
  });
});
