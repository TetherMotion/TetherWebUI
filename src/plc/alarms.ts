/**
 * Alarm-rule designer model — user-defined alarm conditions compiled
 * into a real `AlarmRules` FBD program built on FB_AtcAlarm.
 *
 * A rule binds a project signal (AT address like `%IX0.0` or a variable
 * name) through a compare operator to a latched alarm. The generated
 * POU exposes `<rule>_ACT` / `<rule>_UNACK` outputs plus shared
 * `ACK`/`SHELVE` inputs and is appended to the project's first task.
 */
import { Block, IfaceVar, Network, Pou, Wire } from './model';

export type AlarmOp = '>' | '>=' | '<' | '<=' | '=' | '<>';

export interface AlarmRule {
  id: number;
  /** display name — also the output-var stem (sanitized) */
  name: string;
  /** AT address (`%IX0.0`, `%QB2.3`) or project variable name */
  signal: string;
  op: AlarmOp;
  /** literal threshold text (e.g. '85.0', 'T#5s') */
  threshold: string;
  /** 0 info, 1 warn, 2 alarm, 3 critical — drives FirstOut ordering */
  priority: number;
  /** optional operator-facing message (kept on the block comment) */
  message?: string;
}

export const ALARM_OPS: { op: AlarmOp; typeRef: string }[] = [
  { op: '>', typeRef: 'GT' }, { op: '>=', typeRef: 'GE' },
  { op: '<', typeRef: 'LT' }, { op: '<=', typeRef: 'LE' },
  { op: '=', typeRef: 'EQ' }, { op: '<>', typeRef: 'NE' },
];

export function defaultRule(id: number): AlarmRule {
  return { id, name: `alarm${id}`, signal: '%IX0.0', op: '>', threshold: '0.0', priority: 2 };
}

const IDENT = /[^A-Za-z0-9_]/g;

/** sanitize a rule name into a valid ST identifier stem. */
export function ruleStem(name: string, id: number): string {
  const s = name.replace(IDENT, '_').replace(/^_+|_+$/g, '');
  const base = s || `alarm${id}`;
  return /^[0-9]/.test(base) ? `a_${base}` : base;
}

function blk(
  id: number, kind: Block['kind'], typeRef: string, x: number, y: number,
  extra: Partial<Block> = {},
): Block {
  return {
    id, kind, type_ref: typeRef,
    pos: { x, y }, params: {}, exec_order: 0, negated: [], comment: '',
    ...extra,
  };
}

function vblk(id: number, x: number, y: number, role: 'in' | 'out', name: string, at?: string): Block {
  return blk(id, 'variable', '', x, y, { role, name, ...(at ? { at } : {}) });
}

/**
 * Build (or rebuild) the `AlarmRules` program POU from the rule list.
 * Returns the POU; caller inserts/replaces it in fbd.pous and ensures
 * a task references it.
 */
export function buildAlarmPou(rules: AlarmRule[]): Pou {
  const sorted = rules.slice().sort((a, b) => b.priority - a.priority || a.id - b.id);
  const iface: IfaceVar[] = [
    { name: 'ACK', kind: 'var_input', type: 'BOOL' },
    { name: 'SHELVE', kind: 'var_input', type: 'BOOL' },
  ];
  for (const r of sorted) {
    const st = ruleStem(r.name, r.id);
    iface.push({ name: `${st}_ACT`, kind: 'var_output', type: 'BOOL' });
    iface.push({ name: `${st}_UNACK`, kind: 'var_output', type: 'BOOL' });
  }

  const blocks: Block[] = [];
  const wires: Wire[] = [];
  let nid = 4, wid = 1;
  const Y0 = 4, DY = 6;

  /* shared ack/shelve/cycletime inputs */
  blocks.push(vblk(1, 1, 2, 'in', 'ack'));
  blocks.push(vblk(2, 1, 4, 'in', 'shelve'));
  blocks.push(vblk(3, 1, 6, 'in', 'cycletime'));

  const almIds: number[] = [];
  sorted.forEach((r, i) => {
    const y = Y0 + i * DY;
    const st = ruleStem(r.name, r.id);
    const sigIsAt = r.signal.trim().startsWith('%');
    const sigId = nid++;
    blocks.push(vblk(sigId, 1, y, 'in', sigIsAt ? `sig${r.id}` : r.signal, sigIsAt ? r.signal : undefined));
    const opId = nid++;
    const tref = ALARM_OPS.find((o) => o.op === r.op)?.typeRef ?? 'GT';
    blocks.push(blk(opId, 'operator', tref, 8, y, {
      params: { IN1: r.threshold },
      comment: r.message ? `${r.name}: ${r.message}` : r.name,
    }));
    const almId = nid++;
    almIds.push(almId);
    blocks.push(blk(almId, 'fb', 'FB_AtcAlarm', 16, y, {
      instance: `alm${r.id}`,
      params: { CycleTime: '0.1', ShelveTime: '0.0' },
      comment: `${r.name} p${r.priority}`,
    }));
    const actId = nid++, unId = nid++;
    blocks.push(vblk(actId, 26, y, 'out', `${st}_act`));
    blocks.push(vblk(unId, 26, y + 2, 'out', `${st}_unack`));

    wires.push({ id: wid++, src: { block: sigId, port: 0 }, dsts: [{ block: opId, port: 'IN0' }] });
    wires.push({ id: wid++, src: { block: opId, port: 0 }, dsts: [{ block: almId, port: 'Cond' }] });
    wires.push({ id: wid++, src: { block: 1, port: 0 }, dsts: [{ block: almId, port: 'Ack' }] });
    wires.push({ id: wid++, src: { block: 2, port: 0 }, dsts: [{ block: almId, port: 'Shelve' }] });
    wires.push({ id: wid++, src: { block: 3, port: 0 }, dsts: [{ block: almId, port: 'CycleTime' }] });
    /* higher-priority actives → HigherPriActive via an OR fold */
    if (i > 0) {
      const orId = nid++;
      blocks.push(blk(orId, 'operator', 'OR', 22, y - 1, {}));
      for (let j = 0; j < i; j++) {
        wires.push({
          id: wid++,
          src: { block: almIds[j]!, port: 'Active' },
          dsts: [{ block: orId, port: `IN${j}` }],
        });
      }
      wires.push({ id: wid++, src: { block: orId, port: 0 }, dsts: [{ block: almId, port: 'HigherPriActive' }] });
    }
    wires.push({ id: wid++, src: { block: almId, port: 'Active' }, dsts: [{ block: actId, port: 0 }] });
    wires.push({ id: wid++, src: { block: almId, port: 'Unacked' }, dsts: [{ block: unId, port: 0 }] });
  });

  const net: Network = {
    id: 'n1', kind: 'fbd', label: 'alarm rules',
    comments: [], assocs: [], labels: [], jumps: [], returns: [],
    blocks, wires,
  };
  return {
    id: 'p_alarms', name: 'AlarmRules', kind: 'program', en_eno: 'inherit',
    interface: iface, networks: [net],
  };
}
