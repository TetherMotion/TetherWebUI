import { describe, expect, it, vi } from 'vitest';
import type { MetaChannel } from './build';
import * as pa from './projectapi';
import { emptyProject } from './model';
import {
  loadRemoteProject,
  remoteProjectInfo,
  saveProjectRemote,
  type PlcProject,
} from './store';

/** Fake MetaChannel: records ops, replies from a handler map. */
function fakeChannel(
  handler: (op: string, fields: Record<string, unknown>) => unknown,
): MetaChannel & { calls: { op: string; fields: Record<string, unknown> }[] } {
  const calls: { op: string; fields: Record<string, unknown> }[] = [];
  return {
    calls,
    meta<T = unknown>(op: string, fields: Record<string, unknown> = {}): Promise<T> {
      calls.push({ op, fields });
      return Promise.resolve(handler(op, fields) as T);
    },
  };
}

const project = (): PlcProject => ({
  fbd: emptyProject('demo'),
  stSources: { Main: 'PROGRAM Main\nEND_PROGRAM\n' },
});

describe('projectapi', () => {
  it('projectGet returns info and swallows errors', async () => {
    const info = { root: '/p', name: 'p', manifest: { name: 'p' } };
    const ch = fakeChannel((op) => (op === 'project_get' ? info : undefined));
    expect(await pa.projectGet(ch)).toEqual(info);
    const bad = fakeChannel(() => {
      throw new Error('no project');
    });
    expect(await pa.projectGet(bad)).toBeUndefined();
  });

  it('projectOpen posts the path and propagates errors', async () => {
    const ch = fakeChannel((op) =>
      op === 'project_open' ? { root: '/x', name: 'x', manifest: {} } : undefined,
    );
    const info = await pa.projectOpen(ch, '/x');
    expect(info.root).toBe('/x');
    expect(ch.calls[0]).toEqual({ op: 'project_open', fields: { path: '/x' } });
    const bad = fakeChannel(() => {
      throw new Error('not a project');
    });
    await expect(pa.projectOpen(bad, '/nope')).rejects.toThrow('not a project');
  });

  it('file ops round-trip paths through meta', async () => {
    const ch = fakeChannel((op, f) => {
      if (op === 'project_file_put') return { written: f.path };
      if (op === 'project_file_get') return { path: f.path, content: 'x', size: 1 };
      if (op === 'project_files') return [{ path: 'src/a.st', size: 3 }];
      if (op === 'project_file_delete') return { deleted: f.path };
      return undefined;
    });
    await pa.projectFilePut(ch, 'src/a.st', 'x');
    expect((await pa.projectFileGet(ch, 'src/a.st'))?.content).toBe('x');
    expect(await pa.projectFiles(ch)).toEqual([{ path: 'src/a.st', size: 3 }]);
    await pa.projectFileDelete(ch, 'src/a.st');
    const ops = ch.calls.map((c) => c.op);
    expect(ops).toEqual([
      'project_file_put',
      'project_file_get',
      'project_files',
      'project_file_delete',
    ]);
  });

  it('git ops decode status/log/diff/branch/commit', async () => {
    const ch = fakeChannel((op) => {
      switch (op) {
        case 'git_status':
          return [{ path: 'a.st', status: 'M', staged: false, index_status: ' ', workdir_status: 'M' }];
        case 'git_log':
          return [{ oid: 'abc', short: 'abc1234', author: 'a', email: 'e', time: 1, message: 'init' }];
        case 'git_diff':
          return { diff: '+x' };
        case 'git_branch':
          return { branch: 'main' };
        case 'git_commit':
          return { short: 'abc1234' };
        default:
          return undefined;
      }
    });
    expect((await pa.gitStatus(ch))[0].path).toBe('a.st');
    expect((await pa.gitLog(ch))[0].short).toBe('abc1234');
    expect(await pa.gitDiff(ch)).toBe('+x');
    expect(await pa.gitBranch(ch)).toBe('main');
    expect(await pa.gitCommit(ch, 'msg')).toBe('abc1234');
  });

  it('git ops degrade to empty on error', async () => {
    const bad = fakeChannel(() => {
      throw new Error('not a repo');
    });
    expect(await pa.gitStatus(bad)).toEqual([]);
    expect(await pa.gitLog(bad)).toEqual([]);
    expect(await pa.gitDiff(bad)).toBeNull();
    expect(await pa.gitBranch(bad)).toBe('');
    expect(await pa.gitCommit(bad, 'm')).toBeUndefined();
    expect(await pa.projectsRecent(bad)).toEqual([]);
  });
});

describe('store remote persistence', () => {
  it('saveProjectRemote merges ui into the manifest and saves', async () => {
    const p = project();
    const ch = fakeChannel((op, f) => {
      if (op === 'project_get') return { root: '/p', name: 'p', manifest: { name: 'p', sources: ['src/main.st'] } };
      if (op === 'project_save') return { saved: true };
      return undefined;
    });
    expect(await saveProjectRemote(ch, p)).toBe(true);
    const save = ch.calls.find((c) => c.op === 'project_save');
    const m = (save!.fields.manifest ?? {}) as Record<string, unknown>;
    expect(m.name).toBe('p');
    expect(m.sources).toEqual(['src/main.st']);
    expect(m.ui).toBeDefined();
  });

  it('saveProjectRemote returns false with no project open', async () => {
    const ch = fakeChannel(() => {
      throw new Error('no project');
    });
    expect(await saveProjectRemote(ch, project())).toBe(false);
  });

  it('loadRemoteProject hydrates a persisted ui document', async () => {
    const p = project();
    const ch = fakeChannel((op) =>
      op === 'project_get'
        ? { root: '/p', name: 'p', manifest: { name: 'p', ui: JSON.parse(JSON.stringify(p)) } }
        : undefined,
    );
    const got = await loadRemoteProject(ch);
    expect(got?.fbd.project).toBe('demo');
    expect(got?.stSources.Main).toContain('PROGRAM Main');
  });

  it('loadRemoteProject returns undefined for missing/invalid ui', async () => {
    const noUi = fakeChannel((op) =>
      op === 'project_get' ? { root: '/p', name: 'p', manifest: { name: 'p' } } : undefined,
    );
    expect(await loadRemoteProject(noUi)).toBeUndefined();
    const badUi = fakeChannel((op) =>
      op === 'project_get' ? { root: '/p', name: 'p', manifest: { ui: { nope: 1 } } } : undefined,
    );
    expect(await loadRemoteProject(badUi)).toBeUndefined();
    const down = fakeChannel(() => {
      throw new Error('down');
    });
    expect(await loadRemoteProject(down)).toBeUndefined();
  });

  it('remoteProjectInfo passes through project_get', async () => {
    const info = { root: '/p', name: 'p', manifest: {} };
    const ch = fakeChannel((op) => (op === 'project_get' ? info : undefined));
    expect(await remoteProjectInfo(ch)).toEqual(info);
  });
});
