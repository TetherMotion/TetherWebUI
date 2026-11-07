/**
 * Live-monitoring helpers for the PLC IDE.
 *
 * Naming contract (runtime/bridge CatalogExporter + fbd-lower):
 *  - program vars            → `plc.<pou>.<var>`        (param, rw)
 *  - retain vars             → `plc.<pou>.retain.<var>` (param, ro)
 *  - located-var shadows     → `plc.<pou>.__io_<var>`   (param)
 *  - io channels             → `plc.image.<I|Q|M>.ch.<name>` (signal)
 *  - probed wires            → `plc.<pou>.__probe_<wireId>` (param, ro)
 *  - task stats              → `plc.<pou>.task.<task>.stats.<field>`
 */
import type { TetherIOClient } from '../client';
import type { CatalogEntry } from '../protocol';
import { encodeScalarArgument } from '../protocol/function-codec';
import type { Block, Pou } from './model';

/** catalog `flags` bit marking a writable entry (views/commissioning). */
const ENTRY_FLAG_WRITABLE = 0x02;

export const entryWritable = (e: CatalogEntry): boolean => (e.flags & ENTRY_FLAG_WRITABLE) !== 0;

/** Catalog keys a probed wire's tap value lives under. */
export function probeKeys(pou: Pou, wireId: number): string[] {
  return [`plc.${pou.name}.__probe_${wireId}`];
}

/** Candidate catalog names for a variable block (first hit wins). */
export function varKeys(pou: Pou, b: Block): string[] {
  const out: string[] = [];
  if (b.name) {
    out.push(`plc.${pou.name}.${b.name}`, `plc.${pou.name}.__io_${b.name}`);
  }
  if (b.at) {
    const m = /^%([IQM])/.exec(b.at);
    if (m && b.name) out.push(`plc.image.${m[1]}.ch.${b.name}`);
  }
  return out;
}

/** First key present in the polled values map, else undefined. */
export function resolveKey(keys: string[], values: Map<string, unknown>): string | undefined {
  return keys.find((k) => values.has(k));
}

/**
 * Encode + write a scalar param value. The entry's schema slot gives
 * the scalar wire type (aliases resolved); non-scalar entries and
 * missing catalogs throw.
 */
export async function writeScalar(
  client: TetherIOClient,
  entry: CatalogEntry,
  value: number,
): Promise<void> {
  const catalog = client.schemaCatalog;
  let node = catalog?.slotToNode[entry.schemaSlot];
  // resolve schema aliases (kind 11) like decodeSchemaValue does
  let depth = 0;
  while (node && node.kind === 11 && node.target && depth++ < 32) {
    node = catalog?.nodesByKey.get(keyString(node.target.key));
  }
  if (!node || (node.kind !== 1 && node.kind !== 4)) {
    throw new Error(`${entry.name}: not a scalar parameter`);
  }
  await client.setParameter(entry.id, encodeScalarArgument(node.scalarType, value));
}

const keyString = (key: Uint8Array): string =>
  [...key].map((b) => b.toString(16).padStart(2, '0')).join('');
