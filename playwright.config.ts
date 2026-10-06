import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests drive the real dashboard against the self-contained
 * simulated machine example (no EtherCAT hardware). The server binary
 * must be built first:
 *
 *   cmake --build build --target web_dashboard_example -j8   (in the Tether repo)
 *   npm run build                                            (in this repo)
 *
 * Playwright's bundled Chromium is not installed on this machine; the
 * system Google Chrome is used instead via `channel: 'chrome'`.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: 'http://127.0.0.1:8099',
    channel: 'chrome',
    headless: true,
  },
  webServer: {
    command: '../Tether/build/bin/web_dashboard_example --port 8099',
    url: 'http://127.0.0.1:8099/',
    timeout: 20_000,
    reuseExistingServer: !process.env.CI,
  },
});
