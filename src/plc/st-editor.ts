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
} from '@codemirror/view';
import { Compartment, EditorState } from '@codemirror/state';
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

export class StEditor extends LitElement {
  declare value: string;
  /** ms to debounce `change` emissions while typing */
  declare debounceMs: number;
  /** project symbols for autocompletion (POU + interface var names) */
  declare symbols: StSymbols;

  static properties = {
    value: { attribute: false },
    debounceMs: { type: Number },
    symbols: { attribute: false },
  };

  private view?: EditorView;
  private symbolsComp = new Compartment();
  private debounceTimer?: number;
  private applying = false;

  constructor() {
    super();
    this.value = '';
    this.debounceMs = 400;
    this.symbols = { pous: [], vars: [] };
  }

  updated(changed: Map<string, unknown>): void {
    if (changed.has('symbols') && this.view)
      this.view.dispatch({
        effects: this.symbolsComp.reconfigure(stCompletion(this.symbols)),
      });
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
