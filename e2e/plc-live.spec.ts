import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import {
  block,
  connectDashboard,
  dragWire,
  freshPlcProject,
  newPou,
  openFreshIde,
  openPlcIde,
  paletteItem,
  pane,
  pin,
  projectJson,
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
    // proto-v2+ status surfaces the program-set epoch
    await expect(progHead(page).locator('.plc-dim')).toContainText('epoch');
    // v2 metadata line: deploy timestamp (LiveDemo was deployed at boot)
    await expect(page.locator('.plc-progmeta')).toContainText('deployed');

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

  test('debug watch channel: staged item streams live memory at 10 Hz', async ({
    page,
  }) => {
    await openDeploy(page);

    /* drop watch sets a previous (crashed) run may have left registered —
       handles persist on the runtime across browser sessions */
    const watchTags = page.locator('.plc-force-tag', { hasText: 'watch h' });
    for (let i = 0; i < 8 && (await watchTags.count()) > 0; i++) {
      await watchTags
        .first()
        .locator('button', { hasText: '×' })
        .click();
      await page.waitForTimeout(300);
    }

    const dbgOps = page.locator('.plc-ops', {
      has: page.locator('input[placeholder*="symbol name"]'),
    });
    await dbgOps.locator('input[placeholder*="symbol name"]').fill('cnt');
    await dbgOps.locator('button', { hasText: 'resolve' }).click();
    await expect(dbgOps).toContainText('size 4B', { timeout: 10_000 });

    // stage cnt as a watch item, then register the set on the runtime
    await dbgOps.locator('button', { hasText: '+ watch' }).click();
    const staged = page.locator('.plc-forces', { hasText: 'watch items' });
    await expect(staged).toContainText('cnt', { timeout: 5_000 });
    await staged.locator('button', { hasText: 'add watch' }).click();

    // refreshCtl re-lists DBG_WATCH_LIST → the watch tag renders
    const tag = page.locator('.plc-force-tag', { hasText: 'watch h' });
    await expect(tag).toHaveCount(1, { timeout: 10_000 });
    await expect(tag).toContainText('1×4B', { timeout: 5_000 });

    // one-shot read → the 4-byte DINT as 8 hex nibbles
    await tag.locator('button', { hasText: 'get' }).click();
    await expect(tag).toContainText(/=[0-9a-f]{8}/, { timeout: 10_000 });

    // stream at 10 Hz — cnt increments every scan, so the streamed =hex
    // rendered from DBG_WATCH events must keep changing
    await tag.locator('button', { hasText: 'stream' }).click();
    await expect(tag).toContainText('10Hz', { timeout: 10_000 });
    const streamed = () => tag.textContent();
    const s1 = await streamed();
    await expect
      .poll(streamed, { timeout: 15_000, intervals: [300, 600, 1000] })
      .not.toBe(s1);

    // stop streaming and remove the watch — leaves the runtime clean
    await tag.locator('button', { hasText: 'stop' }).click();
    await expect(tag.locator('button', { hasText: 'stream' })).toHaveCount(1, {
      timeout: 5_000,
    });
    await tag.locator('button', { hasText: '×' }).click();
    await expect(tag).toHaveCount(0, { timeout: 10_000 });
  });

  test('live catalog: plc.* program values stream into the watch pane', async ({
    page,
  }) => {
    /* the dashboard's data connection goes to the live proxy's
       /tether-io WebSocket → tplc-io → ctl.sock, so hub.params/signals
       are the runtime's real plc.* catalog, not the simulator's */
    await freshPlcProject(page, LIVE_CTL);
    await connectDashboard(page, 'operator', 'ws://127.0.0.1:8090/tether-io');
    await openPlcIde(page);
    await pane(page, 'watch');

    // the active program's DINT counter (LiveDemo.cnt, or POU1.cnt when
    // an earlier test's build & deploy swapped the program) increments
    // every scan — the row must appear and its value must keep changing
    const row = page.locator('tr', { hasText: /plc\.\w+\.cnt/ });
    await expect(row).toHaveCount(1, { timeout: 30_000 });
    const val = row.locator('td').nth(2);
    await expect(val).not.toHaveText('—', { timeout: 15_000 });
    const v1 = await val.textContent();
    await expect
      .poll(() => val.textContent(), { timeout: 15_000, intervals: [400, 800] })
      .not.toBe(v1);
  });

  test('deploy rebuilds the live catalog: new program vars appear in watch', async ({
    page,
  }) => {
    await freshPlcProject(page, LIVE_CTL);
    await connectDashboard(page, 'operator', 'ws://127.0.0.1:8090/tether-io');
    await openPlcIde(page);

    // ship POU1 (cnt counter) to the runtime — the epoch bump makes
    // tplc-io rebuild its registry, dropping the WS bridge's TCP leg;
    // the dashboard reconnects and re-lists the catalog
    await newPou(page, 'program');
    await pane(page, 'ST');
    await setStSource(
      page,
      'PROGRAM POU1\nVAR\n    cnt : DINT := 0;\nEND_VAR\ncnt := cnt + 1;\nEND_PROGRAM',
    );
    await pane(page, 'Deploy');
    await page.locator('.plc-ops button', { hasText: 'build & deploy' }).click();
    await expect(page.locator('.plc-status')).toContainText('deployed', {
      timeout: 60_000,
    });

    await pane(page, 'watch');
    const row = page.locator('tr', { hasText: 'plc.POU1.cnt' });
    await expect(row).toHaveCount(1, { timeout: 45_000 });
    await expect(row.locator('td').nth(2)).not.toHaveText('—', {
      timeout: 20_000,
    });
  });

  test('catalog write: watch-pane set drives live program memory', async ({
    page,
  }) => {
    /* setpoint is never assigned by the program, so a catalog write
       must persist and read back — exercises setParameter → tplc-io
       ParamEntry.writeFn → TPLC_OP_DBG_WRITE end to end. */
    await freshPlcProject(page, LIVE_CTL);
    await connectDashboard(page, 'operator', 'ws://127.0.0.1:8090/tether-io');
    await openPlcIde(page);

    await newPou(page, 'program');
    await pane(page, 'ST');
    await setStSource(
      page,
      'PROGRAM POU1\nVAR\n    cnt : DINT := 0;\n    setpoint : DINT := 21;\nEND_VAR\ncnt := cnt + 1;\nEND_PROGRAM',
    );
    await pane(page, 'Deploy');
    await page.locator('.plc-ops button', { hasText: 'build & deploy' }).click();
    await expect(page.locator('.plc-status')).toContainText('deployed', {
      timeout: 60_000,
    });

    await pane(page, 'watch');
    const row = page.locator('tr', { hasText: 'plc.POU1.setpoint' });
    await expect(row).toHaveCount(1, { timeout: 45_000 });
    const val = row.locator('td').nth(2);
    await expect(val).toHaveText('21', { timeout: 20_000 });

    await row.locator('.plc-force-in').fill('77');
    await row.locator('button', { hasText: 'set' }).click();
    await expect(val).toHaveText('77', { timeout: 15_000 });
    // still 77 on the next polls — the program never rewrites it
    await page.waitForTimeout(1200);
    await expect(val).toHaveText('77');
  });

  test('live FBD pins: deployed TON member values stream onto the canvas', async ({
    page,
  }) => {
    /* tplc-io expands FB instance members into plc.<prog>.<inst>.<mem>
       catalog entries; the canvas resolves pinKeys against them, so a
       deployed TON's ET/Q pins must show live, changing values. */
    await freshPlcProject(page, LIVE_CTL);
    await connectDashboard(page, 'operator', 'ws://127.0.0.1:8090/tether-io');
    await openPlcIde(page);
    await newPou(page, 'program');
    await pane(page, 'FBD');
    await page.waitForSelector('fbd-canvas svg');

    await paletteItem(page, 'TON').first().click();
    const ton = block(page, 'TON');
    await expect(ton).toHaveCount(1);

    // select the block → pin params: IN=TRUE, PT=T#60s so ET accumulates
    await ton.locator('.fbd-rect').click();
    const pinRow = (name: string) =>
      page
        .locator('.fbd-pinparams tr')
        .filter({ has: page.locator('.fbd-pname', { hasText: new RegExp(`^${name}$`) }) });
    await pinRow('IN').locator('input[type=checkbox]').check();
    const pt = pinRow('PT').locator('input');
    await pt.fill('T#60s');
    await pt.blur(); // param commits on `change`, not `input`

    // second TON: t1.ET → t2.PT — ET counts up every scan, so the probed
    // wire's live value must keep changing after deploy
    await paletteItem(page, 'TON').first().click();
    const tons = block(page, 'TON');
    await expect(tons).toHaveCount(2);
    const t1 = tons.nth(0);
    const t2 = tons.nth(1);
    await dragWire(page, pin(t1, 'out', 1), pin(t2, 'in', 1)); // ET → PT
    await expect(page.locator('fbd-canvas .fbd-wire')).toHaveCount(1);

    // t2.IN literal TRUE — its PT is driven by the wire
    await t2.locator('.fbd-rect').click();
    await expect(t2).toHaveClass(/sel/); // pinparams now shows t2
    await pinRow('IN').locator('input[type=checkbox]').check();

    // select the wire, press P → live probe flag (lowerer emits __probe_<id>)
    await page
      .locator('fbd-canvas .fbd-wire')
      .dispatchEvent('pointerdown', { bubbles: true });
    await page.locator('fbd-canvas').dispatchEvent('keydown', { key: 'p' });
    await expect(page.locator('fbd-canvas .fbd-wire.probe')).toHaveCount(1);
    await expect
      .poll(
        async () =>
          (await projectJson(page)).fbd.pous[0].networks[0].wires[0].probe,
      )
      .toBe(true);

    // ship it to the real runtime
    await pane(page, 'Deploy');
    await page.locator('.plc-ops button', { hasText: 'build & deploy' }).click();
    await expect(page.locator('.plc-status')).toContainText('deployed', {
      timeout: 60_000,
    });

    // canvas live overlays: TON's out pins resolve plc.<prog>.i1.Q/ET
    await pane(page, 'FBD');
    const lives = ton.locator('.fbd-pin-live');
    await expect(lives.first()).toBeVisible({ timeout: 45_000 });
    // ET accumulates every scan — at least one live text must change
    const texts = () => lives.allTextContents();
    const before = await texts();
    await expect
      .poll(texts, { timeout: 20_000, intervals: [500, 900, 1500] })
      .not.toEqual(before);

    // probed wire: the __probe_<id> field streams the wire's value (t1.ET,
    // which counts every scan) beside the wire itself
    const wireLive = page.locator('fbd-canvas .fbd-wire.probe .fbd-live');
    await expect(wireLive).toBeVisible({ timeout: 45_000 });
    const wireTexts = () => wireLive.allTextContents();
    const wBefore = await wireTexts();
    await expect
      .poll(wireTexts, { timeout: 20_000, intervals: [500, 900, 1500] })
      .not.toEqual(wBefore);
  });

  test('shadow run: upload candidate, watch it scan, promote atomically', async ({
    page,
  }) => {
    /* live-stack.sh builds ShadowDemo.tplc --change-against LiveDemo,
       so the migration predecessor must be the boot program — earlier
       tests may have left POU1 active. Re-deploy LiveDemo first. */
    await openDeploy(page);
    await page.locator('#plc-pkg').setInputFiles({
      name: 'livedemo.tplc',
      mimeType: 'application/octet-stream',
      buffer: readFileSync('/tmp/tplc-live-demo.tplc'),
    });
    await expect(progHead(page)).toContainText('LiveDemo', {
      timeout: 60_000,
    });
    await expect(progHead(page)).toContainText('running', { timeout: 15_000 });

    await page.locator('#plc-shpkg').setInputFiles({
      name: 'shadowcand.tplc',
      mimeType: 'application/octet-stream',
      buffer: readFileSync('/tmp/tplc-live-shadow-cand.tplc'),
    });

    // candidate shows loaded + running with advancing cycles
    const sh = page.locator('h4', { hasText: 'shadow run' });
    await expect(sh).toContainText('ShadowDemo', { timeout: 60_000 });
    await expect(sh).toContainText('running');

    // promote asks for confirmation, then the active program swaps
    page.once('dialog', (d) => void d.accept());
    await page.locator('.plc-ops button', { hasText: 'promote' }).click();
    await expect(progHead(page)).toContainText('ShadowDemo', {
      timeout: 30_000,
    });
    // the new epoch is visible in the program card header
    await expect(progHead(page).locator('.plc-dim')).toContainText('epoch');
  });

  test('temperature loop: AtcProfile+AtcPid run live; catalog shows the ramp', async ({
    page,
  }) => {
    /* headline path end-to-end: atc_tempctrl.st attaches as project
       source, an ST program runs FB_AtcProfile (RAMPT+DWELL) into
       FB_AtcPid against a simulated PT1 plant, and every value —
       program vars AND FB member pins — streams through plc.* catalog
       entries into the watch pane against the real scan loop. */
    const FIXTURES = fileURLToPath(new URL('../test-fixtures', import.meta.url));
    await freshPlcProject(page, LIVE_CTL);
    await connectDashboard(page, 'operator', 'ws://127.0.0.1:8090/tether-io');
    await openPlcIde(page);
    await newPou(page, 'program');

    // Curves pane offers the one-time library attach until the project
    // contains FB_AtcProfile — the file lands in stSources and compiles
    // together with the program
    await pane(page, 'Curves');
    await page.waitForSelector('temp-curve', { timeout: 15_000 });
    await page.locator('.plc-main input[type="file"]').setInputFiles(
      `${FIXTURES}/atc_tempctrl.st`,
    );

    await pane(page, 'ST');
    await setStSource(
      page,
      [
        'PROGRAM POU1',
        'VAR',
        '    pid : FB_AtcPid;',
        '    prof : FB_AtcProfile;',
        '    pv : LREAL := 20.0;',
        '    u : LREAL;',
        '    sp : LREAL;',
        '    flags : DINT := 0;',
        'END_VAR',
        '    prof.SEG[1].KIND := 3;', // RAMPT: reach 80 in 500 s
        '    prof.SEG[1].TGT := 80.0;',
        '    prof.SEG[1].P1 := 500.0;',
        '    prof.SEG[2].KIND := 1;', // DWELL 400 s at 80
        '    prof.SEG[2].TGT := 80.0;',
        '    prof.SEG[2].P1 := 400.0;',
        '    prof.SEG[3].KIND := 0;', // END
        '    prof(NUM_SEG := 3, RUN := TRUE, HOLD := FALSE, RESET := FALSE,',
        '         PvStart := TRUE, PV := pv, CycleTime := 0.5);',
        '    pid(Execute := TRUE, Setpoint := prof.SP, Actual := pv,',
        '        Kp := 2.0, Tn := 20.0, Tv := 0.0,',
        '        OutMin := 0.0, OutMax := 100.0,',
        '        ManEn := FALSE, ManOut := 0.0, CycleTime := 0.5,',
        '        Reset := FALSE);',
        '    u := pid.Out;',
        '    sp := prof.SP;',
        '    pv := pv + (1.5 * u - pv) * (0.5 / (20.0 + 0.5));',
        '    flags := 0;',
        '    IF pv > 75.0 AND pv < 85.0 THEN flags := flags + 1; END_IF;',
        '    IF prof.Done THEN flags := flags + 2; END_IF;',
        '    IF NOT prof.Err AND NOT pid.Err THEN flags := flags + 4; END_IF;',
        'END_PROGRAM',
      ].join('\n'),
    );

    await pane(page, 'Deploy');
    await page.locator('.plc-ops button', { hasText: 'build & deploy' }).click();
    await expect(page.locator('.plc-status')).toContainText('deployed', {
      timeout: 60_000,
    });

    await pane(page, 'watch');
    const consoleLog: string[] = [];
    page.on('console', (m) => consoleLog.push(`${m.type()}: ${m.text()}`));
    page.on('pageerror', (e) => consoleLog.push(`pageerror: ${e.message}`));
    const dumpHub = () =>
      page.evaluate(() => {
        const sh = document.querySelector('tether-shell') as any;
        const hub = sh?.hub;
        if (!hub) return { err: 'no hub' };
        const cat = hub.client.verifiedCatalog;
        const entries = [...hub.params, ...hub.signals].filter((e: any) =>
          e.name.startsWith('plc.POU1'),
        );
        return {
          state: hub.client.state,
          catEpoch: cat ? String(cat.epoch) : null,
          entryEpochs: [...new Set(entries.map((e: any) => String(e.schemaEpoch)))],
          sample: entries.slice(0, 3).map((e: any) => ({
            name: e.name,
            kind: e.kind,
            id: String(e.id),
            epoch: String(e.schemaEpoch),
            schema: e.metadata?.['schema.name'],
          })),
          boundCount: (hub as any).boundKeys?.size,
          valSp: hub.values.get('plc.POU1.sp'),
          valFlags: hub.values.get('plc.POU1.flags'),
        };
      });
    /* exact name-cell match — 'plc.POU1.pid.Out' must not also hit
       '…pid.OutMin'/'…pid.OutMax' rows */
    const val = (name: string) => {
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return page
        .locator('td', { hasText: new RegExp(`^${esc}$`) })
        .locator('xpath=following-sibling::td[2]');
    };
    const num = async (name: string) => Number(await val(name).textContent());
    try {
      for (const n of [
        'plc.POU1.sp',
        'plc.POU1.pv',
        'plc.POU1.u',
        'plc.POU1.flags',
        'plc.POU1.prof.Done',
        'plc.POU1.prof.SegIdx',
        'plc.POU1.pid.Out',
      ]) {
        await expect(val(n)).not.toHaveText('—', { timeout: 45_000 });
      }
    } catch (e) {
      console.log('HUBDUMP', JSON.stringify(await dumpHub(), null, 1));
      console.log('CONSOLE', consoleLog.slice(-40).join('\n'));
      throw e;
    }

    /* 10 ms scans × CycleTime 0.5 → ~50 process-s per wall-s: the 900 s
       profile spans ~18 s wall — long enough to watch the ramp. */
    const sp1 = await num('plc.POU1.sp');
    await expect
      .poll(() => num('plc.POU1.sp'), { timeout: 20_000, intervals: [800, 1500] })
      .not.toBe(sp1);

    // the plant heats toward the rising setpoint
    const pv1 = await num('plc.POU1.pv');
    await expect
      .poll(() => num('plc.POU1.pv'), { timeout: 20_000, intervals: [800, 1500] })
      .toBeGreaterThan(pv1);

    // profile runs RAMPT→DWELL→END; Done latches and the self-check
    // bits (pv in band, no faults) accumulate in flags
    await expect
      .poll(() => num('plc.POU1.prof.Done'), { timeout: 45_000, intervals: [2000] })
      .toBe(1);
    await expect
      .poll(() => num('plc.POU1.flags'), { timeout: 20_000, intervals: [2000] })
      .toBeGreaterThan(0);
  });
});
