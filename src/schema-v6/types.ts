import type { ValueType } from '../protocol';

export interface SchemaRefV6 {
  key: Uint8Array;
  digest: Uint8Array;
}

export interface SchemaManifestEntryV6 {
  ref: SchemaRefV6;
  revision: number;
}

export interface SchemaFieldV6 {
  key: number;
  flags: number;
  presence: number;
  schema: SchemaRefV6;
  name: string;
  description: string;
  restrictions: { kind: number; payload: Uint8Array }[];
  defaultValue: Uint8Array;
}

export interface SchemaNodeV6 {
  key: Uint8Array;
  revision: number;
  kind: number;
  flags: number;
  name: string;
  description: string;
  annotations: Map<string, string>;
  scalarType: ValueType;
  maxBytes: number;
  fixedCount: number;
  minCount: number;
  maxCount: number;
  structEncoding: number;
  element?: SchemaRefV6;
  mapKey?: SchemaRefV6;
  mapValue?: SchemaRefV6;
  target?: SchemaRefV6;
  fields: SchemaFieldV6[];
  oneOfMembers: { key: number; schema: SchemaRefV6 }[];
}

export interface ServerHelloV6 {
  epoch: number;
  manifest: SchemaManifestEntryV6[];
}

export interface SchemaCatalogV6 {
  epoch: number;
  manifest: SchemaManifestEntryV6[];
  nodesByKey: Map<string, SchemaNodeV6>;
  slotToNode: SchemaNodeV6[];
}
