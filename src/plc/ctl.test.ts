import { describe, expect, it, vi, afterEach } from 'vitest';
import { PlcCtl } from './ctl';

/* fake /ws socket: binary sends get a canned ctl-frame reply with the
   request's req_id echoed; text sends get a JSON meta reply. */
let lastReq: Uint8Array | undefined;
let canned: Uint8Array = new Uint8Array();
let cannedMeta: unknown = { ok: true };

class FakeWS {
  static OPEN = 1;
  readyState = 1;
  onopen?: () => void;
  onmessage?: (m: { data: ArrayBuffer | string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  constructor(public url: string) {
    queueMicrotask(() => this.onopen?.());
  }
  send(data: ArrayBuffer | Uint8Array | string): void {
    if (typeof data === 'string') {
      const j = JSON.parse(data) as { id: number };
      const rep = JSON.stringify({ id: j.id, ok: true, data: cannedMeta });
      queueMicrotask(() => this.onmessage?.({ data: rep }));
      return;
    }
    const req = new Uint8Array(data instanceof Uint8Array ? data : new Uint8Array(data));
    lastReq = req;
    const d = new DataView(req.buffer, req.byteOffset);
    const id = d.getBigUint64(8, true);
    const b = new Uint8Array(16 + canned.length);
    const rd = new DataView(b.buffer);
    rd.setUint16(0, 0, true);
    rd.setUint32(4, canned.length, true);
    rd.setBigUint64(8, id, true);
    b.set(canned, 16);
    queueMicrotask(() => this.onmessage?.({ data: b.buffer }));
  }
  close(): void {}
}

function mock(payload: Uint8Array): void {
  lastReq = undefined;
  canned = payload;
  vi.stubGlobal('WebSocket', FakeWS);
}

function cstr(b: Uint8Array, s: string, off = 0): void {
  b.set(new TextEncoder().encode(s), off);
}

/* proto-v3 TplcCtlProgStatus: 336 B base + n × 136 B task rows */
function progStatusV3(taskCount: number): Uint8Array {
  const p = new Uint8Array(336 + taskCount * 136);
  const d = new DataView(p.buffer);
  for (let i = 0; i < 16; i++) p[i] = i;
  cstr(p, 'RampProg', 16);
  p[80] = 1;
  d.setUint32(84, taskCount, true);
  d.setBigUint64(88, 4242n, true);
  d.setInt32(96, -7, true); /* last_fault_code */
  d.setUint32(100, 3, true); /* force_count */
  cstr(p, '1.2.3', 168); /* version */
  d.setUint32(200, 1, true); /* fault_task */
  d.setBigUint64(208, 1234n, true); /* fault_cycle */
  p[216] = 1; /* retain_restored */
  d.setBigUint64(224, 512n, true); /* retain_dirty_bytes */
  d.setBigUint64(240, 1_700_000_000_000_000_000n, true); /* deployed_at_ns */
  d.setBigUint64(288, 42n, true); /* epoch (proto v2+) */
  p[296] = 1; /* shadow_state */
  d.setBigUint64(304, 55n, true); /* shadow_cycles */
  d.setBigUint64(312, 2n, true); /* shadow_missed */
  d.setBigUint64(320, 7n, true); /* shadow_diff_count */
  for (let i = 0; i < taskCount; i++) {
    const o = 336 + i * 136;
    cstr(p, `task${i}`, o);
    p[o + 65] = 2;
    d.setBigUint64(o + 72, 10_000_000n, true);
    d.setBigUint64(o + 80, 100n + BigInt(i), true);
    d.setBigUint64(o + 88, 3n, true);
    d.setBigUint64(o + 96, 1n, true);
  }
  return p;
}

describe('PlcCtl progStatus', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('decodes the proto-v3 layout with the shadow tail', async () => {
    mock(progStatusV3(2));
    const s = await new PlcCtl().progStatus();
    expect(s.uuid).toBe('000102030405060708090a0b0c0d0e0f');
    expect(s.name).toBe('RampProg');
    expect(s.state).toBe(1);
    expect(s.cycles).toBe(4242n);
    expect(s.epoch).toBe(42n);
    expect(s.lastFaultCode).toBe(-7);
    expect(s.forceCount).toBe(3);
    expect(s.version).toBe('1.2.3');
    expect(s.faultTask).toBe(1);
    expect(s.faultCycle).toBe(1234n);
    expect(s.retainRestored).toBe(1);
    expect(s.retainDirtyBytes).toBe(512n);
    expect(s.deployedAtNs).toBe(1_700_000_000_000_000_000n);
    expect(s.shadowState).toBe(1);
    expect(s.shadowCycles).toBe(55n);
    expect(s.shadowMissed).toBe(2n);
    expect(s.shadowDiffCount).toBe(7n);
    expect(s.tasks).toHaveLength(2);
    expect(s.tasks[1]!.name).toBe('task1');
    expect(s.tasks[1]!.state).toBe(2);
    expect(s.tasks[1]!.runs).toBe(101n);
    expect(s.tasks[1]!.late).toBe(3n);
  });

  it('still decodes the proto-v1 layout without a shadow tail', async () => {
    const p = new Uint8Array(104 + 112);
    const d = new DataView(p.buffer);
    cstr(p, 'OldProg', 16);
    p[80] = 1;
    d.setUint32(84, 1, true);
    d.setBigUint64(88, 9n, true);
    cstr(p, 't0', 104);
    p[169] = 1;
    d.setBigUint64(104 + 80, 42n, true);
    mock(p);
    const s = await new PlcCtl().progStatus();
    expect(s.name).toBe('OldProg');
    expect(s.lastFaultCode).toBe(0);
    expect(s.forceCount).toBe(0);
    expect(s.epoch).toBeUndefined();
    expect(s.version).toBeUndefined();
    expect(s.deployedAtNs).toBeUndefined();
    expect(s.shadowState).toBeUndefined();
    expect(s.tasks).toHaveLength(1);
    expect(s.tasks[0]!.name).toBe('t0');
    expect(s.tasks[0]!.runs).toBe(42n);
  });
});

describe('PlcCtl rtStatus', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('decodes status fields, heartbeats and version banner', async () => {
    const p = new Uint8Array(104);
    const d = new DataView(p.buffer);
    d.setUint32(0, 3, true); /* proto_ver */
    d.setUint32(4, 3600, true);
    d.setUint32(8, 2, true);
    d.setUint32(12, 1, true);
    d.setUint32(16, 0, true);
    d.setUint32(20, 1, true);
    d.setBigUint64(24, 111n, true);
    d.setBigUint64(32, 222n, true);
    cstr(p, 'tether-plc 0.1', 40);
    mock(p);
    const s = await new PlcCtl().rtStatus();
    expect(s.uptimeS).toBe(3600);
    expect(s.progCount).toBe(2);
    expect(s.runningCount).toBe(1);
    expect(s.masterStatus).toBe(0);
    expect(s.plcStatus).toBe(1);
    expect(s.masterHbNs).toBe(111n);
    expect(s.plcHbNs).toBe(222n);
    expect(s.version).toBe('tether-plc 0.1');
  });

  it('tolerates a short legacy reply', async () => {
    const p = new Uint8Array(24);
    const d = new DataView(p.buffer);
    d.setUint32(4, 5, true);
    d.setUint32(8, 1, true);
    mock(p);
    const s = await new PlcCtl().rtStatus();
    expect(s.uptimeS).toBe(5);
    expect(s.masterHbNs).toBeUndefined();
    expect(s.version).toBeUndefined();
  });
});

describe('PlcCtl shadow ops', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shadowLoad sends the 16-byte package uuid', async () => {
    const rep = new Uint8Array(17);
    rep[0] = 1;
    for (let i = 0; i < 16; i++) rep[1 + i] = 0xaa;
    mock(rep);
    const r = await new PlcCtl().shadowLoad('a'.repeat(32));
    expect(lastReq!.subarray(16)).toHaveLength(16);
    expect([...lastReq!.subarray(16)].every((b) => b === 0xaa)).toBe(true);
    expect(r.uuid).toBe('aa'.repeat(16));
    expect(new DataView(lastReq!.buffer).getUint16(0, true)).toBe(0x0801);
  });

  it('shadowStatus parses the loaded reply', async () => {
    const p = new Uint8Array(128);
    const d = new DataView(p.buffer);
    for (let i = 0; i < 16; i++) p[i] = 0x10 + i;
    cstr(p, 'Cand', 16);
    p[80] = 1;
    d.setBigUint64(88, 99n, true);
    d.setBigUint64(96, 4n, true);
    d.setBigUint64(104, 12n, true);
    d.setBigUint64(112, 88n, true);
    d.setBigUint64(120, 99n, true);
    mock(p);
    const s = await new PlcCtl().shadowStatus();
    expect(s.loaded).toBe(true);
    expect(s.name).toBe('Cand');
    expect(s.cycles).toBe(99n);
    expect(s.missed).toBe(4n);
    expect(s.diffCount).toBe(12n);
    expect(s.lastDiffCycle).toBe(88n);
    expect(s.runs).toBe(99n);
  });

  it('shadowStatus reports unloaded for the 1-byte reply', async () => {
    mock(new Uint8Array([0]));
    expect((await new PlcCtl().shadowStatus()).loaded).toBe(false);
  });

  it('shadowCompare decodes bounded byte-run rows', async () => {
    const p = new Uint8Array(4 + 2 * 84);
    const d = new DataView(p.buffer);
    d.setUint32(0, 2, true);
    for (const [i, cyc, off] of [
      [0, 10n, 4n],
      [1, 11n, 8n],
    ] as const) {
      const o = 4 + i * 84;
      d.setBigUint64(o, cyc, true);
      d.setBigUint64(o + 8, off, true);
      d.setUint32(o + 16, 2, true);
      p[o + 20] = 0x11 * (i + 1);
      p[o + 21] = 0x22;
      p[o + 52] = 0x33;
      p[o + 53] = 0x44 * (i + 1);
    }
    mock(p);
    const rows = await new PlcCtl().shadowCompare();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.cycle).toBe(10n);
    expect(rows[0]!.imgOff).toBe(4n);
    expect([...rows[0]!.active]).toEqual([0x11, 0x22]);
    expect([...rows[0]!.shadow]).toEqual([0x33, 0x44]);
    expect([...rows[1]!.shadow]).toEqual([0x33, 0x88]);
    expect(new DataView(lastReq!.buffer).getUint16(0, true)).toBe(0x0803);
  });

  it('shadowPromote parses uuid + epoch', async () => {
    const p = new Uint8Array(24);
    const d = new DataView(p.buffer);
    for (let i = 0; i < 16; i++) p[i] = 0xbb;
    d.setBigUint64(16, 7n, true);
    mock(p);
    const r = await new PlcCtl().shadowPromote();
    expect(r.uuid).toBe('bb'.repeat(16));
    expect(r.epoch).toBe(7n);
  });

  it('dbgRead appends the selector byte only when sel ≠ 0', async () => {
    mock(new Uint8Array(4));
    const c = new PlcCtl();
    await c.dbgRead(16n, 8);
    expect(lastReq!).toHaveLength(16 + 12);
    await c.dbgRead(16n, 8, 1);
    expect(lastReq!).toHaveLength(16 + 13);
    expect(lastReq![16 + 12]).toBe(1);
    const d = new DataView(lastReq!.buffer, 16);
    expect(d.getBigUint64(0, true)).toBe(16n);
    expect(d.getUint32(8, true)).toBe(8);
  });
});

describe('PlcCtl program ops', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('progPrepare sends the 16-byte package uuid as PROG_PREPARE', async () => {
    mock(new Uint8Array(0));
    const uuid = '0123456789abcdef0123456789abcdef';
    await new PlcCtl().progPrepare(uuid);
    expect(lastReq!).toHaveLength(16 + 16);
    expect(new DataView(lastReq!.buffer).getUint16(0, true)).toBe(0x0301);
    const want = [...uuid.matchAll(/../g)].map((m) => parseInt(m[0], 16));
    expect([...lastReq!.subarray(16)]).toEqual(want);
  });
});

describe('PlcCtl mqtt ops', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('mqttStatus decodes broker rows', async () => {
    // {u32 n, {u32 h,state,jcount,port,transport,tls,mver, str host, str cid}*}
    const p = new Uint8Array(256);
    const d = new DataView(p.buffer);
    d.setUint32(0, 1, true);
    let o = 4;
    d.setUint32(o, 3, true);
    o += 4; // handle
    d.setUint32(o, 2, true);
    o += 4; // state connected
    d.setUint32(o, 7, true);
    o += 4; // journal count
    d.setUint32(o, 8883, true);
    o += 4;
    d.setUint32(o, 4, true);
    o += 4; // wss
    d.setUint32(o, 1, true);
    o += 4; // tls
    d.setUint32(o, 5, true);
    o += 4; // mqtt5
    const host = new TextEncoder().encode('broker.example.com/mqtt');
    d.setUint16(o, host.length, true);
    o += 2;
    p.set(host, o);
    o += host.length;
    const cid = new TextEncoder().encode('plc-1');
    d.setUint16(o, cid.length, true);
    o += 2;
    p.set(cid, o);
    o += cid.length;
    mock(p.subarray(0, o));
    const conns = await new PlcCtl().mqttStatus();
    expect(conns).toHaveLength(1);
    expect(conns[0]).toMatchObject({
      handle: 3,
      state: 2,
      journalCount: 7,
      port: 8883,
      transport: 4,
      tls: 1,
      mqttVersion: 5,
      host: 'broker.example.com/mqtt',
      clientId: 'plc-1',
    });
  });

  it('mqttJournal decodes entries oldest→newest', async () => {
    // reply {i32 total, u32 n, {u64 ts,u32 qos,u32 ret,u32 msgid,
    //   str topic, u32 plen, bytes payload}*}
    const p = new Uint8Array(512);
    const d = new DataView(p.buffer);
    d.setInt32(0, 12, true); // total retained
    d.setUint32(4, 2, true); // n returned
    let o = 8;
    const topic = new TextEncoder().encode('tether/boiler/temp');
    const payload = new TextEncoder().encode('72.5');
    d.setBigUint64(o, 1_700_000_000_000n, true);
    o += 8;
    d.setUint32(o, 1, true);
    o += 4; // qos
    d.setUint32(o, 0, true);
    o += 4; // retain
    d.setUint32(o, 42, true);
    o += 4; // msgid
    d.setUint16(o, topic.length, true);
    o += 2;
    p.set(topic, o);
    o += topic.length;
    d.setUint32(o, payload.length, true);
    o += 4;
    p.set(payload, o);
    o += payload.length;
    // second entry, binary payload
    const topic2 = new TextEncoder().encode('x/y');
    d.setBigUint64(o, 1_700_000_001_000n, true);
    o += 8;
    d.setUint32(o, 0, true);
    o += 4;
    d.setUint32(o, 1, true);
    o += 4;
    d.setUint32(o, 7, true);
    o += 4;
    d.setUint16(o, topic2.length, true);
    o += 2;
    p.set(topic2, o);
    o += topic2.length;
    d.setUint32(o, 3, true);
    o += 4;
    p.set([0xde, 0xad, 0xbe], o);
    o += 3;
    mock(p.subarray(0, o));
    const r = await new PlcCtl().mqttJournal(3, 5, 2);
    expect(r.total).toBe(12);
    expect(r.entries).toHaveLength(2);
    expect(r.entries[0]!.topic).toBe('tether/boiler/temp');
    expect(new TextDecoder().decode(r.entries[0]!.payload)).toBe('72.5');
    expect(r.entries[0]!.msgid).toBe(42);
    expect([...r.entries[1]!.payload]).toEqual([0xde, 0xad, 0xbe]);
    // request frame carries {handle, idx, max}
    const q = new DataView(lastReq!.buffer, 16);
    expect(q.getUint32(0, true)).toBe(3);
    expect(q.getUint32(4, true)).toBe(5);
    expect(q.getUint32(8, true)).toBe(2);
  });
});
