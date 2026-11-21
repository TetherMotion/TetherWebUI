/**
 * <st-editor> — CodeMirror 6 editor for IEC structured text.
 * Light-DOM Lit wrapper: `.value` in, `change` events out (debounced).
 * Uses the StreamLanguage ST mode from st-lang.ts — highlighting,
 * line numbers, bracket matching, folding, indent-on-input.
 */
import { LitElement } from 'lit';
import {
  EditorView,
  lineNumbers,
  highlightActiveLine,
  keymap,
  drawSelection,
  hoverTooltip,
} from '@codemirror/view';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { st } from './st-lang';
import { stCompletion, StSymbols } from './st-complete';
import { signatureAt, findDefinition, findUsages, wordAt } from './stnav';
import type { StWorld, DefTarget, Usage } from './stnav';

/** detail payload of the `st-nav` event the IDE listens for. */
export interface StNavEvent {
  action: 'goto' | 'usages' | 'rename';
  target?: DefTarget;
  name?: string;
  usages?: Usage[];
  from?: number;
  to?: number;
}

export class StEditor extends LitElement {
  declare value: string;
  /** ms to debounce `change` emissions while typing */
  declare debounceMs: number;
  /** project symbols for autocompletion (POU + interface var names) */
  declare symbols: StSymbols;
  /** semantic nav world (POUs + stSources) for calltips/goto/usages */
  declare world: StWorld | undefined;
  /** name of the POU this editor buffer belongs to */
  declare pouName: string;

  static properties = {
    value: { attribute: false },
    debounceMs: { type: Number },
    symbols: { attribute: false },
    world: { attribute: false },
    pouName: { attribute: false },
  };

  private view?: EditorView;
  private symbolsComp = new Compartment();
  private navComp = new Compartment();
  private debounceTimer?: number;
  private applying = false;

  /**
   * Commit a pending debounced edit synchronously. The IDE calls this
   * before compiling and before unmounting the editor on pane switches —
   * otherwise the last <debounceMs of typing is silently dropped.
   */
  flushPending(): void {
    if (this.debounceTimer === undefined || !this.view) return;
    window.clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    this.value = this.view.state.doc.toString();
    this.dispatchEvent(
      new CustomEvent('change', { detail: this.value, bubbles: true, composed: true }),
    );
  }

  constructor() {
    super();
    this.value = '';
    this.debounceMs = 400;
    this.symbols = { pous: [], vars: [] };
    this.world = undefined;
    this.pouName = '';
  }

  updated(changed: Map<string, unknown>): void {
    if (changed.has('symbols') && this.view)
      this.view.dispatch({
        effects: this.symbolsComp.reconfigure(stCompletion(this.symbols)),
      });
    if ((changed.has('world') || changed.has('pouName')) && this.view)
      this.view.dispatch({ effects: this.navComp.reconfigure(this.navExt()) });
  }

  /** semantic-nav extensions: signature hover + F12/Shift-F12/F2 keys.
      Results are emitted as `st-nav` events — the IDE owns navigation
      (POU switching) and rename application. */
  private navExt() {
    return [
      hoverTooltip(
        (view, pos) => {
          const w = this.world;
          if (!w || !this.pouName) return null;
          const s = signatureAt(w, view.state.doc.toString(), pos);
          if (!s) return null;
          return {
            pos: s.from,
            end: s.to,
            above: true,
            create: () => {
              const dom = document.createElement('div');
              dom.className = 'st-tooltip';
              dom.textContent = `${s.name} — ${s.sig}`;
              return { dom };
            },
          };
        },
        { hoverTime: 250 },
      ),
      Prec.high(
        keymap.of([
          { key: 'F12', run: (v) => this.navAction(v, 'goto') },
          { key: 'Shift-F12', run: (v) => this.navAction(v, 'usages') },
          { key: 'F2', run: (v) => this.navAction(v, 'rename') },
        ]),
      ),
    ];
  }

  private navAction(view: EditorView, action: StNavEvent['action']): boolean {
    const w = this.world;
    const pn = this.pouName;
    if (!w || !pn) return false;
    const doc = view.state.doc.toString();
    const pos = view.state.selection.main.head;
    const word = wordAt(doc, pos);
    if (!word) return false;
    const detail: StNavEvent = { action };
    if (action === 'goto') {
      const t = findDefinition(w, pn, doc, pos);
      if (!t) return false;
      detail.target = t;
    } else if (action === 'usages') {
      detail.name = word.text;
      detail.usages = findUsages(w, word.text);
      if (!detail.usages.length) return false;
    } else {
      detail.name = word.text;
      detail.from = word.from;
      detail.to = word.to;
    }
    this.dispatchEvent(
      new CustomEvent('st-nav', { detail, bubbles: true, composed: true }),
    );
    return true;
  }

  createRenderRoot(): this {
    return this;
  }

  firstUpdated(): void {
    this.view = new EditorView({
      parent: this,
      state: EditorState.create({
        doc: this.value,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          drawSelection(),
          history(),
          foldGutter(),
          lintGutter(),
          indentOnInput(),
          bracketMatching(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          st(),
          this.symbolsComp.of(stCompletion(this.symbols)),
          this.navComp.of(this.navExt()),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged || this.applying) return;
            window.clearTimeout(this.debounceTimer);
            this.debounceTimer = window.setTimeout(() => {
              this.value = u.state.doc.toString();
              this.dispatchEvent(
                new CustomEvent('change', { detail: this.value, bubbles: true, composed: true }),
              );
            }, this.debounceMs);
          }),
        ],
      }),
    });
  }

  willUpdate(changed: Map<string, unknown>): void {
    if (changed.has('value') && this.view) {
      const cur = this.view.state.doc.toString();
      if (cur !== this.value) {
        this.applying = true;
        this.view.dispatch({ changes: { from: 0, to: cur.length, insert: this.value } });
        this.applying = false;
      }
    }
  }

  /** replace the lint markers (compile diags, from the check button). */
  setDiags(diags: Diagnostic[]): void {
    if (this.view) {
      this.view.dispatch(setDiagnostics(this.view.state, diags));
    }
  }

  /** move the caret to a byte offset and scroll it into view. */
  jumpTo(offset: number): void {
    if (!this.view) return;
    const pos = Math.min(Math.max(0, offset), this.view.state.doc.length);
    this.view.dispatch({
      selection: { anchor: pos },
      scrollIntoView: true,
    });
    this.view.focus();
  }

  disconnectedCallback(): void {
    window.clearTimeout(this.debounceTimer);
    this.view?.destroy();
    this.view = undefined;
    super.disconnectedCallback();
  }
}

customElements.define('st-editor', StEditor);
