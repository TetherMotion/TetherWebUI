/**
 * PlcWs — WebSocket transport for the `tplc serve` /ws endpoint.
 *
 * One socket carries everything:
 *   binary message → a verbatim ctl frame (16-byte LE header + payload);
 *                    replies are matched by req_id, unsolicited F_EVENT
 *                    frames go to event subscribers.
 *   text message   → JSON meta-op {"id":N,"op":…,…}; replies are
 *                    {"id":N,"ok":true,"data":…} / {"ok":false,"error"}.
 *
 * The socket is opened lazily on first use and re-opened after a drop;
 * event subscribers survive reconnects.
 */
import type { CtlEvent, CtlReply } from './ctl';

const F_ERROR = 1 << 15;

function cstr(b: Uint8Array): string {
  const n = b.indexOf(0);
  return new TextDecoder().decode(n < 0 ? b : b.subarray(0, n));
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

export class WsError extends Error {}

let reqId = 1n;
let metaId = 1;

export class PlcWs {
  private ws?: WebSocket;
  private connecting?: Promise<void>;
  private pending = new Map<bigint, { res: (r: CtlReply) => void; rej: (e: Error) => void }>();
  private metaPending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  private eventCbs = new Set<(e: CtlEvent) => void>();
  private closeCbs = new Set<() => void>();

  constructor(public base = localStorage.getItem('tether.plc.ctlUrl') ?? 'http://127.0.0.1:8089') {}

  private wsUrl(): string {
    const u = new URL(this.base, location.origin);
    u.protocol = u.protocol === 'https:' || u.protocol === 'wss:' ? 'wss:' : 'ws:';
    u.pathname = '/ws';
    u.search = '';
    u.hash = '';
    return u.toString();
  }

  /** open (or reuse) the socket; resolves once the WS handshake is done. */
  connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((res, rej) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.wsUrl());
      } catch (e) {
        this.connecting = undefined;
        rej(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      this.ws = ws;
      ws.onopen = () => {
        this.connecting = undefined;
        res();
      };
      ws.onerror = () => {
        // onclose follows; reject a pending connect there
      };
      ws.onclose = () => {
        const wasOpen = this.ws === ws && ws.readyState !== WebSocket.CONNECTING;
        if (this.ws === ws) this.ws = undefined;
        this.connecting = undefined;
        const err = new WsError('websocket closed');
        for (const p of this.pending.values()) p.rej(err);
        this.pending.clear();
        for (const p of this.metaPending.values()) p.rej(err);
        this.metaPending.clear();
        if (wasOpen) for (const cb of this.closeCbs) cb();
      };
      ws.onmessage = (m: MessageEvent) => this.onMessage(m);
    });
    return this.connecting;
  }

  private onMessage(m: MessageEvent): void {
    if (typeof m.data === 'string') {
      let j: { id?: number; ok?: boolean; data?: unknown; error?: string };
      try {
        j = JSON.parse(m.data);
      } catch {
        return;
      }
      const id = j.id;
      if (typeof id !== 'number') return;
      const p = this.metaPending.get(id);
      if (!p) return;
      this.metaPending.delete(id);
      if (j.ok) p.res(j.data);
      else p.rej(new WsError(j.error ?? 'meta op failed'));
      return;
    }
    const buf =
      m.data instanceof ArrayBuffer
        ? new Uint8Array(m.data)
        : new Uint8Array(m.data as ArrayBuffer);
    if (buf.length < 16) return;
    const d = new DataView(buf.buffer, buf.byteOffset);
    const rep: CtlReply = {
      type: d.getUint16(0, true),
      flags: d.getUint16(2, true),
      req: d.getBigUint64(8, true),
      payload: buf.subarray(16),
    };
    if (rep.flags & (1 << 1)) {
      // F_EVENT — unsolicited push (EV_* types only)
      if (rep.type & 0x0e00) {
        const e: CtlEvent = { type: rep.type, payload: rep.payload };
        for (const cb of this.eventCbs) cb(e);
      }
      return;
    }
    const p = this.pending.get(rep.req);
    if (!p) return;
    this.pending.delete(rep.req);
    if (rep.flags & F_ERROR) {
      const pl = rep.payload;
      const dv = new DataView(pl.buffer, pl.byteOffset);
      const ml = pl.length >= 10 ? dv.getUint16(8, true) : 0;
      p.rej(
        new CtlError(
          pl.length >= 8 ? dv.getInt32(0, true) : -1,
          pl.length >= 8 ? dv.getUint32(4, true) : 0,
          cstr(pl.subarray(10, 10 + ml)),
        ),
      );
    } else {
      p.res(rep);
    }
  }

  /** send one ctl op; resolves with the reply frame (errors → CtlError). */
  async sendCtl(type: number, payload: Uint8Array = new Uint8Array()): Promise<CtlReply> {
    await this.connect();
    const ws = this.ws;
    if (!ws) throw new WsError('websocket not connected');
    const req = reqId++;
    const b = new Uint8Array(16 + payload.length);
    const d = new DataView(b.buffer);
    d.setUint16(0, type, true);
    d.setUint32(4, payload.length, true);
    d.setBigUint64(8, req, true);
    b.set(payload, 16);
    return new Promise<CtlReply>((res, rej) => {
      this.pending.set(req, { res, rej });
      try {
        ws.send(b);
      } catch (e) {
        this.pending.delete(req);
        rej(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** send a JSON meta-op; resolves with `data` (errors → WsError). */
  async meta<T = unknown>(op: string, fields: Record<string, unknown> = {}): Promise<T> {
    await this.connect();
    const ws = this.ws;
    if (!ws) throw new WsError('websocket not connected');
    const id = metaId++;
    return new Promise<T>((res, rej) => {
      this.metaPending.set(id, { res: res as (v: unknown) => void, rej });
      try {
        ws.send(JSON.stringify({ id, op, ...fields }));
      } catch (e) {
        this.metaPending.delete(id);
        rej(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** subscribe to F_EVENT frames; returns an unsubscribe fn. */
  onEvent(cb: (e: CtlEvent) => void): () => void {
    this.eventCbs.add(cb);
    return () => this.eventCbs.delete(cb);
  }

  /** subscribe to socket close (after having been open). */
  onClose(cb: () => void): () => void {
    this.closeCbs.add(cb);
    return () => this.closeCbs.delete(cb);
  }

  close(): void {
    this.ws?.close();
    this.ws = undefined;
    this.connecting = undefined;
  }
}
