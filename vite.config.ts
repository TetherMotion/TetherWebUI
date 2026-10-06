import { execSync } from 'node:child_process';

import { defineConfig } from 'vite';

import pkg from './package.json' with { type: 'json' };

let gitSha = 'unknown';
try {
  gitSha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
} catch {
  /* no git metadata available (source tarball builds) */
}
const buildTime = new Date().toISOString();

export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __GIT_SHA__: JSON.stringify(gitSha),
    __BUILD_TIME__: JSON.stringify(buildTime),
  },
  build: { outDir: 'dist', emptyOutDir: true },
  plugins: [
    {
      name: 'build-metadata',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'version.json',
          source: `${JSON.stringify({ version: pkg.version, gitSha, buildTime }, null, 2)}\n`,
        });
      },
    },
  ],
});
