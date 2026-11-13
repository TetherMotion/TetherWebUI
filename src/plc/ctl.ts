/**
 * PlcCtl — browser client for the tether-plc control channel via
 * tplc-ctl-proxy (POST /ctl = one ctl frame round-trip, octet-stream).
 * Frame format: [u16 type][u16 flags][u32 len][u64 req][payload LE].
 * Error replies carry flags bit15 + TplcCtlError{code,subcode,msg}.
 */

export const CTL = {
  HELLO: 0x0101,
  HELLO_ACK: 0x0102,
  PING: 0x0103,
  DEPLOY_BEGIN: 0x0201,
  DEPLOY_CHUNK: 0x0202,
  DEPLOY_COMMIT: 0x0203,
  DEPLOY_ABORT: 0x0204,
  PKG_LIST: 0x0205,
  PKG_INFO: 0x0206,
  PROG_PREPARE: 0x0301,
  PROG_START: 0x0302,
  PROG_STOP: 0x0303,
  PROG_KILL: 0x0304,
  PROG_RESET: 0x0305,
  PROG_UNLOAD: 0x0306,
  PROG_STATUS: 0x0307,
  PROG_LIST: 0x0308,
  PROG_LAYOUT: 0x0309,
  PROG_SWAP: 0x030a,
  PROG_ROLLBACK: 0x030b,
  TASK_STATS: 0x0401,
  TASK_SUSPEND: 0x0402,
  TASK_RESUME: 0x0403,
  TASK_STEP: 0x0404,
  DBG_RESOLVE: 0x0501,
  DBG_READ: 0x0502,
  DBG_WRITE: 0x0503,
  DBG_STATE: 0x0504,
  DBG_FORCE: 0x0505,
  DBG_FORCE_LIST: 0x0506,
  DBG_FORCE_CLEAR: 0x0507,
  DBG_BREAK: 0x0508,
  DBG_BREAK_LIST: 0x0509,
  DBG_BREAK_CLEAR: 0x050a,
  TRACE_CONF: 0x050b,
  TRACE_STATUS: 0x050c,
  TRACE_READ: 0x050d,
  TRACE_CLEAR: 0x050e,
  DBG_CAPTURE: 0x050f,
  DBG_WATCH_ADD: 0x0510,
  DBG_WATCH_GET: 0x0511,
  DBG_WATCH_REMOVE: 0x0512,
  DBG_WATCH_STREAM: 0x0513,
  DBG_WATCH_LIST: 0x0514,
  DBG_BREAK_EXPR: 0x0515,
  DBG_CAPTURE_EXPR: 0x0516,
  DBG_STATE_DIFF: 0x0517,
  IMAGE_STATS: 0x0701,
  SHADOW_LOAD: 0x0801,
  SHADOW_STATUS: 0x0802,
  SHADOW_COMPARE: 0x0803,
  SHADOW_PROMOTE: 0x0804,
  SHADOW_DROP: 0x0805,
  SHADOW_RESET: 0x0806,
  RT_STATUS: 0x0901,
  RETAIN_STATUS: 0x0601,
  RETAIN_FLUSH: 0x0602,
  RETAIN_CLEAR: 0x0603,
  RETAIN_DUMP: 0x0604,
} as const;

const F_ERROR = 1 << 15;

/** unsolicited event types (msg_type range 0x0E00, pushed via /events SSE) */
export const EV = {
  PROG_TRANSITION: 0x0e01,
  FAULT: 0x0e02,
  DBG_BREAK: 0x0e03,
  DBG_WATCH: 0x0e04,
} as const;

export interface CtlEvent {
  type: number;
  payload: Uint8Array;
}

export class CtlError extends Error {
  constructor(
    public code: number,
    public subcode: number,
    msg: string,
  ) {
    super(`ctl ${code}: ${msg}`);
  }
}

export interface CtlReply {
  type: number;
  flags: number;
  req: bigint;
  payload: Uint8Array;
}

/** resolved symbol (DBG_RESOLVE reply) — placement + epoch tag */
export interface DbgSym {
  uuid: string;
  symIdx: number;
  kind: number;
  flags: number;
  region: number;
  access: number;
  typeRef: number;
  offset: bigint;
  size: number;
}

/** program blob geometry (DBG_STATE reply) */
export interface DbgState {
  uuid: string;
  blobSize: bigint;
  retainOff: bigint;
  retainLen: bigint;
  symCount: number;
}

/** one active force override (DBG_FORCE_LIST entry) */
export interface DbgForce {
  handle: number;
  offset: bigint;
  bytes: Uint8Array;
  mask: Uint8Array;
}

/** one armed conditional trigger (DBG_BREAK_LIST entry) */
export interface DbgBreak {
  handle: number;
  taskIdx: number;
  offset: bigint;
  len: number;
  cmp: number;
  /** 0 suspend task, 1 freeze recorder */
  kind: number;
  /** re-resolution failed after a program swap */
  stale: boolean;
  value: bigint;
  hits: bigint;
}

/** cmp codes shared with the runtime's DBG_BREAK payload */
export const DBG_CMP = ['==', '!=', '<', '<=', '>', '>='] as const;

/** one flight-recorder channel (TRACE_CONF) */
export interface DbgTraceCh {
  offset: bigint;
  len: number;
}

/** one registered watch set (DBG_WATCH_LIST entry) */
export interface DbgWatchEntry {
  handle: number;
  items: number;
  rateHz: number;
  totalLen: number;
  /** items that failed post-swap re-resolution */
  stale: number;
}

/** ring counters (TRACE_STATUS); frozen = post-trigger hold */
export interface DbgTraceStatus {
  channels: number;
  frameLen: number;
  written: bigint;
  avail: bigint;
  frozen: boolean;
}

/** one recorded frame (TRACE_READ) */
export interface DbgTraceFrame {
  seq: bigint;
  ts: bigint;
  data: Uint8Array;
}

/** one migrate rule in a state.diff report.
    kind: 0 copy 1 transform 2 init 3 drop 4 deny 5 alias */
export interface DbgDiffRule {
  kind: number;
  sev: number;
  tid: number;
  aux: number;
  oldOff: bigint;
  oldLen: number;
  newOff: bigint;
  newLen: number;
  oldVal: Uint8Array;
  newVal: Uint8Array;
  oldName: string;
  newName: string;
}

/** post-migration report (DBG_STATE_DIFF) */
export interface DbgStateDiff {
  sameLayout: boolean;
  migStatus: number;
  rules: DbgDiffRule[];
}

export interface ProgStatus {
  uuid: string;
  name: string;
  state: number;
  cycles: bigint;
  lastFaultCode: number;
  forceCount: number;
  /** program-set generation (proto v2+; bumps on deploy/promote) */
  epoch?: bigint;
  /** proto-v2 program metadata (absent on v1 runtimes) */
  version?: string;
  faultTask?: number;
  faultCycle?: bigint;
  retainRestored?: number;
  retainDirtyBytes?: bigint;
  /** CLOCK_REALTIME ns when the active package was deployed */
  deployedAtNs?: bigint;
  swapStage?: number;
  quarantineLeft?: number;
  /** proto-v3 shadow tail (absent on older runtimes) */
  shadowState?: number;
  shadowCycles?: bigint;
  shadowMissed?: bigint;
  shadowDiffCount?: bigint;
  tasks: {
    name: string;
    state: number;
    periodNs: bigint;
    runs: bigint;
    late: bigint;
    faults: bigint;
  }[];
}

/** SHADOW_STATUS reply — loaded flag + TplcCtlShadowStatus fields */
export interface ShadowStatus {
  loaded: boolean;
  uuid?: string;
  name?: string;
  state?: number;
  cycles?: bigint;
  missed?: bigint;
  diffCount?: bigint;
  lastDiffCycle?: bigint;
  runs?: bigint;
}

/** SHADOW_COMPARE ring entry — one bounded differing byte-run */
export interface ShadowDiff {
  cycle: bigint;
  imgOff: bigint;
  len: number;
  active: Uint8Array;
  shadow: Uint8Array;
}

export interface RtStatus {
  uptimeS: number;
  progCount: number;
  runningCount: number;
  masterStatus: number;
  plcStatus: number;
  /** CLOCK_MONOTONIC ns heartbeats — staleness needs a local poll
      delta, the browser has no shared monotonic clock           */
  masterHbNs?: bigint;
  plcHbNs?: bigint;
  version?: string;
}

export interface RetainStatus {
  attached: boolean;
  dirty: boolean;
  /** bytes in the program's retain region */
  len: bigint;
  generation: bigint;
  flushes: bigint;
  restores: bigint;
  losses: bigint;
}

let reqId = 1n;

function u32(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, true);
  return b;
}

function u64(v: bigint | number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(v), true);
  return b;
}

function frame(type: number, payload: Uint8Array): ArrayBuffer {
  const b = new Uint8Array(16 + payload.length);
  const d = new DataView(b.buffer);
  d.setUint16(0, type, true);
  d.setUint32(4, payload.length, true);
  d.setBigUint64(8, reqId++, true);
  b.set(payload, 16);
  return b.buffer;
}

const cstr = (b: Uint8Array): string => {
  const n = b.indexOf(0);
  return new TextDecoder().decode(n < 0 ? b : b.subarray(0, n));
};

export class PlcCtl {
  constructor(public url = localStorage.getItem('tether.plc.ctlUrl') ?? 'http://127.0.0.1:8089') {}

  async call(type: number, payload: Uint8Array = new Uint8Array()): Promise<CtlReply> {
    const r = await fetch(`${this.url}/ctl`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: frame(type, payload),
    });
    if (!r.ok) throw new Error(`proxy ${r.status}: ${await r.text()}`);
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length < 16) throw new Error('short ctl frame');
    const d = new DataView(buf.buffer);
    const rep: CtlReply = {
      type: d.getUint16(0, true),
      flags: d.getUint16(2, true),
      req: d.getBigUint64(8, true),
      payload: buf.subarray(16),
    };
    if (rep.flags & F_ERROR) {
      const p = rep.payload;
      const ml = p.length >= 10 ? new DataView(p.buffer, p.byteOffset + 8).getUint16(0, true) : 0;
      throw new CtlError(
        p.length >= 8 ? new DataView(p.buffer, p.byteOffset).getInt32(0, true) : -1,
        p.length >= 8 ? new DataView(p.buffer, p.byteOffset).getUint32(4, true) : 0,
        cstr(p.subarray(10, 10 + ml)),
      );
    }
    return rep;
  }

  /** subscribe to runtime events; caller owns closing the EventSource. */
  events(onEvent: (e: CtlEvent) => void): EventSource {
    const es = new EventSource(`${this.url}/events`);
    es.onmessage = (m: MessageEvent<string>) => {
      try {
        const j = JSON.parse(m.data) as { type: number; payload: string };
        if (!(j.type & 0x0e00)) return;
        const bin = atob(j.payload ?? '');
        const payload = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) payload[i] = bin.charCodeAt(i);
        onEvent({ type: j.type, payload });
      } catch {
        /* malformed line */
      }
    };
    return es;
  }

  /**
   * Proxy reachability — any HTTP response counts, including the proxy's
   * 503 "backend down" from /health (that status means tplccd is absent,
   * not that the proxy is unreachable; /compile and /blocks still work).
   */
  async health(): Promise<boolean> {
    try {
      await fetch(`${this.url}/health`);
      return true;
    } catch {
      return false;
    }
  }

  async ping(): Promise<void> {
    await this.call(CTL.PING);
  }

  progStatus(): Promise<ProgStatus> {
    return this.call(CTL.PROG_STATUS).then((r) => {
      const d = new DataView(r.payload.buffer, r.payload.byteOffset);
      const taskCount = d.getUint32(84, true);
      /* the task array trails the versioned base struct: v1 = 104 B
         base/112 B stride, v2 = 296/136, v3 = 336/136 (shadow tail).
         Detect by exact reply length. */
      const lay =
        [
          { base: 336, stride: 136 },
          { base: 296, stride: 136 },
          { base: 104, stride: 112 },
        ].find((c) => r.payload.length === c.base + taskCount * c.stride) ??
        { base: 104, stride: 112 };
      const tasks: ProgStatus['tasks'] = [];
      for (let i = 0; i < taskCount; i++) {
        const o = lay.base + i * lay.stride;
        tasks.push({
          name: cstr(r.payload.subarray(o, o + 64)),
          state: r.payload[o + 65]!,
          periodNs: d.getBigUint64(o + 72, true),
          runs: d.getBigUint64(o + 80, true),
          late: d.getBigUint64(o + 88, true),
          faults: d.getBigUint64(o + 96, true),
        });
      }
      const v3 = lay.base === 336;
      return {
        uuid: [...r.payload.subarray(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join(''),
        name: cstr(r.payload.subarray(16, 80)),
        state: r.payload[80]!,
        cycles: d.getBigUint64(88, true),
        lastFaultCode: d.getInt32(96, true),
        forceCount: d.getUint32(100, true),
        epoch: lay.base >= 296 ? d.getBigUint64(288, true) : undefined,
        version: lay.base >= 296 ? cstr(r.payload.subarray(168, 200)) : undefined,
        faultTask: lay.base >= 296 ? d.getUint32(200, true) : undefined,
        faultCycle: lay.base >= 296 ? d.getBigUint64(208, true) : undefined,
        retainRestored: lay.base >= 296 ? r.payload[216]! : undefined,
        retainDirtyBytes: lay.base >= 296 ? d.getBigUint64(224, true) : undefined,
        deployedAtNs: lay.base >= 296 ? d.getBigUint64(240, true) : undefined,
        swapStage: lay.base >= 296 ? r.payload[272]! : undefined,
        quarantineLeft: lay.base >= 296 ? d.getUint32(280, true) : undefined,
        shadowState: v3 ? r.payload[296]! : undefined,
        shadowCycles: v3 ? d.getBigUint64(304, true) : undefined,
        shadowMissed: v3 ? d.getBigUint64(312, true) : undefined,
        shadowDiffCount: v3 ? d.getBigUint64(320, true) : undefined,
        tasks,
      };
    });
  }

  rtStatus(): Promise<RtStatus> {
    return this.call(CTL.RT_STATUS).then((r) => {
      const d = new DataView(r.payload.buffer, r.payload.byteOffset);
      return {
        uptimeS: d.getUint32(4, true),
        progCount: d.getUint32(8, true),
        runningCount: d.getUint32(12, true),
        masterStatus: d.getUint32(16, true),
        plcStatus: d.getUint32(20, true),
        masterHbNs: r.payload.length >= 40 ? d.getBigUint64(24, true) : undefined,
        plcHbNs: r.payload.length >= 40 ? d.getBigUint64(32, true) : undefined,
        version: r.payload.length >= 104 ? cstr(r.payload.subarray(40, 104)) : undefined,
      };
    });
  }

  progStart(): Promise<CtlReply> {
    return this.call(CTL.PROG_START);
  }

  progStop(): Promise<CtlReply> {
    return this.call(CTL.PROG_STOP);
  }

  /**
   * Load a stored package (by 16-byte uuid hex from DEPLOY_COMMIT, or a
   * `packages_dir` path) as the program — lands STOPPED; PROG_START runs
   * it. Rejected while a program is RUNNING (stop first).
   */
  progPrepare(uuidHex: string): Promise<CtlReply> {
    const b = new Uint8Array(16);
    for (let i = 0; i < 16; i++)
      b[i] = parseInt(uuidHex.slice(i * 2, i * 2 + 2), 16);
    return this.call(CTL.PROG_PREPARE, b);
  }

  taskSuspend(idx: number): Promise<CtlReply> {
    return this.call(CTL.TASK_SUSPEND, u32(idx));
  }

  taskResume(idx: number): Promise<CtlReply> {
    return this.call(CTL.TASK_RESUME, u32(idx));
  }

  taskStep(idx: number, n = 1): Promise<CtlReply> {
    const p = new Uint8Array(8);
    const d = new DataView(p.buffer);
    d.setUint32(0, idx, true);
    d.setUint32(4, n, true);
    return this.call(CTL.TASK_STEP, p);
  }

  /** qualified name → placement. Errors -410 (not found) / -416 (no map). */
  dbgResolve(name: string): Promise<DbgSym> {
    const nb = new TextEncoder().encode(name);
    const p = new Uint8Array(2 + nb.length);
    new DataView(p.buffer).setUint16(0, nb.length, true);
    p.set(nb, 2);
    return this.call(CTL.DBG_RESOLVE, p).then((r) => {
      const d = new DataView(r.payload.buffer, r.payload.byteOffset);
      return {
        uuid: [...r.payload.subarray(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join(''),
        symIdx: d.getUint32(16, true),
        kind: r.payload[20]!,
        flags: r.payload[21]!,
        region: r.payload[22]!,
        access: r.payload[23]!,
        typeRef: d.getUint32(24, true),
        offset: d.getBigUint64(28, true),
        size: d.getUint32(36, true),
      };
    });
  }

  /** cycle-consistent read of the program blob.
      sel 0 = active (default), 1 = shadow blob (read-only). */
  dbgRead(offset: bigint | number, len: number, sel = 0): Promise<Uint8Array> {
    const p = new Uint8Array(sel ? 13 : 12);
    const d = new DataView(p.buffer);
    d.setBigUint64(0, BigInt(offset), true);
    d.setUint32(8, len, true);
    if (sel) p[12] = sel;
    return this.call(CTL.DBG_READ, p).then((r) => r.payload);
  }

  /** one-shot write at the next task boundary (no force semantics). */
  dbgWrite(offset: bigint | number, bytes: Uint8Array): Promise<CtlReply> {
    const p = new Uint8Array(12 + bytes.length);
    const d = new DataView(p.buffer);
    d.setBigUint64(0, BigInt(offset), true);
    d.setUint32(8, bytes.length, true);
    p.set(bytes, 12);
    return this.call(CTL.DBG_WRITE, p);
  }

  /** persistent override at every boundary until cleared → handle.
      mask (same length) limits the override to the marked bits;
      omitted = full overwrite. */
  dbgForce(offset: bigint | number, bytes: Uint8Array,
           mask?: Uint8Array): Promise<number> {
    const p = new Uint8Array(12 + bytes.length + (mask?.length ?? 0));
    const d = new DataView(p.buffer);
    d.setBigUint64(0, BigInt(offset), true);
    d.setUint32(8, bytes.length, true);
    p.set(bytes, 12);
    if (mask) p.set(mask, 12 + bytes.length);
    return this.call(CTL.DBG_FORCE, p).then((r) =>
      new DataView(r.payload.buffer, r.payload.byteOffset).getUint32(0, true));
  }

  dbgForceList(): Promise<DbgForce[]> {
    return this.call(CTL.DBG_FORCE_LIST).then((r) => {
      const d = new DataView(r.payload.buffer, r.payload.byteOffset);
      const n = d.getUint32(0, true);
      const out: DbgForce[] = [];
      let o = 4;
      for (let i = 0; i < n; i++) {
        const handle = d.getUint32(o, true);
        const offset = d.getBigUint64(o + 4, true);
        const len = d.getUint32(o + 12, true);
        out.push({
          handle,
          offset,
          bytes: r.payload.slice(o + 16, o + 16 + len),
          mask: r.payload.slice(o + 16 + len, o + 16 + 2 * len),
        });
        o += 16 + 2 * len;
      }
      return out;
    });
  }

  /** clear one handle, or all when omitted (0xFFFFFFFF). */
  dbgForceClear(handle = 0xffffffff): Promise<CtlReply> {
    return this.call(CTL.DBG_FORCE_CLEAR, u32(handle));
  }

  /** arm a conditional suspend: len∈{1,2,4,8}, cmp 0..5 → handle. */
  dbgBreak(taskIdx: number, offset: bigint | number, len: number,
           cmp: number, value: bigint | number): Promise<number> {
    const p = new Uint8Array(28);
    const d = new DataView(p.buffer);
    d.setUint32(0, taskIdx, true);
    d.setBigUint64(4, BigInt(offset), true);
    d.setUint32(12, len, true);
    d.setUint8(16, cmp);
    d.setBigUint64(20, BigInt(value), true);
    return this.call(CTL.DBG_BREAK, p).then((r) =>
      new DataView(r.payload.buffer, r.payload.byteOffset).getUint32(0, true));
  }

  /** capture trigger: same payload; freezes the recorder on hit. */
  dbgCapture(taskIdx: number, offset: bigint | number, len: number,
             cmp: number, value: bigint | number): Promise<number> {
    const p = new Uint8Array(28);
    const d = new DataView(p.buffer);
    d.setUint32(0, taskIdx, true);
    d.setBigUint64(4, BigInt(offset), true);
    d.setUint32(12, len, true);
    d.setUint8(16, cmp);
    d.setBigUint64(20, BigInt(value), true);
    return this.call(CTL.DBG_CAPTURE, p).then((r) =>
      new DataView(r.payload.buffer, r.payload.byteOffset).getUint32(0, true));
  }

  /** expression trigger: paths resolve via SMAP at arm time;
      capture=true freezes the recorder on true, else suspends. */
  dbgBreakExpr(taskIdx: number, expr: string,
               capture = false): Promise<number> {
    const enc = new TextEncoder().encode(expr);
    const p = new Uint8Array(6 + enc.length);
    const d = new DataView(p.buffer);
    d.setUint32(0, taskIdx, true);
    d.setUint16(4, enc.length, true);
    p.set(enc, 6);
    return this.call(
      capture ? CTL.DBG_CAPTURE_EXPR : CTL.DBG_BREAK_EXPR, p)
      .then((r) =>
        new DataView(r.payload.buffer, r.payload.byteOffset)
          .getUint32(0, true));
  }

  dbgBreakList(): Promise<DbgBreak[]> {
    return this.call(CTL.DBG_BREAK_LIST).then((r) => {
      const d = new DataView(r.payload.buffer, r.payload.byteOffset);
      const n = d.getUint32(0, true);
      const out: DbgBreak[] = [];
      let o = 4;
      for (let i = 0; i < n; i++) {
        out.push({
          handle: d.getUint32(o, true),
          taskIdx: d.getUint32(o + 4, true),
          offset: d.getBigUint64(o + 8, true),
          len: d.getUint32(o + 16, true),
          cmp: r.payload[o + 20]!,
          kind: r.payload[o + 21]!,
          stale: r.payload[o + 22] !== 0,
          value: d.getBigUint64(o + 24, true),
          hits: d.getBigUint64(o + 32, true),
        });
        o += 40;
      }
      return out;
    });
  }

  dbgBreakClear(handle = 0xffffffff): Promise<CtlReply> {
    return this.call(CTL.DBG_BREAK_CLEAR, u32(handle));
  }

  /** what the last committed swap's migrate rules did */
  dbgStateDiff(): Promise<DbgStateDiff> {
    return this.call(CTL.DBG_STATE_DIFF).then((r) => {
      const d = new DataView(r.payload.buffer, r.payload.byteOffset);
      const p = r.payload;
      const rules: DbgDiffRule[] = [];
      let o = 8;
      const n = d.getUint32(4, true);
      const td = new TextDecoder();
      for (let i = 0; i < n; i++) {
        const rule: DbgDiffRule = {
          kind: p[o]!, sev: p[o + 1]!,
          tid: d.getUint16(o + 2, true),
          aux: d.getUint32(o + 4, true),
          oldOff: d.getBigUint64(o + 8, true),
          oldLen: d.getUint32(o + 16, true),
          newOff: d.getBigUint64(o + 24, true),
          newLen: d.getUint32(o + 32, true),
          oldVal: p.slice(o + 44, o + 44 + p[o + 40]!),
          newVal: p.slice(o + 52, o + 52 + p[o + 41]!),
          oldName: '', newName: '',
        };
        o += 60;
        const ol = d.getUint16(o, true); o += 2;
        rule.oldName = td.decode(p.subarray(o, o + ol)); o += ol;
        const nl = d.getUint16(o, true); o += 2;
        rule.newName = td.decode(p.subarray(o, o + nl)); o += nl;
        rules.push(rule);
      }
      return {
        sameLayout: p[0] !== 0, migStatus: p[1]!, rules,
      };
    });
  }

  /** arm the flight recorder: ≤8 channels, per-ch len ≤8, Σlen ≤64.
      nofreeze keeps recording through faults (default freezes on fault). */
  dbgTraceConf(chs: { offset: bigint | number; len: number }[],
               nofreeze = false): Promise<number> {
    const p = new Uint8Array(8 + chs.length * 16);
    const d = new DataView(p.buffer);
    d.setUint32(0, chs.length, true);
    d.setUint32(4, nofreeze ? 1 : 0, true);
    chs.forEach((c, i) => {
      d.setBigUint64(8 + i * 16, BigInt(c.offset), true);
      d.setUint32(8 + i * 16 + 8, c.len, true);
    });
    return this.call(CTL.TRACE_CONF, p).then((r) =>
      new DataView(r.payload.buffer, r.payload.byteOffset)
        .getUint32(0, true));
  }

  dbgTraceStatus(): Promise<DbgTraceStatus> {
    return this.call(CTL.TRACE_STATUS).then((r) => {
      const d = new DataView(r.payload.buffer, r.payload.byteOffset);
      return {
        channels: d.getUint32(0, true),
        frameLen: d.getUint32(4, true),
        written: d.getBigUint64(8, true),
        avail: d.getBigUint64(16, true),
        frozen: r.payload.length >= 28 &&
          (d.getUint32(24, true) & 1) !== 0,
      };
    });
  }

  /** frames with seq ≥ fromSeq still in the ring; ≤512 per call. */
  dbgTraceRead(fromSeq: bigint | number, max = 256):
      Promise<{ first: bigint; frameLen: number; frames: DbgTraceFrame[] }> {
    const p = new Uint8Array(12);
    const d = new DataView(p.buffer);
    d.setBigUint64(0, BigInt(fromSeq), true);
    d.setUint32(8, max, true);
    return this.call(CTL.TRACE_READ, p).then((r) => {
      const dv = new DataView(r.payload.buffer, r.payload.byteOffset);
      const n = dv.getUint32(8, true);
      const frameLen = dv.getUint32(12, true);
      const frames: DbgTraceFrame[] = [];
      let o = 16;
      for (let i = 0; i < n; i++) {
        frames.push({
          seq: dv.getBigUint64(o, true),
          ts: dv.getBigUint64(o + 8, true),
          data: r.payload.slice(o + 16, o + 16 + frameLen),
        });
        o += 16 + frameLen;
      }
      return { first: dv.getBigUint64(0, true), frameLen, frames };
    });
  }

  dbgTraceClear(): Promise<CtlReply> {
    return this.call(CTL.TRACE_CLEAR);
  }

  /** register a watch set (≤16 items, Σlen ≤ 512). Items with a
      name resolve through the symmap and re-resolve after a swap;
      nameless offset items go stale on swap. */
  dbgWatchAdd(items: { offset: bigint | number; len: number;
                      name?: string }[]): Promise<number> {
    const enc = new TextEncoder();
    const names = items.map((c) => enc.encode(c.name ?? ''));
    const size = 8 + items.reduce(
      (s, c, i) => s + 14 + names[i]!.length, 0);
    const p = new Uint8Array(size);
    const d = new DataView(p.buffer);
    d.setUint32(0, items.length, true);
    let o = 8;
    items.forEach((c, i) => {
      const nm = names[i]!;
      d.setBigUint64(o, BigInt(c.offset), true);
      d.setUint32(o + 8, c.len, true);
      d.setUint16(o + 12, nm.length, true);
      p.set(nm, o + 14);
      o += 14 + nm.length;
    });
    return this.call(CTL.DBG_WATCH_ADD, p).then((r) =>
      new DataView(r.payload.buffer, r.payload.byteOffset)
        .getUint32(0, true));
  }

  /** one-shot boundary-consistent read of a watch set. */
  dbgWatchGet(handle: number): Promise<Uint8Array[]> {
    return this.call(CTL.DBG_WATCH_GET, u32(handle)).then((r) => {
      const d = new DataView(r.payload.buffer, r.payload.byteOffset);
      const n = d.getUint32(0, true);
      const out: Uint8Array[] = [];
      let o = 4;
      for (let i = 0; i < n; i++) {
        const l = d.getUint32(o, true);
        out.push(r.payload.slice(o + 4, o + 4 + l));
        o += 4 + l;
      }
      return out;
    });
  }

  /** arm/disarm a ≤50 Hz EV_DBG_WATCH push for a watch set. */
  dbgWatchStream(handle: number, rateHz: number): Promise<CtlReply> {
    const p = new Uint8Array(8);
    const d = new DataView(p.buffer);
    d.setUint32(0, handle, true);
    d.setUint32(4, rateHz, true);
    return this.call(CTL.DBG_WATCH_STREAM, p);
  }

  /** drop one watch, or all when omitted (0xFFFFFFFF). */
  dbgWatchRemove(handle = 0xffffffff): Promise<CtlReply> {
    return this.call(CTL.DBG_WATCH_REMOVE, u32(handle));
  }

  dbgWatchList(): Promise<DbgWatchEntry[]> {
    return this.call(CTL.DBG_WATCH_LIST).then((r) => {
      const d = new DataView(r.payload.buffer, r.payload.byteOffset);
      const n = d.getUint32(0, true);
      const out: DbgWatchEntry[] = [];
      let o = 4;
      const rowSize = n > 0 ? (r.payload.length - 4) / n : 16;
      for (let i = 0; i < n; i++) {
        out.push({
          handle: d.getUint32(o, true),
          items: d.getUint32(o + 4, true),
          rateHz: d.getUint32(o + 8, true),
          totalLen: d.getUint32(o + 12, true),
          stale: rowSize >= 20 ? d.getUint32(o + 16, true) : 0,
        });
        o += rowSize;
      }
      return out;
    });
  }

  dbgState(): Promise<DbgState> {
    return this.call(CTL.DBG_STATE).then((r) => {
      const d = new DataView(r.payload.buffer, r.payload.byteOffset);
      return {
        uuid: [...r.payload.subarray(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join(''),
        blobSize: d.getBigUint64(16, true),
        retainOff: d.getBigUint64(24, true),
        retainLen: d.getBigUint64(32, true),
        symCount: d.getUint32(40, true),
      };
    });
  }

  progSwap(uuidHex: string): Promise<CtlReply> {
    const uuid = new Uint8Array(16);
    for (let i = 0; i < 16; i++) uuid[i] = parseInt(uuidHex.slice(i * 2, i * 2 + 2), 16);
    return this.call(CTL.PROG_SWAP, uuid);
  }

  progRollback(): Promise<CtlReply> {
    return this.call(CTL.PROG_ROLLBACK);
  }

  /* ---- shadow run (doc 19) --------------------------------------- */

  /** load a deployed package as the shadow candidate → uuid + loaded */
  shadowLoad(uuidHex: string): Promise<{ uuid: string }> {
    const uuid = new Uint8Array(16);
    for (let i = 0; i < 16; i++) uuid[i] = parseInt(uuidHex.slice(i * 2, i * 2 + 2), 16);
    return this.call(CTL.SHADOW_LOAD, uuid).then((r) => ({
      uuid: [...r.payload.subarray(1, 17)].map((b) => b.toString(16).padStart(2, '0')).join(''),
    }));
  }

  shadowStatus(): Promise<ShadowStatus> {
    return this.call(CTL.SHADOW_STATUS).then((r) => {
      if (r.payload.length <= 1) return { loaded: false };
      const d = new DataView(r.payload.buffer, r.payload.byteOffset);
      return {
        loaded: true,
        uuid: [...r.payload.subarray(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join(''),
        name: cstr(r.payload.subarray(16, 80)),
        state: r.payload[80]!,
        cycles: d.getBigUint64(88, true),
        missed: d.getBigUint64(96, true),
        diffCount: d.getBigUint64(104, true),
        lastDiffCycle: d.getBigUint64(112, true),
        runs: d.getBigUint64(120, true),
      };
    });
  }

  /** newest %Q diffs (bounded byte runs, ≤ max entries) */
  shadowCompare(max = 64): Promise<ShadowDiff[]> {
    return this.call(CTL.SHADOW_COMPARE, u32(max)).then((r) => {
      const d = new DataView(r.payload.buffer, r.payload.byteOffset);
      const n = r.payload.length >= 4 ? d.getUint32(0, true) : 0;
      const out: ShadowDiff[] = [];
      for (let i = 0; i < n && 4 + (i + 1) * 84 <= r.payload.length; i++) {
        const o = 4 + i * 84;
        const len = d.getUint32(o + 16, true);
        out.push({
          cycle: d.getBigUint64(o, true),
          imgOff: d.getBigUint64(o + 8, true),
          len,
          active: r.payload.slice(o + 20, o + 20 + Math.min(len, 32)),
          shadow: r.payload.slice(o + 52, o + 52 + Math.min(len, 32)),
        });
      }
      return out;
    });
  }

  /** adopt the shadow as the active program → uuid + new epoch */
  shadowPromote(): Promise<{ uuid: string; epoch: bigint }> {
    return this.call(CTL.SHADOW_PROMOTE).then((r) => {
      const d = new DataView(r.payload.buffer, r.payload.byteOffset);
      return {
        uuid: [...r.payload.subarray(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join(''),
        epoch: d.getBigUint64(16, true),
      };
    });
  }

  shadowDrop(): Promise<CtlReply> {
    return this.call(CTL.SHADOW_DROP);
  }

  /** re-run the active→shadow migration → out_status + first_error */
  shadowReset(): Promise<{ outStatus: number; firstErr: number }> {
    return this.call(CTL.SHADOW_RESET).then((r) => {
      const d = new DataView(r.payload.buffer, r.payload.byteOffset);
      return {
        outStatus: d.getUint32(0, true),
        firstErr: d.getUint32(4, true),
      };
    });
  }

  retainStatus(): Promise<RetainStatus> {
    return this.call(CTL.RETAIN_STATUS).then((r) => {
      const d = new DataView(r.payload.buffer, r.payload.byteOffset);
      return {
        attached: r.payload[0] === 1,
        dirty: r.payload[1] === 1,
        len: d.getBigUint64(4, true),
        generation: d.getBigUint64(12, true),
        flushes: d.getBigUint64(20, true),
        restores: d.getBigUint64(28, true),
        losses: d.getBigUint64(36, true),
      };
    });
  }

  retainFlush(): Promise<CtlReply> {
    return this.call(CTL.RETAIN_FLUSH);
  }

  retainClear(): Promise<CtlReply> {
    return this.call(CTL.RETAIN_CLEAR);
  }

  /** raw bytes of the running program's retain region. */
  retainDump(): Promise<Uint8Array> {
    return this.call(CTL.RETAIN_DUMP).then((r) => r.payload);
  }

  /** Deploy a .tplc package: BEGIN{size,sha256,mode} → CHUNKs → COMMIT. */
  async deploy(pkg: Uint8Array, mode = 0, onProgress?: (frac: number) => void): Promise<string> {
    const sha = new Uint8Array(await crypto.subtle.digest('SHA-256', pkg as BufferSource));
    const begin = new Uint8Array(41);
    begin.set(u64(pkg.length), 0);
    begin.set(sha, 8);
    begin[40] = mode;
    const r1 = await this.call(CTL.DEPLOY_BEGIN, begin);
    const d1 = new DataView(r1.payload.buffer, r1.payload.byteOffset);
    const upid = d1.getBigUint64(0, true);
    let maxc = d1.getUint32(8, true);
    if (maxc === 0 || maxc > 48 * 1024) maxc = 48 * 1024;
    for (let off = 0; off < pkg.length; off += maxc) {
      const n = Math.min(maxc, pkg.length - off);
      const frame_ = new Uint8Array(16 + n);
      frame_.set(u64(upid), 0);
      frame_.set(u64(off), 8);
      frame_.set(pkg.subarray(off, off + n), 16);
      await this.call(CTL.DEPLOY_CHUNK, frame_);
      onProgress?.((off + n) / pkg.length);
    }
    const r3 = await this.call(CTL.DEPLOY_COMMIT, u64(upid));
    return [...r3.payload.subarray(1, 17)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
}
