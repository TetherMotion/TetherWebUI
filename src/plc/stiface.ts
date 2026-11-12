/**
 * Minimal ST interface parser for attached library sources.
 *
 * The canvas needs pin names/types to draw and typecheck a block. Project
 * POUs carry their interface in the fbd.v1 doc, but a library attached as
 * a `.st` source only exists as text — this extracts
 * `FUNCTION_BLOCK` / `FUNCTION` declarations with their VAR_INPUT /
 * VAR_OUTPUT / VAR_IN_OUT sections into synthetic `Pou` objects that
 * `sigs.pouSig` and `types.inferNetwork` can consume unchanged.
 *
 * Deliberately not a full ST parser: bodies, VAR/VAR_TEMP locals, and
 * type declarations are ignored.
 */
import { IfaceKind, IfaceVar, Pou } from './model';

/** Strip `(* … *)` and `// …` comments (strings are not modeled). */
function stripComments(src: string): string {
  return src
    .replace(/\(\*[\s\S]*?\*\)/g, ' ')
    .split('\n')
    .map((l) => {
      const i = l.indexOf('//');
      return i >= 0 ? l.slice(0, i) : l;
    })
    .join('\n');
}

/** Parse one `A, B : TYPE;` declaration line into interface vars. */
function parseDeclLine(line: string, kind: IfaceKind): IfaceVar[] {
  const m = /^\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*:\s*([^;]+);?/.exec(line);
  if (!m) return [];
  const names = m[1]!
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const type = m[2]!.trim().replace(/\s+/g, ' ');
  return names.map((name) => ({ name, kind, type }));
}

/**
 * Extract every FB/FUNCTION interface from ST source text.
 * Ids are prefixed `lib:` so callers can tell synthetic decls apart.
 */
export function parseStInterfaces(sources: string[]): Pou[] {
  const out: Pou[] = [];
  const seen = new Set<string>();
  for (const raw of sources) {
    const src = stripComments(raw);
    const re =
      /\b(FUNCTION_BLOCK|FUNCTION)\s+([A-Za-z_]\w*)\s*(?::\s*([A-Za-z_][\w\s()[\].]*?))?\s*(?:\r?\n|$)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const isFn = m[1]!.toUpperCase() === 'FUNCTION';
      const name = m[2]!;
      const up = name.toUpperCase();
      if (seen.has(up)) continue;
      seen.add(up);
      const start = re.lastIndex;
      const end = src.slice(start).search(/\bEND_(FUNCTION_BLOCK|FUNCTION)\b/i);
      const body = end >= 0 ? src.slice(start, start + end) : src.slice(start);
      const iface: IfaceVar[] = [];
      const secRe = /\b(VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|VAR_TEMP|VAR)\b([\s\S]*?)\bEND_VAR\b/gi;
      let s: RegExpExecArray | null;
      while ((s = secRe.exec(body))) {
        const kw = s[1]!.toUpperCase();
        // VAR / VAR_TEMP are locals, not pins — skipped
        if (kw !== 'VAR_INPUT' && kw !== 'VAR_OUTPUT' && kw !== 'VAR_IN_OUT') continue;
        const kind: IfaceKind =
          kw === 'VAR_INPUT' ? 'var_input' : kw === 'VAR_OUTPUT' ? 'var_output' : 'var_in_out';
        for (const line of s[2]!.split(';')) iface.push(...parseDeclLine(line, kind));
      }
      out.push({
        id: `lib:${name}`,
        name,
        kind: isFn ? 'function' : 'function_block',
        en_eno: 'off',
        interface: iface,
        networks: [],
        ...(isFn && m[3] ? { ret_ty: m[3].trim() } : {}),
      });
    }
  }
  return out;
}

/** True when a POU is a synthetic library declaration. */
export const isLibPou = (p: Pou): boolean => p.id.startsWith('lib:');
