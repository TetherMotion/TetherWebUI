import { afterEach, describe, expect, it, vi } from 'vitest';
import { TetherIOClient } from './client';
import { BinaryWriter, MessageType } from './protocol';

class MockWebSocket {
  static readonly OPEN = 1;
  static instances: MockWebSocket[] = [];
  binaryType = 'blob';
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  sent: Uint8Array[] = [];

  constructor(_url: string) {
    MockWebSocket.instances.push(this);
  }
  send(data: ArrayBufferLike | Blob | ArrayBufferView): void {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
    this.sent.push(bytes);
    if (bytes[0] === MessageType.clientHello) queueMicrotask(() => this.receive(serverHello()));
    if (bytes[0] === MessageType.getParamReq) {
      const request = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const response = new BinaryWriter(1 + 8 + 1 + 4)
        .u8(MessageType.getParamResp)
        .u64(request.getBigUint64(1, true))
        .varint(4)
        .bytes(Uint8Array.from([0x2a, 0, 0, 0]))
        .finish();
      queueMicrotask(() => this.receive(response));
    }
    if (bytes[0] === MessageType.setParameterReq) {
      const request = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const response = new BinaryWriter(9)
        .u8(MessageType.setParameterResp)
        .u64(request.getBigUint64(1, true))
        .finish();
      queueMicrotask(() => this.receive(response));
    }
    if (bytes[0] === MessageType.invokeExReq) {
      const request = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const response = new BinaryWriter(17)
        .u8(MessageType.invokeExResp)
        .u64(request.getBigUint64(1, true))
        .u8(0)
        .u32(0)
        .u16(0)
        .u8(0)
        .finish();
      queueMicrotask(() => this.receive(response));
    }
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: '', wasClean: true } as CloseEvent);
  }
  receive(bytes: Uint8Array): void {
    this.onmessage?.({
      data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    } as MessageEvent);
  }
  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }
}

function serverHello(): Uint8Array {
  const writer = new BinaryWriter(38).u8(MessageType.serverHello).u8(6).u32(0);
  for (let i = 0; i < 6; i += 1) writer.u32(1024);
  return writer.u32(3).u32(0).finish();
}

const originalWebSocket = globalThis.WebSocket;
afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  MockWebSocket.instances = [];
  vi.restoreAllMocks();
});

describe('TetherIOClient V6 session', () => {
  it('negotiates schemas before resolving connect and decodes varint-framed values', async () => {
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    const client = new TetherIOClient();
    const connect = client.connect('ws://test/tether-io');
    const socket = MockWebSocket.instances[0]!;
    socket.open();
    await connect;
    expect(socket.sent.map((frame) => frame[0])).toEqual([
      MessageType.clientHello,
      MessageType.schemaCommit,
    ]);
    expect(client.schemaCatalog?.epoch).toBe(3);

    const value = await client.get('param', 0x1234n);
    expect([...value]).toEqual([0x2a, 0, 0, 0]);
    await client.setParameter(0x1234n, Uint8Array.from([1, 2, 3, 4]));
    const setFrame = socket.sent.at(-1)!;
    expect([...setFrame]).toEqual([
      MessageType.setParameterReq,
      0x34,
      0x12,
      0,
      0,
      0,
      0,
      0,
      0,
      4,
      1,
      2,
      3,
      4,
    ]);
    const call = await client.callFunction(0x7788n);
    expect(call.success).toBe(true);
    expect(call.functionId).toBe(0x7788n);
    expect(socket.sent.at(-1)?.[0]).toBe(MessageType.invokeExReq);
    client.disconnect();
  });

  it('dispatches stale/reconnecting/resynchronized on an unexpected close', async () => {
    vi.useFakeTimers();
    try {
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
      const client = new TetherIOClient();
      const events: string[] = [];
      for (const name of ['connected', 'stale', 'reconnecting', 'resynchronized', 'disconnected']) {
        client.addEventListener(name, () => events.push(name));
      }
      const connect = client.connect('ws://test/tether-io', { enabled: true, initialDelayMs: 100 });
      MockWebSocket.instances[0]!.open();
      await connect;
      expect(client.state).toBe('connected');

      // Unexpected close → stale + reconnecting, pending requests rejected.
      const hung = client.list('params'); // mock never answers ListParamsReq
      MockWebSocket.instances[0]!.close();
      await expect(hung).rejects.toThrow(/closed/);
      expect(events).toContain('stale');
      expect(events).toContain('reconnecting');
      expect(client.state).toBe('reconnecting');
      // No new socket until the backoff delay elapses.
      expect(MockWebSocket.instances).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(MockWebSocket.instances).toHaveLength(2);
      MockWebSocket.instances[1]!.open();
      await vi.advanceTimersByTimeAsync(0);
      expect(client.state).toBe('connected');
      expect(events).toContain('resynchronized');
      expect(events.filter((e) => e === 'connected')).toHaveLength(2);
      client.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays disconnected after close when reconnect is disabled', async () => {
    vi.useFakeTimers();
    try {
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
      const client = new TetherIOClient();
      const connect = client.connect('ws://test/tether-io');
      MockWebSocket.instances[0]!.open();
      await connect;
      MockWebSocket.instances[0]!.close();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(client.state).toBe('disconnected');
      expect(MockWebSocket.instances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('enforces message-size and pending-queue bounds', async () => {
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    const client = new TetherIOClient();
    const connect = client.connect('ws://test/tether-io');
    const socket = MockWebSocket.instances[0]!;
    socket.open();
    await connect;

    // Oversized inbound frames are dropped without touching pending state.
    const oversized = new Uint8Array((1 << 20) + 1);
    oversized[0] = MessageType.streamData;
    socket.receive(oversized);

    // Oversized outbound frames reject before hitting the wire.
    const big = new Uint8Array((1 << 20) + 1);
    big[0] = MessageType.getParamReq;
    await expect(
      (client as unknown as { request(p: Uint8Array, t: number): Promise<unknown> }).request(
        big,
        1,
      ),
    ).rejects.toThrow(/frame limit/);

    // The pending-request queue is bounded: >512 unanswered requests reject.
    const hung = Array.from({ length: 512 }, () => client.list('params'));
    await expect(client.list('params')).rejects.toThrow(/Too many pending/);
    client.disconnect();
    for (const p of hung) await p.catch(() => undefined);
  });

  it('clamps stream interval/chunk and bounds the entry count', async () => {
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    const client = new TetherIOClient();
    const connect = client.connect('ws://test/tether-io');
    const socket = MockWebSocket.instances[0]!;
    socket.open();
    await connect;

    await expect(
      client.configureStream(Array.from({ length: 257 }, (_, i) => BigInt(i))),
    ).rejects.toThrow(/256 entries/);

    // The mock answers ConfigureStreamReq with a minimal ack so we can
    // inspect the clamped wire values.
    const origSend = socket.send.bind(socket);
    socket.send = (data: ArrayBufferLike | Blob | ArrayBufferView): void => {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
      if (bytes[0] === MessageType.configureStream) {
        const req = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const ack = new BinaryWriter(64)
          .u8(MessageType.configureAck)
          .u32(1) // specId
          .u32(0) // entryCount
          .u32(0) // rowSize
          .u64(0n) // schemaEpoch
          .finish();
        queueMicrotask(() => socket.receive(ack));
        expect(req.getUint32(2, true)).toBe(10_000); // intervalMs clamped up
        expect(req.getUint32(6, true)).toBe(1_000); // chunkSize clamped down
      }
      return origSend(data);
    };
    await client.configureStream([1n], 999_999, 5_000);
    client.disconnect();
  });

  it('sends deadlineUs on InvokeEx and rejects on abort', async () => {
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    const client = new TetherIOClient();
    const connect = client.connect('ws://test/tether-io');
    MockWebSocket.instances[0]!.open();
    await connect;

    await client.callFunction(0x1n, [], { deadlineUs: 250_000n });
    const frame = MockWebSocket.instances[0]!.sent.at(-1)!;
    // Layout: type | reqId u64 | fnId u64 | deadline u64 | arg count u32
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    expect(view.getBigUint64(17, true)).toBe(250_000n);

    const abort = new AbortController();
    const pending = client.callFunction(0x2n, [], { signal: abort.signal });
    abort.abort();
    await expect(pending).rejects.toThrow();
    client.disconnect();
  });
});
