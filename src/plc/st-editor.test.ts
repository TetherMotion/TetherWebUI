import { describe, expect, it, vi } from 'vitest';
import './st-editor';
import type { StEditor } from './st-editor';
import { stLanguage } from './st-lang';
import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { forEachDiagnostic } from '@codemirror/lint';
import type { EditorView } from '@codemirror/view';

function mount(value: string): StEditor {
  const el = document.createElement('st-editor') as StEditor;
  el.value = value;
  document.body.appendChild(el);
  return el;
}

describe('st-editor', () => {
  it('mounts a CodeMirror view with the given source', async () => {
    const el = mount('PROGRAM Main\nEND_PROGRAM\n');
    await el.updateComplete;
    expect(el.querySelector('.cm-editor')).toBeTruthy();
    expect(el.querySelector('.cm-content')!.textContent).toContain('PROGRAM Main');
    el.remove();
  });

  it('emits change after edits (debounced)', async () => {
    vi.useFakeTimers();
    const el = mount('VAR x : INT; END_VAR\n');
    await el.updateComplete;
    let got = '';
    el.addEventListener('change', (e) => (got = (e as CustomEvent<string>).detail));
    const view = el.querySelector('.cm-content') as HTMLElement;
    // simulate a doc change via the internal view
    const ed = (el as unknown as { view: { dispatch: (c: unknown) => void } }).view;
    ed.dispatch({ changes: { from: 0, insert: '// hi\n' } });
    vi.advanceTimersByTime(500);
    expect(got).toContain('// hi');
    vi.useRealTimers();
    el.remove();
    void view;
  });

  it('setDiags stores lint markers at the given positions', async () => {
    const el = mount('PROGRAM P\ny := x;\nEND_PROGRAM\n');
    await el.updateComplete;
    el.setDiags([
      { from: 11, to: 12, severity: 'error', message: 'undeclared name y', source: 'TPLC_E' },
    ]);
    const view = (el as unknown as { view: EditorView }).view;
    const found: { from: number; to: number; msg: string }[] = [];
    forEachDiagnostic(view.state, (d, from, to) => {
      found.push({ from, to, msg: d.message });
    });
    expect(found).toEqual([{ from: 11, to: 12, msg: 'undeclared name y' }]);
    el.setDiags([]);
    const cleared: unknown[] = [];
    forEachDiagnostic(view.state, (d) => cleared.push(d));
    expect(cleared).toHaveLength(0);
    el.remove();
  });

  it('jumpTo moves the caret and clamps to the doc', async () => {
    const el = mount('abc\ndef\n');
    await el.updateComplete;
    const view = (el as unknown as { view: EditorView }).view;
    el.jumpTo(5);
    expect(view.state.selection.main.head).toBe(5);
    el.jumpTo(999);
    expect(view.state.selection.main.head).toBe(8);
    el.remove();
  });
});

describe('st language mode', () => {
  function tree(src: string) {
    const state = EditorState.create({ doc: src, extensions: [stLanguage] });
    return ensureSyntaxTree(state, src.length, 2000);
  }

  it('produces a syntax tree over a full ST program', () => {
    const src = `PROGRAM Main
VAR_INPUT
  start_in AT %IX0.0 : BOOL;
  PT : TIME := T#200ms;
END_VAR
VAR_OUTPUT
  run AT %QX0.0 : BOOL;
END_VAR
ton1(IN := start_in AND NOT stop_in, PT := PT);
run := ton1.Q;
IF run THEN cnt := cnt + 1; END_IF
END_PROGRAM`;
    const t = tree(src);
    expect(t).toBeTruthy();
    expect(t!.length).toBeGreaterThan(0);
  });
});
