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
  IMAGE_STATS: 0x0701,
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
}

/** one armed conditional break (DBG_BREAK_LIST entry) */
export interface DbgBreak {
  handle: number;
  taskIdx: number;
  offset: bigint;
  len: number;
  cmp: number;
  value: bigint;
  hits: bigint;
}

/** cmp codes shared with the runtime's DBG_BREAK payload */
export const DBG_CMP = ['==', '!=', '<', '<=', '>', '>='] as const;

export interface ProgStatus {
  uuid: string;
  name: string;
  state: number;
  cycles: bigint;
  tasks: {
    name: string;
    state: number;
    periodNs: bigint;
    runs: bigint;
    late: bigint;
    faults: bigint;
  }[];
}

export interface RtStatus {
  uptimeS: number;
  progCount: number;
  runningCount: number;
  masterStatus: number;
  plcStatus: number;
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

  async health(): Promise<boolean> {
    try {
      return (await fetch(`${this.url}/health`)).ok;
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
      const tasks: ProgStatus['tasks'] = [];
      for (let i = 0; i < taskCount; i++) {
        const o = 104 + i * 112;
        tasks.push({
          name: cstr(r.payload.subarray(o, o + 64)),
          state: r.payload[o + 65]!,
          periodNs: d.getBigUint64(o + 72, true),
          runs: d.getBigUint64(o + 80, true),
          late: d.getBigUint64(o + 88, true),
          faults: d.getBigUint64(o + 96, true),
        });
      }
      return {
        uuid: [...r.payload.subarray(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join(''),
        name: cstr(r.payload.subarray(16, 80)),
        state: r.payload[80]!,
        cycles: d.getBigUint64(88, true),
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
      };
    });
  }

  progStart(): Promise<CtlReply> {
    return this.call(CTL.PROG_START);
  }

  progStop(): Promise<CtlReply> {
    return this.call(CTL.PROG_STOP);
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

  /** cycle-consistent read of the program blob. */
  dbgRead(offset: bigint | number, len: number): Promise<Uint8Array> {
    const p = new Uint8Array(12);
    const d = new DataView(p.buffer);
    d.setBigUint64(0, BigInt(offset), true);
    d.setUint32(8, len, true);
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

  /** persistent override at every boundary until cleared → handle. */
  dbgForce(offset: bigint | number, bytes: Uint8Array): Promise<number> {
    const p = new Uint8Array(12 + bytes.length);
    const d = new DataView(p.buffer);
    d.setBigUint64(0, BigInt(offset), true);
    d.setUint32(8, bytes.length, true);
    p.set(bytes, 12);
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
        });
        o += 16 + len;
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
