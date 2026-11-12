/**
 * FBD type system — TypeScript mirror of `tplc-mir::ty` + `fbd-lower::ty`.
 *
 * The canvas typechecks every network as you edit: pin types are derived
 * from the POU interface / FB signatures / operator rules, propagated
 * through wires, and compared with the same coercion matrix the compiler
 * uses (`compatible` / `convertible` / `narrows`). A mismatch the
 * compiler would reject is an error; a narrowing is a warning.
 */
import { Block, IfaceVar, Network, Pou } from './model';
import { opKind, opIns, blockSig, builtinFbSig } from './sigs';

export type Ty =
  | { k: 'bool' }
  | { k: 'int'; signed: boolean; bits: number }
  | { k: 'real'; bits: number }
  | { k: 'time' }
  | { k: 'str'; cap: number; w: boolean }
  | { k: 'enum'; name: string }
  | { k: 'array'; elem: Ty; lo: number; hi: number }
  | { k: 'fb'; name: string }
  /** generic operand (ANY_*) — no check possible until resolved */
  | { k: 'any' }
  /** unresolved / undeclared */
  | { k: 'unknown' };

export const BOOL: Ty = { k: 'bool' };
export const TIME: Ty = { k: 'time' };
export const ANY: Ty = { k: 'any' };
export const UNKNOWN: Ty = { k: 'unknown' };
export const INT = (bits = 16, signed = true): Ty => ({ k: 'int', signed, bits });
export const REAL = (bits = 32): Ty => ({ k: 'real', bits });

/** IEC elementary type names → Ty (mirrors fbd-lower::ty::parse_type). */
const SCALARS: Record<string, Ty> = {
  BOOL: BOOL,
  SINT: INT(8, true),
  INT: INT(16, true),
  DINT: INT(32, true),
  LINT: INT(64, true),
  USINT: INT(8, false),
  UINT: INT(16, false),
  UDINT: INT(32, false),
  ULINT: INT(64, false),
  BYTE: INT(8, false),
  WORD: INT(16, false),
  DWORD: INT(32, false),
  LWORD: INT(64, false),
  REAL: REAL(32),
  LREAL: REAL(64),
  TIME: TIME,
  DATE: TIME,
  TOD: TIME,
  DT: TIME,
  LTIME: TIME,
};

/** Parse an IEC type expression (`ARRAY[1..8] OF REAL`, `STRING(80)`, …). */
export function parseTy(expr: string | undefined, pous: Pou[]): Ty {
  if (!expr) return UNKNOWN;
  const t = expr.trim();
  const up = t.toUpperCase();
  if (up.startsWith('ARRAY')) {
    const m = /^ARRAY\s*\[\s*(-?\d+)\s*\.\.\s*(-?\d+)\s*\]\s*OF\s+(.+)$/i.exec(t);
    if (!m) return UNKNOWN;
    return { k: 'array', lo: Number(m[1]), hi: Number(m[2]), elem: parseTy(m[3], pous) };
  }
  const s = /^(W?STRING)(?:\s*\(\s*(\d+)\s*\))?$/i.exec(t);
  if (s) return { k: 'str', cap: Number(s[2] ?? 80), w: s[1]!.toUpperCase().startsWith('W') };
  if (SCALARS[up]) return SCALARS[up]!;
  // user-declared POU → FB type; otherwise nominal (struct/enum) unknown
  if (pous.some((p) => p.name.toUpperCase() === up)) return { k: 'fb', name: up };
  return UNKNOWN;
}

export function tyName(t: Ty): string {
  switch (t.k) {
    case 'bool':
      return 'BOOL';
    case 'int': {
      const base = ({ 8: 'SINT', 16: 'INT', 32: 'DINT', 64: 'LINT' } as Record<number, string>)[
        t.bits
      ];
      return t.signed ? (base ?? 'DINT') : `U${base ?? 'DINT'}`;
    }
    case 'real':
      return t.bits === 64 ? 'LREAL' : 'REAL';
    case 'time':
      return 'TIME';
    case 'str':
      return `${t.w ? 'W' : ''}STRING`;
    case 'enum':
      return t.name;
    case 'array':
      return `ARRAY[${t.lo}..${t.hi}] OF ${tyName(t.elem)}`;
    case 'fb':
      return t.name;
    case 'any':
      return 'ANY';
    case 'unknown':
      return '?';
  }
}

export const isNum = (t: Ty): boolean => t.k === 'int' || t.k === 'real';

/** tplc-mir::ty::compatible — exact or enum→int. */
export function compatible(a: Ty, b: Ty): boolean {
  if (a.k === b.k) {
    if (a.k === 'int' && b.k === 'int') return a.signed === b.signed && a.bits === b.bits;
    if (a.k === 'real' && b.k === 'real') return a.bits === b.bits;
    if (a.k === 'fb' && b.k === 'fb') return a.name === b.name;
    if (a.k === 'array' && b.k === 'array')
      return a.lo === b.lo && a.hi === b.hi && compatible(a.elem, b.elem);
    if (a.k === 'str' && b.k === 'str') return a.w === b.w && a.cap === b.cap;
    if (a.k === 'enum' && b.k === 'enum') return a.name === b.name;
    return true;
  }
  return a.k === 'enum' && b.k === 'int';
}

/** tplc-mir::ty::convertible. */
export function convertible(a: Ty, b: Ty): boolean {
  if (a.k === 'any' || b.k === 'any' || a.k === 'unknown' || b.k === 'unknown') return true;
  if (compatible(a, b)) return true;
  const num = (t: Ty) => t.k === 'int' || t.k === 'real';
  if (num(a) && num(b)) return true;
  if (a.k === 'int' && b.k === 'bool') return true;
  if (a.k === 'bool' && b.k === 'int') return true;
  if ((a.k === 'int' || a.k === 'time') && b.k === 'time') return true;
  if (a.k === 'time' && b.k === 'int') return true;
  if ((a.k === 'enum' && b.k === 'int') || (a.k === 'int' && b.k === 'enum')) return true;
  if (a.k === 'str' && b.k === 'str') return a.w === b.w;
  return false;
}

/** tplc-mir::ty::narrows — assignment loses precision. */
export function narrows(a: Ty, b: Ty): boolean {
  if (a.k === 'int' && b.k === 'int') return b.bits < a.bits;
  if (a.k === 'real' && b.k === 'real') return b.bits < a.bits;
  if (a.k === 'real' && b.k === 'int') return true;
  if ((a.k === 'int' || a.k === 'time') && b.k === 'bool') return true;
  if (a.k === 'time' && b.k === 'int') return b.bits < 64;
  return false;
}

/** tplc-mir::ty::unify_num — numeric result of a binary op. */
export function unifyNum(a: Ty, b: Ty): Ty {
  if (a.k === 'any' || b.k === 'any' || a.k === 'unknown' || b.k === 'unknown') return UNKNOWN;
  if (a.k === 'real' || b.k === 'real') {
    return REAL(a.k === 'real' && a.bits === 64 ? 64 : b.k === 'real' && b.bits === 64 ? 64 : 32);
  }
  if (a.k === 'time' || b.k === 'time') return TIME;
  if (a.k === 'int' && b.k === 'int') {
    return INT(Math.max(a.bits, b.bits), a.signed && b.signed);
  }
  if (a.k === b.k) return a;
  return INT(32, true);
}

export type Level = 'exact' | 'ok' | 'narrow' | 'bad';

/** Assignment compatibility of `src` into a `dst` pin. */
export function coerce(src: Ty, dst: Ty): Level {
  if (dst.k === 'any' || src.k === 'any' || src.k === 'unknown' || dst.k === 'unknown') return 'ok';
  if (compatible(src, dst)) return 'exact';
  if (!convertible(src, dst)) return 'bad';
  return narrows(src, dst) ? 'narrow' : 'ok';
}

/* ---------------- block pin types ---------------- */

/** Type of an interface var, including %location fallbacks. */
function ifaceTy(pou: Pou, name: string, pous: Pou[]): Ty {
  const v = pou.interface.find((x) => x.name.toUpperCase() === name.toUpperCase());
  if (v) return parseTy(v.type, pous);
  return UNKNOWN;
}

/** `%IX` bit → BOOL, `%IW` → INT, `%ID` → DINT, `%IL` → LINT. */
export function atTy(at: string | undefined): Ty {
  if (!at) return UNKNOWN;
  const m = /^%[IQM]([XBWDL])/i.exec(at);
  if (!m) return UNKNOWN;
  switch (m[1]!.toUpperCase()) {
    case 'X':
      return BOOL;
    case 'B':
      return INT(8, false);
    case 'W':
      return INT(16, true);
    case 'D':
      return INT(32, true);
    case 'L':
      return INT(64, true);
    default:
      return UNKNOWN;
  }
}

/** Builtin FB pin types (mirrors fbd-lower::resolve::builtin_sig). */
const BUILTIN_TYS: Record<string, { ins: [string, Ty][]; outs: [string, Ty][] }> = {
  TON: {
    ins: [
      ['IN', BOOL],
      ['PT', TIME],
    ],
    outs: [
      ['Q', BOOL],
      ['ET', TIME],
    ],
  },
  TOF: {
    ins: [
      ['IN', BOOL],
      ['PT', TIME],
    ],
    outs: [
      ['Q', BOOL],
      ['ET', TIME],
    ],
  },
  TP: {
    ins: [
      ['IN', BOOL],
      ['PT', TIME],
    ],
    outs: [
      ['Q', BOOL],
      ['ET', TIME],
    ],
  },
  R_TRIG: { ins: [['CLK', BOOL]], outs: [['Q', BOOL]] },
  F_TRIG: { ins: [['CLK', BOOL]], outs: [['Q', BOOL]] },
  CTU: {
    ins: [
      ['CU', BOOL],
      ['R', BOOL],
      ['PV', INT(32)],
    ],
    outs: [
      ['QU', BOOL],
      ['CV', INT(32)],
    ],
  },
  CTD: {
    ins: [
      ['CD', BOOL],
      ['LD', BOOL],
      ['PV', INT(32)],
    ],
    outs: [
      ['QD', BOOL],
      ['CV', INT(32)],
    ],
  },
  CTUD: {
    ins: [
      ['CU', BOOL],
      ['CD', BOOL],
      ['R', BOOL],
      ['LD', BOOL],
      ['PV', INT(32)],
    ],
    outs: [
      ['QU', BOOL],
      ['QD', BOOL],
      ['CV', INT(32)],
    ],
  },
  SR: {
    ins: [
      ['S1', BOOL],
      ['R', BOOL],
    ],
    outs: [['Q1', BOOL]],
  },
  RS: {
    ins: [
      ['S', BOOL],
      ['R1', BOOL],
    ],
    outs: [['Q1', BOOL]],
  },
};

/** Pin types of a block from its declaration (operators resolved later). */
export function declaredPins(b: Block, pou: Pou, pous: Pou[]): { ins: Ty[]; outs: Ty[] } {
  const sig = blockSig(b, pous);
  switch (b.kind) {
    case 'variable': {
      const t = b.name ? ifaceTy(pou, b.name, pous) : atTy(b.at);
      const ty = t.k !== 'unknown' ? t : atTy(b.at);
      return b.role === 'in' ? { ins: [], outs: [ty] } : { ins: [ty], outs: [] };
    }
    case 'fb':
    case 'function': {
      const builtin = BUILTIN_TYS[b.type_ref.toUpperCase()];
      if (builtin) {
        return {
          ins: sig.ins.map((n) => builtin.ins.find(([pn]) => pn === n)?.[1] ?? UNKNOWN),
          outs: sig.outs.map((n) => builtin.outs.find(([pn]) => pn === n)?.[1] ?? UNKNOWN),
        };
      }
      const decl = pous.find((p) => p.name.toUpperCase() === b.type_ref.toUpperCase());
      if (!decl) return { ins: sig.ins.map(() => UNKNOWN), outs: sig.outs.map(() => UNKNOWN) };
      const by = (n: string): Ty => {
        if (decl.kind === 'function' && n.toUpperCase() === decl.name.toUpperCase())
          return parseTy(decl.ret_ty, pous);
        return ifaceTy(decl, n, pous);
      };
      return { ins: sig.ins.map(by), outs: sig.outs.map(by) };
    }
    case 'st':
    case 'device': {
      const pins = b.pins ?? [];
      const by = (n: string) => {
        const p = pins.find((x) => x.name === n);
        return p ? parseTy(p.type, pous) : UNKNOWN;
      };
      return { ins: sig.ins.map(by), outs: sig.outs.map(by) };
    }
    case 'operator':
      // shaped by the operands — resolved during inference
      return { ins: sig.ins.map(() => ANY), outs: sig.outs.map(() => ANY) };
    default:
      return { ins: sig.ins.map(() => UNKNOWN), outs: sig.outs.map(() => UNKNOWN) };
  }
}

/** Operator result type from its resolved input types. */
export function opResultTy(typeRef: string, ins: Ty[]): Ty {
  const op = opKind(typeRef);
  if (!op) return UNKNOWN;
  // unresolved (ANY) operands don't constrain the result — only
  // genuinely unknown types poison it
  const known = ins.filter((t) => t.k !== 'unknown' && t.k !== 'any');
  const all = (f: (t: Ty) => boolean) => known.length > 0 && known.every(f);
  switch (op.kind) {
    case 'fold':
      if (all((t) => t.k === 'bool')) return BOOL;
      return known.reduce<Ty>((acc, t) => (acc.k === 'unknown' ? t : unifyNum(acc, t)), UNKNOWN);
    case 'bin': {
      const t = typeRef.toUpperCase();
      if (['GT', 'GE', 'LT', 'LE', 'EQ', 'NE'].includes(t)) return BOOL;
      if (['SHL', 'SHR', 'ROL', 'ROR'].includes(t)) return known[0] ?? UNKNOWN;
      return known.length >= 2 ? unifyNum(known[0]!, known[1]!) : (known[0] ?? UNKNOWN);
    }
    case 'not':
      return known[0] ?? UNKNOWN;
    case 'move':
    case 'abs':
      return known[0] ?? UNKNOWN;
    case 'sel':
    case 'minmax':
    case 'limit': {
      const vals = op.kind === 'sel' ? known.slice(1) : known;
      return vals.reduce<Ty>((acc, t) => (acc.k === 'unknown' ? t : unifyNum(acc, t)), UNKNOWN);
    }
    case 'mux': {
      const vals = known.slice(1);
      return vals.reduce<Ty>((acc, t) => (acc.k === 'unknown' ? t : unifyNum(acc, t)), UNKNOWN);
    }
    case 'cast': {
      const to = typeRef.toUpperCase().split('_TO_')[1] ?? '';
      return SCALARS[to] ?? UNKNOWN;
    }
  }
}

/** Expected type of an operator input pin (for checks). */
export function opInputTy(typeRef: string, index: number, ins: Ty[]): Ty {
  const op = opKind(typeRef);
  if (!op) return ANY;
  const t = typeRef.toUpperCase();
  switch (op.kind) {
    case 'sel':
      return index === 0 ? BOOL : ANY;
    case 'mux':
      return index === 0 ? INT(32, true) : ANY;
    case 'cast':
      return parseTy(t.split('_TO_')[0], []);
    case 'bin':
      if (['SHL', 'SHR', 'ROL', 'ROR'].includes(t)) return index === 1 ? INT(32, true) : ANY;
      if (['GT', 'GE', 'LT', 'LE', 'EQ', 'NE'].includes(t)) return ins[0] ?? ANY;
      return ANY;
    default:
      return ANY;
  }
}

/* ---------------- network inference ---------------- */

export interface TypeIssue {
  severity: 'error' | 'warning';
  message: string;
  block?: number;
  pin?: string;
}

export interface Inference {
  /** `${blockId}:in:${i}` / `${blockId}:out:${i}` → type */
  pin: Map<string, Ty>;
  issues: TypeIssue[];
}

const key = (b: number, dir: 'in' | 'out', i: number) => `${b}:${dir}:${i}`;

/**
 * Propagate types across a network: declarations seed the pins, wires
 * carry source types to destinations, operators derive their outputs
 * from their operands (fixpoint over a few passes).
 */
export function inferNetwork(net: Network, pou: Pou, pous: Pou[]): Inference {
  const pin = new Map<string, Ty>();
  const issues: TypeIssue[] = [];
  const byId = new Map(net.blocks.map((b) => [b.id, b]));

  for (const b of net.blocks) {
    const d = declaredPins(b, pou, pous);
    d.ins.forEach((t, i) => pin.set(key(b.id, 'in', i), t));
    d.outs.forEach((t, i) => pin.set(key(b.id, 'out', i), t));
  }

  // destination type per (block, in-index) from wires
  const wireTys: { srcTy: Ty; dst: { block: number; port: number | string }; wire: number }[] = [];
  const dstIndex = (b: Block, port: number | string): number => {
    const sig = blockSig(b, pous);
    if (typeof port === 'number') return port;
    const i = sig.ins.findIndex((n) => n.toUpperCase() === String(port).toUpperCase());
    return i >= 0 ? i : 0;
  };

  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const b of net.blocks) {
      if (b.kind !== 'operator') continue;
      const sig = blockSig(b, pous);
      // operand types arrive on wires into this block
      const ins: Ty[] = sig.ins.map((_, i) => pin.get(key(b.id, 'in', i)) ?? ANY);
      const out = opResultTy(b.type_ref, ins);
      const cur = pin.get(key(b.id, 'out', 0));
      if (out.k !== 'unknown' && (!cur || cur.k === 'any' || cur.k === 'unknown')) {
        pin.set(key(b.id, 'out', 0), out);
        changed = true;
      }
      // resolve pin types for the operands that have a fixed expectation
      ins.forEach((t, i) => {
        const exp = opInputTy(b.type_ref, i, ins);
        if (exp.k !== 'any' && exp.k !== 'unknown' && (t.k === 'any' || t.k === 'unknown')) {
          pin.set(key(b.id, 'in', i), exp);
          changed = true;
        }
      });
    }
    // wires: source type → destination pin
    for (const w of net.wires) {
      const src = byId.get(w.src.block);
      if (!src) continue;
      const sig = blockSig(src, pous);
      const srcIdx =
        typeof w.src.port === 'number'
          ? w.src.port
          : Math.max(
              0,
              sig.outs.findIndex((n) => n.toUpperCase() === String(w.src.port).toUpperCase()),
            );
      const srcTy = pin.get(key(src.id, 'out', srcIdx)) ?? UNKNOWN;
      for (const d of w.dsts) {
        const db = byId.get(d.block);
        if (!db) continue;
        const di = dstIndex(db, d.port);
        const cur = pin.get(key(db.id, 'in', di));
        if (srcTy.k !== 'unknown' && (!cur || cur.k === 'any' || cur.k === 'unknown')) {
          pin.set(key(db.id, 'in', di), srcTy);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  // checks
  for (const w of net.wires) {
    const src = byId.get(w.src.block);
    if (!src) continue;
    const sig = blockSig(src, pous);
    const srcIdx =
      typeof w.src.port === 'number'
        ? w.src.port
        : Math.max(
            0,
            sig.outs.findIndex((n) => n.toUpperCase() === String(w.src.port).toUpperCase()),
          );
    const srcTy = pin.get(key(src.id, 'out', srcIdx)) ?? UNKNOWN;
    if (srcTy.k === 'unknown') continue;
    for (const d of w.dsts) {
      const db = byId.get(d.block);
      if (!db) continue;
      const di = dstIndex(db, d.port);
      const dstSig = blockSig(db, pous);
      const dstTy = pin.get(key(db.id, 'in', di)) ?? ANY;
      const lvl = coerce(srcTy, dstTy);
      if (lvl === 'bad') {
        issues.push({
          severity: 'error',
          message: `type mismatch: ${tyName(srcTy)} → ${dstTy.k === 'any' ? '?' : tyName(dstTy)} at ${db.type_ref || db.kind}.${dstSig.ins[di] ?? di}`,
          block: db.id,
          pin: dstSig.ins[di],
        });
      } else if (lvl === 'narrow') {
        issues.push({
          severity: 'warning',
          message: `narrowing: ${tyName(srcTy)} → ${tyName(dstTy)} at ${db.type_ref || db.kind}.${dstSig.ins[di] ?? di}`,
          block: db.id,
          pin: dstSig.ins[di],
        });
      }
    }
  }

  // operator operand class checks (BOOL-only / numeric-only / int-only)
  for (const b of net.blocks) {
    if (b.kind !== 'operator') continue;
    const sig = blockSig(b, pous);
    const ins = sig.ins.map((_, i) => pin.get(key(b.id, 'in', i)) ?? ANY);
    const t = b.type_ref.toUpperCase();
    const known = ins.filter((x) => x.k !== 'unknown' && x.k !== 'any');
    if (!known.length) continue;
    const isBoolOnly = ['AND', 'OR', 'XOR', 'NOT'].includes(t);
    const isNumOnly = ['ADD', 'SUB', 'MUL', 'DIV', 'MOD', 'MIN', 'MAX', 'LIMIT', 'ABS'].includes(t);
    const isIntOnly = ['SHL', 'SHR', 'ROL', 'ROR', 'MUX'].includes(t);
    if (isBoolOnly && !known.every((x) => x.k === 'bool' || x.k === 'int')) {
      issues.push({
        severity: 'error',
        message: `${t}: operands must be BOOL (or bit string)`,
        block: b.id,
      });
    }
    if (isNumOnly && !known.every(isNum)) {
      issues.push({ severity: 'error', message: `${t}: operands must be numeric`, block: b.id });
    }
    if (isIntOnly && !known.every((x) => x.k === 'int')) {
      issues.push({ severity: 'error', message: `${t}: operands must be integers`, block: b.id });
    }
  }

  return { pin, issues };
}

/** Type of an interface var for display (helper for panels). */
export function ifaceVarTy(v: IfaceVar, pous: Pou[]): Ty {
  return parseTy(v.type, pous);
}

/** True when a block type is a builtin FB (used for palette grouping). */
export const isBuiltinFb = (name: string): boolean => !!builtinFbSig(name);

/** All operator input names for a given arity (re-export for panels). */
export const operatorIns = opIns;
