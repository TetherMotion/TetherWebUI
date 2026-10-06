/**
 * @file cache.ts
 * @brief Persistence of the verified V6 schema catalog across reconnects.
 *
 * The catalog is keyed by server URL plus a manifest fingerprint (BLAKE3 of
 * every manifest key+digest+revision). A cache hit is only trusted after the
 * server advertises the identical manifest in ServerHello — stale entries are
 * dropped, never merged.
 */
import { blake3 } from '@noble/hashes/blake3';
import { SchemaCatalogV6, SchemaFieldV6, SchemaManifestEntryV6, SchemaNodeV6, SchemaRefV6 } from './types';
import { computeSchemaDigestV6 } from './handshake';

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** Order-independent fingerprint of a manifest (sorted by key). */
export function manifestFingerprint(manifest: SchemaManifestEntryV6[]): string {
  const entries = manifest
    .map((entry) => ({ key: b64(entry.ref.key), digest: b64(entry.ref.digest), revision: entry.revision }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const encoder = new TextEncoder();
  const bytes = encoder.encode(JSON.stringify(entries));
  return b64(blake3(bytes, { dkLen: 32 }));
}

interface RefJson { key: string; digest: string }

const refToJson = (ref?: SchemaRefV6): RefJson | undefined =>
  ref ? { key: b64(ref.key), digest: b64(ref.digest) } : undefined;
const refFromJson = (json?: RefJson): SchemaRefV6 | undefined =>
  json ? { key: unb64(json.key), digest: unb64(json.digest) } : undefined;

const fieldToJson = (field: SchemaFieldV6) => ({
  key: field.key, flags: field.flags, presence: field.presence,
  schema: refToJson(field.schema)!, name: field.name, description: field.description,
  restrictions: field.restrictions.map((r) => ({ kind: r.kind, payload: b64(r.payload) })),
  defaultValue: b64(field.defaultValue),
});
const fieldFromJson = (json: ReturnType<typeof fieldToJson>): SchemaFieldV6 => ({
  key: json.key, flags: json.flags, presence: json.presence,
  schema: refFromJson(json.schema)!, name: json.name, description: json.description,
  restrictions: json.restrictions.map((r) => ({ kind: r.kind, payload: unb64(r.payload) })),
  defaultValue: unb64(json.defaultValue),
});

const nodeToJson = (node: SchemaNodeV6) => ({
  key: b64(node.key), revision: node.revision, kind: node.kind, flags: node.flags,
  name: node.name, description: node.description,
  annotations: [...node.annotations.entries()],
  scalarType: node.scalarType, maxBytes: node.maxBytes, fixedCount: node.fixedCount,
  minCount: node.minCount, maxCount: node.maxCount, structEncoding: node.structEncoding,
  element: refToJson(node.element), mapKey: refToJson(node.mapKey),
  mapValue: refToJson(node.mapValue), target: refToJson(node.target),
  fields: node.fields.map(fieldToJson),
  oneOfMembers: node.oneOfMembers.map((m) => ({ key: m.key, schema: refToJson(m.schema)! })),
});
const nodeFromJson = (json: ReturnType<typeof nodeToJson>): SchemaNodeV6 => ({
  key: unb64(json.key), revision: json.revision, kind: json.kind, flags: json.flags,
  name: json.name, description: json.description,
  annotations: new Map(json.annotations),
  scalarType: json.scalarType, maxBytes: json.maxBytes, fixedCount: json.fixedCount,
  minCount: json.minCount, maxCount: json.maxCount, structEncoding: json.structEncoding,
  element: refFromJson(json.element), mapKey: refFromJson(json.mapKey),
  mapValue: refFromJson(json.mapValue), target: refFromJson(json.target),
  fields: json.fields.map(fieldFromJson),
  oneOfMembers: json.oneOfMembers.map((m) => ({ key: m.key, schema: refFromJson(m.schema)! })),
});

function storageKey(url: string): string {
  return `tether.io.schema.${url}`;
}

/** Persist a fully verified catalog for later reconnects. */
export function storeCatalog(url: string, catalog: SchemaCatalogV6): void {
  try {
    const payload = {
      epoch: catalog.epoch,
      fingerprint: manifestFingerprint(catalog.manifest),
      manifest: catalog.manifest.map((entry) => ({
        key: b64(entry.ref.key), digest: b64(entry.ref.digest), revision: entry.revision,
      })),
      nodes: [...catalog.nodesByKey.values()].map(nodeToJson),
    };
    localStorage.setItem(storageKey(url), JSON.stringify(payload));
  } catch {
    // Storage quota/private-mode failures must not break the connection.
  }
}

/**
 * Load a cached catalog. Only returns it when `manifest` (from ServerHello)
 * matches the cached fingerprint bit-for-bit and every cached node's digest
 * recomputes cleanly — a cached catalog is never trusted beyond that.
 */
export function loadCatalog(url: string, manifest: SchemaManifestEntryV6[]): SchemaCatalogV6 | undefined {
  try {
    const raw = localStorage.getItem(storageKey(url));
    if (!raw) return undefined;
    const payload = JSON.parse(raw) as {
      fingerprint: string;
      nodes: ReturnType<typeof nodeToJson>[];
    };
    if (payload.fingerprint !== manifestFingerprint(manifest)) return undefined;
    const nodesByKey = new Map<string, SchemaNodeV6>();
    for (const json of payload.nodes) {
      const node = nodeFromJson(json);
      nodesByKey.set(b64(node.key), node);
    }
    // Re-hash manifest roots: a corrupted cache must not survive.
    for (const entry of manifest) {
      const node = nodesByKey.get(b64(entry.ref.key));
      if (!node) return undefined;
      const digest = computeSchemaDigestV6(node);
      if (!digest.every((byte, index) => byte === entry.ref.digest[index])) return undefined;
    }
    const slotToNode = manifest.map((entry) => nodesByKey.get(b64(entry.ref.key)));
    if (slotToNode.some((node) => !node)) return undefined;
    return { epoch: 0, manifest, nodesByKey, slotToNode: slotToNode as SchemaNodeV6[] };
  } catch {
    return undefined;
  }
}

/** The manifest advertised in a previous session's ServerHello, for ClientHello.cachedSchemas. */
export function loadCachedManifest(url: string): SchemaManifestEntryV6[] | undefined {
  try {
    const raw = localStorage.getItem(storageKey(url));
    if (!raw) return undefined;
    const payload = JSON.parse(raw) as {
      manifest: { key: string; digest: string; revision: number }[];
    };
    return payload.manifest.map((entry) => ({
      ref: { key: unb64(entry.key), digest: unb64(entry.digest) },
      revision: entry.revision,
    }));
  } catch {
    return undefined;
  }
}

/** Drop the cached catalog for a URL (schema update or failed verify). */
export function clearCatalog(url: string): void {
  try {
    localStorage.removeItem(storageKey(url));
  } catch {
    // ignore
  }
}
