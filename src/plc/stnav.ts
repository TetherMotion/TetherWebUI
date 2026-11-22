/**
 * ST semantic navigation — symbol index, signature help, go-to-
 * definition, find-usages and rename for the PLC IDE.
 *
 * Scope: project POUs (fbd.v1 + attached .st sources), interface and
 * global vars, FB instance members, and builtin signatures. It is a
 * pragmatic index — not a full language server — but it covers the
 * daily motions: jump to a POU/var declaration, see a call signature,
 * list every use of a symbol, rename safely inside the project.
 */
import { FbdProject, Pou } from './model';
import { parseStInterfaces } from './stiface';
import { BUILTIN_FB_NAMES } from './sigs';

export interface StWorld {
  /** project POUs (fbd.v1) */
  pous: Pou[];
  /** POU name → ST source (attached/library/inline bodies) */
  stSources: Record<string, string>;
  /** synthetic library decls parsed from stSources */
  libPous: Pou[];
  /** catalog-declared FBs (/ws blocks meta-op) — name + signature text */
  catalogSigs?: Record<string, string>;
}

export interface Word {
  from: number;
  to: number;
  text: string;
}

/** identifier under/near `pos` in `src`, or null. */
export function wordAt(src: string, pos: number): Word | null {
  const isId = (c: string | undefined) => !!c && /[A-Za-z0-9_.]/.test(c);
  if (!isId(src[pos])) return null;
  let from = pos;
  while (from > 0 && isId(src[from - 1])) from--;
  let to = pos;
  while (to < src.length && isId(src[to])) to++;
  const text = src.slice(from, to);
  /* member access `inst.member` — return the head identifier */
  const dot = text.lastIndexOf('.');
  if (dot > 0) {
    const head = text.slice(0, dot);
    const sub = text.slice(dot + 1);
    /* cursor inside member part → resolve member of head's FB type */
    return { from: from + dot + 1, to, text: sub, };
  }
  return { from, to, text };
}

/** line/col (1-based) of an offset for display. */
export function lineCol(src: string, off: number): { line: number; col: number } {
  const upto = src.slice(0, off);
  const line = upto.split('\n').length;
  const col = off - upto.lastIndexOf('\n');
  return { line, col };
}

/** strip comments so keyword/decl scans don't hit comment text.
    Length-preserving (comment chars → spaces, newlines kept) so
    reported offsets still index the original source. */
function stripComments(src: string): string {
  return src
    .replace(/\(\*[\s\S]*?\*\)/g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => {
      const i = l.indexOf('//');
      return i >= 0 ? l.slice(0, i) + ' '.repeat(l.length - i) : l;
    })
    .join('\n');
}

/** POU names declared in an ST source (PROGRAM/FUNCTION_BLOCK/FUNCTION). */
export function declaredPous(src: string): { name: string; kind: string; offset: number }[] {
  const out: { name: string; kind: string; offset: number }[] = [];
  const clean = stripComments(src);
  const re = /\b(PROGRAM|FUNCTION_BLOCK|FUNCTION)\s+([A-Za-z_]\w*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    out.push({ name: m[2]!, kind: m[1]!.toLowerCase(), offset: m.index });
  }
  return out;
}

/** VAR_* sections of an ST source → {section, decls:[{names,type,offset}]}. */
export function stVarSections(src: string): {
  section: string;
  decls: { names: string[]; type: string; offset: number }[];
}[] {
  const clean = stripComments(src);
  const out: { section: string; decls: { names: string[]; type: string; offset: number }[] }[] = [];
  const re = /\b(VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|VAR_GLOBAL|VAR_TEMP|VAR_EXTERNAL|VAR)\b([\s\S]*?)\bEND_VAR\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const decls: { names: string[]; type: string; offset: number }[] = [];
    const body = m[2]!;
    const dre = /([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*:\s*([^;:=]+?)\s*(?:[:=]|;)/g;
    let d: RegExpExecArray | null;
    while ((d = dre.exec(body))) {
      decls.push({
        names: d[1]!.split(',').map((s) => s.trim()),
        type: d[2]!.trim(),
        offset: m.index + d.index,
      });
    }
    out.push({ section: m[1]!.toUpperCase(), decls });
  }
  return out;
}

/** Build the navigation world for a project. */
export function stWorld(project: {
  fbd: FbdProject;
  stSources?: Record<string, string>;
}): StWorld {
  const stSources = project.stSources ?? {};
  const srcs = Object.values(stSources);
  const libPous = parseStInterfaces(srcs);
  return { pous: project.fbd.pous, stSources, libPous };
}

export interface SigInfo {
  name: string;
  kind: string;
  /** signature text e.g. `FB_AtcPid(IN SP: REAL; PV: REAL; …) : REAL` */
  sig: string;
}

function ifaceSig(p: Pou): string {
  const ins = p.interface.filter((v) => v.kind === 'var_input' || v.kind === 'var_in_out');
  const outs = p.interface.filter((v) => v.kind === 'var_output' || v.kind === 'var_in_out');
  const fmt = (vs: typeof ins) => vs.map((v) => `${v.name}: ${v.type}`).join('; ');
  const parts: string[] = [];
  if (ins.length) parts.push(`in ${fmt(ins)}`);
  if (outs.length) parts.push(`out ${fmt(outs)}`);
  const ret = p.kind === 'function' && p.ret_ty ? ` : ${p.ret_ty}` : '';
  return `${p.kind === 'function' ? 'fn' : 'fb'} ${parts.join(' | ')}${ret}`.trim();
}

/** All known callable signatures (POUs + lib decls + builtins). */
export function allSignatures(w: StWorld): SigInfo[] {
  const out: SigInfo[] = [];
  for (const p of [...w.pous.filter((x) => !x.id.startsWith('lib:')), ...w.libPous]) {
    out.push({ name: p.name, kind: p.kind, sig: ifaceSig(p) });
  }
  for (const n of BUILTIN_FB_NAMES) out.push({ name: n, kind: 'builtin', sig: 'builtin' });
  return out;
}

/** instance name → its declared FB/FN type within one ST source. */
export function instanceType(src: string, name: string): string | undefined {
  const up = name.toUpperCase();
  for (const sec of stVarSections(src)) {
    for (const d of sec.decls) {
      if (d.names.some((n) => n.toUpperCase() === up)) return d.type;
    }
  }
  return undefined;
}

/** Calltip for the callable whose name ends just before `pos`
    (i.e. cursor is inside/right after `name(`). */
export function signatureAt(
  w: StWorld,
  src: string,
  pos: number,
): { name: string; sig: string; from: number; to: number } | undefined {
  /* find `IDENT (` immediately left of cursor */
  const before = src.slice(0, pos);
  const m = /([A-Za-z_]\w*)\s*\([^()]*$/.exec(before);
  if (!m || m.index === undefined) return undefined;
  let name = m[1]!;
  /* instance call `fb1(` → resolve through its declared type */
  let sig = allSignatures(w).find((s) => s.name.toUpperCase() === name.toUpperCase());
  if (!sig) {
    const t = instanceType(src, name);
    if (t) {
      sig = allSignatures(w).find((s) => s.name.toUpperCase() === t.toUpperCase());
      if (sig) name = sig.name;
    }
  }
  if (!sig) return undefined;
  return { name: sig.name, sig: sig.sig, from: m.index, to: pos };
}

export type DefTarget =
  | { kind: 'pou'; pou: string; offset?: number; source?: string }
  | { kind: 'var'; pou: string; name: string; section: string; offset?: number; source?: string }
  | { kind: 'global'; name: string }
  | { kind: 'member'; pou: string; instance: string; member: string };

/** Resolve the identifier at `pos` in `src` (of POU `pouName`) to a
    definition location, or undefined. */
export function findDefinition(
  w: StWorld,
  pouName: string,
  src: string,
  pos: number,
): DefTarget | undefined {
  const word = wordAt(src, pos);
  if (!word) return undefined;
  const name = word.text;
  const up = name.toUpperCase();

  /* member access inst.member → resolve the instance's FB type */
  if (src[word.from - 1] === '.') {
    const headMatch = /([A-Za-z_]\w*)\s*\.\s*$/.exec(src.slice(0, word.from));
    const inst = headMatch?.[1];
    if (inst) return { kind: 'member', pou: pouName, instance: inst, member: name };
  }

  /* FB/FN instance reference `fb1(...)` or `fb1.x` → its declared type */
  const mySrc0 = w.stSources[pouName];
  if (mySrc0) {
    const t = instanceType(mySrc0, name);
    if (t) {
      const tp = [...w.pous, ...w.libPous].find(
        (p) => p.name.toUpperCase() === t.toUpperCase(),
      );
      if (tp) {
        const srcName = Object.keys(w.stSources).find(
          (k) => k.toUpperCase() === tp.name.toUpperCase(),
        );
        const decl = srcName
          ? declaredPous(w.stSources[srcName]!).find(
              (d) => d.name.toUpperCase() === tp.name.toUpperCase(),
            )
          : undefined;
        return { kind: 'pou', pou: tp.name, offset: decl?.offset, source: srcName };
      }
    }
  }

  /* POU declaration/call? */
  for (const p of [...w.pous, ...w.libPous]) {
    if (p.name.toUpperCase() === up) {
      const srcName = Object.keys(w.stSources).find(
        (k) => k.toUpperCase() === p.name.toUpperCase(),
      );
      const decl = srcName
        ? declaredPous(w.stSources[srcName]!).find((d) => d.name.toUpperCase() === up)
        : undefined;
      return { kind: 'pou', pou: p.name, offset: decl?.offset, source: srcName };
    }
  }
  /* fbd.pous names without ST bodies — still navigable to the POU */
  for (const p of w.pous) {
    if (p.name.toUpperCase() === up) return { kind: 'pou', pou: p.name };
  }

  /* var in the current POU's ST source sections */
  const mySrc = w.stSources[pouName];
  if (mySrc) {
    for (const sec of stVarSections(mySrc)) {
      for (const d of sec.decls) {
        if (d.names.some((n) => n.toUpperCase() === up)) {
          return { kind: 'var', pou: pouName, name, section: sec.section, offset: d.offset, source: pouName };
        }
      }
    }
  }
  /* fbd.v1 interface vars of the current POU */
  const pou = w.pous.find((p) => p.name.toUpperCase() === pouName.toUpperCase());
  if (pou?.interface.some((v) => v.name.toUpperCase() === up)) {
    return { kind: 'var', pou: pouName, name, section: 'interface' };
  }
  /* globals */
  if (w.pous[0] && false) void 0;
  return undefined;
}

export interface Usage {
  /** 'st:<pou>' or 'fbd:<pou>' */
  where: string;
  offset: number;
  line: number;
  col: number;
  text: string;
}

/** Find every textual use of `name` across ST sources (word-boundary,
    comments stripped). FBD references are covered via block
    type_ref/instance/name matching in `findFbdUsages`. */
export function findUsages(w: StWorld, name: string): Usage[] {
  const out: Usage[] = [];
  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
  for (const [pou, src] of Object.entries(w.stSources)) {
    const clean = stripComments(src);
    let m: RegExpExecArray | null;
    while ((m = re.exec(clean))) {
      const { line, col } = lineCol(clean, m.index);
      out.push({ where: `st:${pou}`, offset: m.index, line, col, text: src.slice(m.index, m.index + name.length) });
    }
  }
  return out.sort((a, b) => a.where.localeCompare(b.where) || a.offset - b.offset);
}

/** Rename `old` → `nw` inside one ST source (word-boundary, comments
    preserved untouched). Returns the new source. */
export function renameInSource(src: string, old: string, nw: string): string {
  const re = new RegExp(`\\b${old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
  /* mask comments so we don't rename inside them */
  const parts = src.split(/(\(\*[\s\S]*?\*\)|\/\/[^\n]*)/g);
  return parts
    .map((p, i) => (i % 2 === 1 ? p : p.replace(re, nw)))
    .join('');
}

/** Rename `inst.member` accesses in `src` where `inst` is declared as
    type `pouType` — the unambiguous half of member rename (named-arg
    call sites `f(x := v)` are textually indistinguishable from
    assignments and are left for the compiler to flag). */
export function renameMemberAccesses(
  src: string,
  pouType: string,
  member: string,
  nw: string,
): string {
  const re = /([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)/g;
  return src.replace(re, (whole, inst: string, mem: string, off: number) => {
    if (mem.toUpperCase() !== member.toUpperCase()) return whole;
    if (instanceType(src, inst)?.toUpperCase() !== pouType.toUpperCase()) return whole;
    void off;
    return `${inst}.${nw}`;
  });
}

/** Rename a POU across the whole project: stSources keys + decl lines,
    fbd pous/tasks, and every ST call site. Returns a patch list the
    IDE applies. */
export interface RenameEdit {
  /** 'source:<pou>' → replace stSources[pou]; 'fbd' handled structurally */
  pou?: string;
  source?: string;
  stSources?: Record<string, string>;
  pouRenames?: { old: string; nw: string }[];
}

export function renamePou(
  w: StWorld,
  oldName: string,
  newName: string,
): { stSources: Record<string, string>; pouNames: { old: string; nw: string }[] } {
  const stSources: Record<string, string> = {};
  for (const [k, v] of Object.entries(w.stSources)) {
    const nk = k.toUpperCase() === oldName.toUpperCase() ? newName : k;
    stSources[nk] = renameInSource(v, oldName, newName);
  }
  return { stSources, pouNames: [{ old: oldName, nw: newName }] };
}
