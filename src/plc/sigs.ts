/**
 * Block pin signatures — TypeScript mirror of fbd-lower/src/resolve.rs.
 * Determines the pin layout the canvas draws and which in-pins are
 * required (FBD002) vs supplied by params.
 */
import { Block, BlockKind, Pou } from './model';

export interface PinSig {
  ins: string[];
  outs: string[];
}

export type Op =
  | { kind: 'fold' }
  | { kind: 'bin' }
  | { kind: 'not' }
  | { kind: 'move' }
  | { kind: 'sel' }
  | { kind: 'minmax' }
  | { kind: 'limit' }
  | { kind: 'abs' }
  | { kind: 'mux' }
  | { kind: 'cast' };

const FOLD_OPS = new Set(['AND', 'OR', 'XOR', 'ADD', 'MUL']);
const BIN_OPS = new Set([
  'SUB',
  'DIV',
  'MOD',
  'GT',
  'GE',
  'LT',
  'LE',
  'EQ',
  'NE',
  'SHL',
  'SHR',
  'ROL',
  'ROR',
]);

export function opKind(typeRef: string): Op | undefined {
  const t = typeRef.toUpperCase();
  if (FOLD_OPS.has(t)) return { kind: 'fold' };
  if (BIN_OPS.has(t)) return { kind: 'bin' };
  if (t === 'NOT') return { kind: 'not' };
  if (t === 'MOVE') return { kind: 'move' };
  if (t === 'SEL') return { kind: 'sel' };
  if (t === 'MIN' || t === 'MAX') return { kind: 'minmax' };
  if (t === 'LIMIT') return { kind: 'limit' };
  if (t === 'ABS') return { kind: 'abs' };
  if (t === 'MUX') return { kind: 'mux' };
  if (t.includes('_TO_')) return { kind: 'cast' };
  return undefined;
}

/** Input pin names for an operator with `n` visible pins. */
export function opIns(typeRef: string, n: number): string[] {
  const op = opKind(typeRef);
  if (!op) return [];
  switch (op.kind) {
    case 'sel':
      return ['G', 'IN0', 'IN1'];
    case 'limit':
      return ['MN', 'IN', 'MX'];
    case 'mux':
      return ['K', ...Array.from({ length: Math.max(1, n - 1) }, (_, i) => `IN${i}`)];
    case 'not':
    case 'move':
    case 'abs':
    case 'cast':
      return ['IN'];
    case 'bin':
      return ['IN0', 'IN1'];
    case 'fold':
    case 'minmax':
      return Array.from({ length: Math.max(2, n) }, (_, i) => `IN${i}`);
  }
}

/** Named in-pin → operand index (mirrors op_in_index in resolve.rs). */
export function opInIndex(typeRef: string, name: string): number | undefined {
  const op = opKind(typeRef);
  if (!op) return undefined;
  const n = name.toUpperCase();
  switch (op.kind) {
    case 'sel':
      return { G: 0, IN0: 1, IN1: 2 }[n];
    case 'limit':
      return { MN: 0, IN: 1, MX: 2 }[n];
    case 'mux':
      if (n === 'K') return 0;
      if (n.startsWith('IN')) {
        const i = Number(n.slice(2));
        return Number.isInteger(i) ? i + 1 : undefined;
      }
      return undefined;
    case 'not':
    case 'move':
    case 'abs':
    case 'cast':
      return n === 'IN' || n === 'IN0' ? 0 : undefined;
    default:
      if (!n.startsWith('IN')) return undefined;
      const i = Number(n.slice(2));
      return Number.isInteger(i) ? i : undefined;
  }
}

const BUILTIN_FB: Record<string, PinSig> = {
  TON: { ins: ['IN', 'PT'], outs: ['Q', 'ET'] },
  TOF: { ins: ['IN', 'PT'], outs: ['Q', 'ET'] },
  TP: { ins: ['IN', 'PT'], outs: ['Q', 'ET'] },
  R_TRIG: { ins: ['CLK'], outs: ['Q'] },
  F_TRIG: { ins: ['CLK'], outs: ['Q'] },
  CTU: { ins: ['CU', 'R', 'PV'], outs: ['QU', 'CV'] },
  CTD: { ins: ['CD', 'LD', 'PV'], outs: ['QD', 'CV'] },
  CTUD: { ins: ['CU', 'CD', 'R', 'LD', 'PV'], outs: ['QU', 'QD', 'CV'] },
  SR: { ins: ['S1', 'R'], outs: ['Q1'] },
  RS: { ins: ['S', 'R1'], outs: ['Q1'] },
};

export const BUILTIN_FB_NAMES = Object.keys(BUILTIN_FB);

export function builtinFbSig(name: string): PinSig | undefined {
  return BUILTIN_FB[name.toUpperCase()];
}

/** User-declared FB/FUNCTION signature from its interface (pou_sig). */
export function pouSig(pou: Pou): PinSig {
  const sig: PinSig = { ins: [], outs: [] };
  for (const v of pou.interface) {
    if (v.kind === 'var_input' || v.kind === 'var_in_out') sig.ins.push(v.name);
    else if (v.kind === 'var_output') sig.outs.push(v.name);
  }
  if (pou.kind === 'function') sig.outs.unshift(pou.name);
  return sig;
}

/**
 * Visible pin list for a block. `extraIns` extends variadic operator
 * pin lists (max(wired max index, params max index, 2)).
 */
export function blockSig(b: Block, pous: Pou[]): PinSig {
  switch (b.kind) {
    case 'variable':
      if (b.role === 'in') return { ins: [], outs: [''] };
      return { ins: [''], outs: [] };
    case 'operator': {
      const op = opKind(b.type_ref);
      if (!op) return { ins: [], outs: [''] };
      const ins = opIns(b.type_ref, maxInArity(b));
      return { ins, outs: [''] };
    }
    case 'fb':
      return builtinFbSig(b.type_ref) ?? pouSigFor(b.type_ref, pous) ?? { ins: [], outs: [''] };
    case 'function':
      return pouSigFor(b.type_ref, pous) ?? { ins: [], outs: [''] };
    case 'jump_target':
      return { ins: [], outs: [] };
  }
}

function pouSigFor(typeRef: string, pous: Pou[]): PinSig | undefined {
  const pou = pous.find((p) => p.name === typeRef);
  return pou ? pouSig(pou) : undefined;
}

/** Highest visible in-pin count for a variadic operator. */
function maxInArity(b: Block): number {
  let n = 2;
  const op = opKind(b.type_ref);
  if (op?.kind === 'mux') n = 3;
  return n;
}

/** Fixed arity when the op is not variadic, else minimum 2. */
export function opRequiredIns(typeRef: string): number {
  const op = opKind(typeRef);
  if (!op) return 0;
  switch (op.kind) {
    case 'not':
    case 'move':
    case 'abs':
    case 'cast':
      return 1;
    case 'bin':
      return 2;
    case 'sel':
    case 'limit':
      return 3;
    case 'mux':
      return 3; // K + at least two INs is not enforced; require K+IN0+IN1
    default:
      return 2;
  }
}

/** Resolve an input PortSel to a positional index (mirrors in_index). */
export function inIndex(b: Block, sel: number | string, pous: Pou[]): number {
  if (typeof sel === 'number') return sel;
  const name = sel.toUpperCase();
  if (name === 'EN') return -1; // EN pin (sentinel)
  if (b.kind === 'operator') return opInIndex(b.type_ref, name) ?? -1;
  if (b.kind === 'variable') return 0;
  const sig = blockSig(b, pous);
  const i = sig.ins.findIndex((p) => p.toUpperCase() === name);
  return i >= 0 ? i : -1;
}

/** Resolve an output PortSel to a positional index (src_expr side). */
export function outIndex(b: Block, sel: number | string, pous: Pou[]): number {
  if (typeof sel === 'number') return sel;
  const sig = blockSig(b, pous);
  const i = sig.outs.findIndex((p) => p.toUpperCase() === sel.toUpperCase());
  return i >= 0 ? i : -1;
}
