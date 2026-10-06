/**
 * Deterministic fuzz coverage for the wire-facing tagged/array decoders.
 * Every decode is expected to either succeed or throw a normal Error — a
 * crash or hang means a hostile server can wedge the client.
 */
import { describe, expect, it } from 'vitest';
import {
  decodeConfigDiff,
  decodeTaggedArray,
  encodeTagged,
  encodeTaggedArray,
  fieldBytes,
  fieldScalar,
  fieldString,
  getTaggedString,
  parseTagged,
} from './machine-control';
import { parseBaselineFile } from '../views/commissioning';

let state = 0x9e3779b97f4a7c15n;
function next(): number {
  state ^= state << 13n;
  state ^= state >> 7n;
  state ^= state << 17n;
  state &= 0xffffffffffffffffn;
  return Number(state & 0xffffffffn);
}

function randomBytes(maxSize: number): Uint8Array {
  const bytes = new Uint8Array(next() % (maxSize + 1));
  for (let i = 0; i < bytes.length; i++) bytes[i] = next() & 0xff;
  return bytes;
}

function mutate(bytes: Uint8Array): Uint8Array {
  const copy = Uint8Array.from(bytes);
  if (copy.length === 0) return copy;
  switch (next() % 4) {
    case 0:
      copy[next() % copy.length]! ^= next() & 0xff;
      break;
    case 1:
      return copy.slice(0, next() % copy.length);
    case 2:
      copy[0] = 0xff;
      break;
    default:
      return Uint8Array.from([...copy, next() & 0xff]);
  }
  return copy;
}

describe('fuzz: wire decoders', () => {
  it('parseTagged/decodeTaggedArray never hang or crash on garbage', () => {
    for (let i = 0; i < 4000; i++) {
      const bytes = randomBytes(256);
      try {
        const fields = parseTagged(bytes);
        for (const key of [...fields.keys()]) getTaggedString(fields, key);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
      try {
        decodeTaggedArray(bytes);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    }
  });

  it('higher-level decoders survive mutated valid payloads', () => {
    const valid = encodeTagged([
      [1, fieldScalar(7n, 8)],
      [2, fieldString('x')],
      [3, fieldBytes(Uint8Array.of(1, 2, 3))],
    ]);
    const validArray = encodeTaggedArray([valid]);
    for (let i = 0; i < 4000; i++) {
      for (const bytes of [mutate(valid), mutate(validArray), randomBytes(64)]) {
        try {
          decodeConfigDiff(bytes);
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
        }
      }
    }
  });

  it('decoders reject truncated payloads', () => {
    const valid = encodeTagged([
      [1, fieldScalar(1n, 8)],
      [2, fieldString('abc')],
    ]);
    for (let cut = 0; cut < valid.length; cut++) {
      expect(() => parseTagged(valid.slice(0, cut))).toThrow();
    }
  });

  it('baseline file parser rejects malformed JSON shapes', () => {
    for (let i = 0; i < 2000; i++) {
      const text = Buffer.from(randomBytes(48)).toString('latin1');
      expect(parseBaselineFile(text)).toBeUndefined();
    }
    expect(
      parseBaselineFile(JSON.stringify({ format: 'tether.config.baseline.v1', entries: [{ entry_id: 'not-a-number', value: 'zz' }] })),
    ).toBeUndefined();
  });
});
