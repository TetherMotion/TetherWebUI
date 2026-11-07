/**
 * Compile service client — POSTs project sources to the ctl proxy's
 * `/compile` route, which runs `tplcc check|build --json` on the plc
 * host and wraps the result:
 *
 *   request  [u16 count][u16 nameLen,name,u32 len,utf8 content]×N (LE)
 *   response {"compile":{"ok","errors","diags":[…]}, "exit":N,
 *             "package":"<base64>"}          (package = build mode only)
 */
import type { PlcProject } from './store';

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

/** serialize sources to the proxy's binary src frame. */
export function encodeSrcFrame(files: { name: string; content: string }[]): ArrayBuffer {
  const chunks = files.map((f) => ({ n: enc.encode(f.name), c: enc.encode(f.content) }));
  const total = 2 + chunks.reduce((s, ch) => s + 2 + ch.n.length + 4 + ch.c.length, 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, chunks.length, true);
  let o = 2;
  for (const { n, c } of chunks) {
    dv.setUint16(o, n.length, true);
    out.set(n, o + 2);
    dv.setUint32(o + 2 + n.length, c.length, true);
    out.set(c, o + 6 + n.length);
    o += 6 + n.length + c.length;
  }
  return out.buffer;
}

/** pick the sources tplcc can compile for this project. */
export function projectSources(project: PlcProject): {
  files: { name: string; content: string }[];
  notes: string[];
} {
  const notes: string[] = [];
  const st = Object.entries(project.stSources).filter(([, s]) => s.trim().length > 0);
  if (st.length > 0) {
    if (project.fbd.pous.some((p) => p.networks.some((n) => n.blocks.length > 0))) {
      notes.push('mixed ST/FBD project: compiler accepts one language; FBD networks skipped');
    }
    return {
      files: st.map(([name, content]) => ({ name: `${name}.st`, content })),
      notes,
    };
  }
  return {
    files: [{ name: 'project.fbd.json', content: JSON.stringify(project.fbd) }],
    notes,
  };
}

/** POST sources to the proxy; build=true returns the .tplc package too. */
export async function compileProject(
  base: string,
  project: PlcProject,
  build = false,
): Promise<CompileResult> {
  const { files, notes } = projectSources(project);
  const res = await fetch(`${base}/compile${build ? '?build' : ''}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: encodeSrcFrame(files),
  });
  if (!res.ok) throw new Error(`compile: HTTP ${res.status} ${await res.text()}`);
  const raw = (await res.json()) as {
    compile?: { ok?: boolean; errors?: number; diags?: CompileDiag[] };
    package?: string;
  };
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
