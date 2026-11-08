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
