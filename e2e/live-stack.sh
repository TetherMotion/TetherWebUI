#!/usr/bin/env bash
# Live TetherPLC stack for e2e/plc-live.spec.ts:
#   tplc-image + tether-plc (real scan loop, pre-deployed LiveDemo pkg)
#   → tplc-io (tether_io catalog/functions over TCP, dynamic plc.*
#     field entries from the running program)
#   → tplc-ctl-proxy :$LIVE_PORT with --socket → ctl.sock (POST /ctl,
#     GET /events) and --tplc-io → the provider, whose /tether-io
#     WebSocket endpoint gives browsers the live catalog + values.
#     /compile still goes through tplcc (popen).
#
# Env: TPLC_ROOT (default ../TetherPLC), LIVE_PORT (default 8090),
#      TPLC_LIBDIRS (colon-separated, same default as playwright.config).
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
TPLC=${TPLC_ROOT:-$ROOT/../TetherPLC}
PORT=${LIVE_PORT:-8090}
IMG=/tplc_pw_live_$$
W=$(mktemp -d /tmp/tplc-live-stack.XXXXXX)
RT_PID="" PROXY_PID="" IO_PID=""

cleanup() {
    [ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null || true
    [ -n "$IO_PID" ] && kill "$IO_PID" 2>/dev/null || true
    [ -n "$RT_PID" ] && kill "$RT_PID" 2>/dev/null || true
    [ -n "$RT_PID" ] && wait "$RT_PID" 2>/dev/null || true
    "$TPLC/build/tplc-image" unlink "$IMG" >/dev/null 2>&1 || true
    rm -rf "$W"
}
trap cleanup EXIT INT TERM

TPLCC=${TPLCC:-$TPLC/compiler/target/debug/tplcc}
PROXY=${TPLC_PROXY:-$TPLC/build/tplc-ctl-proxy}
IMAGE_CLI=${TPLC_IMAGE:-$TPLC/build/tplc-image}
PLC=${TPLC_HOST:-$TPLC/build/tether-plc}
IO=${TPLC_IO:-$TPLC/build/tplc-io}
for b in "$TPLCC" "$PROXY" "$IMAGE_CLI" "$PLC" "$IO"; do
    [ -x "$b" ] || { echo "live-stack: missing $b" >&2; exit 1; }
done

# pre-deployed program: free-running counter + TON so prog status and
# task suspend/step have observable state
cat > "$W/livedemo.st" <<'EOF'
PROGRAM LiveDemo
VAR
    cnt  : DINT := 0;
    tick : TON;
END_VAR
cnt := cnt + 1;
tick(IN := TRUE, PT := T#100ms);
END_PROGRAM
EOF
"$TPLCC" build "$W/livedemo.st" -o "$W/livedemo.tplc" >/dev/null
"$IMAGE_CLI" create "$IMG" 64 64 >/dev/null
"$PLC" --image "$IMG" --package "$W/livedemo.tplc" --ctl "$W/ctl.sock" \
    --packages "$W/packages" >"$W/rt.log" 2>&1 &
RT_PID=$!
for _ in $(seq 100); do
    [ -S "$W/ctl.sock" ] && break
    sleep 0.1
done
[ -S "$W/ctl.sock" ] || { echo "live-stack: ctl.sock never appeared" >&2; exit 1; }

LIBDIRS=""
IFS=':' read -ra dirs <<< "${TPLC_LIBDIRS:-$TPLC/libraries/tempctrl:$TPLC/compat/tc2:$TPLC/compat/tc3}"
for d in "${dirs[@]}"; do LIBDIRS="$LIBDIRS --libdir $d"; done

# tplc-io: tether_io provider on a free TCP port. --pkg covers the
# boot-time --package load; --packages covers ctl-deployed packages so
# dynamic plc.* field entries get TYPC types either way.
IO_PORT=$(python3 - <<'PY' 2>/dev/null || echo 43771
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)
"$IO" --ctl "$W/ctl.sock" --port "$IO_PORT" --bind 127.0.0.1 \
    --packages "$W/packages" --pkg "$W/livedemo.tplc" \
    >"$W/tplcio.log" 2>&1 &
IO_PID=$!
for _ in $(seq 100); do
    (exec 3<>"/dev/tcp/127.0.0.1/$IO_PORT") 2>/dev/null && { exec 3>&- 3<&-; break; }
    sleep 0.1
done

"$PROXY" --port "$PORT" --socket "$W/ctl.sock" --tplccd "" \
    --tplcc "$TPLCC" --tplc-io "127.0.0.1:$IO_PORT" $LIBDIRS \
    >"$W/proxy.log" 2>&1 &
PROXY_PID=$!
for _ in $(seq 100); do
    curl -sf -m 1 "http://127.0.0.1:$PORT/blocks" >/dev/null 2>&1 && break
    sleep 0.1
done
echo "live-stack: proxy :$PORT → $W/ctl.sock, /tether-io → tplc-io :$IO_PORT (workdir $W)" >&2
wait "$PROXY_PID"
