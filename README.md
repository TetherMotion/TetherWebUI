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

### Cross-language schema digest vectors

`test-fixtures/schema-digest-vectors.json` is a contract shared with the Tether
C++ test suite (`tests/io/test_io_schema.cpp`). Both sides independently
reconstruct the listed schema graphs and must produce the same BLAKE3 digests
of the canonical descriptor. **Do not edit digests by hand** — recompute with
the TypeScript builder and confirm the C++ test still passes.

## Protocol

The wire protocol (binary framing, V6 schema negotiation, catalog, function
invocation, authority leases) is implemented in `src/protocol`,
`src/schema-v6`, and `src/client.ts`; the server counterpart lives in
`include/tether/io/` and `src/io/` of the Tether repository.

## License

Dual-licensed under **Apache-2.0 OR MPL-2.0** — see [LICENSE.md](LICENSE.md).
