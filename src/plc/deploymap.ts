/**
 * Deploy-map generation + validation for the bridge I/O map.
 *
 * The deploy map (package section 0x31, bridge text format) binds the
 * PLC process image to transport channels — `key=` files for the sim
 * transport, `pdo=` endpoints for the live EtherCAT bus. This module:
 *
 *  - TERMINALS: Beckhoff/virtual terminal catalog — channel layout,
 *    PDO payload sizes, endpoint-key prefix (matches the fleet
 *    catalog in Tether's BeckhoffFleet.hpp).
 *  - projectIoBindingsEx: every `at` binding in the project — FBD
 *    globals/POU vars/variable+device blocks plus ST `AT` decls.
 *  - generateDeployMap: draft map text from the project — device
 *    blocks with `endpoint` become `pdo=` channels, the rest become
 *    `key=` file channels; epoch-stamped with the canonical hash.
 *  - validateDeployMapText: client-side mirror of the bridge's
 *    validate_map (range/owner/dir/at/bind/pdo-size/safe rules).
 *  - nextFreeBase / atCollisions: address allocation + duplicate-AT
 *    warnings for the device wizard and io-map card.
 */
import type { FbdProject, Pou } from './model';
import {
  parseDeployMap,
  projectIoBindings,
  type DeployMap,
  type DeployMapChannel,
  type ProjectBinding,
} from './plc-ide';

/* ------------------------------------------------------------------ */
/* terminal catalog                                                     */
/* ------------------------------------------------------------------ */

export interface TerminalGroup {
  channel: 'DI' | 'DO' | 'AI' | 'AO';
  count: number;
  /** IEC type for the generated pins. */
  ty: string;
  /** bytes per channel in the image (analog only; digital packs bits). */
  pitch: number;
}

export interface TerminalSpec {
  /** part number / device type_ref, e.g. 'EL1014'. */
  part: string;
  label: string;
  /** pump PDO endpoint prefix, e.g. 'el1014' → endpoints
      `el1014.c1`, `el1014.c1.2` (fleet occurrence suffix). Empty for
      virtual terminals that only use the file transport. */
  pdoKey?: string;
  groups: TerminalGroup[];
  /** PDO payload bytes: tx = device→master (%I side), rx = %Q side. */
  txSize: number;
  rxSize: number;
}

const G = (channel: TerminalGroup['channel'], count: number, ty: string, pitch = 0): TerminalGroup =>
  ({ channel, count, ty, pitch });

/** PDO sizes follow the emulated fleet: digital channels pack into
    whole bytes, analog channels are int16 pairs. */
function pdoSizes(groups: TerminalGroup[]): { tx: number; rx: number } {
  let diB = 0, doB = 0, ai = 0, ao = 0;
  for (const g of groups) {
    if (g.channel === 'DI') diB += Math.ceil(g.count / 8);
    else if (g.channel === 'DO') doB += Math.ceil(g.count / 8);
    else if (g.channel === 'AI') ai += g.count;
    else ao += g.count;
  }
  return { tx: diB + ai * 2, rx: doB + ao * 2 };
}

function term(part: string, label: string, pdoKey: string | undefined, groups: TerminalGroup[]): TerminalSpec {
  const { tx, rx } = pdoSizes(groups);
  return { part, label, pdoKey, groups, txSize: tx, rxSize: rx };
}

export const TERMINALS: TerminalSpec[] = [
  /* EtherCAT EL bus terminals — PDO payload = int16 analog + packed
     digital, matching BeckhoffFleet.hpp fleetModuleCatalog. */
  term('EL1014', 'EL1014 — 4-ch digital input', 'el1014', [G('DI', 4, 'BOOL')]),
  term('EL1004', 'EL1004 — 4-ch digital input', 'el1004', [G('DI', 4, 'BOOL')]),
  term('EL2004', 'EL2004 — 4-ch digital output', 'el2004', [G('DO', 4, 'BOOL')]),
  term('EL2008', 'EL2008 — 8-ch digital output', 'el2008', [G('DO', 8, 'BOOL')]),
  term('EL3104', 'EL3104 — 4-ch analog in (±10 V, int16 counts)', 'el3104', [G('AI', 4, 'INT', 2)]),
  term('EL3114', 'EL3114 — 4-ch analog in (0..20 mA, int16 counts)', 'el3114', [G('AI', 4, 'INT', 2)]),
  term('EL4104', 'EL4104 — 4-ch analog out (±10 V, int16 counts)', 'el4104', [G('AO', 4, 'INT', 2)]),
  term('EL4114', 'EL4114 — 4-ch analog out (0..20 mA, int16 counts)', 'el4114', [G('AO', 4, 'INT', 2)]),
  /* virtual terminals (file transport / non-EtherCAT I/O) — REAL
     engineering-unit channels, no PDO endpoint. */
  term('EK1108', 'EK1108 — 8-ch digital input', undefined, [G('DI', 8, 'BOOL')]),
  term('EK1123', 'EK1123 — 8-ch digital output', undefined, [G('DO', 8, 'BOOL')]),
  term('EK1110', 'EK1110 — 4 DI + 4 DO', undefined, [G('DI', 4, 'BOOL'), G('DO', 4, 'BOOL')]),
  term('EK1122', 'EK1122 — 2 AI + 2 AO (±10 V / 0..20 mA)', undefined, [
    G('AI', 2, 'REAL', 4), G('AO', 2, 'REAL', 4),
  ]),
];

export function terminalSpec(part: string): TerminalSpec | undefined {
  const up = part.trim().toUpperCase();
  return TERMINALS.find((t) => t.part.toUpperCase() === up);
}

/* ------------------------------------------------------------------ */
/* AT addresses + type sizes                                            */
/* ------------------------------------------------------------------ */

export interface AtAddr {
  region: 'I' | 'Q' | 'M';
  width: string;
  byte: number;
  bit?: number;
}

/** `%IX0.0` / `%QB3` / `%ID16.0` — the AT number is a raw byte offset
    for every width code (compiler + runtime semantics). */
export function parseAt(at: string): AtAddr | undefined {
  const m = /^%([IQM])([XBWDL])([0-9]+)(?:\.([0-9]+))?$/.exec(at.trim());
  if (!m) return undefined;
  return {
    region: m[1] as AtAddr['region'],
    width: m[2]!,
    byte: parseInt(m[3]!, 10),
    bit: m[4] !== undefined ? parseInt(m[4], 10) : undefined,
  };
}

/** IEC scalar byte size — mirrors typedval.ts codec sizes. */
export function typeSize(ty: string | undefined): number {
  switch ((ty ?? '').toUpperCase()) {
    case 'BOOL': case 'SINT': case 'USINT': case 'BYTE': return 1;
    case 'INT': case 'UINT': case 'WORD': return 2;
    case 'DINT': case 'UDINT': case 'REAL': case 'FLOAT': return 4;
    case 'LINT': case 'ULINT': case 'LREAL': case 'TIME': case 'DWORD':
    case 'LWORD': return 8;
    default: return 1;
  }
}

/* ------------------------------------------------------------------ */
/* project bindings (FBD + ST)                                          */
/* ------------------------------------------------------------------ */

const ST_AT_RE = /^\s*([A-Za-z_]\w*)\s+AT\s+(%[IQM][XBWDL][0-9]+(?:\.[0-9]+)?)\s*:\s*([A-Za-z_]\w*)/;

/** `name AT %IX0.0 : BOOL;` declarations inside ST sources — the ST
    counterpart of FBD located vars, invisible to projectIoBindings. */
export function stIoBindings(stSources: Record<string, string>): ProjectBinding[] {
  const out: ProjectBinding[] = [];
  for (const [pou, src] of Object.entries(stSources)) {
    for (const line of src.split('\n')) {
      const m = ST_AT_RE.exec(line);
      if (m) out.push({ name: `${pou}.${m[1]}`, at: m[2]!, type: m[3] });
    }
  }
  return out;
}

/** Every `at` binding in the project: FBD model + ST sources. */
export function projectIoBindingsEx(project: { fbd: FbdProject; stSources?: Record<string, string> }): ProjectBinding[] {
  const out = projectIoBindings(project.fbd);
  if (project.stSources) out.push(...stIoBindings(project.stSources));
  return out.sort((a, b) => a.at.localeCompare(b.at) || a.name.localeCompare(b.name));
}

/* ------------------------------------------------------------------ */
/* generation                                                           */
/* ------------------------------------------------------------------ */

interface GenBinding {
  name: string;
  at: string;
  addr: AtAddr;
  span: number; // image bytes covered
}

interface GenChannel {
  dir: 'in' | 'out';
  off: number;
  size: number;
  key: string;
  pdo?: string;
}

/** canonical hash input — must match MapRunner.cpp map_hash() */
function canonicalMap(m: { inSize: number; outSize: number; channels: GenChannel[]; bindings: { at: string; key: string }[]; safety: string[] }): string {
  let s = 'tplc-map-v1\n';
  s += `image in=${m.inSize} out=${m.outSize}\n`;
  for (const c of m.channels) {
    s += `${c.dir} off=${c.off} size=${c.size} file=${c.key} pdo=${c.pdo ?? ''} type= safe=${c.dir === 'out' ? 0 : 0} sval=0\n`;
  }
  for (const b of m.bindings) s += `bind ${b.at} ${b.key}\n`;
  for (const k of m.safety) s += `safety ${k}\n`;
  return s;
}

async function sha256hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface GenResult {
  text: string;
  map: DeployMap;
  warnings: string[];
}

/** Serialize a DeployMap to bridge text (inverse of parseDeployMap). */
export function serializeDeployMap(m: DeployMap): string {
  const lines: string[] = [];
  if (m.inSize !== undefined || m.outSize !== undefined)
    lines.push(`image in ${m.inSize ?? 0} out ${m.outSize ?? 0}`);
  for (const c of m.channels) {
    const kv = [`off=${c.off}`, `size=${c.size}`];
    if (c.pdo) kv.push(`pdo=${c.pdo}`);
    else kv.push(`key=${c.key}`);
    if (c.type) kv.push(`type=${c.type}`);
    if (c.safe) kv.push(`safe=${c.safe}`);
    lines.push(`${c.dir} ${kv.join(' ')}`);
  }
  for (const b of m.bindings) lines.push(`bind ${b.at} ${b.key}`);
  for (const s of m.safety) lines.push(`safety ${s}`);
  if (m.hash) lines.push(`hash ${m.hash}`);
  return lines.join('\n') + '\n';
}

/**
 * Draft a deploy map from the project. Device blocks with `endpoint`
 * become `pdo=` channels (size = covered image span — the bridge
 * validates it against the live .bus PDO payload); everything else
 * becomes `key=` file channels over contiguous byte runs. The map is
 * epoch-stamped with the canonical SHA-256 hash.
 */
export async function generateDeployMap(
  project: { fbd: FbdProject; stSources?: Record<string, string> },
): Promise<GenResult> {
  const warnings: string[] = [];
  const raw = projectIoBindingsEx(project);
  const bindings: GenBinding[] = [];
  for (const b of raw) {
    const addr = b.at ? parseAt(b.at) : undefined;
    if (!addr) { warnings.push(`unparseable AT '${b.at}' on ${b.name}`); continue; }
    bindings.push({ name: b.name, at: b.at, addr, span: Math.max(1, typeSize(b.type)) });
  }

  /* pass 1: device blocks with endpoint → pdo channels per direction */
  const pdoChans: GenChannel[] = [];
  const usedEndpoints = new Map<string, string>();
  const pdoCover: { dir: 'in' | 'out'; off: number; end: number; key: string }[] = [];
  for (const pou of project.fbd.pous) {
    for (const net of pou.networks) {
      for (const blk of net.blocks) {
        if (blk.kind !== 'device' || !blk.endpoint) continue;
        const spec = terminalSpec(blk.type_ref);
        for (const dir of ['in', 'out'] as const) {
          /* var_output pins = device→logic = %I 'in'; var_input = %Q 'out' */
          const wantKind = dir === 'in' ? 'var_output' : 'var_input';
          const pins = (blk.pins ?? []).filter((p) => p.kind === wantKind && p.at);
          if (!pins.length) continue;
          const parsed = pins.map((p) => ({ p, a: parseAt(p.at!) }));
          if (parsed.some((x) => !x.a)) {
            warnings.push(`${blk.type_ref}: pin without valid AT in ${pou.name}`);
            continue;
          }
          const wantRegion = dir === 'in' ? 'I' : 'Q';
          const badRegion = parsed.find((x) => x.a!.region !== wantRegion);
          if (badRegion) {
            warnings.push(`${blk.type_ref}: ${badRegion.p.name} AT ${badRegion.p.at} is %${badRegion.a!.region} but belongs in %${wantRegion}`);
            continue;
          }
          const off = Math.min(...parsed.map((x) => x.a!.byte));
          const end = Math.max(...parsed.map((x) => x.a!.byte + Math.max(1, typeSize(x.p.type))));
          const size = end - off;
          const key = `${blk.endpoint}.${dir === 'in' ? 'tx' : 'rx'}`;
          /* endpoint uniqueness: two blocks on one PDO endpoint is a
             wiring error — warn and keep the first */
          const epKey = `${blk.endpoint}:${dir}`;
          const prev = usedEndpoints.get(epKey);
          if (prev) {
            warnings.push(`endpoint ${blk.endpoint} (${dir}) claimed by both ${prev} and ${blk.type_ref} in ${pou.name}`);
            continue;
          }
          usedEndpoints.set(epKey, `${blk.type_ref} (${pou.name})`);
          /* catalog cross-check when the part is known */
          if (spec) {
            const want = dir === 'in' ? spec.txSize : spec.rxSize;
            if (want > 0 && size !== want)
              warnings.push(`${blk.type_ref}: ${dir} channel span ${size}B != ${spec.part} PDO ${want}B — pins must match the PDO layout`);
          }
          pdoChans.push({ dir, off, size, key, pdo: blk.endpoint });
          pdoCover.push({ dir, off, end, key });
        }
      }
    }
  }

  /* pass 2: uncovered bindings → contiguous key= runs per region.
     pdo-covered bytes are carved out so %Q channels never overlap. */
  const inBindings = bindings.filter((b) => b.addr.region === 'I');
  const outBindings = bindings.filter((b) => b.addr.region === 'Q');
  const autoChans: GenChannel[] = [];

  const coverFor = (dir: 'in' | 'out', b: GenBinding) =>
    pdoCover.find((c) => c.dir === dir && b.addr.byte >= c.off && b.addr.byte + b.span <= c.end);

  const uncovered = (dir: 'in' | 'out', list: GenBinding[]) =>
    list.filter((b) => !coverFor(dir, b));

  const runsFor = (dir: 'in' | 'out', list: GenBinding[]): GenChannel[] => {
    /* occupied pdo intervals in this direction */
    const occ = pdoCover.filter((c) => c.dir === dir).sort((a, b) => a.off - b.off);
    const res: GenChannel[] = [];
    const sorted = [...list].sort((a, b) => a.addr.byte - b.addr.byte || a.span - b.span);
    let cur: { off: number; end: number; name: string } | undefined;
    const flush = () => {
      if (!cur) return;
      const key = `${dir === 'in' ? 'in' : 'out'}_${cur.name.replace(/[^A-Za-z0-9_.-]/g, '_')}`;
      res.push({ dir, off: cur.off, size: cur.end - cur.off, key });
      cur = undefined;
    };
    for (const b of sorted) {
      let s = b.addr.byte, e = b.addr.byte + b.span;
      /* split the binding's span around occupied pdo intervals */
      for (;;) {
        const hit = occ.find((o) => s < o.end && e > o.off);
        if (!hit) break;
        if (s < hit.off) {
          /* free head [s, hit.off) */
          if (!cur || cur.end !== s) { flush(); cur = { off: s, end: hit.off, name: b.name }; }
          else cur.end = hit.off;
        }
        s = Math.max(s, hit.end);
        if (s >= e) break;
      }
      if (s >= e) continue;
      if (!cur || s > cur.end) { flush(); cur = { off: s, end: e, name: b.name }; }
      else cur.end = Math.max(cur.end, e);
    }
    flush();
    return res;
  };

  autoChans.push(...runsFor('in', uncovered('in', inBindings)));
  autoChans.push(...runsFor('out', uncovered('out', outBindings)));

  const channels: DeployMapChannel[] = [
    ...pdoChans.map((c) => ({ ...c })),
    ...autoChans.map((c) => ({ ...c })),
  ];

  /* pass 3: binds — prefer the pdo channel, then auto coverage */
  const mapBinds: { at: string; key: string }[] = [];
  const allChans = [...pdoChans, ...autoChans];
  const chanFor = (dir: 'in' | 'out', b: GenBinding): GenChannel | undefined => {
    const c = allChans
      .filter((x) => x.dir === dir && b.addr.byte >= x.off && b.addr.byte + b.span <= x.off + x.size)
      .sort((a, b2) => a.size - b2.size);   // most specific wins
    return c[0];
  };
  for (const b of bindings) {
    if (b.addr.region === 'M') { mapBinds.push({ at: b.at, key: '*' }); continue; }
    const dir = b.addr.region === 'I' ? 'in' : 'out';
    const c = chanFor(dir, b);
    if (c) mapBinds.push({ at: b.at, key: c.key });
    else { mapBinds.push({ at: b.at, key: '*' }); warnings.push(`${b.name} AT ${b.at} uncovered — no channel`); }
  }

  /* image sizes = max covered extent per region */
  const extent = (dir: 'in' | 'out') =>
    Math.max(
      0,
      ...channels.filter((c) => c.dir === dir).map((c) => c.off + c.size),
      ...bindings.filter((b) => (dir === 'in' ? b.addr.region === 'I' : b.addr.region === 'Q'))
        .map((b) => b.addr.byte + b.span),
    );
  const inSize = extent('in'), outSize = extent('out');

  /* out channels need an explicit safe policy (MAP_SAFE) */
  for (const c of channels)
    if (c.dir === 'out') (c as DeployMapChannel).safe = 'zero';

  /* same-direction channel overlap corrupts the image (MAP_OWNER) —
     warn so the user fixes the AT assignment, don't silently emit. */
  for (let i = 0; i < channels.length; i++)
    for (let j = i + 1; j < channels.length; j++) {
      const a = channels[i]!, b = channels[j]!;
      if (a.dir === b.dir && a.off < b.off + b.size && b.off < a.off + a.size)
        warnings.push(`%${a.dir === 'in' ? 'I' : 'Q'} channels ${a.key} and ${b.key} overlap — check AT addresses`);
    }

  const hash = await sha256hex(canonicalMap({
    inSize, outSize,
    channels: channels.map((c) => ({ dir: c.dir, off: c.off, size: c.size, key: c.key, pdo: c.pdo ?? '' })),
    bindings: mapBinds,
    safety: [],
  }));

  const text = serializeDeployMap({
    inSize, outSize, channels, bindings: mapBinds, safety: [], hash,
  });
  return { text, map: { inSize, outSize, channels, bindings: mapBinds, safety: [], hash }, warnings };
}

/* ------------------------------------------------------------------ */
/* validation (client mirror of validate_map)                          */
/* ------------------------------------------------------------------ */

export interface BusEndpoint { tx: boolean; key: string; size: number }

export function parseBusCatalog(text: string): BusEndpoint[] {
  const out: BusEndpoint[] = [];
  for (const line of text.split('\n')) {
    const h = line.indexOf('#');
    const l = (h >= 0 ? line.slice(0, h) : line).trim();
    if (!l) continue;
    const t = l.split(/\s+/);
    if ((t[0] === 'tx' || t[0] === 'rx') && t.length === 3)
      out.push({ tx: t[0] === 'tx', key: t[1]!, size: parseInt(t[2]!, 10) || 0 });
  }
  return out;
}

export interface MapViolation { rule: string; detail: string }

/** Mirror of the bridge validate_map rules that can be checked
    client-side. `bus` = live .bus catalog when known (pdo sizes). */
export function validateDeployMapText(
  text: string,
  bus?: BusEndpoint[],
): MapViolation[] {
  const v: MapViolation[] = [];
  const m = parseDeployMap(text);
  const imgIn = m.inSize ?? 0, imgOut = m.outSize ?? 0;
  const bad = (rule: string, detail: string) => v.push({ rule, detail });

  /* channel range + same-dir owner overlap + safe policy + pdo size —
     %I channels are writers too (transport → image pump), so overlap
     corrupts in both directions (mirrors validate_map MAP_OWNER). */
  for (const c of m.channels) {
    const lim = c.dir === 'in' ? imgIn : imgOut;
    if (c.off + c.size > lim)
      bad('MAP_RANGE', `${c.dir} channel ${c.key} [${c.off}..${c.off + c.size}) outside image (${lim}B)`);
    if (c.dir === 'out' && !c.safe)
      bad('MAP_SAFE', `out channel ${c.key} has no safe policy`);
    for (const o of m.channels) {
      if (o === c || o.dir !== c.dir) continue;
      if (c.off < o.off + o.size && o.off < c.off + c.size)
        bad('MAP_OWNER', `%${c.dir === 'in' ? 'I' : 'Q'} range of ${c.key} overlaps ${o.key}`);
    }
    if (c.pdo && bus) {
      const ep = bus.find((e) => e.key === c.pdo && e.tx === (c.dir === 'in'));
      if (!ep) bad('MAP_PDO', `${c.dir} channel pdo ${c.pdo} not on bus`);
      else if (ep.size !== c.size)
        bad('MAP_PDO', `${c.dir} channel ${c.key} size ${c.size} != pdo ${c.pdo} size ${ep.size}`);
    }
  }
  /* binds: AT must be covered by a channel of matching direction */
  for (const b of m.bindings) {
    if (b.key === '*') continue;
    const a = parseAt(b.at);
    if (!a) { bad('MAP_AT', `unparseable AT ${b.at}`); continue; }
    const dir = a.region === 'I' ? 'in' : a.region === 'Q' ? 'out' : undefined;
    if (!dir) continue; /* %M scratch binds are unmanaged */
    const covered = m.channels.some((c) =>
      c.dir === dir && a.byte >= c.off && a.byte < c.off + c.size);
    if (!covered) bad('MAP_AT', `bind ${b.at} lands outside any ${dir} channel`);
    const ch = m.channels.find((c) => c.key === b.key);
    if (!ch) bad('MAP_BIND', `bind ${b.at} → missing channel ${b.key}`);
    else if (ch.dir !== dir) bad('MAP_DIR', `bind ${b.at} → ${b.key} direction mismatch`);
  }
  return v;
}

/* ------------------------------------------------------------------ */
/* allocation + collision helpers                                       */
/* ------------------------------------------------------------------ */

/** occupied byte intervals per image region across a flat binding
    list (image space is shared by every POU). */
export function occupiedIntervals(
  bindings: ProjectBinding[],
): Map<'I' | 'Q', [number, number][]> {
  const occ = new Map<'I' | 'Q', [number, number][]>();
  for (const b of bindings) {
    const a = parseAt(b.at);
    if (!a || a.region === 'M') continue;
    const span = Math.max(1, typeSize(b.type));
    const list = occ.get(a.region) ?? [];
    list.push([a.byte, a.byte + span]);
    occ.set(a.region, list);
  }
  for (const l of occ.values()) l.sort((a, b) => a[0] - b[0]);
  return occ;
}

/** lowest base byte where `need` contiguous image bytes are free in
    `region` for a flat binding list. Digital channels need
    ceil(count/8); analog count*pitch. */
export function nextFreeBaseFor(
  bindings: ProjectBinding[],
  region: 'I' | 'Q',
  needBytes: number,
  align = 1,
): number {
  const occ = occupiedIntervals(bindings).get(region) ?? [];
  let off = 0;
  for (;;) {
    off = Math.ceil(off / align) * align;
    const end = off + needBytes;
    const hit = occ.find(([s, e]) => off < e && end > s);
    if (!hit) return off;
    off = hit[1];
  }
}

export function nextFreeBase(
  project: { fbd: FbdProject; stSources?: Record<string, string> },
  region: 'I' | 'Q',
  needBytes: number,
  align = 1,
): number {
  return nextFreeBaseFor(projectIoBindingsEx(project), region, needBytes, align);
}

/** Suggest the next free PDO endpoint for a terminal prefix, matching
    the fleet's occurrence naming (`el1014.c1`, `el1014.c1.2`, …). */
export function suggestEndpoint(prefix: string, used: Iterable<string>): string {
  const taken = new Set(used);
  const cands: string[] = [];
  for (let chain = 1; chain <= 8; chain++) {
    cands.push(`${prefix}.c${chain}`);
    for (let occ = 2; occ <= 16; occ++) cands.push(`${prefix}.c${chain}.${occ}`);
  }
  for (const c of cands) if (!taken.has(c)) return c;
  return `${prefix}.c1`;
}

export interface AtCollision {
  /** image region + byte range, e.g. 'I[0..1)'. */
  at: string;
  claimants: string[];
}

/** image byte ranges claimed by pins of two or more different device
    blocks — `%IX0.0` and `%ID0.0` collide on byte 0 even though the AT
    strings differ. Almost always an unallocated-base mistake. */
export function atCollisions(fbd: FbdProject): AtCollision[] {
  interface Iv { s: number; e: number; owner: string; who: string }
  const byRegion = new Map<'I' | 'Q', Iv[]>();
  for (const pou of fbd.pous) {
    for (const net of pou.networks) {
      for (const blk of net.blocks) {
        if (blk.kind !== 'device') continue;
        for (const p of blk.pins ?? []) {
          if (!p.at) continue;
          const a = parseAt(p.at);
          if (!a || a.region === 'M') continue;
          const owner = `${blk.type_ref}#${blk.id}`;
          const list = byRegion.get(a.region) ?? [];
          list.push({
            s: a.byte, e: a.byte + Math.max(1, typeSize(p.type)),
            owner,
            who: `${owner}.${p.name} (${pou.name})`,
          });
          byRegion.set(a.region, list);
        }
      }
    }
  }
  const out: AtCollision[] = [];
  for (const [region, ivs] of byRegion) {
    const sorted = [...ivs].sort((a, b) => a.s - b.s || a.e - b.e);
    /* sweep: group transitively-overlapping intervals; a group owned
       by >1 block is a collision */
    let cur: Iv[] = [];
    let curEnd = -1;
    const flush = () => {
      const owners = new Set(cur.map((x) => x.owner));
      if (owners.size > 1) {
        const s = Math.min(...cur.map((x) => x.s));
        const e = Math.max(...cur.map((x) => x.e));
        out.push({ at: `${region}[${s}..${e})`, claimants: [...new Set(cur.map((x) => x.who))].sort() });
      }
      cur = [];
    };
    for (const iv of sorted) {
      if (cur.length && iv.s >= curEnd) { flush(); curEnd = -1; }
      cur.push(iv);
      curEnd = Math.max(curEnd, iv.e);
    }
    flush();
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** PDO endpoints claimed by more than one device block. */
export function endpointCollisions(fbd: FbdProject): { endpoint: string; claimants: string[] }[] {
  const byEp = new Map<string, Set<string>>();
  for (const pou of fbd.pous) {
    for (const net of pou.networks) {
      for (const blk of net.blocks) {
        if (blk.kind !== 'device' || !blk.endpoint) continue;
        const set = byEp.get(blk.endpoint) ?? new Set<string>();
        set.add(`${blk.type_ref}#${blk.id} (${pou.name})`);
        byEp.set(blk.endpoint, set);
      }
    }
  }
  const out: { endpoint: string; claimants: string[] }[] = [];
  for (const [endpoint, claimants] of byEp)
    if (claimants.size > 1) out.push({ endpoint, claimants: [...claimants].sort() });
  return out.sort((a, b) => a.endpoint.localeCompare(b.endpoint));
}

/* ------------------------------------------------------------------ */
/* ST AT declaration generator (M5)                                    */
/* ------------------------------------------------------------------ */

/** IEC located-var declarations for a device block's pins — paste
    into an ST source's VAR section. */
export function deviceStDecls(pou: Pou, blk: { type_ref: string; pins?: { name: string; kind: string; type: string; at?: string }[] }): string {
  const lines: string[] = [];
  const want = (k: string) => blk.pins?.filter((p) => p.at && p.kind === k);
  for (const group of [
    ['var_output', 'VAR_OUTPUT'],
    ['var_input', 'VAR_INPUT'],
    ['var_in_out', 'VAR_IN_OUT'],
  ] as const) {
    const pins = want(group[0]);
    if (!pins?.length) continue;
    lines.push(`${group[1]}`);
    for (const p of pins) lines.push(`    ${p.name} AT ${p.at} : ${p.type};`);
    lines.push('END_VAR');
  }
  return lines.join('\n') + '\n';
}
