/**
 * Library block catalog — client for the /ws `blocks` and `libsrc`
 * meta-ops (a merged `tplcc blocks --json` over every --libdir, plus
 * embedded ST source for auto-attach).
 *
 * The catalog turns installed libraries (tempctrl, TC2/TC3 compat
 * packs, .tplc packages) into first-class FBD blocks: typed pins for
 * signatures/typechecking, palette groups per library file, and the
 * source file needed to make the project self-contained.
 */
import { FbdProject, IfaceKind, IfaceVar, Pou } from './model';
import type { PaletteGroup, PaletteItem } from './palette';
import type { MetaChannel } from './build';

export interface CatalogPin {
  name: string;
  dir: 'in' | 'out' | 'inout';
  ty: string;
  init?: string;
}

export interface CatalogBlock {
  name: string;
  kind: 'fb' | 'function';
  ret_ty?: string | null;
  file: string;
  pins: CatalogPin[];
}

export interface Catalog {
  pous: number;
  errors: number;
  blocks: CatalogBlock[];
  enums: Record<string, string[]>;
}

export interface CatalogLib {
  name: string;
  dir: string;
  catalog: Catalog;
}

/** basename of a catalog `file` (paths differ between tplcc invocations). */
export function srcBase(file: string): string {
  const i = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  return i >= 0 ? file.slice(i + 1) : file;
}

/** stem of a source file name (`atc_tempctrl.st` → `atc_tempctrl`). */
export function libStem(file: string): string {
  return srcBase(file).replace(/\.(st|ST)$/, '');
}

/** Fetch the merged catalog; [] when the backend has no --libdir. */
export async function fetchCatalog(ch: MetaChannel): Promise<CatalogLib[]> {
  try {
    const d = await ch.meta<{ libs?: CatalogLib[] }>('blocks');
    return Array.isArray(d.libs) ? d.libs : [];
  } catch {
    return [];
  }
}

/** Fetch one library source for auto-attach; undefined on failure. */
export async function fetchLibSrc(
  ch: MetaChannel,
  lib: string,
  file: string,
): Promise<string | undefined> {
  try {
    const d = await ch.meta<{ text?: string }>('libsrc', { lib, file });
    return typeof d.text === 'string' ? d.text : undefined;
  } catch {
    return undefined;
  }
}

const PIN_DIR: Record<CatalogPin['dir'], IfaceKind> = {
  in: 'var_input',
  out: 'var_output',
  inout: 'var_in_out',
};

/**
 * Synthetic POU decls for every catalog block — same shape
 * `parseStInterfaces` produces (`lib:` ids) so `sigs`/`types` resolve
 * catalog blocks exactly like attached sources.
 */
export function catalogPous(libs: CatalogLib[]): Pou[] {
  const out: Pou[] = [];
  const seen = new Set<string>();
  for (const l of libs) {
    for (const b of l.catalog.blocks) {
      const up = b.name.toUpperCase();
      if (seen.has(up)) continue;
      seen.add(up);
      const iface: IfaceVar[] = b.pins.map((p) => ({
        name: p.name,
        kind: PIN_DIR[p.dir],
        type: p.ty,
        ...(p.init !== undefined ? { init: p.init } : {}),
      }));
      out.push({
        id: `lib:${l.name}:${b.name}`,
        name: b.name,
        kind: b.kind === 'function' ? 'function' : 'function_block',
        en_eno: 'off',
        interface: iface,
        networks: [],
        ...(b.kind === 'function' && b.ret_ty ? { ret_ty: b.ret_ty } : {}),
      });
    }
  }
  return out;
}

/**
 * Palette groups — one per (library, source file) so e.g. the TC2 pack
 * splits into Tc2_Math / Tc2_Dmx / … rather than one 200-button dump.
 * Items carry `lib` + `srcFile` so the canvas can request the source
 * for auto-attach on placement.
 */
export function catalogGroups(libs: CatalogLib[]): PaletteGroup[] {
  const byFile = new Map<string, { lib: CatalogLib; file: string; blocks: CatalogBlock[] }>();
  for (const l of libs) {
    for (const b of l.catalog.blocks) {
      const file = srcBase(b.file) || '(unknown)';
      const key = `${l.name}${file}`;
      let g = byFile.get(key);
      if (!g) {
        g = { lib: l, file, blocks: [] };
        byFile.set(key, g);
      }
      g.blocks.push(b);
    }
  }
  const groups: PaletteGroup[] = [];
  for (const g of byFile.values()) {
    const items: PaletteItem[] = g.blocks
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((b) => ({
        kind: (b.kind === 'function' ? 'function' : 'fb') as 'fb' | 'function',
        type: b.name,
        label: b.name,
        hint: `${b.kind === 'function' ? 'FUNCTION' : 'FUNCTION_BLOCK'} ${b.name} — ${g.lib.name}/${g.file}`,
        lib: g.lib.name,
        srcFile: g.file === '(unknown)' ? undefined : g.file,
      }));
    groups.push({
      name: `${g.lib.name} · ${g.file.replace(/\.(st|tplc)$/i, '')}`,
      items,
    });
  }
  return groups.sort((a, b) => a.name.localeCompare(b.name));
}

const FB_REF = /\b(?:FB|F)_[A-Za-z0-9_]+/gi;
const POU_DECL =
  /\b(?:FUNCTION_BLOCK|FUNCTION|PROGRAM|TYPE|STRUCT|VAR_GLOBAL|VAR_EXTERNAL)\s+([A-Za-z_][A-Za-z0-9_]*)/gi;

/**
 * Type names the project references but does not declare itself —
 * every place a library block can sneak in:
 *
 *   - fbd block `type_ref`s (dropped/generated blocks)
 *   - pin/interface/global var types (`PROF : FB_AtcProfile`,
 *     `ARRAY[..] OF FB_X`)
 *   - FB_/F_-prefixed identifiers inside attached ST sources and
 *     inline-ST block bodies (params.CODE declares FB-typed vars)
 *
 * Names the project declares itself (pou names, POU/TYPE decls in
 * stSources) are excluded so a user-defined `FB_Foo` never triggers a
 * same-named library attach. Feed the result through `blockSource` —
 * refs that aren't catalog blocks resolve to undefined.
 */
export function projectLibRefs(
  fbd: FbdProject,
  stSources: Record<string, string>,
): Set<string> {
  const refs = new Set<string>();
  const declared = new Set<string>();
  const addTy = (ty: string | undefined): void => {
    if (!ty) return;
    for (const m of ty.matchAll(FB_REF)) refs.add(m[0].toUpperCase());
  };
  const scanSt = (text: string): void => {
    for (const m of text.matchAll(POU_DECL)) declared.add(m[1]!.toUpperCase());
    for (const m of text.matchAll(FB_REF)) refs.add(m[0].toUpperCase());
  };
  for (const p of fbd.pous) declared.add(p.name.toUpperCase());
  for (const v of fbd.global_vars ?? []) addTy(v.type);
  for (const src of Object.values(stSources)) scanSt(src);
  for (const p of fbd.pous) {
    for (const v of p.interface) addTy(v.type);
    for (const n of p.networks)
      for (const b of n.blocks) {
        if (b.type_ref) refs.add(b.type_ref.toUpperCase());
        for (const pin of b.pins ?? []) addTy(pin.type);
        for (const val of Object.values(b.params ?? {})) scanSt(val);
      }
  }
  for (const d of declared) refs.delete(d);
  return refs;
}

/** Look up which library/file a block name came from (for auto-attach). */
export function blockSource(
  libs: CatalogLib[],
  name: string,
): { lib: string; file: string } | undefined {
  const up = name.toUpperCase();
  for (const l of libs)
    for (const b of l.catalog.blocks)
      if (b.name.toUpperCase() === up && b.file) return { lib: l.name, file: srcBase(b.file) };
  return undefined;
}
