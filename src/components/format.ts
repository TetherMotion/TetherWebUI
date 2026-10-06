/** Shared presentation helpers for catalog components. */
import type { CatalogEntry } from '../protocol';

export function schemaTypeName(
  entry: Pick<CatalogEntry, 'schemaEpoch' | 'schemaSlot' | 'metadata'>,
): string {
  const base = `schema ${entry.schemaEpoch.toString()}/${entry.schemaSlot}`;
  return entry.metadata?.unit ? `${base} · ${entry.metadata.unit}` : base;
}
