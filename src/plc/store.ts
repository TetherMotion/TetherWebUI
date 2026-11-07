/**
 * PLC project container + persistence.
 *
 * The working document is the fbd.v1 JSON (graphical sources) plus a
 * per-POU ST source map (textual sources — ST bodies are not part of
 * fbd.v1). Persisted in localStorage under `tether.plc.project.v1`;
 * import/export is canonical .fbd.json.
 */
import { emptyProject, FbdProject, isFbdProject } from './model';

const STORAGE_KEY = 'tether.plc.project.v1';

export interface PlcProject {
  fbd: FbdProject;
  /** POU name → ST source text (POUs written in ST, not the FBD model). */
  stSources: Record<string, string>;
}

export function emptyPlcProject(): PlcProject {
  return { fbd: emptyProject('untitled'), stSources: {} };
}

export function loadProject(): PlcProject {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyPlcProject();
    const parsed = JSON.parse(raw);
    if (parsed && isFbdProject(parsed.fbd)) {
      return {
        fbd: parsed.fbd,
        stSources: parsed.stSources && typeof parsed.stSources === 'object' ? parsed.stSources : {},
      };
    }
    // tolerate a bare fbd.v1 doc saved by an earlier version
    if (isFbdProject(parsed)) return { fbd: parsed, stSources: {} };
  } catch {
    /* fall through to empty */
  }
  return emptyPlcProject();
}

export function saveProject(p: PlcProject): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
}

/** Parse an imported .fbd.json document into a PlcProject. */
export function importFbdJson(text: string): PlcProject {
  const parsed: unknown = JSON.parse(text);
  if (!isFbdProject(parsed)) throw new Error('not an fbd.v1 project document');
  return { fbd: parsed, stSources: {} };
}

/** Canonical export — the fbd.v1 document only. */
export function exportFbdJson(p: PlcProject): string {
  return `${JSON.stringify(p.fbd, null, 1)}\n`;
}
