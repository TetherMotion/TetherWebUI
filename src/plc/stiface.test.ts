import { describe, expect, it } from 'vitest';
import { isLibPou, parseStInterfaces } from './stiface';

const SRC = `
(* header comment with FUNCTION_BLOCK FakeInside *)
FUNCTION_BLOCK MyFb
VAR_INPUT
    A, B : REAL;   // two pins on one line
    G : BOOL;
END_VAR
VAR_OUTPUT
    Q : LREAL;
END_VAR
VAR_IN_OUT
    Buf : ARRAY[1..4] OF INT;
END_VAR
VAR
    tmp : DINT;
END_VAR
    Q := A + B;
END_FUNCTION_BLOCK

FUNCTION Fn : LREAL
VAR_INPUT X : REAL; END_VAR
Fn := X;
END_FUNCTION
`;

describe('parseStInterfaces', () => {
  it('extracts FB and FUNCTION interfaces', () => {
    const pous = parseStInterfaces([SRC]);
    expect(pous.map((p) => p.name)).toEqual(['MyFb', 'Fn']);
    const fb = pous[0]!;
    expect(fb.kind).toBe('function_block');
    expect(fb.interface).toEqual([
      { name: 'A', kind: 'var_input', type: 'REAL' },
      { name: 'B', kind: 'var_input', type: 'REAL' },
      { name: 'G', kind: 'var_input', type: 'BOOL' },
      { name: 'Q', kind: 'var_output', type: 'LREAL' },
      { name: 'Buf', kind: 'var_in_out', type: 'ARRAY[1..4] OF INT' },
    ]);
    // locals are not pins
    expect(fb.interface.some((v) => v.name === 'tmp')).toBe(false);
    const fn = pous[1]!;
    expect(fn.kind).toBe('function');
    expect(fn.ret_ty).toBe('LREAL');
    expect(isLibPou(fb)).toBe(true);
  });

  it('ignores declarations inside comments and de-duplicates', () => {
    const pous = parseStInterfaces([SRC, SRC]);
    expect(pous.map((p) => p.name)).toEqual(['MyFb', 'Fn']);
    expect(pous.some((p) => p.name === 'FakeInside')).toBe(false);
  });

  it('returns nothing for source without POUs', () => {
    expect(parseStInterfaces(['PROGRAM Main\nEND_PROGRAM\n'])).toEqual([]);
  });
});
