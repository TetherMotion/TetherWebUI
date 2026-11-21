/**
 * Project version history — named snapshots of PlcProject persisted in
 * localStorage (`tether.plc.history.v1`), newest first, capped at 40.
 *
 * The IDE auto-snapshots on save (throttled) and lets the user restore
 * or delete entries. Snapshots store the full PlcProject so restore is
 * lossless; this complements — not replaces — canonical .fbd.json
 * export for sharing.
 */
import type { PlcProject } from './store';

const KEY = 'tether.plc.history.v1';
const MAX = 40;
const AUTO_MIN_MS = 30_000;

export interface Snapshot {
  id: number;
  ts: number;
  label: string;
  project: PlcProject;
}

let counter = 0;

function load(): Snapshot[] {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as Snapshot[]) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function store(list: Snapshot[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    /* quota — drop oldest and retry once */
    try {
      localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX / 2)));
    } catch { /* give up silently */ }
  }
}

export function listHistory(): Snapshot[] {
  return load();
}

let lastAuto = 0;

/** Push a snapshot; returns the new snapshot (or null if throttled). */
export function pushSnapshot(project: PlcProject, label: string, auto = false): Snapshot | null {
  if (auto && Date.now() - lastAuto < AUTO_MIN_MS) return null;
  const list = load();
  const snap: Snapshot = {
    id: ++counter || Date.now(),
    ts: Date.now(),
    label: label || `snapshot ${list.length + 1}`,
    project: JSON.parse(JSON.stringify(project)) as PlcProject,
  };
  list.unshift(snap);
  store(list);
  if (auto) lastAuto = snap.ts;
  return snap;
}

/** Snapshot summary for UI lists (no project payload). */
export function historyIndex(): Omit<Snapshot, 'project'>[] {
  return load().map(({ id, ts, label }) => ({ id, ts, label }));
}

export function getSnapshot(id: number): PlcProject | null {
  return load().find((s) => s.id === id)?.project ?? null;
}

export function deleteSnapshot(id: number): void {
  store(load().filter((s) => s.id !== id));
}

/** diff counts between two projects for the UI (pous/blocks/wires). */
export function diffSummary(a: PlcProject, b: PlcProject): string {
  const count = (p: PlcProject) =>
    p.fbd.pous.reduce(
      (n, pou) => n + pou.networks.reduce((m, net) => m + net.blocks.length + net.wires.length, 0),
      0,
    );
  const pa = count(a), pb = count(b);
  const st = Object.keys(a.stSources).length, sb = Object.keys(b.stSources).length;
  return `${pb - pa >= 0 ? '+' : ''}${pb - pa} blocks/wires · ${sb - st >= 0 ? '+' : ''}${sb - st} ST sources`;
}
