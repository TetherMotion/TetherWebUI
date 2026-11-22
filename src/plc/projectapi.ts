/**
 * Project & git API — typed wrappers over the tplc serve WS meta-ops
 * (`project_*`, `git_*`, `projects`).  The backend persists each
 * project in its own directory (`.tplc/project.json` manifest +
 * integrated git repo); these calls are best-effort — callers should
 * tolerate failures (older backends, no project open) and fall back
 * to localStorage.
 */
import type { MetaChannel } from './build';

export interface ProjectManifest {
  version?: number;
  name?: string;
  description?: string;
  sources?: string[];
  libs?: string[];
  taskPeriodNs?: number;
  imageIn?: number;
  imageOut?: number;
  deployMap?: string;
  /** opaque WebUI document — the PlcProject JSON round-trips here. */
  ui?: unknown;
  [k: string]: unknown;
}

export interface ProjectInfo {
  root: string;
  name: string;
  manifest: ProjectManifest;
  git?: boolean;
  branch?: string;
}

export interface ProjectFile {
  path: string;
  size: number;
}

export interface GitStatusEntry {
  path: string;
  status: string;
  staged: boolean;
  index_status: string;
  workdir_status: string;
}

export interface GitCommit {
  oid: string;
  short: string;
  author: string;
  email: string;
  time: number;
  message: string;
}

export interface GitDiff {
  diff: string | null;
}

/** Current project info; undefined when no project is open. */
export async function projectGet(ch: MetaChannel): Promise<ProjectInfo | undefined> {
  try {
    return await ch.meta<ProjectInfo>('project_get');
  } catch {
    return undefined;
  }
}

/** Recently opened project roots (backend-side list). */
export async function projectsRecent(ch: MetaChannel): Promise<string[]> {
  try {
    const d = await ch.meta<string[]>('projects');
    return Array.isArray(d) ? d : [];
  } catch {
    return [];
  }
}

/** Open (or adopt) a project directory on the backend. */
export async function projectOpen(ch: MetaChannel, path: string): Promise<ProjectInfo> {
  return ch.meta<ProjectInfo>('project_open', { path });
}

/** Persist the manifest (incl. the `ui` document) to .tplc/project.json. */
export async function projectSave(ch: MetaChannel, manifest: ProjectManifest): Promise<void> {
  await ch.meta('project_save', { manifest });
}

/** Recursive project file list (skips .git/ and build/). */
export async function projectFiles(ch: MetaChannel): Promise<ProjectFile[]> {
  try {
    const d = await ch.meta<ProjectFile[]>('project_files');
    return Array.isArray(d) ? d : [];
  } catch {
    return [];
  }
}

export async function projectFileGet(
  ch: MetaChannel,
  path: string,
): Promise<{ path: string; content: string; size: number } | undefined> {
  try {
    return await ch.meta('project_file_get', { path });
  } catch {
    return undefined;
  }
}

export async function projectFilePut(ch: MetaChannel, path: string, content: string): Promise<void> {
  await ch.meta('project_file_put', { path, content });
}

export async function projectFileDelete(ch: MetaChannel, path: string): Promise<void> {
  await ch.meta('project_file_delete', { path });
}

export async function gitStatus(ch: MetaChannel): Promise<GitStatusEntry[]> {
  try {
    const d = await ch.meta<GitStatusEntry[]>('git_status');
    return Array.isArray(d) ? d : [];
  } catch {
    return [];
  }
}

export async function gitLog(ch: MetaChannel, n = 50): Promise<GitCommit[]> {
  try {
    const d = await ch.meta<GitCommit[]>('git_log', { n });
    return Array.isArray(d) ? d : [];
  } catch {
    return [];
  }
}

export async function gitDiff(ch: MetaChannel, path?: string): Promise<string | null> {
  try {
    const d = await ch.meta<GitDiff>('git_diff', path ? { path } : {});
    return d.diff ?? null;
  } catch {
    return null;
  }
}

export async function gitBranch(ch: MetaChannel): Promise<string> {
  try {
    const d = await ch.meta<{ branch?: string }>('git_branch');
    return d.branch ?? '';
  } catch {
    return '';
  }
}

export async function gitCommit(ch: MetaChannel, message: string): Promise<string | undefined> {
  try {
    const d = await ch.meta<{ short?: string }>('git_commit', { message });
    return d.short;
  } catch {
    return undefined;
  }
}
