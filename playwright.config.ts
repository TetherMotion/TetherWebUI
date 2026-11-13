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
 *   cmake --build build -j8 && cargo build                   (in TetherPLC)
 *
 * which provides `tplc-ctl-proxy` (HTTP compile/catalog service) and
 * `tplcc` (compiler). Paths resolve relative to this repo's parent
 * (`../Tether`, `../TetherPLC`) and can be overridden with env vars:
 *   WEB_DASHBOARD_EXAMPLE, TPLC_PROXY, TPLCC, TPLC_LIBDIRS (colon-separated)
 *
 * Playwright's bundled Chromium is used (install with
 * `npx playwright install chromium`); set PW_CHANNEL=chrome to use a
 * system Google Chrome instead.
 */
const repoRoot = fileURLToPath(new URL('.', import.meta.url));
const abs = (p: string) => (isAbsolute(p) ? p : resolve(repoRoot, p));
const webDashboard = abs(
  process.env.WEB_DASHBOARD_EXAMPLE ?? '../Tether/build/bin/web_dashboard_example',
);
const proxy = abs(process.env.TPLC_PROXY ?? '../TetherPLC/build/tplc-ctl-proxy');
const tplcc = abs(process.env.TPLCC ?? '../TetherPLC/compiler/target/debug/tplcc');
/* the proxy cd's into a temp dir before invoking tplcc — every path it
   receives must be absolute */
const libdirs = (
  process.env.TPLC_LIBDIRS ??
  '../TetherPLC/libraries/tempctrl:../TetherPLC/compat/tc2:../TetherPLC/compat/tc3'
)
  .split(':')
  .filter(Boolean)
  .flatMap((d) => ['--libdir', abs(d)]);

const plcE2E = existsSync(webDashboard) && existsSync(proxy) && existsSync(tplcc);

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
            command: `${proxy} --port 8089 --tplcc ${tplcc} ${libdirs.join(' ')}`,
            /* /health is 503 until a tplccd backend attaches; /blocks is
               200 as soon as the proxy is serving (catalog is lazy). */
            url: 'http://127.0.0.1:8089/blocks',
            timeout: 20_000,
            reuseExistingServer: !process.env.CI,
          },
        ]
      : []),
  ],
});
