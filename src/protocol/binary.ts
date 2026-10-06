/** Binary readers/writers and legacy SLIP framing primitives. */

export class BinaryReader {
  private offset = 0;
  private readonly view: DataView;

  constructor(private readonly input: Uint8Array) {
    this.view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  }

  get remaining(): number {
    return this.view.byteLength - this.offset;
  }

  get position(): number {
    return this.offset;
  }

  slice(start: number, end: number): Uint8Array {
    if (start < 0 || end < start || end > this.offset) throw new Error('invalid reader slice');
    return this.input.slice(start, end);
  }

  private take(size: number): number {
    if (size < 0 || this.remaining < size) throw new Error('truncated packet');
    const start = this.offset;
    this.offset += size;
    return start;
  }

  u8(): number { return this.view.getUint8(this.take(1)); }
  u16(): number { return this.view.getUint16(this.take(2), true); }
  u32(): number { return this.view.getUint32(this.take(4), true); }
  u64(): bigint { return this.view.getBigUint64(this.take(8), true); }

  bytesOf(size: number): Uint8Array {
    const start = this.take(size);
    return this.input.slice(start, start + size);
  }

  varint(): number {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const byte = this.u8();
      value += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) return value;
    }
    throw new Error('invalid varint');
  }

  string16(): string { return new TextDecoder().decode(this.bytesOf(this.u16())); }
  string32(): string { return new TextDecoder('utf-8', { fatal: true }).decode(this.bytesOf(this.u32())); }

  assertEnd(): void {
    if (this.remaining !== 0) throw new Error('trailing packet data');
  }
}

export class BinaryWriter {
  private readonly output: Uint8Array;
  private readonly view: DataView;
  private offset = 0;

  constructor(size = 256) {
    this.output = new Uint8Array(size);
    this.view = new DataView(this.output.buffer);
  }

  private room(size: number): number {
    if (this.offset + size > this.output.length) throw new Error('packet too large');
    const start = this.offset;
    this.offset += size;
    return start;
  }

  u8(value: number): this { this.view.setUint8(this.room(1), value); return this; }
  u16(value: number): this { this.view.setUint16(this.room(2), value, true); return this; }
  u32(value: number): this { this.view.setUint32(this.room(4), value, true); return this; }
  u64(value: bigint): this { this.view.setBigUint64(this.room(8), value, true); return this; }

  bytes(value: Uint8Array): this {
    this.output.set(value, this.room(value.length));
    return this;
  }

  varint(value: number): this {
    do {
      const byte = value % 128;
      value = Math.floor(value / 128);
      this.u8(byte | (value ? 0x80 : 0));
    } while (value);
    return this;
  }

  finish(): Uint8Array { return this.output.slice(0, this.offset); }
}

export function slipEncode(payload: Uint8Array): Uint8Array {
  const result: number[] = [];
  for (const byte of payload) {
    if (byte === 0xc0) result.push(0xdb, 0xdc);
    else if (byte === 0xdb) result.push(0xdb, 0xdd);
    else result.push(byte);
  }
  result.push(0xc0);
  return Uint8Array.from(result);
}

export class SlipDecoder {
  private frame: number[] = [];
  private escaped = false;
  private discarding = false;

  constructor(private readonly maxFrameSize = 1024 * 1024) {}

  push(chunk: Uint8Array): Uint8Array[] {
    const frames: Uint8Array[] = [];
    for (const byte of chunk) {
      if (this.discarding) {
        if (byte === 0xc0) {
          this.discarding = false;
          this.frame = [];
        }
        continue;
      }
      if (byte === 0xc0) {
        if (this.frame.length) frames.push(Uint8Array.from(this.frame));
        this.frame = [];
        this.escaped = false;
        continue;
      }
      if (this.escaped) {
        if (byte === 0xdc) this.frame.push(0xc0);
        else if (byte === 0xdd) this.frame.push(0xdb);
        else {
          this.frame = [];
          this.discarding = true;
        }
        this.escaped = false;
      } else if (byte === 0xdb) {
        this.escaped = true;
      } else {
        this.frame.push(byte);
      }
      if (this.frame.length > this.maxFrameSize) {
        this.frame = [];
        this.escaped = false;
        this.discarding = true;
      }
    }
    return frames;
  }
}
