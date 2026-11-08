/**
 * ST autocompletion: IEC keywords, elementary types, builtin FBs and
 * operators (from sigs), plus project symbols (POU names, interface
 * vars) supplied by the IDE. Tokenizer-level, not scope-aware — a real
 * grammar/language server can replace `override` later.
 */
import { autocompletion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { Extension } from '@codemirror/state';
import { KEYWORD_LIST, TYPE_LIST } from './st-lang';
import { BUILTIN_FB_NAMES } from './sigs';

export interface StSymbols {
  pous: string[];
  vars: string[];
}

const STATIC_OPTS = [
  ...KEYWORD_LIST.map((label) => ({ label, type: 'keyword' })),
  ...TYPE_LIST.map((label) => ({ label, type: 'type' })),
  ...BUILTIN_FB_NAMES.map((label) => ({ label, type: 'function' })),
];

export function stCompletion(symbols: StSymbols): Extension {
  const opts = [
    ...STATIC_OPTS,
    ...symbols.pous.map((label) => ({ label, type: 'class' })),
    ...symbols.vars.map((label) => ({ label, type: 'variable' })),
  ];
  return autocompletion({
    override: [
      (ctx: CompletionContext): CompletionResult | null => {
        const word = ctx.matchBefore(/[A-Za-z_][A-Za-z0-9_.]*/);
        if (!word || (word.from === word.to && !ctx.explicit)) return null;
        return { from: word.from, options: opts, validFor: /^[A-Za-z0-9_.]*$/ };
      },
    ],
  });
}
