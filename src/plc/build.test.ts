import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  byteToOffset,
  compileProject,
  diagsForFile,
  encodeSrcFrame,
  projectSources,
} from './build';
import type { PlcProject } from './store';
import { emptyProject } from './model';

const dec = new TextDecoder();

function decodeSrcFrame(buf: ArrayBuffer): { name: string; content: string }[] {
  const b = new Uint8Array(buf);
  const dv = new DataView(buf);
  const count = dv.getUint16(0, true);
  let o = 2;
  const out = [];
  for (let i = 0; i < count; i++) {
    const nl = dv.getUint16(o, true);
    o += 2;
    const name = dec.decode(b.subarray(o, o + nl));
    o += nl;
    const len = dv.getUint32(o, true);
    o += 4;
    out.push({ name, content: dec.decode(b.subarray(o, o + len)) });
    o += len;
  }
  return out;
}

const proj = (over: Partial<PlcProject> = {}): PlcProject => ({
  fbd: emptyProject('demo'),
  stSources: {},
  ...over,
});

describe('encodeSrcFrame', () => {
  it('round-trips file names and utf8 contents', () => {
    const files = [
      { name: 'a.st', content: 'PROGRAM A\nEND_PROGRAM\n' },
      { name: 'b.st', content: 'x := 16#FF; (* ünïcode *)' },
    ];
    expect(decodeSrcFrame(encodeSrcFrame(files))).toEqual(files);
  });
});

describe('byteToOffset / diagsForFile', () => {
  it('maps utf8 byte offsets to string positions', () => {
    // 'ü' is 2 bytes: byte offset of 'x' differs from its string index
    const src = 'üx';
    expect(byteToOffset(src, 2)).toBe(1); // after ü (bytes 0,1)
    expect(byteToOffset(src, 3)).toBe(2); // after x
    expect(byteToOffset(src, 0)).toBe(0);
    expect(byteToOffset(src, 99)).toBe(2); // clamped
  });

  it('converts compile diags to editor ranges', () => {
    const src = 'PROGRAM P\ny := x;\nEND_PROGRAM\n';
    const diags = diagsForFile(
      [
        {
          code: 'TPLC_E',
          severity: 'error',
          message: 'undeclared name y',
          help: 'did you mean x?',
          file: 'p.st',
          offset: 10,
          len: 1,
        },
        { code: 'TPLC_W', severity: 'note', message: 'other file', file: 'q.st', offset: 0 },
      ],
      'p.st',
      src,
    );
    expect(diags).toHaveLength(1);
    expect(src.slice(diags[0]!.from, diags[0]!.to)).toBe('y');
    expect(diags[0]!.severity).toBe('error');
    expect(diags[0]!.message).toContain('help: did you mean x?');
  });

  it('maps note severity to info', () => {
    const diags = diagsForFile(
      [{ code: 'W', severity: 'note', message: 'm', file: 'p.st', offset: 0, len: 1 }],
      'p.st',
      'ab',
    );
    expect(diags[0]!.severity).toBe('info');
  });
});

describe('projectSources', () => {
  it('sends one .fbd.json when no ST sources exist', () => {
    const p = proj();
    p.fbd.pous.push({
      id: 'p1',
      name: 'main',
      kind: 'program',
      en_eno: 'off',
      interface: [],
      networks: [],
    });
    const { files, notes } = projectSources(p);
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe('project.fbd.json');
    expect(JSON.parse(files[0]!.content).pous).toHaveLength(1);
    expect(notes).toHaveLength(0);
  });

  it('sends .st files per non-empty stSource', () => {
    const { files } = projectSources(
      proj({ stSources: { main: 'PROGRAM M\nEND_PROGRAM\n', helper: '' } }),
    );
    expect(files).toEqual([{ name: 'main.st', content: 'PROGRAM M\nEND_PROGRAM\n' }]);
  });

  it('notes a mixed ST/FBD project', () => {
    const p = proj({ stSources: { main: 'PROGRAM M\nEND_PROGRAM\n' } });
    p.fbd.pous.push({
      id: 'p1',
      name: 'f',
      kind: 'program',
      en_eno: 'off',
      interface: [],
      networks: [
        {
          id: 'n1',
          kind: 'fbd',
          label: '',
          blocks: [
            {
              id: 1,
              kind: 'variable',
              type_ref: '',
              pos: { x: 0, y: 0 },
              params: {},
              exec_order: 0,
              negated: [],
              comment: '',
            },
          ],
          wires: [],
          assocs: [],
          comments: [],
          labels: [],
          jumps: [],
          returns: [],
        },
      ],
    });
    const { notes, files } = projectSources(p);
    // mixed module: the fbd project and every .st compile together
    expect(files.map((f) => f.name)).toEqual(['project.fbd.json', 'main.st']);
    expect(notes).toHaveLength(0);
  });

  it('drops FBD stub POUs whose body lives in an stSource', () => {
    const p = proj({ stSources: { helper: 'FUNCTION_BLOCK helper\nEND_FUNCTION_BLOCK\n' } });
    p.fbd.pous.push({
      id: 'p1',
      name: 'helper',
      kind: 'function_block',
      en_eno: 'off',
      interface: [],
      networks: [
        {
          id: 'n1',
          kind: 'fbd',
          label: '',
          blocks: [],
          wires: [],
          assocs: [],
          comments: [],
          labels: [],
          jumps: [],
          returns: [],
        },
      ],
    });
    const { files } = projectSources(p);
    // stub dropped; no remaining fbd content → only the .st source goes
    expect(files).toEqual([{ name: 'helper.st', content: p.stSources.helper }]);
  });
});

describe('compileProject', () => {
  afterEach(() => vi.unstubAllGlobals());

  const mockFetch = (payload: unknown, status = 200) => {
    const f = vi.fn(async () => ({
      ok: status < 300,
      status,
      text: async () => 'err',
      json: async () => payload,
    }));
    vi.stubGlobal('fetch', f);
    return f;
  };

  it('posts to /compile and maps the envelope', async () => {
    const f = mockFetch({
      compile: {
        ok: false,
        errors: 1,
        diags: [
          { code: 'TPLC_E_X', severity: 'error', message: 'bad', file: 'a.st', line: 2, col: 1 },
        ],
      },
      exit: 1,
    });
    const r = await compileProject('http://p:8089', proj({ stSources: { a: 'x' } }));
    expect(f).toHaveBeenCalledWith(
      'http://p:8089/compile',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(r.ok).toBe(false);
    expect(r.diags[0]!.file).toBe('a.st');
    expect(r.package).toBeUndefined();
  });

  it('decodes the base64 package in build mode', async () => {
    const f = mockFetch({
      compile: { ok: true, errors: 0, diags: [] },
      exit: 0,
      package: btoa('\x01\x02\x03'),
    });
    const r = await compileProject('http://p:8089', proj(), true);
    expect(f).toHaveBeenCalledWith('http://p:8089/compile?build', expect.anything());
    expect(r.ok).toBe(true);
    expect(r.package).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('throws on HTTP errors', async () => {
    mockFetch({}, 502);
    await expect(compileProject('http://p:8089', proj())).rejects.toThrow('HTTP 502');
  });
});
