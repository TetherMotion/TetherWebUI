/**
 * fbd.v1 project model — TypeScript mirror of compiler/fbd-model.
 * Canonical JSON (stable key order) is the editor save format; PLCopen
 * XML is only an exchange surface (doc 06 §6).
 */

export const FBD_SCHEMA = 'fbd.v1';

export type PouKind = 'program' | 'function_block' | 'function';
export type NetworkKind = 'fbd' | 'ld';
export type IfaceKind =
  'var_input' | 'var_output' | 'var_in_out' | 'var' | 'var_temp' | 'var_external' | 'var_global';
export type BlockKind =
  | 'variable'
  | 'operator'
  | 'fb'
  | 'function'
  | 'jump_target'
  | 'st'
  | 'device';
export type VarRole = 'in' | 'out' | 'in_out';
export type PortSel = number | string;

export interface Pos {
  x: number;
  y: number;
}

export interface PortRef {
  block: number;
  port: PortSel;
}

export interface Wire {
  id: number;
  src: PortRef;
  dsts: PortRef[];
  probe?: boolean;
}

export interface Assoc {
  src_name: string;
  dst: PortRef;
}

export interface Comment {
  id: number;
  pos: Pos;
  text: string;
}

export interface Label {
  id: number;
  pos: Pos;
  name: string;
}

export interface Jump {
  id: number;
  pos: Pos;
  target: string;
}

export interface ReturnMarker {
  id: number;
  pos: Pos;
}

export interface Block {
  id: number;
  kind: BlockKind;
  type_ref: string;
  instance?: string;
  pos: Pos;
  params: Record<string, string>;
  exec_order: number;
  negated: number[];
  comment: string;
  role?: VarRole;
  /**
   * Ladder-only flow class. Absent = power flow (IEC contact/coil —
   * BOOL gated by rung flow). 'data' = PLCopen in/out/inOutVariable
   * element: typed data tap lowered like an FBD variable block.
   */
  flow?: 'data';
  name?: string;
  at?: string;
  /**
   * Inline-ST block pins (kind === 'st'). Each entry declares one
   * generated-FB interface var: var_input → input pin, var_output →
   * output pin, var_in_out → pin on both sides, var/var_temp → an
   * internal local (no pin). The ST body lives in params.CODE; the
   * compiler expands the block into a generated FUNCTION_BLOCK.
   */
  pins?: IfaceVar[];
  /**
   * Device block (kind === 'device'): a fieldbus terminal (e.g. a
   * Beckhoff EK module). `type_ref` is the device/terminal name,
   * `pins` are the channel declarations — each pin is a located var
   * (`at` = process-image address); var_output = device→logic,
   * var_input = logic→device, var_in_out = both. `endpoint` is the
   * bus PDO endpoint key (e.g. `el1014.c1`) the deploy map binds to;
   * empty/absent = file-transport channel.
   */
  endpoint?: string;
}

export interface IfaceVar {
  name: string;
  kind: IfaceKind;
  type: string;
  init?: string;
  at?: string;
  retain?: boolean;
}

export interface Network {
  id: string;
  kind: NetworkKind;
  label: string;
  comments: Comment[];
  assocs: Assoc[];
  labels: Label[];
  jumps: Jump[];
  returns: ReturnMarker[];
  blocks: Block[];
  wires: Wire[];
}

export interface Pou {
  id: string;
  name: string;
  kind: PouKind;
  en_eno: string;
  interface: IfaceVar[];
  networks: Network[];
  /** declared return type — kind === 'function' only. */
  ret_ty?: string;
}

export interface Task {
  name: string;
  period_ns: number;
  programs: string[];
  priority: number;
}

export interface FbdProject {
  schema: string;
  project: string;
  data_types: unknown[];
  global_vars: IfaceVar[];
  pous: Pou[];
  tasks: Task[];
}

export function emptyProject(name: string): FbdProject {
  return {
    schema: FBD_SCHEMA,
    project: name,
    data_types: [],
    global_vars: [],
    pous: [],
    tasks: [],
  };
}

export function isFbdProject(v: unknown): v is FbdProject {
  return (
    !!v &&
    typeof v === 'object' &&
    (v as FbdProject).schema === FBD_SCHEMA &&
    Array.isArray((v as FbdProject).pous)
  );
}

/**
 * Next free NodeId in a POU — monotonic across every node class
 * (blocks, wires, comments, labels, jumps, returns), never reused
 * (doc 06 §6 provenance durability).
 */
export function nextNodeId(pou: Pou): number {
  let max = 0;
  for (const n of pou.networks) {
    const ids: number[] = [
      ...n.blocks.map((b) => b.id),
      ...n.wires.map((w) => w.id),
      ...n.comments.map((c) => c.id),
      ...n.labels.map((l) => l.id),
      ...n.jumps.map((j) => j.id),
      ...n.returns.map((r) => r.id),
    ];
    for (const id of ids) if (id > max) max = id;
  }
  return max + 1;
}

export function portLabel(sel: PortSel): string {
  return typeof sel === 'number' ? `#${sel}` : sel;
}
