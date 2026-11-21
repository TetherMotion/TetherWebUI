import { describe, expect, it } from 'vitest';
import {
  wordAt, lineCol, declaredPous, stVarSections, stWorld,
  signatureAt, findDefinition, findUsages, renameInSource,
} from './stnav';
import { FbdProject } from './model';

const SRC_MAIN = `PROGRAM Main
VAR_INPUT
  start : BOOL;
  sp    : REAL;
END_VAR
VAR
  cnt : INT;
  fb1 : FB_AtcPid;
END_VAR
fb1(sp := sp, pv := pv);
x := cnt + 1;
END_PROGRAM`;

const SRC_PID = `FUNCTION_BLOCK FB_AtcPid
VAR_INPUT
  sp : REAL;
  pv : REAL;
END_VAR
VAR_OUTPUT
  out : REAL;
END_VAR
out := sp - pv;
END_FUNCTION_BLOCK`;

function proj(): { fbd: FbdProject; stSources: Record<string, string> } {
  return {
    fbd: {
      version: 'fbd.v1', name: 't', pous: [
        { id: 'p1', name: 'Main', kind: 'program', en_eno: 'inherit', interface: [
          { name: 'start', type: 'BOOL', kind: 'var_input' },
        ], networks: [{ id: 'n1', kind: 'fbd', label: '', comments: [], assocs: [], labels: [], jumps: [], returns: [], blocks: [], wires: [] }] },
      ], tasks: [], globals: [],
    } as unknown as FbdProject,
    stSources: { Main: SRC_MAIN, FB_AtcPid: SRC_PID },
  };
}

describe('stnav', () => {
  it('wordAt finds identifiers and member parts', () => {
    const w = wordAt('x := fb1.sp + 1;', 10);
    expect(w?.text).toBe('sp');
    expect(w?.from).toBe(9);
    const w2 = wordAt('cnt := 3;', 2);
    expect(w2?.text).toBe('cnt');
  });

  it('lineCol reports 1-based line/col', () => {
    expect(lineCol('a\nb\nc', 4)).toEqual({ line: 3, col: 1 });
  });

  it('declaredPous + stVarSections parse decls', () => {
    const d = declaredPous(SRC_PID);
    expect(d[0]).toMatchObject({ name: 'FB_AtcPid', kind: 'function_block' });
    const secs = stVarSections(SRC_MAIN);
    expect(secs.map((s) => s.section)).toEqual(['VAR_INPUT', 'VAR']);
    expect(secs[0]!.decls.map((d) => d.names)).toEqual([['start'], ['sp']]);
    expect(secs[1]!.decls.map((d) => d.names)).toEqual([['cnt'], ['fb1']]);
  });

  it('signatureAt resolves a call inside parens', () => {
    const w = stWorld(proj());
    const src = SRC_MAIN;
    const pos = src.indexOf('fb1(sp') + 4; // inside the call
    const sig = signatureAt(w, src, pos);
    expect(sig?.name).toBe('FB_AtcPid');
    expect(sig?.sig).toContain('sp: REAL');
  });

  it('findDefinition resolves POU calls, vars, and member access', () => {
    const w = stWorld(proj());
    const src = SRC_MAIN;
    // call site of fb1 → FB_AtcPid decl offset
    const callPos = src.indexOf('fb1(sp');
    const def = findDefinition(w, 'Main', src, callPos);
    expect(def).toMatchObject({ kind: 'pou', pou: 'FB_AtcPid' });
    // var decl `sp` inside VAR_INPUT
    const spPos = src.indexOf('sp :=');
    const vdef = findDefinition(w, 'Main', src, spPos);
    expect(vdef).toMatchObject({ kind: 'var', name: 'sp', section: 'VAR_INPUT' });
    // member access fb1.sp → member target
    const memSrc = 'x := fb1.sp;';
    const mpos = memSrc.indexOf('sp') + 1;
    const mdef = findDefinition(w, 'Main', memSrc, mpos);
    expect(mdef).toMatchObject({ kind: 'member', instance: 'fb1', member: 'sp' });
  });

  it('findUsages lists word-boundary hits across sources, skipping decl kw', () => {
    const w = stWorld(proj());
    const usages = findUsages(w, 'sp');
    const where = usages.map((u) => u.where);
    expect(where).toContain('st:Main');
    expect(where).toContain('st:FB_AtcPid');
    // decl `sp : REAL` hits too (textual index) — count >= uses
    expect(usages.length).toBeGreaterThanOrEqual(3);
  });

  it('renameInSource renames identifiers but not comments', () => {
    const src = 'x := cnt; // cnt stays\n(* cnt *)\ncnt := 2;';
    const out = renameInSource(src, 'cnt', 'n2');
    expect(out).toContain('x := n2;');
    expect(out).toContain('// cnt stays');
    expect(out).toContain('(* cnt *)');
    expect(out).toContain('n2 := 2;');
  });
});
