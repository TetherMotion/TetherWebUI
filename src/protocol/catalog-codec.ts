/** Catalog and stream response parsers. */
import { BinaryReader } from './binary';
import { CatalogEntry, FunctionEntry, FunctionParameter, StreamLayoutEntry, StreamRow } from './types';

export function readEntryCatalog(payload: Uint8Array): CatalogEntry[] {
  const reader = new BinaryReader(payload);
  reader.u8();
  reader.u32();
  reader.u32();
  const count = reader.u32();
  const schemaEpoch = reader.u64();
  const entries: CatalogEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    entries.push({
      id: reader.u64(), schemaEpoch, schemaSlot: reader.u32(), flags: reader.u32(),
      name: reader.string16(), description: reader.string16(), group: reader.string16(), kind: 'signal',
    });
  }
  reader.assertEnd();
  return entries;
}

export function readFunctionCatalog(payload: Uint8Array): FunctionEntry[] {
  const reader = new BinaryReader(payload);
  reader.u8();
  reader.u32();
  reader.u32();
  const count = reader.u32();
  const functions: FunctionEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = reader.u64();
    const name = reader.string16();
    const description = reader.string16();
    const group = reader.string16();
    const parameters: FunctionParameter[] = [];
    const parameterCount = reader.u32();
    for (let parameterIndex = 0; parameterIndex < parameterCount; parameterIndex += 1) {
      const parameter: FunctionParameter = {
        name: reader.string16(),
        description: reader.string16(),
        key: reader.u32(),
        schemaSlot: reader.u32(),
        flags: reader.u32(),
        metadata: {},
      };
      if (parameter.flags & 2) parameter.defaultValue = reader.bytesOf(reader.varint());
      parameter.metadata = readMetadata(reader);
      parameters.push(parameter);
    }
    const returnPresent = reader.u8() !== 0;
    let returnSchemaSlot: number | undefined;
    let returnMetadata: Record<string, string> | undefined;
    if (returnPresent) {
      reader.string16();
      reader.string16();
      returnSchemaSlot = reader.u32();
      reader.u32();
      returnMetadata = readMetadata(reader);
    }
    const metadata = readMetadata(reader);
    functions.push({ id, name, description, group, parameters, returnPresent, returnSchemaSlot, returnMetadata, metadata });
  }
  reader.assertEnd();
  return functions;
}

function readMetadata(reader: BinaryReader): Record<string, string> {
  const result: Record<string, string> = {};
  const count = reader.u32();
  for (let index = 0; index < count; index += 1) result[reader.string16()] = reader.string16();
  return result;
}

export function readConfigureAck(payload: Uint8Array): {
  specId: number;
  rowSize: number;
  layout: StreamLayoutEntry[];
} {
  const reader = new BinaryReader(payload);
  reader.u8();
  const specId = reader.u32();
  const count = reader.u32();
  const rowSize = reader.u32();
  const schemaEpoch = reader.u64();
  const layout: StreamLayoutEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    layout.push({ id: reader.u64(), schemaEpoch, schemaSlot: reader.u32(), valueSize: reader.u8() });
  }
  reader.assertEnd();
  return { specId, rowSize, layout };
}

export function decodeStreamData(payload: Uint8Array, layout: StreamLayoutEntry[]): StreamRow[] {
  const reader = new BinaryReader(payload);
  reader.u8();
  const specId = reader.u32();
  const count = reader.u32();
  const rows: StreamRow[] = [];
  for (let rowIndex = 0; rowIndex < count; rowIndex += 1) {
    const timestampUs = reader.u64();
    const values = layout.map((entry) => reader.bytesOf(entry.valueSize || reader.varint()));
    rows.push({ specId, timestampUs, values });
  }
  reader.assertEnd();
  return rows;
}

