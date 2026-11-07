import { describe, expect, it } from 'vitest';
import { exportPlcopenXml, importPlcopenXml } from './plcopen';
import { emptyProject, FbdProject } from './model';

const BEREMIZ_FBD = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://www.plcopen.org/xml/tc6_0200">
  <fileHeader companyName="Beremiz" productName="Beremiz" productVersion="1" creationDateTime="2009-02-03T14:03:42"/>
  <contentHeader name="first_steps">
    <coordinateInfo>
      <fbd><scaling x="10" y="10"/></fbd>
    </coordinateInfo>
  </contentHeader>
  <types>
    <dataTypes/>
    <pous>
      <pou name="Main" pouType="program">
        <interface>
          <localVars>
            <variable name="Reset" type="BOOL"/>
            <variable name="OUT" type="INT"/>
          </localVars>
        </interface>
        <body>
          <FBD>
            <block localId="1" typeName="CounterFBD" instanceName="CounterFBD0" height="54" width="121">
              <position x="211" y="146"/>
              <inputVariables>
                <variable formalParameter="Reset">
                  <connectionPointIn>
                    <relPosition x="0" y="37"/>
                    <connection refLocalId="13"/>
                  </connectionPointIn>
                </variable>
                <variable formalParameter="Inc">
                  <connectionPointIn negated="true">
                    <expression>1</expression>
                  </connectionPointIn>
                </variable>
              </inputVariables>
              <outputVariables>
                <variable formalParameter="OUT">
                  <connectionPointOut/>
                </variable>
              </outputVariables>
            </block>
            <inVariable localId="13" height="30" width="79">
              <position x="35" y="170"/>
              <connectionPointOut><relPosition x="79" y="15"/></connectionPointOut>
              <expression>Reset</expression>
            </inVariable>
            <outVariable localId="20" height="30" width="79">
              <position x="420" y="146"/>
              <connectionPointIn>
                <connection refLocalId="1" formalParameter="OUT"/>
              </connectionPointIn>
              <expression>OUT</expression>
            </outVariable>
          </FBD>
        </body>
      </pou>
      <pou name="AverageVal" pouType="function">
        <interface>
          <inputVars>
            <variable name="Cnt" type="INT"/>
          </inputVars>
          <outputVars>
            <variable name="AverageVal" type="INT"/>
          </outputVars>
        </interface>
        <body>
          <ST>
            <xhtml><![CDATA[AverageVal := Cnt;]]></xhtml>
          </ST>
        </body>
      </pou>
    </pous>
  </types>
</project>`;

describe('importPlcopenXml', () => {
  it('imports a Beremiz-style FBD pou', () => {
    const { project, notes } = importPlcopenXml(BEREMIZ_FBD);
    expect(project.project).toBe('first_steps');
    expect(project.pous).toHaveLength(2);

    const main = project.pous[0]!;
    expect(main.kind).toBe('program');
    expect(main.interface.map((v) => v.name)).toEqual(['Reset', 'OUT']);

    const net = main.networks[0]!;
    expect(net.blocks).toHaveLength(3);
    const fb = net.blocks.find((b) => b.id === 1)!;
    expect(fb.kind).toBe('fb');
    expect(fb.type_ref).toBe('CounterFBD');
    expect(fb.instance).toBe('CounterFBD0');
    expect(fb.pos).toEqual({ x: 211, y: 146 });
    // Inc pin has an expression → literal param; negated named pin is
    // not representable in negated: number[] (same as the Rust importer)
    expect(fb.params.Inc).toBe('1');
    expect(fb.negated).toEqual([]);

    const varIn = net.blocks.find((b) => b.id === 13)!;
    expect(varIn.kind).toBe('variable');
    expect(varIn.role).toBe('in');
    expect(varIn.name).toBe('Reset');

    const varOut = net.blocks.find((b) => b.id === 20)!;
    expect(varOut.role).toBe('out');
    expect(varOut.name).toBe('OUT');

    // wire: var-in 13 → fb.Reset (named port); fb.OUT → var-out 20
    const wReset = net.wires.find((w) => w.src.block === 13)!;
    expect(wReset.dsts).toEqual([{ block: 1, port: 'Reset' }]);
    const wOut = net.wires.find((w) => w.src.block === 1)!;
    expect(wOut.src.port).toBe('OUT');
    expect(wOut.dsts).toEqual([{ block: 20, port: 0 }]);

    // ST body of the function reported as a note
    expect(notes.some((n) => n.includes('AverageVal') && n.includes('ST'))).toBe(true);
    expect(project.pous[1]!.kind).toBe('function');
  });

  it('splits networks on --- net --- markers and skips empty ones', () => {
    const xml = `<?xml version="1.0"?>
<project><contentHeader name="m"/><types><pous>
<pou name="P" pouType="program"><interface/><body><FBD>
  <comment localId="90"><position x="0" y="0"/><content><xhtml>--- net one ---</xhtml></content></comment>
  <inVariable localId="1"><position x="0" y="0"/><expression>A</expression></inVariable>
  <comment localId="91"><position x="0" y="50"/><content><xhtml>--- net two ---</xhtml></content></comment>
  <inVariable localId="2"><position x="0" y="60"/><expression>B</expression></inVariable>
</FBD></body></pou></pous></types></project>`;
    const { project } = importPlcopenXml(xml);
    const nets = project.pous[0]!.networks;
    expect(nets).toHaveLength(2);
    expect(nets[0]!.id).toBe('one');
    expect(nets[0]!.blocks[0]!.name).toBe('A');
    expect(nets[1]!.id).toBe('two');
    expect(nets[1]!.blocks[0]!.name).toBe('B');
    // marker comments are dropped, not imported as comments
    expect(nets[0]!.comments).toHaveLength(0);
  });

  it('maps labels, jumps, returns and rejects non-projects', () => {
    const xml = `<?xml version="1.0"?>
<project><contentHeader name="n"/><types><pous>
<pou name="P" pouType="program"><interface/><body><FBD>
  <label localId="1" label="Top"><position x="5" y="5"/></label>
  <jump localId="2" label="Top"><position x="50" y="5"/></jump>
  <return localId="3"><position x="90" y="5"/></return>
  <leftPowerRail localId="4"><position x="0" y="0"/></leftPowerRail>
</FBD></body></pou></pous></types></project>`;
    const { project, notes } = importPlcopenXml(xml);
    const net = project.pous[0]!.networks[0]!;
    expect(net.labels[0]!.name).toBe('Top');
    expect(net.jumps[0]!.target).toBe('Top');
    expect(net.returns).toHaveLength(1);
    expect(notes.some((n) => n.includes('leftPowerRail'))).toBe(true);
  });

  it('imports tasks and global vars', () => {
    const xml = `<?xml version="1.0"?>
<project xmlns:tether="http://tether.dev/plc/tc6ext"><contentHeader name="t"/>
<types><globalVars><variable name="G" type="DINT" address="%MD0"/></globalVars>
<pous><pou name="P" pouType="program"><interface/><body><FBD/></body></pou></pous></types>
<addData><data name="tether:tasks" handleUnknown="implementation">
<tether:task name="FAST" period_ns="10000000" priority="5">
  <tether:program ref="P"/>
</tether:task></data></addData></project>`;
    const { project } = importPlcopenXml(xml);
    expect(project.global_vars[0]).toMatchObject({
      name: 'G',
      kind: 'var_global',
      type: 'DINT',
      at: '%MD0',
    });
    expect(project.tasks[0]).toEqual({
      name: 'FAST',
      period_ns: 10000000,
      priority: 5,
      programs: ['P'],
    });
  });

  it('throws on malformed and non-project XML', () => {
    expect(() => importPlcopenXml('<<<not xml')).toThrow();
    expect(() => importPlcopenXml('<foo><bar/></foo>')).toThrow();
    expect(() =>
      importPlcopenXml('<project><contentHeader name="x"/><types><pous></pous></types></project>'),
    ).toThrow();
  });
});

describe('exportPlcopenXml', () => {
  const demo = (): FbdProject => {
    const p = emptyProject('roundtrip_demo');
    p.pous.push({
      id: 'MAIN',
      name: 'MAIN',
      kind: 'program',
      en_eno: 'inherit',
      interface: [
        { name: 'Start', kind: 'var', type: 'BOOL', at: '%IX0.0' },
        { name: 'Heat', kind: 'var', type: 'BOOL', at: '%QX0.0' },
      ],
      networks: [
        {
          id: 'net1',
          kind: 'fbd',
          label: '',
          comments: [{ id: 50, pos: { x: 4, y: 4 }, text: 'hello & <world>' }],
          assocs: [],
          labels: [{ id: 51, pos: { x: 0, y: 0 }, name: 'L1' }],
          jumps: [{ id: 52, pos: { x: 9, y: 0 }, target: 'L1' }],
          returns: [{ id: 53, pos: { x: 10, y: 0 } }],
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
              role: 'in',
              name: 'Start',
              at: '%IX0.0',
            },
            {
              id: 2,
              kind: 'fb',
              type_ref: 'TON',
              instance: 'T1',
              pos: { x: 4, y: 0 },
              params: { PT: 'T#200ms' },
              exec_order: 0,
              negated: [1],
              comment: '',
            },
            {
              id: 3,
              kind: 'variable',
              type_ref: '',
              pos: { x: 8, y: 0 },
              params: {},
              exec_order: 0,
              negated: [],
              comment: '',
              role: 'out',
              name: 'Heat',
              at: '%QX0.0',
            },
            {
              id: 4,
              kind: 'variable',
              type_ref: '',
              pos: { x: 8, y: 2 },
              params: {},
              exec_order: 0,
              negated: [],
              comment: '',
              role: 'out',
              name: 'Fan2',
            },
          ],
          wires: [
            {
              id: 20,
              src: { block: 1, port: 0 },
              dsts: [
                { block: 2, port: 'IN' },
                { block: 4, port: 0 },
              ],
              probe: true,
            },
            { id: 21, src: { block: 2, port: 'Q' }, dsts: [{ block: 3, port: 0 }] },
          ],
        },
      ],
    });
    p.tasks.push({ name: 'CYC', period_ns: 20000000, programs: ['MAIN'], priority: 3 });
    return p;
  };

  it('round-trips blocks, fan-out wires, params, negation, probes, annotations', () => {
    const src = demo();
    const xml = exportPlcopenXml(src);
    const { project: back } = importPlcopenXml(xml);
    const net = back.pous[0]!.networks[0]!;

    expect(back.project).toBe('roundtrip_demo');
    expect(net.blocks).toHaveLength(4);
    const ton = net.blocks.find((b) => b.type_ref === 'TON')!;
    expect(ton.instance).toBe('T1');
    expect(ton.params.PT).toBe('T#200ms');

    // fan-out wire merged back into one Wire via tether:wire ids
    const fanout = net.wires.find((w) => w.src.block === 1)!;
    expect(fanout.dsts).toHaveLength(2);
    expect(fanout.probe).toBe(true);
    const tonWire = net.wires.find((w) => w.src.block === 2)!;
    expect(tonWire.src.port).toBe('Q');
    expect(tonWire.dsts[0]!.block).toBe(3);

    expect(net.comments[0]!.text).toBe('hello & <world>');
    expect(net.labels[0]!.name).toBe('L1');
    expect(net.jumps[0]!.target).toBe('L1');
    expect(net.returns).toHaveLength(1);
    expect(back.tasks[0]!.programs).toEqual(['MAIN']);
    // var blocks carry at + tether:name
    const start = net.blocks.find((b) => b.role === 'in')!;
    expect(start.at).toBe('%IX0.0');
    expect(start.name).toBe('Start');
  });

  it('emits valid XML that reparses without error', () => {
    const xml = exportPlcopenXml(demo());
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    expect(doc.documentElement.localName).toBe('project');
  });
});
