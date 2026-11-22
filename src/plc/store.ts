/**
 * PLC project container + persistence.
 *
 * The working document is the fbd.v1 JSON (graphical sources) plus a
 * per-POU ST source map (textual sources — ST bodies are not part of
 * fbd.v1). Persisted in localStorage under `tether.plc.project.v1`;
 * import/export is canonical .fbd.json.
 */
import { CurveProfile } from './curve';
import { emptyProject, FbdProject, isFbdProject } from './model';
import type { MetaChannel } from './build';
import * as pa from './projectapi';
import { TuneCfg } from './tune';
import type { AlarmRule } from './alarms';

const STORAGE_KEY = 'tether.plc.project.v1';

export interface PlcProject {
  fbd: FbdProject;
  /** POU name → ST source text (POUs written in ST, not the FBD model). */
  stSources: Record<string, string>;
  /** POU name → temperature profile being edited for it (Curves pane). */
  curves?: Record<string, CurveProfile>;
  /** POU name → autotune configuration being edited for it (Curves pane). */
  tunes?: Record<string, TuneCfg>;
  /** deploy-map override (bridge text) injected into the package at
      build+deploy time; absent = no DEPLOY_MAP section. */
  deployMap?: string;
  /** user-defined alarm rules (Alarms pane) — compiled into the
      generated `AlarmRules` FBD program on demand. */
  alarms?: AlarmRule[];
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
        curves: parsed.curves && typeof parsed.curves === 'object' ? parsed.curves : {},
        tunes: parsed.tunes && typeof parsed.tunes === 'object' ? parsed.tunes : {},
        deployMap: typeof parsed.deployMap === 'string' ? parsed.deployMap : undefined,
        alarms: Array.isArray(parsed.alarms) ? parsed.alarms : undefined,
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

/* ---- backend project persistence (tplc serve project meta-ops) ----
   The canonical store is the project directory's `.tplc/project.json`
   (`manifest.ui` holds this PlcProject document).  localStorage stays
   as the offline fallback / pre-project cache. */

/** Parse a persisted UI document (manifest.ui or localStorage value). */
export function plcProjectFromJson(parsed: unknown): PlcProject | undefined {
  if (parsed && typeof parsed === 'object') {
    const u = parsed as Record<string, unknown>;
    if (u.fbd && isFbdProject(u.fbd)) {
      return {
        fbd: u.fbd,
        stSources:
          u.stSources && typeof u.stSources === 'object'
            ? (u.stSources as Record<string, string>)
            : {},
        curves: u.curves && typeof u.curves === 'object' ? (u.curves as never) : undefined,
        tunes: u.tunes && typeof u.tunes === 'object' ? (u.tunes as never) : undefined,
        deployMap: typeof u.deployMap === 'string' ? u.deployMap : undefined,
        alarms: Array.isArray(u.alarms) ? (u.alarms as never) : undefined,
      };
    }
  }
  return undefined;
}

/**
 * Push the working document into the backend project manifest
 * (`manifest.ui`).  Best-effort: resolves false when no project is
 * open or the backend is unreachable — callers ignore the result.
 */
export async function saveProjectRemote(ch: MetaChannel, p: PlcProject): Promise<boolean> {
  try {
    const info = await pa.projectGet(ch);
    if (!info) return false;
    const manifest: pa.ProjectManifest = {
      ...(info.manifest ?? {}),
      name: info.name || p.fbd.project || 'project',
      ui: p,
    };
    await pa.projectSave(ch, manifest);
    return true;
  } catch {
    return false;
  }
}

/**
 * Hydrate the working document from the backend project manifest.
 * Returns undefined when no project is open or it has no `ui` doc.
 */
export async function loadRemoteProject(ch: MetaChannel): Promise<PlcProject | undefined> {
  try {
    const info = await pa.projectGet(ch);
    return info ? plcProjectFromJson(info.manifest?.ui) : undefined;
  } catch {
    return undefined;
  }
}

/** Current backend project info for the Project pane (undefined = none). */
export async function remoteProjectInfo(ch: MetaChannel): Promise<pa.ProjectInfo | undefined> {
  return pa.projectGet(ch);
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
