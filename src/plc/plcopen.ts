/**
 * PLCopen TC6 XML <-> fbd.v1 exchange, browser side. Port of
 * compiler/plcopen-io: DOM-walked import (tolerant of foreign
 * dialects) and a Roundtrip-mode export (TC6 + `tether:` extensions
 * so our own files reimport losslessly).
 */
import {
  Block,
  Comment,
  FbdProject,
  IfaceKind,
  IfaceVar,
  Jump,
  Label,
  Network,
  PortRef,
  PortSel,
  Pou,
  PouKind,
  VarRole,
  Wire,
  FBD_SCHEMA,
} from './model';

const OPERATORS = new Set([
  'AND',
  'OR',
  'XOR',
  'ADD',
  'MUL',
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
  'NOT',
  'MOVE',
  'SEL',
  'MIN',
  'MAX',
  'LIMIT',
  'ABS',
  'MUX',
]);

const TETHER_NS = 'http://tether.dev/plc/tc6ext';

export interface PlcopenImport {
  project: FbdProject;
  notes: string[];
}

interface Conn {
  src: PortRef;
  dst: PortRef;
  probe: boolean;
  wireId?: number;
  negated: boolean;
  /** connector localId → name map scoped to this conn's FBD body —
   *  Beremiz localIds are only unique within one body. */
  bodyConns: Map<number, string>;
}

const local = (e: Element): string => e.localName;
const attr = (e: Element | undefined, n: string): string | undefined =>
  e?.getAttribute(n) ?? undefined;
const tetherAttr = (e: Element, n: string): string | undefined =>
  e.getAttributeNS(TETHER_NS, n) ?? e.getAttribute(`tether:${n}`) ?? undefined;
const num = (s: string | undefined, d = 0): number => {
  const v = Number(s);
  return Number.isFinite(v) ? v : d;
};
const children = (e: Element): Element[] => [...e.children];
const child = (e: Element, name: string): Element | undefined =>
  children(e).find((c) => local(c) === name);
const descendant = (e: Element, name: string): Element | undefined => descendants(e, name)[0];
/** localName-matched descendant walk — namespace-agnostic. */
function descendants(e: Element, name: string): Element[] {
  const out: Element[] = [];
  const walk = (el: Element): void => {
    for (const c of children(el)) {
      if (local(c) === name) out.push(c);
      walk(c);
    }
  };
  walk(e);
  return out;
}

function posOf(e: Element): { x: number; y: number } {
  const p = child(e, 'position');
  return { x: num(attr(p ?? e, 'x')), y: num(attr(p ?? e, 'y')) };
}

/** `IN3` → 3; bare `IN` is a named pin, not an index. */
function pinIndex(pin: string): number | undefined {
  if (!pin.startsWith('IN')) return undefined;
  const i = Number(pin.slice(2));
  return Number.isInteger(i) && pin.slice(2) !== '' ? i : undefined;
}

export function importPlcopenXml(xml: string): PlcopenImport {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const root = doc.documentElement;
  if (!root || local(root) === 'parsererror') {
    throw new Error('malformed XML');
  }
  if (local(root) !== 'project') {
    throw new Error('not a PLCopen project document');
  }
  const notes: string[] = [];
  const conns: Conn[] = [];
  const usedIds = new Set<number>();
  // collect every localId for the allocator
  let alloc = 0;
  const visitIds = (el: Element): void => {
    const id = num(attr(el, 'localId'), -1);
    if (id >= 0) usedIds.add(id);
    for (const c of children(el)) visitIds(c);
  };
  visitIds(root);
  alloc = [...usedIds].reduce((m, i) => Math.max(m, i), 0) + 1;
  const nextId = (e: Element): number => {
    const id = num(attr(e, 'localId'), -1);
    return id >= 0 ? id : alloc++;
  };

  const project: FbdProject = {
    schema: FBD_SCHEMA,
    project: attr(descendant(root, 'contentHeader'), 'name') ?? 'imported',
    data_types: [],
    global_vars: [],
    pous: [],
    tasks: [],
  };

  // ---- interface variables -------------------------------------------
  const ifaceKind = (parentTag: string): IfaceKind =>
    (
      ({
        inputVars: 'var_input',
        outputVars: 'var_output',
        externalVars: 'var_external',
        inOutVars: 'var_in_out',
      }) as Record<string, IfaceKind>
    )[parentTag] ?? 'var';

  // IEC elementary type element names inside <type> — Beremiz emits
  // <type><INT/></type> rather than a type attribute
  const ELEM_TYPES = new Set([
    'BOOL', 'SINT', 'USINT', 'BYTE', 'INT', 'UINT', 'WORD',
    'DINT', 'UDINT', 'DWORD', 'LINT', 'ULINT', 'LWORD',
    'REAL', 'LREAL', 'TIME', 'DATE', 'TOD', 'DT', 'STRING', 'WSTRING',
  ]);

  // Extract a type string from a <type> (or nested baseType/
  // subrange) element: elementary child, derived name, or
  // ARRAY[lo..hi] OF elem.
  const xmlType = (el: Element): string => {
    for (const c of children(el)) {
      const t = local(c).toUpperCase();
      if (ELEM_TYPES.has(t)) {
        let s = t;
        const len = attr(c, 'length');
        if ((t === 'STRING' || t === 'WSTRING') && len !== undefined) s += `[${len}]`;
        return s;
      }
      if (t === 'DERIVED') {
        const n = attr(c, 'name');
        if (n !== undefined) return n;
      }
      if (t === 'ARRAY') {
        const dim = descendant(c, 'dimension');
        const bt = descendant(c, 'baseType');
        const elem = bt ? xmlType(bt) : '';
        if (elem) {
          const lo = attr(dim, 'lower') ?? '0';
          const hi = attr(dim, 'upper') ?? '0';
          return `ARRAY[${lo}..${hi}] OF ${elem}`;
        }
      }
      if (t === 'STRUCT' || t === 'ENUM') {
        notes.push(`<${local(c)}> type not imported (no struct/enum support)`);
        return '';
      }
      // containers — baseType/subrange/type nest the real type
      if (t === 'BASETYPE' || t === 'SUBRANGE' || t === 'TYPE') {
        const inner = xmlType(c);
        if (inner) return inner;
      }
    }
    return '';
  };

  const importVar = (v: Element, kind: IfaceKind): IfaceVar => {
    const dv = descendant(v, 'derived');
    const iv = child(v, 'initialValue');
    const sv = iv ? descendant(iv, 'simpleValue') : undefined;
    const typeEl = child(v, 'type');
    const nested = typeEl ? xmlType(typeEl) : '';
    const ty = attr(v, 'type') ?? (nested || undefined) ?? attr(dv, 'name') ?? 'BOOL';
    return {
      name: attr(v, 'name') ?? '',
      kind,
      type: ty,
      ...(attr(sv, 'value') !== undefined ? { init: attr(sv, 'value')! } : {}),
      ...(attr(v, 'address') !== undefined ? { at: attr(v, 'address')! } : {}),
      ...(attr(v, 'retain') === 'true' || attr(v, 'retain') === '1' ? { retain: true } : {}),
    };
  };

  const setVarName = (b: Block, t: string): void => {
    if (t.startsWith('%')) b.at ??= t;
    else b.name ??= t;
  };
  const readCpi = (
    cpi: Element,
    b: Block,
    pin: string | undefined,
    bodyConns: Map<number, string>,
  ): void => {
    const negated = attr(cpi, 'negated') === 'true';
    if (negated) {
      const i = pin !== undefined ? pinIndex(pin) : pin === undefined ? 0 : undefined;
      if (i !== undefined && !b.negated.includes(i)) b.negated.push(i);
    }
    let hasConn = false;
    for (const c of children(cpi)) {
      if (local(c) === 'connection' && attr(c, 'refLocalId') !== undefined) {
        hasConn = true;
        conns.push({
          src: {
            block: num(attr(c, 'refLocalId')),
            port: attr(c, 'formalParameter') ?? 0,
          },
          dst: { block: b.id, port: pin ? (pinIndex(pin) ?? pin) : 0 },
          probe: attr(c, 'probe') === 'true' || tetherAttr(c, 'probe') === 'true',
          wireId: tetherAttr(c, 'wire') !== undefined ? num(tetherAttr(c, 'wire')) : undefined,
          negated,
          bodyConns,
        });
      } else if (local(c) === 'expression') {
        const t = (c.textContent ?? '').trim();
        if (t && pin) b.params[pin] = t;
        else if (t && !hasConn && b.kind === 'variable') setVarName(b, t);
      }
    }
  };

  // ---- FBD body -------------------------------------------------------
  const importFbd = (fbd: Element, pou: Pou): void => {
    const bodyConns = new Map<number, string>();
    for (const c of descendants(fbd, 'connector')) {
      const name = attr(c, 'name');
      if (name !== undefined) bodyConns.set(num(attr(c, 'localId'), -1), name);
    }
    let net = newNet(`net${pou.networks.length + 1}`);
    const pushNet = (): void => {
      if (!netIsEmpty(net)) pou.networks.push(net);
      net = newNet(`net${pou.networks.length + 1}`);
    };
    const readBodyCpi = (cpi: Element, b: Block, pin: string | undefined): void =>
      readCpi(cpi, b, pin, bodyConns);

    const handle = (el: Element): void => {
      const tag = local(el);
      if (tag === 'network') {
        pushNet();
        net = newNet(attr(el, 'id') ?? `net${pou.networks.length + 1}`);
        const k = attr(el, 'kind');
        net.kind = k === 'ladder' || k === 'ld' ? 'ld' : 'fbd';
        net.label = attr(el, 'label') ?? '';
        for (const sub of children(el)) handle(sub);
        return;
      }
      if (tag === 'block') {
        const tn = attr(el, 'typeName') ?? '';
        const inst = attr(el, 'instanceName');
        const isOp = OPERATORS.has(tn.toUpperCase()) || tn.toUpperCase().includes('_TO_');
        const b: Block = {
          id: nextId(el),
          kind: inst ? 'fb' : isOp ? 'operator' : 'function',
          type_ref: tn,
          ...(inst !== undefined ? { instance: inst } : {}),
          pos: posOf(el),
          params: {},
          exec_order: num(attr(el, 'executionOrderId')),
          negated: [],
          comment: '',
        };
        for (const c of descendants(el, 'variable')) {
          const pin = attr(c, 'formalParameter');
          const cpi = child(c, 'connectionPointIn');
          if (cpi) readBodyCpi(cpi, b, pin);
        }
        net.blocks.push(b);
      } else if (tag === 'inVariable' || tag === 'outVariable' || tag === 'inOutVariable') {
        const role: VarRole =
          tag === 'inVariable' ? 'in' : tag === 'outVariable' ? 'out' : 'in_out';
        const b: Block = {
          id: nextId(el),
          kind: 'variable',
          type_ref: '',
          pos: posOf(el),
          params: {},
          exec_order: 0,
          negated: [],
          comment: '',
          role,
          // in/out/inOutVariable elements are data taps — in ladder
          // bodies wires carry values, not gated power flow
          flow: 'data',
        };
        const friendly = tetherAttr(el, 'name') ?? attr(el, 'name');
        if (friendly !== undefined) b.name = friendly;
        if (attr(el, 'negated') === 'true' || attr(el, 'negatedIn') === 'true') b.negated.push(0);
        for (const c of children(el)) {
          if (local(c) === 'connectionPointIn') readBodyCpi(c, b, undefined);
          else if (local(c) === 'expression' || local(c) === 'connectionPointOut') {
            const holder = local(c) === 'connectionPointOut' ? descendant(c, 'expression') : c;
            const t = (holder?.textContent ?? '').trim();
            if (t) setVarName(b, t);
          }
        }
        net.blocks.push(b);
      } else if (tag === 'contact' || tag === 'coil') {
        // roundtrip ladder nets (tether:network kind=ladder inside
        // <FBD>) carry IEC LD power elements — same shape as importLd
        if (net.kind !== 'ld') {
          notes.push(`<${tag}> outside LD body not imported`);
          return;
        }
        const b: Block = {
          id: nextId(el),
          kind: 'variable',
          type_ref: '',
          pos: posOf(el),
          params: {},
          exec_order: 0,
          negated: attr(el, 'negated') === 'true' ? [0] : [],
          comment: '',
          role: tag === 'contact' ? 'in' : 'out',
        };
        for (const a of ['storage', 'edge']) {
          const v = attr(el, a);
          if (v !== undefined && v !== 'none') {
            notes.push(
              `LD ${tag} ${a}="${v}" not imported (flow model supports none only)`,
            );
          }
        }
        for (const c of children(el)) {
          const ct = local(c);
          if (ct === 'connectionPointIn') readBodyCpi(c, b, undefined);
          else if (ct === 'variable' || ct === 'expression') {
            const t = (c.textContent ?? '').trim();
            if (t) setVarName(b, t);
          }
        }
        net.blocks.push(b);
      } else if (tag === 'comment') {
        const c: Comment = { id: nextId(el), pos: posOf(el), text: commentText(el) };
        const marker = markerNet(c.text);
        if (marker !== undefined) {
          pushNet();
          net = newNet(marker);
        } else {
          net.comments.push(c);
        }
      } else if (tag === 'label' || tag === 'labelStep') {
        const l: Label = {
          id: nextId(el),
          pos: posOf(el),
          name: attr(el, 'label') ?? attr(el, 'name') ?? '',
        };
        net.labels.push(l);
      } else if (tag === 'jump' || tag === 'jumpStep') {
        const j: Jump = {
          id: nextId(el),
          pos: posOf(el),
          target: attr(el, 'label') ?? attr(el, 'targetName') ?? '',
        };
        net.jumps.push(j);
      } else if (tag === 'return' || tag === 'returnStep') {
        net.returns.push({ id: nextId(el), pos: posOf(el) });
      } else if (tag === 'connector') {
        // dst stub; wires referencing its localId become assocs at
        // merge. Its own CPI binds the name to a source — no model
        // equivalent, so the inbound edge is dropped with a note.
        const cpi = child(el, 'connectionPointIn');
        if (cpi && descendant(cpi, 'connection')) {
          notes.push(`connector '${attr(el, 'name') ?? ''}': inbound wire not representable`);
        }
      } else if (
        tag === 'continuation' ||
        tag === 'leftPowerRail' ||
        tag === 'rightPowerRail' ||
        tag === 'vendor' ||
        tag === 'action'
      ) {
        notes.push(`<${tag}> element not imported`);
      }
    };
    for (const el of children(fbd)) handle(el);
    pushNet();
  };

  // ---- LD body ---------------------------------------------------------
  // <contact>/<coil> become variable blocks; connectionPointIn links
  // become conns exactly like FBD. Power rails emit no blocks —
  // connections sourced at a rail localId are dropped before
  // mergeWires so rail-fed elements evaluate rail-powered.
  const ldRails = new Map<Network, Set<number>>();
  const importLd = (ld: Element, pou: Pou): void => {
    const net = newNet(`net${pou.networks.length + 1}`);
    net.kind = 'ld';
    net.label = 'LD';
    const rails = new Set<number>();
    ldRails.set(net, rails);
    const noBodyConns = new Map<number, string>();
    for (const el of children(ld)) {
      const tag = local(el);
      if (tag === 'leftPowerRail' || tag === 'rightPowerRail' || tag === 'powerRail') {
        const id = num(attr(el, 'localId'), -1);
        if (id >= 0) rails.add(id);
      } else if (
        tag === 'contact' ||
        tag === 'coil' ||
        tag === 'inVariable' ||
        tag === 'outVariable' ||
        tag === 'inOutVariable'
      ) {
        // contact/coil are power-flow elements; in/out/inOutVariable
        // are data taps (flow:'data') lowered like FBD vars
        const data = tag === 'inVariable' || tag === 'outVariable' || tag === 'inOutVariable';
        const role: VarRole = data
          ? tag === 'inVariable'
            ? 'in'
            : tag === 'outVariable'
              ? 'out'
              : 'in_out'
          : tag === 'contact'
            ? 'in'
            : 'out';
        const b: Block = {
          id: nextId(el),
          kind: 'variable',
          type_ref: '',
          pos: posOf(el),
          params: {},
          exec_order: 0,
          negated:
            attr(el, 'negated') === 'true' || attr(el, 'negatedIn') === 'true' ? [0] : [],
          comment: '',
          role,
          ...(data ? { flow: 'data' as const } : {}),
        };
        if (!data) {
          for (const a of ['storage', 'edge']) {
            const v = attr(el, a);
            if (v !== undefined && v !== 'none') {
              notes.push(
                `LD ${tag} ${a}="${v}" not imported (flow model supports none only)`,
              );
            }
          }
        }
        for (const c of children(el)) {
          const ct = local(c);
          if (ct === 'connectionPointIn') {
            readCpi(c, b, undefined, noBodyConns);
          } else if (ct === 'variable' || ct === 'expression') {
            const t = (c.textContent ?? '').trim();
            if (t) setVarName(b, t);
          }
        }
        net.blocks.push(b);
      } else if (tag === 'block') {
        // Beremiz LD embeds FBD-style blocks (ADD/SEL/FBs) — same
        // import as the FBD path, conns land in noBodyConns
        const tn = attr(el, 'typeName') ?? '';
        const inst = attr(el, 'instanceName');
        const isOp = OPERATORS.has(tn.toUpperCase()) || tn.toUpperCase().includes('_TO_');
        const b: Block = {
          id: nextId(el),
          kind: inst ? 'fb' : isOp ? 'operator' : 'function',
          type_ref: tn,
          ...(inst !== undefined ? { instance: inst } : {}),
          pos: posOf(el),
          params: {},
          exec_order: num(attr(el, 'executionOrderId')),
          negated: [],
          comment: '',
        };
        for (const c of descendants(el, 'variable')) {
          const pin = attr(c, 'formalParameter');
          const cpi = child(c, 'connectionPointIn');
          if (cpi) readCpi(cpi, b, pin, noBodyConns);
        }
        net.blocks.push(b);
      }
    }
    if (!netIsEmpty(net)) pou.networks.push(net);
  };

  // ---- pous / globals / tasks ------------------------------------------
  for (const pouEl of descendants(root, 'pou')) {
    const pt = attr(pouEl, 'pouType');
    const kind: PouKind =
      pt === 'functionBlock' ? 'function_block' : pt === 'function' ? 'function' : 'program';
    const pou: Pou = {
      id: attr(pouEl, 'name') ?? `pou_${project.pous.length}`,
      name: attr(pouEl, 'name') ?? 'unnamed',
      kind,
      en_eno: 'inherit',
      interface: [],
      networks: [],
    };
    const iface = child(pouEl, 'interface');
    if (iface) {
      for (const group of children(iface)) {
        const gt = local(group);
        if (['inputVars', 'outputVars', 'localVars', 'externalVars', 'inOutVars'].includes(gt)) {
          for (const v of children(group)) {
            if (local(v) === 'variable') pou.interface.push(importVar(v, ifaceKind(gt)));
          }
        }
      }
    }
    const body = child(pouEl, 'body');
    if (body) {
      for (const b of children(body)) {
        if (local(b) === 'FBD') importFbd(b, pou);
        else if (local(b) === 'LD') importLd(b, pou);
        else if (['SFC', 'ST', 'IL'].includes(local(b))) {
          notes.push(`${pou.name}: body language <${local(b)}> not imported (FBD/LD only)`);
        }
      }
    }
    dedupeInstanceDecls(pou);
    project.pous.push(pou);
  }

  for (const gv of descendants(root, 'globalVars')) {
    for (const v of children(gv)) {
      if (local(v) === 'variable') project.global_vars.push(importVar(v, 'var_global'));
    }
  }
  for (const dt of descendants(root, 'dataType')) {
    const n = attr(dt, 'name');
    if (n) project.data_types.push({ name: n });
  }
  for (const t of descendants(root, 'task')) {
    const task = {
      name: attr(t, 'name') ?? '',
      period_ns: num(attr(t, 'period_ns')),
      programs: children(t)
        .flatMap((c) => (local(c) === 'program' ? [attr(c, 'ref') ?? ''] : []))
        .filter(Boolean),
      priority: num(attr(t, 'priority')),
    };
    if (task.name) project.tasks.push(task);
  }

  // drop conns sourced at an LD power rail — the fed element is
  // rail-powered by having no input wire
  const blockNet = new Map<number, Network>();
  for (const p of project.pous)
    for (const n of p.networks)
      for (const b of n.blocks) blockNet.set(b.id, n);
  const keptConns = conns.filter((c) => {
    const net = blockNet.get(c.dst.block);
    const rails = net ? ldRails.get(net) : undefined;
    return !(rails !== undefined && rails.has(c.src.block));
  });
  mergeWires(project, keptConns, () => alloc++);

  if (!project.pous.length && !project.global_vars.length) {
    throw new Error('not a PLCopen project document');
  }
  return { project, notes };
}

function newNet(id: string): Network {
  return {
    id,
    kind: 'fbd',
    label: '',
    comments: [],
    assocs: [],
    labels: [],
    jumps: [],
    returns: [],
    blocks: [],
    wires: [],
  };
}

function netIsEmpty(n: Network): boolean {
  return (
    !n.blocks.length &&
    !n.wires.length &&
    !n.comments.length &&
    !n.labels.length &&
    !n.jumps.length &&
    !n.returns.length &&
    !n.assocs.length
  );
}

function commentText(el: Element): string {
  const c = descendant(el, 'content');
  return ((c ?? el).textContent ?? '').trim();
}

function markerNet(text: string): string | undefined {
  const t = text.trim();
  if (t.startsWith('--- net ') && t.endsWith(' ---')) return t.slice(8, -4);
  return undefined;
}

function dedupeInstanceDecls(pou: Pou): void {
  const insts = new Set(
    pou.networks.flatMap((n) =>
      n.blocks
        .filter((b) => b.kind === 'fb' && b.instance)
        .map((b) => `${b.instance}|${b.type_ref}`),
    ),
  );
  pou.interface = pou.interface.filter(
    (v) => !(v.kind === 'var' && !v.at && !v.init && !v.retain && insts.has(`${v.name}|${v.type}`)),
  );
}

/** fan-out merge: `tether:wire` ids win, else group by src endpoint. */
function mergeWires(project: FbdProject, conns: Conn[], alloc: () => number): void {
  const allNets = project.pous.flatMap((p) => p.networks);
  const netOfBlock = (blockId: number): Network | undefined =>
    allNets.find((n) => n.blocks.some((b) => b.id === blockId));
  const keyOf = new Map<string, Wire>();
  for (const c of conns) {
    const connName = c.bodyConns.get(c.src.block);
    if (connName !== undefined) {
      const net = netOfBlock(c.dst.block) ?? allNets[allNets.length - 1];
      net?.assocs.push({ src_name: connName, dst: c.dst });
      continue;
    }
    const key = c.wireId !== undefined ? `w${c.wireId}` : `s${c.src.block}:${String(c.src.port)}`;
    let w = keyOf.get(key);
    if (!w) {
      w = { id: c.wireId ?? alloc(), src: c.src, dsts: [] };
      keyOf.set(key, w);
      const net = netOfBlock(c.src.block) ?? netOfBlock(c.dst.block) ?? allNets[allNets.length - 1];
      net?.wires.push(w);
    }
    if (c.probe) w.probe = true;
    w.dsts.push(c.dst);
    if (c.negated && typeof c.dst.port === 'number') {
      const b = netOfBlock(c.dst.block)?.blocks.find((x) => x.id === c.dst.block);
      if (b && !b.negated.includes(c.dst.port)) b.negated.push(c.dst.port);
    }
  }
}

// ============================================================================
// Export — Roundtrip mode (TC6 + tether: extensions)
// ============================================================================

const escXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

class Xml {
  out = '';
  private depth = 0;
  open(tag: string, attrs: [string, string][] = []): void {
    this.pad();
    this.out += `<${tag}${attrs.map(([k, v]) => ` ${k}="${escXml(v)}"`).join('')}>\n`;
    this.depth++;
  }
  empty(tag: string, attrs: [string, string][] = []): void {
    this.pad();
    this.out += `<${tag}${attrs.map(([k, v]) => ` ${k}="${escXml(v)}"`).join('')}/>\n`;
  }
  text(t: string): void {
    this.pad();
    this.out += `${escXml(t)}\n`;
  }
  close(tag: string): void {
    this.depth--;
    this.pad();
    this.out += `</${tag}>\n`;
  }
  private pad(): void {
    this.out += '  '.repeat(this.depth);
  }
}

const portKey = (p: PortSel): string => (typeof p === 'number' ? `#${p}` : p);

export function exportPlcopenXml(p: FbdProject): string {
  const x = new Xml();
  x.out += `<?xml version="1.0" encoding="UTF-8"?>\n`;
  x.open('project', [
    ['xmlns', 'http://www.plcopen.org/xml/tc6_0200'],
    ['xmlns:tether', TETHER_NS],
  ]);
  x.open('fileHeader', [
    ['companyName', 'TetherMotion'],
    ['productName', 'TetherPLC'],
    ['productVersion', '1'],
    ['creationDateTime', new Date().toISOString()],
  ]);
  x.close('fileHeader');
  x.open('contentHeader', [['name', p.project]]);
  x.close('contentHeader');
  x.open('types');
  if (p.data_types.length) {
    x.open('dataTypes');
    for (const dt of p.data_types as { name: string }[]) {
      x.open('dataType', [['name', dt.name]]);
      x.close('dataType');
    }
    x.close('dataTypes');
  }
  if (p.global_vars.length) {
    x.open('globalVars');
    for (const v of p.global_vars) exportIfaceVar(x, v);
    x.close('globalVars');
  }
  x.open('pous');
  for (const pou of p.pous) exportPou(x, pou);
  x.close('pous');
  x.close('types');
  if (p.tasks.length) {
    x.open('addData');
    x.open('data', [
      ['name', 'tether:tasks'],
      ['handleUnknown', 'implementation'],
    ]);
    for (const t of p.tasks) {
      x.open('tether:task', [
        ['name', t.name],
        ['period_ns', String(t.period_ns)],
        ['priority', String(t.priority)],
      ]);
      for (const prog of t.programs) x.empty('tether:program', [['ref', prog]]);
      x.close('tether:task');
    }
    x.close('data');
    x.close('addData');
  }
  x.close('project');
  return x.out;
}

function exportPou(x: Xml, pou: Pou): void {
  const pouType =
    pou.kind === 'function_block'
      ? 'functionBlock'
      : pou.kind === 'function'
        ? 'function'
        : 'program';
  x.open('pou', [
    ['name', pou.name],
    ['pouType', pouType],
  ]);
  const localVars: IfaceVar[] = [
    ...pou.interface.filter((v) => v.kind === 'var' || v.kind === 'var_temp'),
  ];
  // auto-emit FB instance decls so foreign tools see the types
  const have = new Set(localVars.map((v) => v.name));
  for (const n of pou.networks) {
    for (const b of n.blocks) {
      if (b.kind === 'fb' && b.instance && !have.has(b.instance)) {
        localVars.push({ name: b.instance, kind: 'var', type: b.type_ref });
        have.add(b.instance);
      }
    }
  }
  const groups: [string, IfaceVar[]][] = [
    ['inputVars', pou.interface.filter((v) => v.kind === 'var_input')],
    ['outputVars', pou.interface.filter((v) => v.kind === 'var_output')],
    ['localVars', localVars],
    ['inOutVars', pou.interface.filter((v) => v.kind === 'var_in_out')],
    ['externalVars', pou.interface.filter((v) => v.kind === 'var_external')],
  ];
  x.open('interface');
  for (const [tag, vars] of groups) {
    if (!vars.length) continue;
    x.open(tag);
    for (const v of vars) exportIfaceVar(x, v);
    x.close(tag);
  }
  x.close('interface');
  x.open('body');
  x.open('FBD');
  for (const net of pou.networks) {
    const a: [string, string][] = [
      ['id', net.id],
      ['kind', net.kind === 'ld' ? 'ladder' : 'fbd'],
    ];
    if (net.label) a.push(['label', net.label]);
    x.open('tether:network', a);
    exportNetwork(x, net);
    x.close('tether:network');
  }
  x.close('FBD');
  x.close('body');
  x.close('pou');
}

function exportIfaceVar(x: Xml, v: IfaceVar): void {
  const a: [string, string][] = [
    ['name', v.name],
    ['type', v.type],
  ];
  if (v.at) a.push(['address', v.at]);
  if (v.retain) a.push(['retain', 'true']);
  x.open('variable', a);
  if (v.init) {
    x.open('initialValue');
    x.empty('simpleValue', [['value', v.init]]);
    x.close('initialValue');
  }
  x.close('variable');
}

function connElem(x: Xml, src: PortRef, w: Wire): void {
  const a: [string, string][] = [['refLocalId', String(src.block)]];
  if (typeof src.port === 'string') a.push(['formalParameter', src.port]);
  a.push(['tether:wire', String(w.id)]);
  if (w.probe) a.push(['tether:probe', 'true']);
  x.empty('connection', a);
}

function exportNetwork(x: Xml, net: Network): void {
  const byDst = new Map<string, Wire[]>();
  for (const w of net.wires) {
    for (const d of w.dsts) {
      const k = `${d.block}|${portKey(d.port)}`;
      byDst.set(k, [...(byDst.get(k) ?? []), w]);
    }
  }
  for (const b of net.blocks) exportBlock(x, net, b, byDst);
  for (const c of net.comments) {
    x.open('comment', [['localId', String(c.id)]]);
    x.empty('position', [
      ['x', String(c.pos.x)],
      ['y', String(c.pos.y)],
    ]);
    x.open('content');
    x.open('xhtml', [['xmlns', 'http://www.w3.org/1999/xhtml']]);
    x.text(c.text);
    x.close('xhtml');
    x.close('content');
    x.close('comment');
  }
  for (const l of net.labels) {
    x.open('label', [
      ['localId', String(l.id)],
      ['label', l.name],
    ]);
    x.empty('position', [
      ['x', String(l.pos.x)],
      ['y', String(l.pos.y)],
    ]);
    x.close('label');
  }
  for (const j of net.jumps) {
    x.open('jump', [
      ['localId', String(j.id)],
      ['label', j.target],
    ]);
    x.empty('position', [
      ['x', String(j.pos.x)],
      ['y', String(j.pos.y)],
    ]);
    x.close('jump');
  }
  for (const r of net.returns) {
    x.open('return', [['localId', String(r.id)]]);
    x.empty('position', [
      ['x', String(r.pos.x)],
      ['y', String(r.pos.y)],
    ]);
    x.close('return');
  }
}

function exportBlock(x: Xml, net: Network, b: Block, byDst: Map<string, Wire[]>): void {
  if (b.kind === 'variable') {
    exportVarBlock(x, net, b, byDst);
    return;
  }
  if (b.kind === 'jump_target') {
    if (b.name) {
      x.open('label', [
        ['localId', String(b.id)],
        ['label', b.name],
      ]);
      x.empty('position', [
        ['x', String(b.pos.x)],
        ['y', String(b.pos.y)],
      ]);
      x.close('label');
    }
    return;
  }
  const a: [string, string][] = [
    ['localId', String(b.id)],
    ['typeName', b.type_ref],
  ];
  if (b.instance) a.push(['instanceName', b.instance]);
  if (b.exec_order) a.push(['executionOrderId', String(b.exec_order)]);
  x.open('block', a);
  x.empty('position', [
    ['x', String(b.pos.x)],
    ['y', String(b.pos.y)],
  ]);

  // input pins = union of wired dst ports + literal params
  const ins = new Set<string>();
  for (const k of byDst.keys()) {
    const sep = k.indexOf('|');
    if (Number(k.slice(0, sep)) === b.id) ins.add(k.slice(sep + 1));
  }
  for (const p of Object.keys(b.params)) ins.add(p);
  if (ins.size) {
    x.open('inputVariables');
    for (const pin of [...ins].sort()) {
      const idx = pin.startsWith('#') ? pin.slice(1) : undefined;
      x.open('variable', [['formalParameter', idx !== undefined ? `IN${idx}` : pin]]);
      const neg = idx !== undefined && b.negated.includes(Number(idx));
      x.open('connectionPointIn', neg ? [['negated', 'true']] : []);
      const ws = byDst.get(`${b.id}|${pin}`);
      if (ws) {
        for (const w of ws) connElem(x, w.src, w);
      } else if (b.params[pin] !== undefined) {
        x.open('expression');
        x.text(b.params[pin]!);
        x.close('expression');
      }
      x.close('connectionPointIn');
      x.close('variable');
    }
    x.close('inputVariables');
  }
  const outs = new Set<string>();
  for (const w of net.wires) {
    if (w.src.block === b.id) outs.add(portKey(w.src.port));
  }
  if (outs.size) {
    x.open('outputVariables');
    for (const pin of [...outs].sort()) {
      x.open('variable', pin.startsWith('#') ? [] : [['formalParameter', pin]]);
      x.empty('connectionPointOut');
      x.close('variable');
    }
    x.close('outputVariables');
  }
  x.close('block');
}

function exportVarBlock(x: Xml, net: Network, b: Block, byDst: Map<string, Wire[]>): void {
  const role = b.role ?? 'in';
  // ladder power elements (contacts/coils) export as IEC LD
  // elements; data taps (flow=data) and all FBD vars keep the
  // in/out/inOutVariable form
  const power = net.kind === 'ld' && b.flow !== 'data';
  const tag = power
    ? role === 'in'
      ? 'contact'
      : 'coil'
    : role === 'in'
      ? 'inVariable'
      : role === 'out'
        ? 'outVariable'
        : 'inOutVariable';
  const nameExpr = b.at ?? b.name ?? '';
  const a: [string, string][] = [['localId', String(b.id)]];
  if (b.negated.length) a.push(['negated', 'true']);
  if (b.at && b.name) a.push(['tether:name', b.name]);
  x.open(tag, a);
  x.empty('position', [
    ['x', String(b.pos.x)],
    ['y', String(b.pos.y)],
  ]);
  // connectionPointIn carries incoming wires for any role — LD
  // contacts are role=in yet receive flow from upstream elements
  const hasIn =
    (byDst.get(`${b.id}|#0`)?.length ?? 0) > 0 || (byDst.get(`${b.id}|`)?.length ?? 0) > 0;
  if (role !== 'in' || hasIn) {
    x.open('connectionPointIn');
    for (const key of ['#0', '']) {
      for (const w of byDst.get(`${b.id}|${key}`) ?? []) connElem(x, w.src, w);
    }
    x.close('connectionPointIn');
  }
  if (power) {
    // IEC LD elements reference their variable in a <variable>
    // child; contacts keep an (empty) out connection-point marker,
    // coils have none
    if (role !== 'out') {
      x.open('connectionPointOut');
      x.close('connectionPointOut');
    }
    x.open('variable');
    x.text(nameExpr);
    x.close('variable');
  } else {
    if (role !== 'out') {
      x.open('connectionPointOut');
      x.open('expression');
      x.text(nameExpr);
      x.close('expression');
      x.close('connectionPointOut');
    }
    if (role === 'out') {
      x.open('expression');
      x.text(nameExpr);
      x.close('expression');
    }
  }
  x.close(tag);
}
