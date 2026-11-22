/**
 * Compile service client — sends project sources as a `compile`
 * meta-op over the /ws socket, which runs `tplcc check|build --json`
 * on the plc host and wraps the result:
 *
 *   request  {"op":"compile","build":bool,"files":[{name,content}]}
 *   response {"compile":{"ok","errors","diags":[…]}, "exit":N,
 *             "package":"<base64>"}          (package = build mode only)
 */
import type { PlcProject } from './store';

/** minimal meta-op channel — PlcCtl in the app, a stub in tests. */
export interface MetaChannel {
  meta<T = unknown>(op: string, fields?: Record<string, unknown>): Promise<T>;
}

export interface CompileDiag {
  code: string;
  severity: 'error' | 'warning' | 'note' | string;
  message: string;
  help?: string;
  notes?: string[];
  /** source file name (St provenance). */
  file?: string;
  line?: number;
  col?: number;
  /** byte offset + length into the source text (CodeMirror positions). */
  offset?: number;
  len?: number;
  /** Fbd provenance: network index, node id, pin. */
  fbd?: { sheet: number; node: number; pin: number };
}

export interface CompileResult {
  ok: boolean;
  errors: number;
  diags: CompileDiag[];
  /** compiled .tplc bytes (build mode, on success). */
  package?: Uint8Array;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** CM6-facing diagnostic shape (mirrors @codemirror/lint's Diagnostic). */
export interface EditorDiag {
  from: number;
  to: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  source?: string;
}

/** utf8 byte offset → js string index (CM6 doc positions). */
export function byteToOffset(text: string, byteOff: number): number {
  const bytes = enc.encode(text);
  const cut = byteOff > bytes.length ? bytes.length : byteOff;
  return dec.decode(bytes.subarray(0, cut)).length;
}

/** compile diags → editor positions for one file's source text. */
export function diagsForFile(diags: CompileDiag[], fileName: string, source: string): EditorDiag[] {
  const out: EditorDiag[] = [];
  for (const d of diags) {
    if (d.file !== fileName || d.offset === undefined) continue;
    const from = byteToOffset(source, d.offset);
    const to = byteToOffset(source, d.offset + (d.len || 1));
    out.push({
      from,
      to: Math.max(to, Math.min(from + 1, source.length)),
      severity: d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warning' : 'info',
      message: d.message + (d.help ? `\nhelp: ${d.help}` : ''),
      source: d.code,
    });
  }
  return out;
}

/**
 * Pick the sources tplcc compiles for this project. Mixed FBD+ST is
 * one module: the .fbd.json project plus every .st source compile
 * together — FBD blocks instantiate ST POUs as extern signatures, ST
 * calls FBD POUs after merge, and `st` blocks expand to generated
 * FUNCTION_BLOCKs (params.CODE is the body, block.pins its interface).
 * FBD POUs whose body is ST-authored (a non-empty stSource and no
 * blocks) are editor bookkeeping, not declarations — they are dropped
 * from the emitted JSON so the compiler sees the ST decl alone; FBD
 * resolves them as extern signatures. A POU with both networks and an
 * ST body stays in and produces the duplicate-implementation diag.
 */
export function projectSources(project: PlcProject): {
  files: { name: string; content: string }[];
  notes: string[];
} {
  const notes: string[] = [];
  const st = Object.entries(project.stSources).filter(([, s]) => s.trim().length > 0);
  const stNames = new Set(st.map(([name]) => name.toUpperCase()));
  const hasBody = (p: PlcProject['fbd']['pous'][number]) =>
    p.networks.some((n) => n.blocks.length > 0);
  const fbdPous = project.fbd.pous.filter((p) => hasBody(p) || !stNames.has(p.name.toUpperCase()));
  const files: { name: string; content: string }[] = [];
  const hasFbd =
    fbdPous.length > 0 || project.fbd.global_vars.length > 0 || project.fbd.tasks.length > 0;
  if (hasFbd || st.length === 0) {
    files.push({
      name: 'project.fbd.json',
      content: JSON.stringify({ ...project.fbd, pous: fbdPous }),
    });
  }
  files.push(...st.map(([name, content]) => ({ name: `${name}.st`, content })));
  return { files, notes };
}

/** run a compile meta-op; build=true returns the .tplc package too. */
export async function compileProject(
  ch: MetaChannel,
  project: PlcProject,
  build = false,
): Promise<CompileResult> {
  const { files, notes } = projectSources(project);
  const raw = await ch.meta<{
    compile?: { ok?: boolean; errors?: number; diags?: CompileDiag[] };
    package?: string;
  }>('compile', { build, files });
  const c = raw.compile ?? {};
  const diags = (c.diags ?? []).concat(
    notes.map((message) => ({ code: 'TPLC_W_IDE', severity: 'note', message })),
  );
  return {
    ok: c.ok === true,
    errors: c.errors ?? 0,
    diags,
    package: raw.package ? Uint8Array.from(atob(raw.package), (ch) => ch.charCodeAt(0)) : undefined,
  };
}

/** Inject a DEPLOY_MAP section (0x31) into a compiled .tplc package via
    the `pkgmap` meta-op (runs `tplcc pkg add-section`). */
export async function injectDeployMap(
  ch: MetaChannel,
  pkg: Uint8Array,
  mapText: string,
): Promise<Uint8Array> {
  const b64 = (bytes: Uint8Array) => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
      s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const raw = await ch.meta<{ package?: string }>('pkgmap', {
    package: b64(pkg),
    map: mapText,
  });
  if (!raw.package) throw new Error('pkgmap: no package returned');
  return Uint8Array.from(atob(raw.package), (ch) => ch.charCodeAt(0));
}
