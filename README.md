# TetherWebUI

Browser-based operator dashboard for machines exposing the **Tether IO
protocol** (schema V6). Connects to a Tether machine server — such as the
`web_dashboard_example` binary in the
[Tether](https://github.com/TetherMotion/Tether) repository — over a binary
WebSocket protocol and provides:

- Live signal/catalog browsing and structured value inspection
- Machine control surfaces (motion axes, CiA 402 drives, jog, commands)
- Commissioning: config baseline/stage/validate/commit, diff, recipes
- Diagnostics: alarms, event journal, supervisor state, datalog capture
- Declarative application panels (`machine.app.profile`, keyed-BLAKE3
  verified server-side)

This repository was split out of the Tether repository
(`web/tether-io-dashboard`). The server side — `MachineService`,
`TetherIOWebSocketController`, and the `web_dashboard_example` host — remains
in the Tether repository and serves this app's `dist/` output as static
assets.

## Tech stack

Vite + TypeScript (no framework), Vitest for unit tests, Playwright for e2e.
The only runtime dependency is `@noble/hashes` (BLAKE3 schema digests and
profile fingerprints).

## Getting started

```bash
npm ci
npm run dev        # Vite dev server (expects a Tether IO WebSocket endpoint)
```

## Build

```bash
npm run build      # tsc --noEmit && vite build → dist/
```

Serve `dist/` with any static file server, or point the Tether
`web_dashboard_example` at it:

```bash
# in the Tether repo
cmake --build build --target web_dashboard_example -j8
./build/bin/web_dashboard_example --web-root /path/to/TetherWebUI/dist --port 8080
```

See `docs/WebInterfaceDeployment.md` in the Tether repository for production
deployment, authentication (`--auth-file` bearer tokens), TLS termination,
and rollback guidance.

## Tests

```bash
npm test           # Vitest unit tests (jsdom)
npm run test:e2e   # Playwright e2e (needs the Tether repo checked out as a
                   # sibling directory with web_dashboard_example built, or
                   # set TETHER_E2E_URL=ws://host:port/tether-io)
npm run format:check
```

The `e2e/plc-ide.spec.ts` suite additionally drives the TetherPLC IDE
against a real `tplc-ctl-proxy` + `tplcc` (compile, /blocks catalog,
/libsrc, device wizard, curve editor). It needs the TetherPLC repo as a
sibling with `build/tplc-ctl-proxy` and `compiler/target/debug/tplcc`
built; override with `TPLC_PROXY`, `TPLCC`, `TPLC_LIBDIRS`,
`WEB_DASHBOARD_EXAMPLE`. Browsers install via
`npx playwright install chromium` (or `PW_CHANNEL=chrome` for system
Chrome).

`e2e/plc-live.spec.ts` goes further: `e2e/live-stack.sh` boots a real
`tether-plc` runtime (shm process image + pre-deployed package + ctl
socket) behind a second proxy on :8090, and the spec drives actual
scan-loop state — program stop/start, task suspend/step/resume, and a
browser `build & deploy` that ends with the new package RUNNING. It
needs `build/tether-plc` and `build/tplc-image` as well (override with
`TPLC_HOST`, `TPLC_IMAGE`, `TPLC_ROOT`, `LIVE_PORT`).

### Cross-language schema digest vectors

`test-fixtures/schema-digest-vectors.json` is a contract shared with the Tether
C++ test suite (`tests/io/test_io_schema.cpp`). Both sides independently
reconstruct the listed schema graphs and must produce the same BLAKE3 digests
of the canonical descriptor. **Do not edit digests by hand** — recompute with
the TypeScript builder and confirm the C++ test still passes.

## HMI scene widgets (web ⇄ native parity)

The `tile-hmi-*` widgets (gauge, bargraph, digital, lamp stack, alarm
board) render a shared **scene IR** — a JSON document of `rect`/`line`/
`path`/`text` ops in `src/hmi/scene.ts`. Two backends consume the
identical document, so views match by construction:

- **web** — `sceneToSvg()` → inline SVG (Lit tiles in `src/tiles/hmiw.ts`)
- **native Vulkan** — `examples/hmi_vulkan.cpp` in the Tether repo parses
  the same JSON and rasterizes with Vulkan + glyb (the VolcanoPlot glyph
  engine: FreeType rasterization, HarfBuzz shaping)

`src/hmi/parity.test.ts` rasterizes every widget through both backends
(resvg vs `hmi_vulkan` under lavapipe) and diffs the pixels.

**Auto boards** — `src/hmi/autoscreen.ts` ports the catalog→screen rules
from `Tether/examples/common/HmiAuto.cpp`: `plc.<prog>.<inst>.<member>`
entries are grouped into profile panels, loop clusters (PV/SP/OUT),
lamp stacks and digital readouts, plus an alarm board. The "Auto (PLC)"
card in the new-board picker generates a fully bound board from the
live catalog — no manual wiring.

**Remote native HMI** — `hmi_remote` (Tether repo) connects to any
Tether IO endpoint over TCP (`SlipFramedTransport` + `TetherIOClient`),
enumerates the catalog, runs the same auto-screen rules, polls values
and renders live frames through the Vulkan backend:

```bash
hmi_remote --host 127.0.0.1 --port 43770 --auto --frames 0 --period 500
# --screen FILE   authored screen JSON instead of --auto
# --out PREFIX    PPM frame prefix (default hmi_remote; offscreen render)
```

`hmi_remote` currently renders offscreen to PPM sequences (headless /
lavapipe-friendly); windowed output is future work.

`tplc-io` serves `plc.*` entries for any deployed TetherPLC package, so
the same screen definitions work for the browser UI and a Vulkan
display with zero configuration.

## Protocol

The wire protocol (binary framing, V6 schema negotiation, catalog, function
invocation, authority leases) is implemented in `src/protocol`,
`src/schema-v6`, and `src/client.ts`; the server counterpart lives in
`include/tether/io/` and `src/io/` of the Tether repository.

## License

Dual-licensed under **Apache-2.0 OR MPL-2.0** — see [LICENSE.md](LICENSE.md).
