/**
 * Structured Text language mode for CodeMirror 6 via StreamLanguage —
 * a tokenizer, not a full grammar. Highlights IEC 61131-3 keywords
 * (aligned with the ruSTy lexer set used by tplc-st), elementary type
 * names, literals (numeric bases, TIME, strings), comments, operators.
 */
import { StreamLanguage, StringStream } from '@codemirror/language';
import { HighlightStyle, LanguageSupport, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

const KEYWORDS = new Set([
  'ACTION',
  'END_ACTION',
  'AND',
  'ARRAY',
  'AT',
  'BY',
  'CASE',
  'CONFIGURATION',
  'CONSTANT',
  'CONTINUE',
  'DATE_AND_TIME',
  'DO',
  'DT',
  'ELSE',
  'ELSIF',
  'EN',
  'END_ACTION',
  'END_CASE',
  'END_CONFIGURATION',
  'END_FOR',
  'END_FUNCTION',
  'END_FUNCTION_BLOCK',
  'END_IF',
  'END_PROGRAM',
  'END_REPEAT',
  'END_RESOURCE',
  'END_STRUCT',
  'END_TYPE',
  'END_VAR',
  'END_WHILE',
  'ENO',
  'EXIT',
  'FALSE',
  'FOR',
  'FUNCTION',
  'FUNCTION_BLOCK',
  'GLOBAL',
  'IF',
  'INTERVAL',
  'MOD',
  'NON_RETAIN',
  'NOT',
  'OF',
  'ON',
  'OR',
  'PERSISTENT',
  'PROGRAM',
  'READ_ONLY',
  'READ_WRITE',
  'REPEAT',
  'RESOURCE',
  'RETAIN',
  'RETURN',
  'STRUCT',
  'TASK',
  'THEN',
  'TO',
  'TRUE',
  'TYPE',
  'UNTIL',
  'VAR',
  'VAR_ACCESS',
  'VAR_CONFIG',
  'VAR_EXTERNAL',
  'VAR_GLOBAL',
  'VAR_IN_OUT',
  'VAR_INPUT',
  'VAR_OUTPUT',
  'VAR_TEMP',
  'WHILE',
  'WITH',
  'XOR',
]);

const TYPES = new Set([
  'BOOL',
  'BYTE',
  'CHAR',
  'DATE',
  'DINT',
  'DWORD',
  'INT',
  'LINT',
  'LREAL',
  'LWORD',
  'REAL',
  'SINT',
  'STRING',
  'TIME',
  'TIME_OF_DAY',
  'TOD',
  'UDINT',
  'UINT',
  'ULINT',
  'USINT',
  'WCHAR',
  'WORD',
  'WSTRING',
]);

export const KEYWORD_LIST = [...KEYWORDS];
export const TYPE_LIST = [...TYPES];

interface StState {
  inComment: boolean;
}

function tokenWord(w: string): string | null {
  const u = w.toUpperCase();
  if (KEYWORDS.has(u)) return 'keyword';
  if (TYPES.has(u)) return 'typeName';
  return null;
}

export const stLanguage = StreamLanguage.define<StState>({
  name: 'st',
  startState: (): StState => ({ inComment: false }),
  token(stream: StringStream, state: StState): string | null {
    if (state.inComment) {
      if (stream.match(/^.*?\*\//)) state.inComment = false;
      else stream.skipToEnd();
      return 'comment';
    }
    if (stream.eatSpace()) return null;
    const ch = stream.next()!;
    if (ch === '(' && stream.eat('*')) {
      state.inComment = true;
      if (stream.match(/^.*?\*\//)) state.inComment = false;
      else stream.skipToEnd();
      return 'comment';
    }
    if (ch === '/' && stream.eat('/')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (ch === "'" || ch === '"') {
      while (!stream.eol()) {
        const c = stream.next();
        if (c === ch) break;
        if (c === '$') stream.next();
      }
      return 'string';
    }
    // typed/base literals: T#200ms, 16#FF, 2#1010, TIME#1s, D#2024-01-01
    if (/[A-Za-z0-9_]/.test(ch)) {
      stream.eatWhile(/[A-Za-z0-9_.]/);
      const w = stream.current();
      if (stream.eat('#')) {
        stream.eatWhile(/[A-Za-z0-9_.]/);
        return 'number';
      }
      if (/^\d/.test(w)) return 'number';
      return tokenWord(w) ?? 'variableName';
    }
    // multi-char operators
    if (ch === ':' && stream.eat('=')) return 'operator';
    if (ch === '=' && stream.eat('>')) return 'operator';
    if ((ch === '<' || ch === '>') && (stream.eat('=') || stream.eat('>'))) return 'operator';
    if (ch === '.' && stream.eat('.')) return 'operator';
    if (':=<>+-*/&^%(),;[].'.includes(ch)) return 'operator';
    return null;
  },
  languageData: {
    commentTokens: { line: '//', block: { open: '(*', close: '*)' } },
  },
});

/** Colors keyed to the app theme variables. */
const stHighlight = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--blue)' },
  { tag: t.typeName, color: 'var(--mint)' },
  { tag: t.string, color: '#c98a3f' },
  { tag: t.number, color: '#b48ead' },
  { tag: t.comment, color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: t.variableName, color: 'var(--text)' },
  { tag: t.operator, color: 'var(--text-muted)' },
]);

export function st(): LanguageSupport {
  return new LanguageSupport(stLanguage, [syntaxHighlighting(stHighlight)]);
}
