import { describe, expect, it } from 'vitest';
import { FunctionEntry } from '../protocol/types';
import { TetherIOClient } from '../client';
import {
  CommandReceiptView,
  ConfigTxnState,
  MachineAction,
  MachineControlClient,
  MACHINE_FUNCTION_NAMES,
  decodeAuthoritySnapshot,
  decodeTaggedArray,
  encodeTagged,
  encodeTaggedArray,
  fieldBool,
  fieldBytes,
  fieldScalar,
  fieldString,
  getTaggedString,
  getTaggedU64,
  getTaggedU8,
  parseTagged,
  decodeChecklistItem,
  decodeChecklistReport,
  decodeConfigDiff,
  decodeConfigExport,
  decodePdoEntry,
  decodeSupervisorEntry,
  decodeSupervisorResult,
  SUPERVISOR_STATE_LABELS,
} from './machine-control';

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

describe('tagged struct codec', () => {
  it('round-trips strings, scalars, bytes, and arrays', () => {
    const encoded = encodeTagged([
      [1, fieldString('req-uuid')],
      [2, fieldString('machine')],
      [3, fieldScalar(42n, 8)],
      [7, fieldScalar(5_000_000n, 8)],
      [9, fieldBytes(Uint8Array.of(0xde, 0xad))],
      [5, encodeTaggedArray([fieldString('axis.x'), fieldString('axis.y')])],
      [6, encodeTaggedArray([fieldScalar(7n, 8), fieldScalar(9n, 8)])],
    ]);
    const fields = parseTagged(encoded);
    expect(getTaggedString(fields, 1)).toBe('req-uuid');
    expect(getTaggedString(fields, 2)).toBe('machine');
    expect(getTaggedU64(fields, 3)).toBe(42n);
    expect(getTaggedU64(fields, 7)).toBe(5_000_000n);
    const strings = decodeTaggedArray(fields.get(5)!).map((el) => {
      const m = new Map<number, Uint8Array>([[1, el]]);
      return getTaggedString(m, 1);
    });
    expect(strings).toEqual(['axis.x', 'axis.y']);
    const gens = decodeTaggedArray(fields.get(6)!).map((el) =>
      new DataView(el.buffer, el.byteOffset, 8).getBigUint64(0, true),
    );
    expect(gens).toEqual([7n, 9n]);
  });

  it('sorts out-of-order field keys into ascending order', () => {
    const encoded = encodeTagged([
      [9, fieldScalar(1, 1)],
      [1, fieldString('a')],
    ]);
    const fields = parseTagged(encoded);
    expect(getTaggedString(fields, 1)).toBe('a');
    expect(getTaggedU8(fields, 9)).toBe(1);
  });

  it('rejects malformed payloads', () => {
    expect(() => parseTagged(Uint8Array.of(5, 1))).toThrow();
    // Non-terminated string
    const bad = encodeTagged([[1, Uint8Array.of(0x41)]]);
    expect(() => getTaggedString(parseTagged(bad), 1)).toThrow();
  });
});

describe('decoders', () => {
  it('decodes an AuthoritySnapshotV1 with leases', () => {
    const lease = encodeTagged([
      [1, fieldString('machine')],
      [2, fieldString('operator-1')],
      [3, fieldScalar(7n, 8)],
      [4, fieldScalar(29000, 4)],
    ]);
    const snapshot = decodeAuthoritySnapshot(
      encodeTagged([
        [1, fieldScalar(123456n, 8)],
        [2, encodeTaggedArray([lease])],
      ]),
    );
    expect(snapshot.timestampUs).toBe(123456n);
    expect(snapshot.leases).toEqual([
      { scope: 'machine', ownerActor: 'operator-1', token: 7n, remainingMs: 29000 },
    ]);
  });

  it('action constants match the C++ declaration order', () => {
    expect(MachineAction.Enable).toBe(0);
    expect(MachineAction.JogStart).toBe(6);
    expect(MachineAction.AcknowledgeAlarm).toBe(20);
  });

  it('decodes a CommandReceiptV1 with blockers', async () => {
    const { default: decode } = await Promise.resolve({
      default: (bytes: Uint8Array) => {
        const fields = parseTagged(bytes);
        return {
          requestUuid: getTaggedString(fields, 1),
          state: getTaggedU8(fields, 2),
          message: getTaggedString(fields, 3),
        } as Partial<CommandReceiptView>;
      },
    });
    const receipt = decode(
      encodeTagged([
        [1, fieldString('req-9')],
        [2, fieldScalar(2, 1)],
        [3, fieldString('denied')],
        [4, fieldString('')],
        [5, fieldString('')],
        [6, encodeTaggedArray([fieldString('authority held'), fieldString('estop')])],
      ]),
    );
    expect(receipt.requestUuid).toBe('req-9');
    expect(receipt.state).toBe(2);
  });
});

describe('capture + staged config client', () => {
  const fn = (name: string, id: bigint): FunctionEntry => ({
    id,
    name,
    description: '',
    group: '',
    parameters: [],
    returnPresent: false,
    metadata: {},
  });

  function fakeClient(
    handler: (id: bigint, args: { key: number; value: Uint8Array }[]) => Uint8Array,
  ) {
    const calls: { id: bigint; args: { key: number; value: Uint8Array }[] }[] = [];
    const client = {
      callFunctionOrThrow: (id: bigint, args: { key: number; value: Uint8Array }[]) => {
        calls.push({ id, args });
        return Promise.resolve(handler(id, args));
      },
    } as unknown as TetherIOClient;
    return { client, calls };
  }

  const captureStatusBytes = () =>
    encodeTagged([
      [1, fieldScalar(111n, 8)],
      [2, fieldScalar(1, 1)],
      [3, fieldScalar(64n, 8)],
      [4, fieldScalar(2048n, 8)],
      [5, fieldString('run-1')],
      [6, fieldScalar(1000, 4)],
      [7, fieldScalar(2, 4)],
      [8, fieldBool(true)],
    ]);

  it('encodes capture.configure and decodes CaptureStatusV1', async () => {
    const { client, calls } = fakeClient(() => captureStatusBytes());
    const control = new MachineControlClient(client, [
      fn(MACHINE_FUNCTION_NAMES.captureConfigure, 0xa1n),
      fn(MACHINE_FUNCTION_NAMES.captureStatus, 0xa2n),
    ]);
    expect(control.captureAvailable).toBe(true);

    const status = await control.configureCapture('run-1', 1000, true, [5n, 7n]);
    expect(calls[0]!.id).toBe(0xa1n);
    const args = calls[0]!.args;
    expect(args).toHaveLength(4);
    expect(args[0]!.key).toBe(1);
    expect(new TextDecoder().decode(args[0]!.value.slice(0, -1))).toBe('run-1');
    const ids = decodeTaggedArray(args[3]!.value).map((el) =>
      new DataView(el.buffer, el.byteOffset, 8).getBigUint64(0, true),
    );
    expect(ids).toEqual([5n, 7n]);
    expect(status.state).toBe(1);
    expect(status.logName).toBe('run-1');
    expect(status.fieldCount).toBe(2);
    expect(status.recordsWritten).toBe(64n);

    // Empty entry set encodes as a single zero count varint.
    await control.configureCapture('all', 100, false, []);
    expect([...calls[1]!.args[3]!.value]).toEqual([0]);
  });

  it('runs stage→validate→commit and decodes staged entries', async () => {
    const stagedEntry = encodeTagged([
      [1, fieldScalar(0xf001n, 8)],
      [2, fieldBytes(Uint8Array.of(42, 0, 0, 0))],
    ]);
    const statuses = [
      encodeTagged([
        [1, fieldScalar(1n, 8)],
        [2, fieldScalar(ConfigTxnState.Staged, 1)],
        [3, fieldScalar(3n, 8)],
        [4, fieldScalar(1, 4)],
        [5, fieldString('staged')],
        [6, encodeTaggedArray([stagedEntry])],
      ]),
      encodeTagged([
        [1, fieldScalar(1n, 8)],
        [2, fieldScalar(ConfigTxnState.Validated, 1)],
        [3, fieldScalar(3n, 8)],
        [4, fieldScalar(1, 4)],
        [5, fieldString('valid')],
        [6, encodeTaggedArray([stagedEntry])],
      ]),
      encodeTagged([
        [1, fieldScalar(1n, 8)],
        [2, fieldScalar(ConfigTxnState.Committed, 1)],
        [3, fieldScalar(4n, 8)],
        [4, fieldScalar(0, 4)],
        [5, fieldString('done')],
        [6, encodeTaggedArray([])],
      ]),
    ];
    let call = 0;
    const { client, calls } = fakeClient(() => statuses[call++]!);
    const control = new MachineControlClient(client, [
      fn(MACHINE_FUNCTION_NAMES.configStage, 0xb1n),
      fn(MACHINE_FUNCTION_NAMES.configValidate, 0xb2n),
      fn(MACHINE_FUNCTION_NAMES.configCommit, 0xb3n),
      fn(MACHINE_FUNCTION_NAMES.configRollback, 0xb4n),
      fn(MACHINE_FUNCTION_NAMES.configStatus, 0xb5n),
    ]);
    expect(control.configAvailable).toBe(true);

    const staged = await control.stageConfig([
      { entryId: 0xf001n, value: Uint8Array.of(42, 0, 0, 0) },
    ]);
    expect(staged.state).toBe(ConfigTxnState.Staged);
    expect(staged.staged).toHaveLength(1);
    expect(staged.staged[0]!.entryId).toBe(0xf001n);
    expect([...staged.staged[0]!.value]).toEqual([42, 0, 0, 0]);

    // The request encodes ConfigEntryV1 elements the server can re-parse.
    const sentElements = decodeTaggedArray(calls[0]!.args[0]!.value);
    const sentEntry = parseTagged(sentElements[0]!);
    expect(getTaggedU64(sentEntry, 1)).toBe(0xf001n);
    expect(sentEntry.get(2)![0]).toBe(4); // bytes length prefix

    expect((await control.validateConfig()).state).toBe(ConfigTxnState.Validated);
    const committed = await control.commitConfig();
    expect(committed.state).toBe(ConfigTxnState.Committed);
    expect(committed.revision).toBe(4n);
    expect(calls.map((c) => c.id)).toEqual([0xb1n, 0xb2n, 0xb3n]);
  });

  it('rejects an empty staged transaction client-side', async () => {
    const { client } = fakeClient(() => new Uint8Array());
    const control = new MachineControlClient(client, [fn(MACHINE_FUNCTION_NAMES.configStage, 1n)]);
    await expect(control.stageConfig([])).rejects.toThrow(/1-256/);
  });

  it('reports unavailable when the functions are not advertised', () => {
    const { client } = fakeClient(() => new Uint8Array());
    const control = new MachineControlClient(client, []);
    expect(control.captureAvailable).toBe(false);
    expect(control.configAvailable).toBe(false);
    expect(() => control.functionId('machine.config.stage')).toThrow();
  });
});

describe('PDO + supervisor decoders', () => {
  it('decodes a PDO entry with logical placement', () => {
    const entry = decodePdoEntry(
      encodeTagged([
        [1, fieldScalar(2, 2)],
        [2, fieldScalar(0x1a00, 2)],
        [3, fieldScalar(1, 1)],
        [4, fieldScalar(48, 4)],
        [5, fieldScalar(8, 2)],
        [6, fieldScalar(3, 2)],
      ]),
    );
    expect(entry).toEqual({
      slaveIndex: 2,
      pdoIndex: 0x1a00,
      direction: 1,
      logicalOffset: 48,
      length: 8,
      entryIndex: 3,
    });
  });

  it('decodes supervisor entries and retry results', () => {
    const entry = decodeSupervisorEntry(
      encodeTagged([
        [1, fieldScalar(1, 2)],
        [2, fieldScalar(4, 1)],
        [3, fieldScalar(1, 1)],
        [4, fieldScalar(0, 1)],
        [5, fieldScalar(3, 2)],
      ]),
    );
    expect(entry.state).toBe(4);
    expect(entry.suspended).toBe(true);
    expect(entry.recovering).toBe(false);
    expect(entry.attemptCount).toBe(3);
    expect(SUPERVISOR_STATE_LABELS[entry.state]).toBe('failed');

    // Server layout (MachineService.hpp): {1: ok u8, 2: state u8, 3: error string}.
    const result = decodeSupervisorResult(
      encodeTagged([
        [1, fieldScalar(0, 1)],
        [2, fieldScalar(1, 1)],
        [3, fieldString('recovery already in progress')],
      ]),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe('recovery already in progress');
  });
});

describe('config baseline + checklist decoders', () => {
  const entry = encodeTagged([
    [1, fieldScalar(0xf001n, 8)],
    [2, fieldBytes(Uint8Array.of(42, 0, 0, 0))],
  ]);

  it('decodes a ConfigExportV1 with entries', () => {
    const view = decodeConfigExport(
      encodeTagged([
        [1, fieldScalar(7n, 8)],
        [2, encodeTaggedArray([entry])],
      ]),
    );
    expect(view.revision).toBe(7n);
    expect(view.entries).toEqual([{ entryId: 0xf001n, value: Uint8Array.of(42, 0, 0, 0) }]);
  });

  it('decodes a ConfigDiffV1 mismatch', () => {
    const diff = encodeTagged([
      [1, fieldScalar(0xf001n, 8)],
      [2, fieldBytes(Uint8Array.of(42, 0, 0, 0))],
      [3, fieldBytes(Uint8Array.of(99, 0, 0, 0))],
    ]);
    const view = decodeConfigDiff(
      encodeTagged([
        [1, fieldScalar(8n, 8)],
        [2, fieldScalar(1, 4)],
        [3, encodeTaggedArray([diff])],
      ]),
    );
    expect(view.revision).toBe(8n);
    expect(view.diffs).toHaveLength(1);
    expect(view.diffs[0]!.entryId).toBe(0xf001n);
    expect([...view.diffs[0]!.actual]).toEqual([99, 0, 0, 0]);
  });

  it('decodes checklist items and reports', () => {
    const item = encodeTagged([
      [1, fieldScalar(3, 4)],
      [2, fieldString('Configuration committed')],
      [3, fieldScalar(1, 1)],
      [4, fieldScalar(1, 1)],
      [5, fieldString('revision 2')],
    ]);
    const items = decodeTaggedArray(encodeTaggedArray([item])).map(decodeChecklistItem);
    expect(items[0]).toEqual({
      itemId: 3,
      label: 'Configuration committed',
      required: true,
      passed: true,
      evidence: 'revision 2',
    });
    const report = decodeChecklistReport(
      encodeTagged([
        [1, fieldScalar(123n, 8)],
        [2, fieldScalar(2n, 8)],
        [3, fieldScalar(1, 1)],
        [4, encodeTaggedArray([item])],
      ]),
    );
    expect(report.allRequiredPassed).toBe(true);
    expect(report.items).toHaveLength(1);
  });
});
