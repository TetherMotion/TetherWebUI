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

describe('LD body import', () => {
  // (start OR hold) AND NOT stop -> run; rail-fed contacts have no
  // incoming wire (rail-powered), the NC contact merges two sources.
  const LD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://www.plcopen.org/xml/tc6_0201">
  <contentHeader name="ldtest"/>
  <types/>
  <pous>
    <pou name="LdDemo" pouType="program">
      <interface/>
      <body>
        <LD>
          <leftPowerRail localId="1" height="60" width="10">
            <position x="20" y="20"/>
            <connectionPointOut formalParameter="none"><relPosition x="10" y="20"/></connectionPointOut>
          </leftPowerRail>
          <contact localId="3" negated="false" storage="none" edge="none" height="15" width="21">
            <position x="60" y="30"/>
            <connectionPointIn><relPosition x="0" y="10"/><connection refLocalId="1"/></connectionPointIn>
            <connectionPointOut><relPosition x="21" y="10"/></connectionPointOut>
            <variable>%IX0.0</variable>
          </contact>
          <contact localId="4" negated="false" storage="none" edge="none" height="15" width="21">
            <position x="60" y="70"/>
            <connectionPointIn><relPosition x="0" y="10"/><connection refLocalId="1"/></connectionPointIn>
            <connectionPointOut><relPosition x="21" y="10"/></connectionPointOut>
            <variable>%IX0.1</variable>
          </contact>
          <contact localId="5" negated="true" storage="none" edge="none" height="15" width="21">
            <position x="120" y="30"/>
            <connectionPointIn>
              <relPosition x="0" y="10"/>
              <connection refLocalId="3"/>
              <connection refLocalId="4"/>
            </connectionPointIn>
            <connectionPointOut><relPosition x="21" y="10"/></connectionPointOut>
            <variable>%IX0.2</variable>
          </contact>
          <coil localId="6" negated="false" storage="none" height="15" width="21">
            <position x="180" y="30"/>
            <connectionPointIn><relPosition x="0" y="10"/><connection refLocalId="5"/></connectionPointIn>
            <connectionPointOut><relPosition x="21" y="10"/></connectionPointOut>
            <variable>%QX0.0</variable>
          </coil>
        </LD>
      </body>
    </pou>
  </pous>
</project>`;

  it('imports contacts/coils as variable blocks on a ladder network', () => {
    const { project, notes } = importPlcopenXml(LD_XML);
    expect(notes.filter((n) => n.includes('LD'))).toHaveLength(0);
    const pou = project.pous[0]!;
    expect(pou.networks).toHaveLength(1);
    const net = pou.networks[0]!;
    expect(net.kind).toBe('ld');
    expect(net.blocks).toHaveLength(4);
    const roles = net.blocks.map((b) => b.role);
    expect(roles.filter((r) => r === 'in')).toHaveLength(3);
    expect(roles.filter((r) => r === 'out')).toHaveLength(1);
    const ats = net.blocks.map((b) => b.at);
    for (const a of ['%IX0.0', '%IX0.1', '%IX0.2', '%QX0.0']) expect(ats).toContain(a);
    const nc = net.blocks.find((b) => b.at === '%IX0.2')!;
    expect(nc.negated).toContain(0);
    // positions survive — rung rows drive band clustering
    expect(net.blocks.map((b) => b.pos.y)).toContain(70);
  });

  it('drops rail-sourced connections and keeps the flow graph', () => {
    const { project } = importPlcopenXml(LD_XML);
    const net = project.pous[0]!.networks[0]!;
    expect(net.wires).toHaveLength(3);
    const edges = net.wires.map((w) => [w.src.block, w.dsts.map((d) => d.block)]);
    expect(edges).toContainEqual([3, [5]]);
    expect(edges).toContainEqual([4, [5]]);
    expect(edges).toContainEqual([5, [6]]);
  });

  it('round-trips LD networks through export losslessly', () => {
    const { project } = importPlcopenXml(LD_XML);
    const xml = exportPlcopenXml(project);
    const { project: back } = importPlcopenXml(xml);
    const n1 = project.pous[0]!.networks[0]!;
    const n2 = back.pous[0]!.networks[0]!;
    expect(n2.kind).toBe('ld');
    expect(n2.blocks).toHaveLength(n1.blocks.length);
    expect(n2.wires).toHaveLength(n1.wires.length);
    const nc1 = n1.blocks.find((b) => b.at === '%IX0.2')!;
    const nc2 = n2.blocks.find((b) => b.at === '%IX0.2')!;
    expect(nc2.negated).toContain(0);
    const edges = (n: typeof n1) =>
      n.wires.map((w) => `${w.src.block}->${w.dsts.map((d) => d.block).join(',')}`).sort();
    expect(edges(n2)).toEqual(edges(n1));
  });

  // Beremiz-style LD: in/out/inOutVariable data taps plus an
  // embedded operator block — wires carry values, not gated flow.
  const LD_DATA_XML = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://www.plcopen.org/xml/tc6_0201">
  <contentHeader name="lddata"/>
  <types/>
  <pous>
    <pou name="LdData" pouType="program">
      <interface/>
      <body>
        <LD>
          <inVariable localId="3" height="30" width="34">
            <position x="100" y="50"/>
            <connectionPointOut><relPosition x="34" y="15"/></connectionPointOut>
            <expression>Reset</expression>
          </inVariable>
          <inOutVariable localId="4" height="30" width="34">
            <position x="200" y="50"/>
            <connectionPointIn><relPosition x="0" y="15"/><connection refLocalId="7" formalParameter="OUT"/></connectionPointIn>
            <connectionPointOut><relPosition x="34" y="15"/></connectionPointOut>
            <expression>Cnt</expression>
          </inOutVariable>
          <outVariable localId="2" height="30" width="34">
            <position x="300" y="50"/>
            <connectionPointIn><relPosition x="0" y="15"/><connection refLocalId="4"/></connectionPointIn>
            <expression>Out</expression>
          </outVariable>
          <block localId="7" typeName="ADD" height="80" width="67">
            <position x="150" y="50"/>
            <inputVariables>
              <variable formalParameter="IN1">
                <connectionPointIn><relPosition x="0" y="35"/><connection refLocalId="4"/></connectionPointIn>
              </variable>
              <variable formalParameter="IN2">
                <connectionPointIn><relPosition x="0" y="65"/></connectionPointIn>
              </variable>
            </inputVariables>
            <inOutVariables/>
            <outputVariables>
              <variable formalParameter="OUT">
                <connectionPointOut><relPosition x="67" y="35"/></connectionPointOut>
              </variable>
            </outputVariables>
          </block>
        </LD>
      </body>
    </pou>
  </pous>
</project>`;

  it('imports LD data taps as flow=data variable blocks', () => {
    const { project, notes } = importPlcopenXml(LD_DATA_XML);
    expect(notes.filter((n) => n.includes('not imported'))).toHaveLength(0);
    const net = project.pous[0]!.networks[0]!;
    expect(net.kind).toBe('ld');
    const vars = net.blocks.filter((b) => b.kind === 'variable');
    expect(vars).toHaveLength(3);
    for (const v of vars) expect(v.flow).toBe('data');
    expect(vars.map((v) => v.role).sort()).toEqual(['in', 'in_out', 'out']);
  });

  it('imports embedded LD blocks with named-pin connections', () => {
    const { project } = importPlcopenXml(LD_DATA_XML);
    const net = project.pous[0]!.networks[0]!;
    const add = net.blocks.find((b) => b.kind === 'operator')!;
    expect(add.type_ref).toBe('ADD');
    // SEL-style named ports survive as string port selectors
    const w = net.wires.find((w) => w.src.block === 7)!;
    expect(w.src.port).toBe('OUT');
    // mergeWires groups by source — find the dst entry for block 7
    const d7 = net.wires.flatMap((w) => w.dsts).find((d) => d.block === 7)!;
    expect(d7.port).toBe(1); // formalParameter IN1 → pin index 1
  });
});
