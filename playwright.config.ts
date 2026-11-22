import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests drive the real dashboard against the self-contained
 * simulated machine example (no EtherCAT hardware). The server binary
 * must be built first:
 *
 *   cmake --build build --target web_dashboard_example -j8   (in the Tether repo)
 *   npm run build                                            (in this repo)
 *
 * The PLC IDE specs additionally need the TetherPLC toolchain:
 *
 *   cmake --build build -j8 && cargo build -p tplc -p tplcc  (in TetherPLC)
 *
 * which provides `tplc serve` (the /ws backend: ctl frames + compile/
 * catalog meta-ops) and `tplcc` (compiler). This repo lives at
 * TetherPLC/TetherWebUI (submodule), so defaults resolve to the
 * sibling Tether checkout and the enclosing TetherPLC root; every path
 * can be overridden with env vars: WEB_DASHBOARD_EXAMPLE, TPLC, TPLCC,
 * TPLC_ROOT, TPLC_LIBDIRS (colon-separated)
 *
 * Playwright's bundled Chromium is used (install with
 * `npx playwright install chromium`); set PW_CHANNEL=chrome to use a
 * system Google Chrome instead.
 */
const repoRoot = fileURLToPath(new URL('.', import.meta.url));
const abs = (p: string) => (isAbsolute(p) ? p : resolve(repoRoot, p));
/* submodule layout: <dev>/TetherPLC/TetherWebUI — TetherPLC is ../..,
   the sibling Tether checkout is ../../Tether */
const tplcRoot = abs(process.env.TPLC_ROOT ?? '../..');
const webDashboard = abs(
  process.env.WEB_DASHBOARD_EXAMPLE ?? '../../Tether/build/bin/web_dashboard_example',
);
const tplc = abs(process.env.TPLC ?? `${tplcRoot}/compiler/target/debug/tplc`);
const tplcc = abs(process.env.TPLCC ?? `${tplcRoot}/compiler/target/debug/tplcc`);
const tetherPlc = abs(process.env.TPLC_HOST ?? `${tplcRoot}/build/tether-plc`);
const tplcImage = abs(process.env.TPLC_IMAGE ?? `${tplcRoot}/build/tplc-image`);
const tplcIo = abs(process.env.TPLC_IO ?? `${tplcRoot}/build/tplc-io`);
/* every path tplc/tplcc receives must be absolute */
const libdirs = (
  process.env.TPLC_LIBDIRS ??
  `${tplcRoot}/libraries/tempctrl:${tplcRoot}/libraries/homeassistant:` +
    `${tplcRoot}/libraries/mqtt:${tplcRoot}/libraries/iolink:` +
    `${tplcRoot}/libraries/profinet:${tplcRoot}/libraries/canopen:` +
    `${tplcRoot}/compat/tc2:${tplcRoot}/compat/tc3`
)
  .split(':')
  .filter(Boolean)
  .flatMap((d) => ['--libdir', abs(d)]);

const plcE2E = existsSync(webDashboard) && existsSync(tplc) && existsSync(tplcc);
/* live-runtime stack: real tether-plc + tplc serve on :8090 (plc-live.spec) */
const liveE2E = plcE2E && existsSync(tetherPlc) && existsSync(tplcImage) && existsSync(tplcIo);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: 'http://127.0.0.1:8099',
    headless: true,
    ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
  },
  webServer: [
    {
      command: `${webDashboard} --port 8099 --web-root ${repoRoot}dist`,
      url: 'http://127.0.0.1:8099/',
      timeout: 20_000,
      reuseExistingServer: !process.env.CI,
    },
    ...(plcE2E
      ? [
          {
            /* compile/catalog-only backend: no runtime attached, so the
               ctl socket is a dead path — meta-ops still work. */
            command: `${tplc} serve --port 8089 --ctl ${tplcRoot}/build/.e2e-no-runtime.ctl --tplcc ${tplcc} --tplccd "" --no-webui ${libdirs.join(' ')}`,
            url: 'http://127.0.0.1:8089/health',
            timeout: 20_000,
            reuseExistingServer: !process.env.CI,
          },
        ]
      : []),
    ...(liveE2E
      ? [
          {
            /* e2e/live-stack.sh: image + tether-plc + tplc-io + `tplc
               serve` on :8090 (/ws + /tether-io). /health is always 200
               once serving; the spec skips if the stack isn't up. */
            command: `TPLC_ROOT=${tplcRoot} TPLC=${tplc} TPLC_HOST=${tetherPlc} TPLC_IMAGE=${tplcImage} TPLC_IO=${tplcIo} TPLCC=${tplcc} TPLC_LIBDIRS=${process.env.TPLC_LIBDIRS ?? ''} bash ${repoRoot}e2e/live-stack.sh`,
            url: 'http://127.0.0.1:8090/health',
            timeout: 30_000,
            reuseExistingServer: !process.env.CI,
          },
        ]
      : []),
  ],
});
