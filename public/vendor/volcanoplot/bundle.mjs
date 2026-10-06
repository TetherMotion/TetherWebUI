// wgsl:/home/uli/dev/VolcanoPlot/web/src/shaders/transform.wgsl
var transform_default = "// web/src/shaders/transform.wgsl \u2014 WGSL port of\n// src/render/shaders/TransformGlsl.hpp. Keep function-for-function\n// parity; the field layout mirrors the native push-constant block.\n//\n// NOTE: GLSL mod() is floor-mod; WGSL % on floats is trunc-mod.\n// Wherever the GLSL used mod(x, y) write `x - y*floor(x/y)` (helper\n// `glslMod`). atan(y, x) \u2192 atan2(y, x).\n\nstruct Xform {\n    viewMinSpan : vec4f,   // xy=display min, zw=display span\n    rect        : vec4f,   // pixel rect (x, y, w, h)\n    color       : vec4f,\n    scaleX      : vec4f,   // (code, p1, p2, pad)\n    scaleY      : vec4f,\n    proj        : vec4f,   // (code, thetaOffset, thetaDir, pad)\n    extra       : vec4f,   // u_width etc.\n    extra2      : vec4f,\n};\n\nfn glslMod(x : f32, y : f32) -> f32 { return x - y * floor(x / y); }\n\n// scaleFwd: s=(code,param1,param2); codes match plot::ScaleKind.\nfn scaleFwd(v : f32, s : vec4f) -> f32 {\n    let c = i32(s.x + 0.5);\n    if (c == 1) { return log(max(v, 1e-30)) / log(10.0); }      // log\n    if (c == 2) {                                               // symlog\n        let lt = s.y; let ls = s.z; let b = max(s.w, 1.000001);\n        let adj = ls / (1.0 - pow(b, -1.0));\n        let a = abs(v);\n        if (a <= lt) { return adj * v; }\n        return sign(v) * lt * (adj + log(a / lt) / log(b));\n    }\n    if (c == 3) {                                               // logit\n        let q = clamp(v, 1e-7, 1.0 - 1e-7);\n        return log(q / (1.0 - q));\n    }\n    if (c == 4) {                                               // asinh\n        let a = max(s.y, 1e-30);\n        return a * asinh(v / a);\n    }\n    if (c == 5) {                                               // mercator\n        let phi = clamp(v, -1.48442223, 1.48442223);\n        return log(tan(0.7853981633974483 + phi * 0.5));\n    }\n    return v;                                                   // linear\n}\n\nfn projFwd(p : vec2f, pr : vec3f) -> vec2f {\n    let c = i32(pr.x + 0.5);\n    if (c == 0) { return p; }                                   // rectilinear\n    if (c == 1) {                                               // polar\n        let th = pr.z * p.x + pr.y;\n        return vec2f(p.y * cos(th), p.y * sin(th));\n    }\n    let lon = clamp(p.x, -3.14159265, 3.14159265);\n    let lat = clamp(p.y, -1.5707963, 1.5707963);\n    if (c == 2) {                                               // aitoff\n        let al = acos(clamp(cos(lat) * cos(lon * 0.5), -1.0, 1.0));\n        let sa = select(sin(al) / al, 1.0, abs(al) < 1e-7);\n        return vec2f(2.0 * cos(lat) * sin(lon * 0.5) / sa, sin(lat) / sa);\n    }\n    if (c == 3) {                                               // hammer\n        let z = sqrt(max(1.0 + cos(lat) * cos(lon * 0.5), 1e-12));\n        return vec2f(2.8284271 * cos(lat) * sin(lon * 0.5) / z,\n                     1.41421356 * sin(lat) / z);\n    }\n    if (c == 4) {                                               // lambert\n        let k = sqrt(max(2.0 / (1.0 + cos(lat) * cos(lon)), 0.0));\n        return vec2f(k * cos(lat) * sin(lon), k * sin(lat));\n    }\n    if (c == 5) {                                               // mollweide\n        let s = clamp(sin(lat), -1.0, 1.0);\n        var th = lat;\n        for (var i = 0; i < 8; i++) {\n            let f = 2.0 * th + sin(2.0 * th) - 3.14159265 * s;\n            let fp = 2.0 + 2.0 * cos(2.0 * th);\n            if (abs(fp) < 1e-12) { break; }\n            th -= f / fp;\n        }\n        return vec2f(0.9003163 * lon * cos(th), 1.41421356 * sin(th));\n    }\n    return p;\n}\n";

// wgsl:/home/uli/dev/VolcanoPlot/web/src/shaders/px.wgsl
var px_default = "// web/src/shaders/px.wgsl \u2014 pixel-space primitives (SpineRenderer port).\n// Positions are framebuffer pixels, Y-down; WebGPU NDC is Y-up, so the\n// shader negates Y (native relied on Vulkan's Y-down NDC).\n//\n// Bindings:\n//   0 uniform PxUBO { canvasWH : vec2f, color : vec4f }\n//   1 storage pos : array<vec2f>\n//   2 storage col : array<vec4f>   (VC variant only)\n//\n// Used with triangle-list, line-strip and line-list pipelines.\n\nstruct PxUBO {\n    canvasWH : vec2f,\n    color    : vec4f,\n};\n\n@group(0) @binding(0) var<uniform> U : PxUBO;\n@group(0) @binding(1) var<storage, read> pxPts : array<vec2f>;\n#ifdef VERTEX_COLOR\n@group(0) @binding(2) var<storage, read> pxCol : array<vec4f>;\n#endif\n\nfn pxToNdc(p : vec2f) -> vec2f {\n    return vec2f(p.x / U.canvasWH.x * 2.0 - 1.0,\n                 1.0 - p.y / U.canvasWH.y * 2.0);\n}\n\nstruct VSOut {\n    @builtin(position) pos : vec4f,\n    @location(0) color : vec4f,\n};\n\n@vertex fn vs(@builtin(vertex_index) vi : u32) -> VSOut {\n    var o : VSOut;\n    o.pos = vec4f(pxToNdc(pxPts[vi]), 0.0, 1.0);\n#ifdef VERTEX_COLOR\n    o.color = pxCol[vi];\n#else\n    o.color = U.color;\n#endif\n    return o;\n}\n\n@fragment fn fs(v : VSOut) -> @location(0) vec4f {\n    return v.color;\n}\n";

// wgsl:/home/uli/dev/VolcanoPlot/web/src/shaders/DrawLines.wgsl
var DrawLines_default = "// web/src/shaders/DrawLines.wgsl \u2014 port of LineRenderer.cpp's GLSL.\n// Vertex-pulls from a storage buffer (kind=VertexStorage); equivalent to\n// the native vertex-attribute path. Polyline expansion for width > 1 is\n// the TessLines compute op's job \u2014 this pipeline draws the 1px strip.\n\n// #include transform.wgsl \u2014 inlined by the TS pipeline builder.\n\n@group(0) @binding(0) var<uniform> U : Xform;\n@group(0) @binding(1) var<storage, read> pts : array<vec2f>;\n\nstruct VSOut {\n    @builtin(position) pos : vec4f,\n    @location(0) color : vec4f,\n};\n\n@vertex fn vs(@builtin(vertex_index) vi : u32,\n              @builtin(instance_index) base : u32) -> VSOut {\n    let d = pts[base + vi];\n    let p = projFwd(vec2f(scaleFwd(d.x, U.scaleX),\n                          scaleFwd(d.y, U.scaleY)),\n                    U.proj.xyz);\n    // data \u2192 NDC; viewport rect applied via pass.setViewport (viewRect)\n    let ndc = (p - U.viewMinSpan.xy) / U.viewMinSpan.zw * 2.0 - 1.0;\n    var o : VSOut;\n    o.pos = vec4f(ndc.x, -ndc.y, 0.0, 1.0);  // Y-up \u2192 NDC\n    o.color = U.color;\n    return o;\n}\n\n@fragment fn fs(v : VSOut) -> @location(0) vec4f {\n    return v.color;\n}\n";

// wgsl:/home/uli/dev/VolcanoPlot/web/src/shaders/DrawPoints.wgsl
var DrawPoints_default = "// web/src/shaders/DrawPoints.wgsl \u2014 PointRenderer port.\n// WebGPU has no point sprites: each point expands to a 6-vertex\n// billboard quad in the vertex shader; the fragment shader evaluates the\n// marker SDF (same codes as the GLSL impl \u2014 subset for v1).\n//\n//   0 uniform Xform (transform.wgsl)\n//   1 storage pos  : array<vec2f>\n//   2 storage col  : array<vec4f>   (optional \u2014 HAS_COL)\n//   3 storage size : array<f32>     (optional \u2014 HAS_SIZE)\n\n// #include transform.wgsl\n\n@group(0) @binding(0) var<uniform> U : Xform;\n@group(0) @binding(1) var<storage, read> pts : array<vec2f>;\n#ifdef HAS_COL\n@group(0) @binding(2) var<storage, read> cols : array<vec4f>;\n#endif\n#ifdef HAS_SIZE\n@group(0) @binding(3) var<storage, read> sizes : array<f32>;\n#endif\n\nfn dataToPx(d : vec2f) -> vec2f {\n    let p = projFwd(vec2f(scaleFwd(d.x, U.scaleX),\n                          scaleFwd(d.y, U.scaleY)),\n                    U.proj.xyz);\n    // data \u2192 viewport-relative px: [0,1] over view \u2192 rect\n    let t = (p - U.viewMinSpan.xy) / U.viewMinSpan.zw;\n    return vec2f(U.rect.x + t.x * U.rect.z,\n                 U.rect.y + U.rect.w - t.y * U.rect.w);  // data Y-up\n}\n\nconst CORNERS : array<vec2f, 6> = array<vec2f, 6>(\n    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),\n    vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));\n\nstruct VSOut {\n    @builtin(position) pos : vec4f,\n    @location(0) color : vec4f,\n    @location(1) local : vec2f,   // quad-local coords, \xB1size/2\n    @location(2) size : f32,\n};\n\n@vertex fn vs(@builtin(vertex_index) vi : u32,\n              @builtin(instance_index) inst : u32) -> VSOut {\n    let c = CORNERS[vi];\n    var sz = 6.0;\n#ifdef HAS_SIZE\n    sz = max(sizes[inst], 0.5);\n#endif\n    let center = dataToPx(pts[inst]);\n    let px = center + c * (sz * 0.5 + 1.0);\n    var o : VSOut;\n    // px \u2192 NDC via canvas dims packed in viewMinSpan? No: px shaders\n    // use viewport \u2014 the pass viewport is set to `viewRect`, so emit\n    // NDC in viewport space: px/rect \u2192 [0,1] \u2192 NDC.\n    let ndc = vec2f((px.x - U.rect.x) / U.rect.z * 2.0 - 1.0,\n                    1.0 - (px.y - U.rect.y) / U.rect.w * 2.0);\n    o.pos = vec4f(ndc, 0.0, 1.0);\n    o.local = c * (sz * 0.5 + 1.0);\n    o.size = sz;\n#ifdef HAS_COL\n    o.color = cols[inst];\n#else\n    o.color = U.color;\n#endif\n    return o;\n}\n\n// Marker SDF: u_marker = extra[0..3] \u2192 codes match GLSL impl.\nfn markerDist(c : vec2f, code : i32, nside : i32, rot : f32) -> f32 {\n    // normalize to marker half-extents (~size/2 space is `local`)\n    let r = c * 2.0;   // scale so radius-1 marker \u2248 half quad\n    switch code {\n        case 0i:  { return length(r) - 0.30; }   // '.'\n        case 2i:  {                                // 's' box\n            let q = abs(r) - vec2f(0.75, 0.75);\n            return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0);\n        }\n        case 3i, 5i, 6i, 7i, 8i, 18i, 19i, 20i, 21i: {\n            // regular n-gon (iq sdPoly) \u2014 nside resolved host-side\n            let n = f32(nside);\n            let a = atan2(r.x, r.y) + rot + 3.14159265;\n            let rr = 6.2831853 / n;\n            let m = glslMod(a, rr) - rr * 0.5;\n            return length(vec2f(cos(m), sin(m)) * length(r))\n                   * cos(glslMod(a, rr) - rr * 0.5)\n                   - 0.9 * cos(rr * 0.5);\n        }\n        case 15i: {                              // 'P' plus\n            let q = abs(r);\n            return min(min(q.x, q.y), length(r) - 0.5);\n        }\n        case 16i: {                              // 'X' cross\n            let cr = vec2f(r.x + r.y, r.x - r.y) * 0.7071;\n            let q = abs(cr);\n            return min(min(q.x, q.y), length(cr) - 0.5);\n        }\n        default: { return length(r) - 1.0; }     // 'o' circle + rest\n    }\n}\n\n@fragment fn fs(v : VSOut) -> @location(0) vec4f {\n    let code = i32(U.extra.x + 0.5);\n    let nside = i32(U.extra.z + 0.5);\n    let rot = U.extra.w;\n    // normalize local \u2192 marker units (marker radius \u2248 size/2)\n    let c = v.local / (v.size * 0.5);\n    let d = markerDist(c, code, nside, rot);\n    let w = fwidth(d);\n    let alpha = 1.0 - smoothstep(-w, w, d);\n    if (alpha <= 0.001) { discard; }\n    return vec4f(v.color.rgb, v.color.a * alpha);\n}\n";

// wgsl:/home/uli/dev/VolcanoPlot/web/src/shaders/DrawTrisData.wgsl
var DrawTrisData_default = "// web/src/shaders/DrawTrisData.wgsl \u2014 data-space triangle soup\n// (FillRenderer / pie-affine variants). Vertex-pulling.\n//\n//   0 uniform Xform\n//   1 storage pos : array<vec2f>\n//   2 storage col : array<vec4f>   (optional \u2014 HAS_COL)\n//\n// MODE PIE: positions are pie data units; ubo.rect = {cx, cy, sc, sc}\n// pixel center + half-min scale; px = rect.xy + pos * rect.z * 0.8.\n\n// #include transform.wgsl\n\n@group(0) @binding(0) var<uniform> U : Xform;\n@group(0) @binding(1) var<storage, read> pos : array<vec2f>;\n#ifdef HAS_COL\n@group(0) @binding(2) var<storage, read> cols : array<vec4f>;\n#endif\n\nstruct VSOut {\n    @builtin(position) p : vec4f,\n    @location(0) color : vec4f,\n};\n\n@vertex fn vs(@builtin(vertex_index) vi : u32) -> VSOut {\n    var o : VSOut;\n#ifdef MODE_PIE\n    // pie-data units \u2192 framebuffer px \u2192 viewport NDC (viewport = clip)\n    let px = U.rect.xy + pos[vi] * U.rect.z * 0.8;\n    let ndc = vec2f(px.x / U.extra2.x * 2.0 - 1.0,\n                    1.0 - px.y / U.extra2.y * 2.0);   // extra2=canvasWH\n    o.p = vec4f(ndc, 0.0, 1.0);\n#else\n    let p = projFwd(vec2f(scaleFwd(pos[vi].x, U.scaleX),\n                          scaleFwd(pos[vi].y, U.scaleY)),\n                    U.proj.xyz);\n    let ndc = (p - U.viewMinSpan.xy) / U.viewMinSpan.zw * 2.0 - 1.0;\n    o.p = vec4f(ndc.x, ndc.y, 0.0, 1.0);\n#endif\n#ifdef HAS_COL\n    o.color = cols[vi];\n#else\n    o.color = U.color;\n#endif\n    return o;\n}\n\n@fragment fn fs(v : VSOut) -> @location(0) vec4f {\n    return v.color;\n}\n";

// wgsl:/home/uli/dev/VolcanoPlot/web/src/shaders/DrawTrisGpu.wgsl
var DrawTrisGpu_default = "// web/src/shaders/DrawTrisGpu.wgsl \u2014 pre-tessellated pixel-space mesh\n// (GpuLineRenderer output / SpineRenderer::drawTrianglesGpu port).\n// Vertex record: vec2f pos_px + vec4f color = 24 B.\n//\n//   0 uniform { canvasWH : vec2f, byteOff : u32, pad : u32 }\n//   1 storage verts : array<u32>  (raw view; record = 6 u32)\n\nstruct GpuUBO {\n    canvasWH : vec2f,\n    byteOff  : u32,\n    pad      : u32,\n};\n\n@group(0) @binding(0) var<uniform> U : GpuUBO;\n@group(0) @binding(1) var<storage, read> raw : array<u32>;\n\nfn w2f(w : u32) -> f32 { return bitcast<f32>(w); }\n\nstruct VSOut {\n    @builtin(position) p : vec4f,\n    @location(0) color : vec4f,\n};\n\n@vertex fn vs(@builtin(vertex_index) vi : u32) -> VSOut {\n    let base = U.byteOff / 4u + vi * 6u;\n    let px = vec2f(w2f(raw[base]), w2f(raw[base + 1u]));\n    let col = vec4f(w2f(raw[base + 2u]), w2f(raw[base + 3u]),\n                    w2f(raw[base + 4u]), w2f(raw[base + 5u]));\n    var o : VSOut;\n    o.p = vec4f(px.x / U.canvasWH.x * 2.0 - 1.0,\n                1.0 - px.y / U.canvasWH.y * 2.0, 0.0, 1.0);\n    o.color = col;\n    return o;\n}\n\n@fragment fn fs(v : VSOut) -> @location(0) vec4f {\n    return v.color;\n}\n";

// wgsl:/home/uli/dev/VolcanoPlot/web/src/shaders/DrawInstanced.wgsl
var DrawInstanced_default = "// web/src/shaders/DrawInstanced.wgsl \u2014 InstancedPathRenderer port.\n// Template triangle soup (vec2 px-space unit template) \xD7 per-instance\n// {ox, oy, sx, sy, r, g, b, a} records (8\xD7f32 = 32 B).\n//\n//   0 uniform { canvasWH : vec2f, pad : vec2f }\n//   1 storage tpl  : array<vec2f>\n//   2 storage inst : array<f32>   (8 per instance)\n\nstruct InstUBO { canvasWH : vec2f, pad : vec2f };\n\n@group(0) @binding(0) var<uniform> U : InstUBO;\n@group(0) @binding(1) var<storage, read> tpl : array<vec2f>;\n@group(0) @binding(2) var<storage, read> inst : array<f32>;\n\nstruct VSOut {\n    @builtin(position) p : vec4f,\n    @location(0) color : vec4f,\n};\n\n@vertex fn vs(@builtin(vertex_index) vi : u32,\n              @builtin(instance_index) ii : u32) -> VSOut {\n    let b = ii * 8u;\n    let org = vec2f(inst[b], inst[b + 1u]);\n    let sc  = vec2f(inst[b + 2u], inst[b + 3u]);\n    let col = vec4f(inst[b + 4u], inst[b + 5u], inst[b + 6u],\n                    inst[b + 7u]);\n    let px = tpl[vi] * sc + org;\n    var o : VSOut;\n    o.p = vec4f(px.x / U.canvasWH.x * 2.0 - 1.0,\n                1.0 - px.y / U.canvasWH.y * 2.0, 0.0, 1.0);\n    o.color = col;\n    return o;\n}\n\n@fragment fn fs(v : VSOut) -> @location(0) vec4f {\n    return v.color;\n}\n";

// wgsl:/home/uli/dev/VolcanoPlot/web/src/shaders/DrawImage.wgsl
var DrawImage_default = "// web/src/shaders/DrawImage.wgsl \u2014 HeatmapRenderer port.\n// Full-rect textured quad; grid texture (r32float or rgba8) sampled at\n// cell centers, mapped through a 256\xD71 colormap LUT.\n//\n//   0 uniform Xform (rect = image rect px; params via extra/extra2)\n//   1 texture gridTex  : texture_2d<f32>\n//   2 texture cmapTex  : texture_2d<f32>\n//   3 sampler samp     : sampler (nearest)\n//\n// Params layout (PDrawImage.params[8] \u2192 Xform.extra/extra2):\n//   extra = [rgbaMode, originLower, nanTransparent, valueMin]\n//   extra2 = [valueMax, xMin, yMin, gridW]\n\n// #include transform.wgsl\n\n@group(0) @binding(0) var<uniform> U : Xform;\n@group(0) @binding(1) var gridTex : texture_2d<f32>;\n@group(0) @binding(2) var cmapTex : texture_2d<f32>;\n@group(0) @binding(3) var samp : sampler;\n\nstruct VSOut {\n    @builtin(position) p : vec4f,\n    @location(0) uv : vec2f,\n};\n\n@vertex fn vs(@builtin(vertex_index) vi : u32) -> VSOut {\n    // fullscreen-quad 6 verts over the image rect (viewport=viewRect)\n    let CORNERS = array<vec2f, 6>(\n        vec2f(0.,0.), vec2f(1.,0.), vec2f(1.,1.),\n        vec2f(0.,0.), vec2f(1.,1.), vec2f(0.,1.));\n    let t = CORNERS[vi];\n    var o : VSOut;\n    o.p = vec4f(t.x * 2.0 - 1.0, 1.0 - t.y * 2.0, 0.0, 1.0);\n    // originLower: row 0 at bottom \u2192 v = 1-t.y\n    var v = t.y;\n    if (U.extra.y > 0.5) { v = 1.0 - t.y; }   // originLower\n    o.uv = vec2f(t.x, v);\n    return o;\n}\n\n@fragment fn fs(v : VSOut) -> @location(0) vec4f {\n    let px = textureSample(gridTex, samp, v.uv);\n    if (U.extra.x > 0.5) {                      // rgbaMode: raw colors\n        return px;\n    }\n    let lo = U.extra.w;                         // valueMin\n    let hi = U.extra2.x;                        // valueMax\n    var t = (px.x - lo) / max(hi - lo, 1e-30);\n    if (U.extra.z > 0.5 && (px.x != px.x)) {    // NaN \u2192 transparent\n        discard;\n    }\n    t = clamp(t, 0.0, 1.0);\n    return textureSample(cmapTex, samp, vec2f(t, 0.5));\n}\n";

// wgsl:/home/uli/dev/VolcanoPlot/web/src/shaders/DrawTextQuads.wgsl
var DrawTextQuads_default = "// web/src/shaders/DrawTextQuads.wgsl \u2014 TextRenderer port.\n// glyb emits triangle-soup quads: 32 B records {pos vec2f, uv vec2f,\n// color vec4f}, pixel space. Atlas is r8unorm.\n//\n//   0 uniform { canvasWH : vec2f, pad : vec2f }\n//   1 storage quads : array<u32>   (8 u32 per vertex)\n//   2 texture atlas : texture_2d<f32>\n//   3 sampler samp  : sampler (linear)\n\nstruct TextUBO { canvasWH : vec2f, pad : vec2f };\n\n@group(0) @binding(0) var<uniform> U : TextUBO;\n@group(0) @binding(1) var<storage, read> raw : array<u32>;\n@group(0) @binding(2) var atlas : texture_2d<f32>;\n@group(0) @binding(3) var samp : sampler;\n\nfn w2f(w : u32) -> f32 { return bitcast<f32>(w); }\n\nstruct VSOut {\n    @builtin(position) p : vec4f,\n    @location(0) uv : vec2f,\n    @location(1) color : vec4f,\n};\n\n@vertex fn vs(@builtin(vertex_index) vi : u32) -> VSOut {\n    let b = vi * 8u;\n    let px = vec2f(w2f(raw[b]), w2f(raw[b + 1u]));\n    var o : VSOut;\n    o.p = vec4f(px.x / U.canvasWH.x * 2.0 - 1.0,\n                1.0 - px.y / U.canvasWH.y * 2.0, 0.0, 1.0);\n    o.uv = vec2f(w2f(raw[b + 2u]), w2f(raw[b + 3u]));\n    o.color = vec4f(w2f(raw[b + 4u]), w2f(raw[b + 5u]),\n                    w2f(raw[b + 6u]), w2f(raw[b + 7u]));\n    return o;\n}\n\n@fragment fn fs(v : VSOut) -> @location(0) vec4f {\n    let a = textureSample(atlas, samp, v.uv).r;\n    return vec4f(v.color.rgb, v.color.a * a);\n}\n";

// wgsl:/home/uli/dev/VolcanoPlot/web/src/shaders/ReduceMinMax.wgsl
var ReduceMinMax_default = "// web/src/shaders/ReduceMinMax.wgsl \u2014 2D min/max reduce (ReduceRenderer\n// port). Single workgroup of 256 threads, grid-stride over a vec2f\n// point buffer; order-preserving float\u2192u32 key map lets us use\n// atomicMin/atomicMax on u32 (WGSL has no float atomics).\n//\n//   0 uniform { count : u32, pad[3] }\n//   1 storage pts : array<vec2f>  (read)\n//   2 storage out : array<atomic<u32>, 4>  \u2014 [minX, maxX, minY, maxY]\n//     as u32 keys; JS pre-initialises to {0xffffffff, 0, 0xffffffff, 0}\n//     and decodes keys back to f32 before _vp_mailbox delivery.\n\nstruct RUBO { count : u32, pad0 : u32, pad1 : u32, pad2 : u32 };\n@group(0) @binding(0) var<uniform> U : RUBO;\n@group(0) @binding(1) var<storage, read> pts : array<vec2f>;\n@group(0) @binding(2) var<storage, read_write> out_ : array<atomic<u32>, 4>;\n\n// Monotonic f32\u2192u32: positives get the sign bit set, negatives get all\n// bits inverted \u2014 unsigned order then matches float order.\nfn enc(f : f32) -> u32 {\n    let u = bitcast<u32>(f);\n    return select(u | 0x80000000u, ~u, (u & 0x80000000u) != 0u);\n}\n\nvar<workgroup> wg : array<atomic<u32>, 4>;\n\n@compute @workgroup_size(256)\nfn cs(@builtin(local_invocation_id) lid : vec3u) {\n    if (lid.x == 0u) {\n        atomicStore(&wg[0], 0xffffffffu);\n        atomicStore(&wg[1], 0u);\n        atomicStore(&wg[2], 0xffffffffu);\n        atomicStore(&wg[3], 0u);\n    }\n    workgroupBarrier();\n    var i = lid.x;\n    while (i < U.count) {\n        let pt = pts[i];\n        atomicMin(&wg[0], enc(pt.x));\n        atomicMax(&wg[1], enc(pt.x));\n        atomicMin(&wg[2], enc(pt.y));\n        atomicMax(&wg[3], enc(pt.y));\n        i += 256u;\n    }\n    workgroupBarrier();\n    if (lid.x == 0u) {\n        atomicMin(&out_[0], atomicLoad(&wg[0]));\n        atomicMax(&out_[1], atomicLoad(&wg[1]));\n        atomicMin(&out_[2], atomicLoad(&wg[2]));\n        atomicMax(&out_[3], atomicLoad(&wg[3]));\n    }\n}\n";

// wgsl:/home/uli/dev/VolcanoPlot/web/src/shaders/TessLines.wgsl
var TessLines_default = "// TessLines.wgsl \u2014 WGSL port of kTessGlsl in GpuLineRenderer.cpp.\n// One invocation per segment (quad, 6 verts) + one per point\n// (join/cap, 24 verts). Output record = 6 f32: vec2f pos_px + vec4f\n// color; consumed by DrawTrisGpu in the same frame.\n//\n// Bindings:\n//   0 uniform PTessLines (fields packed to 16 B lanes)\n//   1 storage readonly pts : array<vec2f>\n//   2 storage rw       out : array<f32>\n\nstruct TessPC {\n    // scalar fields packed individually (uniform buffer layout)\n    n : u32, nSeg : u32, hwidth : f32, join : u32,\n    cap : u32, miterLimit : f32, inBase : u32, outBase : u32,\n    color : vec4f,\n};\n\n@group(0) @binding(0) var<uniform> pc : TessPC;\n@group(0) @binding(1) var<storage, read> pts : array<vec2f>;\n@group(0) @binding(2) var<storage, read_write> vout : array<f32>;\n\nconst SEGV : u32 = 6u;\nconst JOINV : u32 = 24u;\n\nfn perp2(d : vec2f) -> vec2f { return vec2f(-d.y, d.x); }\n\nfn finitePt(i : u32) -> bool {\n    let p = pts[pc.inBase + i];\n    return p.x == p.x && p.y == p.y &&\n           abs(p.x) < 1e30 && abs(p.y) < 1e30;\n}\n\nfn emitVert(idx : u32, p : vec2f) {\n    let b = (pc.outBase + idx) * 6u;\n    vout[b]      = p.x;        vout[b + 1u] = p.y;\n    vout[b + 2u] = pc.color.r; vout[b + 3u] = pc.color.g;\n    vout[b + 4u] = pc.color.b; vout[b + 5u] = pc.color.a;\n}\nfn emitTri(idx : u32, a : vec2f, b : vec2f, c : vec2f) {\n    emitVert(idx, a); emitVert(idx + 1u, b); emitVert(idx + 2u, c);\n}\nfn zeroSlot(idx : u32, count : u32) {\n    for (var k = 0u; k < count; k = k + 1u) {\n        let b = (pc.outBase + idx + k) * 6u;\n        for (var f = 0u; f < 6u; f = f + 1u) { vout[b + f] = 0.0; }\n    }\n}\n\nfn arcFan(idx : u32, apex : vec2f, c : vec2f, h : f32,\n          aFrom : vec2f, aTo : vec2f, through : vec2f, steps : u32) {\n    let TAU = 6.28318530718;\n    let a0 = atan2(aFrom.y - c.y, aFrom.x - c.x);\n    let a1 = atan2(aTo.y - c.y, aTo.x - c.x);\n    let am = atan2(through.y - c.y, through.x - c.x);\n    var ccw = glslMod(a1 - a0, TAU);\n    if (ccw < 1e-6) { ccw = TAU; }\n    let mOnCcw = glslMod(am - a0, TAU);\n    let dir = select(-1.0, 1.0, mOnCcw <= ccw);\n    let span = select(-(TAU - ccw), ccw, dir > 0.0);\n    var prev = aFrom;\n    var vi = idx;\n    for (var k = 1u; k <= steps; k = k + 1u) {\n        let a = a0 + span * f32(k) / f32(steps);\n        let cur = c + vec2f(cos(a), sin(a)) * h;\n        emitTri(vi, apex, prev, cur);\n        prev = cur;\n        vi = vi + 3u;\n    }\n}\n\n@compute @workgroup_size(256)\nfn cs(@builtin(global_invocation_id) gid : vec3u) {\n    let e = gid.x;\n    if (e >= pc.nSeg + pc.n) { return; }\n    if (pc.n < 2u) { return; }\n\n    if (e < pc.nSeg) {\n        // segment quad pts[i] -> pts[i+1]\n        let i = e;\n        let slot = i * SEGV;\n        let a = pts[pc.inBase + i];\n        let b = pts[pc.inBase + i + 1u];\n        let d = b - a;\n        let len = length(d);\n        if (len < 1e-6 || !finitePt(i) || !finitePt(i + 1u)) {\n            zeroSlot(slot, SEGV);\n            return;\n        }\n        let n = perp2(d / len) * pc.hwidth;\n        emitTri(slot,      a - n, a + n, b + n);\n        emitTri(slot + 3u, a - n, b + n, b - n);\n        return;\n    }\n\n    // per-point join or cap slot\n    let i = e - pc.nSeg;\n    let slot = pc.nSeg * SEGV + i * JOINV;\n    let prevOk = i > 0u && finitePt(i - 1u) && finitePt(i);\n    let nextOk = i + 1u < pc.n && finitePt(i + 1u) && finitePt(i);\n    let p = pts[pc.inBase + i];\n\n    if (prevOk && nextOk) {\n        let pa = pts[pc.inBase + i - 1u];\n        let pb = pts[pc.inBase + i + 1u];\n        var d0 = p - pa; var d1 = pb - p;\n        let l0 = length(d0); let l1 = length(d1);\n        if (l0 < 1e-6 || l1 < 1e-6) { zeroSlot(slot, JOINV); return; }\n        d0 = d0 / l0; d1 = d1 / l1;\n        let n0 = perp2(d0); let n1 = perp2(d1);\n        let crs = d0.x * d1.y - d0.y * d1.x;\n        if (abs(crs) < 1e-6) { zeroSlot(slot, JOINV); return; }\n        let s = select(-1.0, 1.0, crs > 0.0);\n        let oA = p + n0 * (s * pc.hwidth);\n        let oB = p + n1 * (s * pc.hwidth);\n        if (pc.join == 0u) {\n            let m = n0 + n1;\n            let ml = length(m);\n            let mdir = select(n0, m / ml, ml > 1e-6);\n            let dt = max(dot(mdir, n0), 1e-6);\n            if (dt >= 1.0 / pc.miterLimit) {\n                emitTri(slot, oA, p + mdir * (s * pc.hwidth / dt), oB);\n                zeroSlot(slot + 3u, JOINV - 3u);\n            } else {\n                zeroSlot(slot, JOINV);\n            }\n        } else if (pc.join == 1u) {\n            arcFan(slot, p, p, pc.hwidth, oA, oB, p + (n0 + n1) * s, 8u);\n        } else {\n            zeroSlot(slot, JOINV);   // bevel: chord already covered\n        }\n        return;\n    }\n\n    if (!finitePt(i)) { zeroSlot(slot, JOINV); return; }\n\n    let isStart = !prevOk && nextOk;\n    let isEnd = prevOk && !nextOk;\n    if (!isStart && !isEnd) { zeroSlot(slot, JOINV); return; }\n    if (pc.cap == 0u) { zeroSlot(slot, JOINV); return; }\n\n    let other = select(pts[pc.inBase + i - 1u],\n                       pts[pc.inBase + i + 1u], isStart);\n    var d = other - p;\n    let len = length(d);\n    if (len < 1e-6) { zeroSlot(slot, JOINV); return; }\n    d = d / len;\n    if (isStart) { d = -d; }\n    let n = perp2(d) * pc.hwidth;\n\n    if (pc.cap == 2u) {\n        let o = p + d * pc.hwidth;\n        emitTri(slot,      p - n, p + n, o + n);\n        emitTri(slot + 3u, p - n, o + n, o - n);\n        zeroSlot(slot + 6u, JOINV - 6u);\n    } else {\n        arcFan(slot, p, p, pc.hwidth, p - n, p + n, p + d, 8u);\n    }\n}\n";

// wgsl:/home/uli/dev/VolcanoPlot/web/src/shaders/DrawSurface.wgsl
var DrawSurface_default = "// DrawSurface.wgsl \u2014 3D surface mesh (port of SurfaceRendererVk).\n// Vertex data lives in storage buffers pulled by index; the pipeline\n// uses a depth attachment (unlike all 2D overlay pipelines).\n\nstruct SurfUBO {\n    vp : mat4x4f,          // column-major view-projection\n    gridRange : vec4f,     // xy = xRange min/max, zw = yRange min/max\n    light : vec4f,         // xyz = light dir, w = shade flag\n    valueRange : vec2f,    // min, max of z values\n    pad : vec2f,\n};\n\n@group(0) @binding(0) var<uniform> U : SurfUBO;\n// C++ Point3D is 12 B \u2014 pull raw u32s, three per vertex.\n@group(0) @binding(1) var<storage, read> verts : array<u32>;\n@group(0) @binding(2) var<storage, read> indices : array<u32>;\n\nstruct VOut {\n    @builtin(position) pos : vec4f,\n    @location(0) height : f32,\n    @location(1) world : vec3f,\n};\n\n@vertex fn vs(@builtin(vertex_index) vi : u32) -> VOut {\n    let idx = indices[vi];\n    let p = vec3f(bitcast<f32>(verts[idx * 3u]),\n                  bitcast<f32>(verts[idx * 3u + 1u]),\n                  bitcast<f32>(verts[idx * 3u + 2u]));\n    let nx = (p.x - U.gridRange.x) /\n             max(U.gridRange.y - U.gridRange.x, 1e-30);\n    let ny = (p.y - U.gridRange.z) /\n             max(U.gridRange.w - U.gridRange.z, 1e-30);\n    let h = (p.z - U.valueRange.x) /\n            max(U.valueRange.y - U.valueRange.x, 1e-30);\n    var o : VOut;\n    o.height = h;\n    o.world = vec3f(nx, ny, h);\n    o.pos = U.vp * vec4f(p, 1.0);\n    return o;\n}\n\nfn viridis(t : f32) -> vec3f {\n    let c = array<vec3f, 11>(\n        vec3f(0.267, 0.005, 0.329), vec3f(0.282, 0.140, 0.457),\n        vec3f(0.254, 0.265, 0.530), vec3f(0.207, 0.372, 0.553),\n        vec3f(0.164, 0.471, 0.558), vec3f(0.128, 0.567, 0.551),\n        vec3f(0.135, 0.659, 0.518), vec3f(0.267, 0.749, 0.441),\n        vec3f(0.478, 0.821, 0.318), vec3f(0.741, 0.873, 0.150),\n        vec3f(0.993, 0.906, 0.144));\n    let s = t * 10.0;\n    let i = i32(s);\n    let f = s - f32(i);\n    return mix(c[clamp(i, 0, 10)], c[clamp(i + 1, 0, 10)], f);\n}\n\n@fragment fn fs(in : VOut) -> @location(0) vec4f {\n    var color = viridis(clamp(in.height, 0.0, 1.0));\n    if (U.light.w > 0.5) {\n        // mpl plot_surface shade=True: lambert via screen-space normals.\n        var n = cross(dpdx(in.world), dpdy(in.world));\n        let nl = length(n);\n        n = select(vec3f(0.0, 0.0, 1.0), n / nl, nl > 1e-12);\n        if (n.z < 0.0) { n = -n; }\n        let i = clamp(dot(n, normalize(U.light.xyz)), 0.0, 1.0);\n        color = color * (0.30 + 0.70 * i) + vec3f(0.10) * i * i;\n    }\n    return vec4f(color, 1.0);\n}\n";

// wgsl:/home/uli/dev/VolcanoPlot/web/src/shaders/DrawGrid3D.wgsl
var DrawGrid3D_default = "// DrawGrid3D.wgsl \u2014 ray-cast 3D grid planes (port of\n// Grid3DRendererVk). Fullscreen triangle, no vertex buffer; the\n// fragment shader unprojects near/far and intersects the grid planes.\n\nstruct GridUBO {\n    rect : vec4f,        // xy = offset, zw = extent (unused, clip only)\n    viewX : vec4f,       // x = min, z = span\n    viewY : vec4f,\n    viewZ : vec4f,\n    gridColor : vec4f,\n    flags : vec4f,       // x = floorXZ, y = backWallXY, z = sideWallYZ, w = step\n    invVP0 : vec4f,\n    invVP1 : vec4f,\n    invVP2 : vec4f,\n    invVP3 : vec4f,\n    eye : vec4f,\n};\n@group(0) @binding(0) var<uniform> U : GridUBO;\n\nstruct VOut {\n    @builtin(position) pos : vec4f,\n    @location(0) ndc : vec2f,\n};\n\n@vertex fn vs(@builtin(vertex_index) vi : u32) -> VOut {\n    // fullscreen triangle: (-1,-1) (3,-1) (-1,3)\n    var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));\n    var o : VOut;\n    o.ndc = p[vi];\n    o.pos = vec4f(p[vi], 0.0, 1.0);\n    return o;\n}\n\nfn unproject(ndc : vec3f) -> vec3f {\n    // invVP rows as stored; WGSL mat4x4f takes column vectors, so the\n    // transposed construction below matches the GLSL port.\n    let m = mat4x4f(\n        vec4f(U.invVP0.x, U.invVP1.x, U.invVP2.x, U.invVP3.x),\n        vec4f(U.invVP0.y, U.invVP1.y, U.invVP2.y, U.invVP3.y),\n        vec4f(U.invVP0.z, U.invVP1.z, U.invVP2.z, U.invVP3.z),\n        vec4f(U.invVP0.w, U.invVP1.w, U.invVP2.w, U.invVP3.w));\n    let world = m * vec4f(ndc, 1.0);\n    return world.xyz / world.w;\n}\n\nfn gridLine(coord : f32, step : f32) -> f32 {\n    if (step <= 0.0) { return 0.0; }\n    let f = abs(fract(coord / step - 0.5) - 0.5);\n    let w = fwidth(coord / step);\n    return 1.0 - smoothstep(0.0, w * 1.5, f);\n}\n\n@fragment fn fs(in : VOut) -> @location(0) vec4f {\n    let nearPoint = unproject(vec3f(in.ndc, 0.0));\n    let farPoint = unproject(vec3f(in.ndc, 1.0));\n    let rayDir = farPoint - nearPoint;\n\n    var step = U.flags.w;\n    if (step <= 0.0) {\n        let span = max(U.viewX.z, max(U.viewY.z, U.viewZ.z));\n        step = pow(10.0, floor(log2(max(span, 1e-30)) / log2(10.0)));\n        if (step <= 0.0) { step = 1.0; }\n    }\n\n    // Derivatives (fwidth inside gridLine) require uniform control\n    // flow \u2014 evaluate every plane unconditionally and gate with select.\n    var alpha = 0.0;\n\n    // Floor plane: y = yMin\n    {\n        let t = (U.viewY.x - nearPoint.y) / rayDir.y;\n        let p = nearPoint + t * rayDir;\n        let ok = U.flags.x > 0.5 && abs(rayDir.y) > 1e-6 && t > 0.0 &&\n                 p.x >= U.viewX.x && p.x <= U.viewX.x + U.viewX.z &&\n                 p.z >= U.viewZ.x && p.z <= U.viewZ.x + U.viewZ.z;\n        alpha = max(alpha, select(0.0,\n            max(gridLine(p.x, step), gridLine(p.z, step)), ok));\n    }\n    // Back wall: z = zMin\n    {\n        let t = (U.viewZ.x - nearPoint.z) / rayDir.z;\n        let p = nearPoint + t * rayDir;\n        let ok = U.flags.y > 0.5 && abs(rayDir.z) > 1e-6 && t > 0.0 &&\n                 p.x >= U.viewX.x && p.x <= U.viewX.x + U.viewX.z &&\n                 p.y >= U.viewY.x && p.y <= U.viewY.x + U.viewY.z;\n        alpha = max(alpha, select(0.0,\n            max(gridLine(p.x, step), gridLine(p.y, step)), ok));\n    }\n    // Side wall: x = xMin\n    {\n        let t = (U.viewX.x - nearPoint.x) / rayDir.x;\n        let p = nearPoint + t * rayDir;\n        let ok = U.flags.z > 0.5 && abs(rayDir.x) > 1e-6 && t > 0.0 &&\n                 p.y >= U.viewY.x && p.y <= U.viewY.x + U.viewY.z &&\n                 p.z >= U.viewZ.x && p.z <= U.viewZ.x + U.viewZ.z;\n        alpha = max(alpha, select(0.0,\n            max(gridLine(p.y, step), gridLine(p.z, step)), ok));\n    }\n\n    if (alpha < 0.01) { discard; }\n    return vec4f(U.gridColor.rgb, U.gridColor.a * alpha);\n}\n";

// wgsl:/home/uli/dev/VolcanoPlot/web/src/shaders/KdeEval2D.wgsl
var KdeEval2D_default = "// web/src/shaders/KdeEval2D.wgsl \u2014 2D Gaussian KDE over a grid.\n// One thread per output cell; each gathers all samples.\n// Port of KdeEvalRenderer.cpp kKdeGlsl.\n\nstruct PC {\n    nSamples : u32, gridW : u32, gridH : u32, mailbox : u32,\n    xMin : f32, xStep : f32, yMin : f32, yStep : f32,\n    inv2bwX2 : f32, inv2bwY2 : f32, norm : f32, pad : f32,\n}\n@group(0) @binding(0) var<uniform> pc : PC;\n@group(0) @binding(1) var<storage, read> samples : array<vec2f>;\n@group(0) @binding(2) var<storage, read_write> gridOut : array<f32>;\n\n@compute @workgroup_size(8, 8)\nfn main(@builtin(global_invocation_id) g : vec3u) {\n    let i = g.x; let j = g.y;\n    if (i >= pc.gridW || j >= pc.gridH) { return; }\n    let gx = pc.xMin + (f32(i) + 0.5) * pc.xStep;\n    let gy = pc.yMin + (f32(j) + 0.5) * pc.yStep;\n    var sum = 0.0;\n    for (var k = 0u; k < pc.nSamples; k++) {\n        let s = samples[k];\n        let dx = gx - s.x;\n        let dy = gy - s.y;\n        sum += exp(-(dx * dx * pc.inv2bwX2 + dy * dy * pc.inv2bwY2));\n    }\n    gridOut[j * pc.gridW + i] = sum * pc.norm;\n}\n";

// wgsl:/home/uli/dev/VolcanoPlot/web/src/shaders/PcmTess.wgsl
var PcmTess_default = "// web/src/shaders/PcmTess.wgsl \u2014 pcolormesh quad tessellation.\n// Port of VulkanGpuServices.cpp kPcmTessGlsl: one thread per cell.\n// Outputs pos(vec2)/col(vec4) vertex buffers read by DrawTrisData.\n\nstruct PC {\n    nCols : u32,    // cells per row (flat) or corner count (gouraud)\n    nRows : u32,\n    gouraud : u32,\n    flags : u32,    // bit0 = cmap.bad set, bit1 = skipNaN\n}\n@group(0) @binding(0) var<uniform> pc : PC;\n@group(0) @binding(1) var<storage, read> xs : array<f32>;\n@group(0) @binding(2) var<storage, read> ys : array<f32>;\n@group(0) @binding(3) var<storage, read> ts : array<f32>;\n@group(0) @binding(4) var<storage, read> lut : array<vec4f>;\n@group(0) @binding(5) var<storage, read_write> pos : array<vec2f>;\n@group(0) @binding(6) var<storage, read_write> col : array<vec4f>;\n\nfn colorOf(t : f32) -> vec4f {\n    if (t != t) { return lut[258]; }              // NaN \u2192 bad\n    if (t < 0.0) { return lut[256]; }\n    if (t > 1.0) { return lut[257]; }\n    return lut[u32(t * 255.0 + 0.5)];\n}\n\n@compute @workgroup_size(256)\nfn main(@builtin(global_invocation_id) g : vec3u) {\n    let cell = g.x;\n    if (pc.gouraud == 0u) {\n        if (cell >= pc.nCols * pc.nRows) { return; }\n        let i = cell % pc.nCols;\n        let j = cell / pc.nCols;\n        let c = colorOf(ts[cell]);\n        let bl = vec2f(xs[i],     ys[j]);\n        let br = vec2f(xs[i + 1], ys[j]);\n        let ur = vec2f(xs[i + 1], ys[j + 1]);\n        let ul = vec2f(xs[i],     ys[j + 1]);\n        let v = cell * 6u;\n        pos[v]      = bl; pos[v + 1u] = br; pos[v + 2u] = ul;\n        pos[v + 3u] = br; pos[v + 4u] = ur; pos[v + 5u] = ul;\n        for (var k = 0u; k < 6u; k++) { col[v + k] = c; }\n    } else {\n        // Gouraud: (nCols-1)\xD7(nRows-1) quads, 4 tris meeting at the\n        // averaged center vertex (mpl _convert_mesh_to_triangles).\n        let qw = pc.nCols - 1u;\n        if (cell >= qw * (pc.nRows - 1u)) { return; }\n        let i = cell % qw;\n        let j = cell / qw;\n        let ta = ts[j * pc.nCols + i];\n        let tb = ts[j * pc.nCols + i + 1u];\n        let tc = ts[(j + 1u) * pc.nCols + i + 1u];\n        let td = ts[(j + 1u) * pc.nCols + i];\n        var ca = colorOf(ta); var cb = colorOf(tb);\n        var cc = colorOf(tc); var cd = colorOf(td);\n        // mpl drops the quad if any corner is masked and no bad color.\n        let anyNan = (ta != ta) || (tb != tb) || (tc != tc) || (td != td);\n        if ((pc.flags & 3u) == 2u && anyNan) {\n            ca = vec4f(0.0); cb = vec4f(0.0);\n            cc = vec4f(0.0); cd = vec4f(0.0);\n        }\n        let cCtr = (ca + cb + cc + cd) * 0.25;\n        let pa = vec2f(xs[i],     ys[j]);\n        let pb = vec2f(xs[i + 1], ys[j]);\n        let pq = vec2f(xs[i + 1], ys[j + 1]);\n        let pd = vec2f(xs[i],     ys[j + 1]);\n        let pCtr = (pa + pb + pq + pd) * 0.25;\n        let v = cell * 12u;\n        let pts = array<vec2f, 12>(pa, pb, pCtr, pb, pq, pCtr,\n                                   pq, pd, pCtr, pd, pa, pCtr);\n        let cls = array<vec4f, 12>(ca, cb, cCtr, cb, cc, cCtr,\n                                   cc, cd, cCtr, cd, ca, cCtr);\n        for (var k = 0u; k < 12u; k++) {\n            pos[v + k] = pts[k];\n            col[v + k] = cls[k];\n        }\n    }\n}\n";

// wgsl:/home/uli/dev/VolcanoPlot/web/src/shaders/KdeEval1D.wgsl
var KdeEval1D_default = "// web/src/shaders/KdeEval1D.wgsl \u2014 1-D Gaussian KDE.\n// Port of VulkanGpuServices.cpp kKde1dGlsl: one thread per eval point.\n\nstruct PC {\n    ns : u32, ne : u32, lo : f32, step : f32, bw : f32, pad : vec3f,\n}\n@group(0) @binding(0) var<uniform> pc : PC;\n@group(0) @binding(1) var<storage, read> src : array<f32>;\n@group(0) @binding(2) var<storage, read_write> dst : array<f32>;\n\n@compute @workgroup_size(256)\nfn main(@builtin(global_invocation_id) g : vec3u) {\n    let i = g.x;\n    if (i >= pc.ne) { return; }\n    let y = pc.lo + f32(i) * pc.step;\n    var sum = 0.0;\n    for (var s = 0u; s < pc.ns; s++) {\n        let t = (y - src[s]) / pc.bw;\n        sum += exp(-0.5 * t * t) * 0.39894228;\n    }\n    dst[i] = sum / (f32(pc.ns) * pc.bw);\n}\n";

// src/interpreter.ts
var VPOP_MAGIC = 1448038480;
var OP_VERSION = 1;
var HEADER_BYTES = 40;
var XFORM_BYTES = 128;
var align = (n, a) => n + a - 1 & ~(a - 1);
var align4 = (n) => align(n, 4);
var OpReader = class {
  dv;
  header;
  arena;
  constructor(buf) {
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const d = this.dv;
    if (d.getUint32(0, true) !== VPOP_MAGIC)
      throw new Error("bad VPOP magic");
    if (d.getUint16(4, true) !== OP_VERSION)
      throw new Error("unsupported op-stream version");
    this.header = {
      frameSeq: d.getBigUint64(8, true),
      canvasW: d.getUint32(16, true),
      canvasH: d.getUint32(20, true),
      opCount: d.getUint32(24, true),
      arenaOffset: d.getUint32(28, true),
      clearColor: d.getUint32(32, true),
      loadOp: d.getUint16(6, true) & 1
      // flags bit0
    };
    this.arena = buf.subarray(this.header.arenaOffset);
  }
  *ops() {
    const d = this.dv;
    let off = HEADER_BYTES;
    for (let i = 0; i < this.header.opCount; i++) {
      const op = d.getUint16(off, true);
      const len = d.getUint32(off + 4, true);
      yield { op, p: new DataView(d.buffer, d.byteOffset + off + 8, len) };
      off += 8 + align4(len);
    }
  }
  /** Resolve BufSrc {kind u8 @0, off u64 @8, len u64 @16} → bytes. */
  bulk(p, at) {
    const kind = p.getUint8(at);
    const off = Number(p.getBigUint64(at + 8, true));
    const len = Number(p.getBigUint64(at + 16, true));
    if (kind !== 0) throw new Error("heap bulk src not yet supported");
    return this.arena.subarray(off, off + len);
  }
  clearRGBA() {
    const c = this.header.clearColor;
    return [c & 255, c >> 8 & 255, c >> 16 & 255, c >>> 24 & 255].map((v) => v / 255);
  }
};
function buildWgsl(src, defines) {
  const lines = src.split("\n");
  const out = [];
  const stack = [];
  let active = true;
  for (const l of lines) {
    const t = l.trim();
    if (t.startsWith("#ifdef")) {
      stack.push(active);
      active = active && defines.has(t.slice(6).trim());
    } else if (t.startsWith("#else")) {
      active = stack[stack.length - 1] && !active;
    } else if (t.startsWith("#endif")) {
      active = stack.pop() ?? true;
    } else if (t.startsWith("#define")) {
    } else if (active) {
      out.push(l);
    }
  }
  return out.join("\n");
}
var U = (dyn) => ({
  binding: 0,
  visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
  buffer: { type: "uniform", hasDynamicOffset: dyn }
});
var S = (b) => ({
  binding: b,
  visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
  buffer: { type: "read-only-storage" }
});
var T = (b) => ({
  binding: b,
  visibility: GPUShaderStage.FRAGMENT,
  texture: { sampleType: "float" }
});
var SAMP = (b) => ({
  binding: b,
  visibility: GPUShaderStage.FRAGMENT,
  sampler: { type: "filtering" }
});
var TU = (b) => ({
  binding: b,
  visibility: GPUShaderStage.FRAGMENT,
  texture: { sampleType: "unfilterable-float" }
});
var SAMP_NF = (b) => ({
  binding: b,
  visibility: GPUShaderStage.FRAGMENT,
  sampler: { type: "non-filtering" }
});
var K_VERTEX = 1;
var K_STORAGE = 2;
var K_INDEX = 4;
var K_UNIFORM = 8;
var K_COPYSRC = 16;
var TEXFMTS = ["r8unorm", "rgba8unorm", "r32float"];
var Interpreter = class {
  constructor(device, ctx, format, onMailbox, onMailboxBytes) {
    this.device = device;
    this.ctx = ctx;
    this.format = format;
    this.onMailbox = onMailbox;
    this.onMailboxBytes = onMailboxBytes;
  }
  device;
  ctx;
  format;
  onMailbox;
  onMailboxBytes;
  buffers = /* @__PURE__ */ new Map();
  textures = /* @__PURE__ */ new Map();
  pipelines = /* @__PURE__ */ new Map();
  bgls = /* @__PURE__ */ new Map();
  sampler;
  // Uniform ring — 256 B-aligned slots (min dynamic-offset alignment)
  uniformRing;
  uniformCursor = 0;
  // Frame scratch: arena-embedded vertex data uploaded here
  scratch;
  scratchCursor = 0;
  init() {
    this.sampler = this.device.createSampler({
      magFilter: "nearest",
      minFilter: "nearest"
    });
    this.uniformRing = this.device.createBuffer({
      size: 4 << 20,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.scratch = this.device.createBuffer({
      size: 64 << 20,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    const mk = (key, s, into = this.pipelines, depthMode = false) => {
      if (!depthMode) this.specList.push([key, s]);
      let bgl = this.bgls.get(key);
      if (!bgl) {
        bgl = this.device.createBindGroupLayout({
          entries: s.bindings
        });
        this.bgls.set(key, bgl);
      }
      const src = (s.transform ? transform_default + "\n" : "") + buildWgsl(s.src, new Set(s.defines ?? []));
      const mod = this.device.createShaderModule({ code: src });
      const ds = s.depth || depthMode ? {
        format: "depth32float",
        depthWriteEnabled: s.depth === true && depthMode,
        // 'less-equal': first frames can contain a repeated
        // draw group (atlas-init repaint), so a surface may be
        // drawn twice at identical depth — 'less' would reject
        // the second draw and expose ops painted in between.
        depthCompare: s.depth && depthMode ? "less-equal" : "always"
      } : void 0;
      into.set(key, this.device.createRenderPipeline({
        layout: this.device.createPipelineLayout({
          bindGroupLayouts: [bgl]
        }),
        vertex: { module: mod, entryPoint: "vs" },
        fragment: {
          module: mod,
          entryPoint: "fs",
          targets: [{
            format: this.format,
            blend: s.blend === false ? void 0 : {
              color: {
                srcFactor: "src-alpha",
                dstFactor: "one-minus-src-alpha",
                operation: "add"
              },
              alpha: {
                srcFactor: "zero",
                dstFactor: "one",
                operation: "add"
              }
            }
          }]
        },
        primitive: { topology: s.topology },
        depthStencil: ds
      }));
    };
    this.mkPipe = mk;
    const ub = U(false), ud = U(false);
    mk("px.tris", {
      src: px_default,
      topology: "triangle-list",
      bindings: [ub, S(1)]
    });
    mk("px.trisvc", {
      src: px_default,
      defines: ["VERTEX_COLOR"],
      topology: "triangle-list",
      bindings: [ub, S(1), S(2)]
    });
    mk("px.lineStrip", {
      src: px_default,
      topology: "line-strip",
      bindings: [ub, S(1)]
    });
    mk("px.segs", {
      src: px_default,
      topology: "line-list",
      bindings: [ub, S(1)]
    });
    mk("lines", {
      src: DrawLines_default,
      transform: true,
      topology: "line-strip",
      bindings: [ud, S(1)]
    });
    mk("linesegs", {
      src: DrawLines_default,
      transform: true,
      topology: "line-list",
      bindings: [ud, S(1)]
    });
    mk("points.c.s", {
      src: DrawPoints_default,
      transform: true,
      defines: ["HAS_COL", "HAS_SIZE"],
      topology: "triangle-list",
      bindings: [ud, S(1), S(2), S(3)]
    });
    mk("points.c", {
      src: DrawPoints_default,
      transform: true,
      defines: ["HAS_COL"],
      topology: "triangle-list",
      bindings: [ud, S(1), S(2)]
    });
    mk("points.s", {
      src: DrawPoints_default,
      transform: true,
      defines: ["HAS_SIZE"],
      topology: "triangle-list",
      bindings: [ud, S(1), S(3)]
    });
    mk("points", {
      src: DrawPoints_default,
      transform: true,
      topology: "triangle-list",
      bindings: [ud, S(1)]
    });
    mk("trisData", {
      src: DrawTrisData_default,
      transform: true,
      defines: ["HAS_COL"],
      topology: "triangle-list",
      bindings: [ud, S(1), S(2)]
    });
    mk("trisData.flat", {
      src: DrawTrisData_default,
      transform: true,
      topology: "triangle-list",
      bindings: [ud, S(1)]
    });
    mk("trisGpu", {
      src: DrawTrisGpu_default,
      topology: "triangle-list",
      bindings: [ub, S(1)]
    });
    mk("pie", {
      src: DrawTrisData_default,
      transform: true,
      defines: ["MODE_PIE", "HAS_COL"],
      topology: "triangle-list",
      bindings: [ud, S(1), S(2)]
    });
    mk("image", {
      src: DrawImage_default,
      transform: true,
      topology: "triangle-list",
      bindings: [ud, TU(1), T(2), SAMP_NF(3)]
    });
    mk("instanced", {
      src: DrawInstanced_default,
      topology: "triangle-list",
      bindings: [ub, S(1), S(2)]
    });
    mk("text", {
      src: DrawTextQuads_default,
      topology: "triangle-list",
      bindings: [ub, S(1), T(2), SAMP(3)]
    });
    mk("surface", {
      src: DrawSurface_default,
      topology: "triangle-list",
      depth: true,
      blend: false,
      bindings: [ub, S(1), S(2)]
    });
    mk("grid3d", {
      src: DrawGrid3D_default,
      topology: "triangle-list",
      bindings: [ub]
    });
  }
  /** Pipeline set for passes that carry a depth attachment — every
   * pipeline must declare a (possibly inert) depthStencil state to be
   * attachment-compatible. Built lazily on the first 3D frame. */
  depthPipes;
  specList = [];
  mkPipe;
  activePipes = this.pipelines;
  pipesFor(depth) {
    if (!depth) return this.pipelines;
    if (!this.depthPipes) {
      this.depthPipes = /* @__PURE__ */ new Map();
      for (const [k, s] of this.specList)
        this.mkPipe(k, s, this.depthPipes, true);
    }
    return this.depthPipes;
  }
  // ── helpers ──────────────────────────────────────────────────────
  /** Copy `bytes` into the uniform ring; returns dynamic offset. */
  uboWrite(bytes) {
    const off = align(this.uniformCursor, 256);
    this.device.queue.writeBuffer(
      this.uniformRing,
      off,
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength
    );
    this.uniformCursor = off + Math.max(bytes.byteLength, 256);
    return off;
  }
  /** Copy arena bytes into the frame scratch storage buffer. */
  scratchWrite(bytes) {
    const off = align(this.scratchCursor, 256);
    if (off + bytes.byteLength > this.scratch.size)
      throw new Error("frame scratch exhausted");
    this.device.queue.writeBuffer(this.scratch, off, bytes);
    this.scratchCursor = off + bytes.byteLength;
    return off;
  }
  bindGroup(key, entries) {
    return this.device.createBindGroup({
      layout: this.bgls.get(key),
      entries
    });
  }
  bufRef(h) {
    const e = this.buffers.get(h);
    if (!e) throw new Error(`bad buffer handle ${h}`);
    return e.buf;
  }
  texView(h) {
    const e = this.textures.get(h);
    if (!e) throw new Error(`bad texture handle ${h}`);
    return e.view;
  }
  scissor(pass, p, at = 0) {
    pass.setScissorRect(
      p.getFloat32(at, true),
      p.getFloat32(at + 4, true),
      Math.max(p.getFloat32(at + 8, true), 1),
      Math.max(p.getFloat32(at + 12, true), 1)
    );
  }
  viewport(pass, p, at) {
    pass.setViewport(
      p.getFloat32(at, true),
      p.getFloat32(at + 4, true),
      Math.max(p.getFloat32(at + 8, true), 1),
      Math.max(p.getFloat32(at + 12, true), 1),
      0,
      1
    );
  }
  // ── frame replay ─────────────────────────────────────────────────
  /** Render the frame into `target` (canvas texture by default). */
  draw(frame, target) {
    const r = new OpReader(frame);
    const enc = this.device.createCommandEncoder();
    const canvasWH = new Float32Array(
      [r.header.canvasW, r.header.canvasH]
    );
    const drawOps = [];
    const releases = [];
    for (const { op, p } of r.ops()) {
      if (op <= 6 /* ReleaseTexture */) {
        if (op === 3 /* ReleaseBuffer */ || op === 6 /* ReleaseTexture */)
          releases.push({ op, p });
        else this.execResource(r, op, p);
      } else if (op >= 40 /* TessLines */ && !globalThis.VP_NO_COMPUTE) this.execCompute(r, enc, op, p);
      else {
        const only = globalThis.VP_ONLY;
        if (!globalThis.VP_NO_DRAW && (!only || only.has(op)))
          drawOps.push({ op, p });
      }
    }
    let depthTex;
    if (drawOps.length) {
      const [cr, cg, cb, ca] = r.clearRGBA();
      const needDepth = drawOps.some((d) => d.op === 27 /* DrawSurface */);
      this.activePipes = this.pipesFor(needDepth);
      let depthAttachment;
      if (needDepth) {
        depthTex = this.device.createTexture({
          size: {
            width: r.header.canvasW || 1,
            height: r.header.canvasH || 1
          },
          format: "depth32float",
          usage: GPUTextureUsage.RENDER_ATTACHMENT
        });
        depthAttachment = {
          view: depthTex.createView(),
          depthClearValue: 1,
          depthLoadOp: "clear",
          depthStoreOp: "discard"
        };
      }
      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view: target ?? this.ctx.getCurrentTexture().createView(),
          clearValue: { r: cr, g: cg, b: cb, a: ca },
          loadOp: r.header.loadOp ? "load" : "clear",
          storeOp: "store"
        }],
        depthStencilAttachment: depthAttachment
      });
      for (const { op, p } of drawOps)
        this.dispatchDraw(pass, r, canvasWH, op, p);
      pass.end();
    }
    this.device.queue.submit([enc.finish()]);
    depthTex?.destroy();
    for (const { op, p } of releases) this.execResource(r, op, p);
    this.flushMailbox();
    this.uniformCursor = 0;
    this.scratchCursor = 0;
  }
  // ── function evaluation (FuncDef/EvalFunc) ───────────────────────
  funcPipes = /* @__PURE__ */ new Map();
  evalBgl;
  ensureEval() {
    if (this.evalBgl) return;
    this.evalBgl = this.device.createBindGroupLayout({ entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "storage" }
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "uniform" }
      }
    ] });
  }
  /** Loose GLSL→WGSL for user bodies: bare expressions are wrapped as
   * `y = (expr);` (mirroring EvalRendererVk::wrapBody); common builtin
   * names coincide between the two languages. */
  glslToWgslBody(body) {
    let b = body.trim();
    if (!/[=;{]/.test(b)) b = `y = (${b});`;
    return b.replace(/\bmod\s*\(/g, "vpMod(").replace(/\batan\s*\(\s*([^,()]+)\s*,/g, "atan2($1,").replace(/\bfloat\s*\(/g, "f32(").replace(/\bfloat\s+/g, "var ").replace(/\bint\s*\(/g, "i32(").replace(/\bbool\b/g, "bool").replace(/\bvec([234])\s*\(/g, "vec$1f(");
  }
  funcDef(r, p) {
    const funcId = p.getUint16(0, true);
    const body = new TextDecoder().decode(r.bulk(p, 3));
    const wgsl = `
fn vpMod(a : f32, b : f32) -> f32 { return a - b * floor(a / b); }
struct EvalPC { xBase : f32, xStep : f32, count : u32, pad : u32 };
@group(0) @binding(0) var<storage, read_write> outBuf : array<vec2f>;
@group(0) @binding(1) var<uniform> pc : EvalPC;
@compute @workgroup_size(256)
fn cs(@builtin(global_invocation_id) gid : vec3u) {
    let i = gid.x;
    if (i >= pc.count) { return; }
    let x = pc.xBase + f32(i) * pc.xStep;
    var y = 0.0;
    ${this.glslToWgslBody(body)}
    outBuf[i] = vec2f(x, y);
}`;
    this.ensureEval();
    const mod = this.device.createShaderModule({ code: wgsl });
    void mod.getCompilationInfo().then((info) => info.messages.forEach((m) => console.warn(
      `[VP WGSL func] ${m.lineNum}:${m.linePos} ${m.message}`
    )));
    this.funcPipes.set(funcId, this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [this.evalBgl]
      }),
      compute: { module: mod, entryPoint: "cs" }
    }));
  }
  // ── mailbox (async compute results → C++) ────────────────────────
  pendingBulk = [];
  kdePipe;
  kdeBgl;
  ensureKde() {
    if (this.kdePipe) return;
    this.kdeBgl = this.device.createBindGroupLayout({ entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "uniform" }
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "read-only-storage" }
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "storage" }
      }
    ] });
    const mod = this.device.createShaderModule({ code: KdeEval2D_default });
    this.kdePipe = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [this.kdeBgl]
      }),
      compute: { module: mod, entryPoint: "main" }
    });
  }
  kde1Pipe;
  kde1Bgl;
  ensureKde1() {
    if (this.kde1Pipe) return;
    this.kde1Bgl = this.device.createBindGroupLayout({ entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "uniform" }
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "read-only-storage" }
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "storage" }
      }
    ] });
    const mod = this.device.createShaderModule({ code: KdeEval1D_default });
    this.kde1Pipe = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [this.kde1Bgl]
      }),
      compute: { module: mod, entryPoint: "main" }
    });
  }
  pcmPipe;
  pcmBgl;
  ensurePcm() {
    if (this.pcmPipe) return;
    const sb = (w) => ({ type: w ? "storage" : "read-only-storage" });
    this.pcmBgl = this.device.createBindGroupLayout({ entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "uniform" }
      },
      ...[1, 2, 3, 4].map((binding) => ({
        binding,
        visibility: GPUShaderStage.COMPUTE,
        buffer: sb(false)
      })),
      {
        binding: 5,
        visibility: GPUShaderStage.COMPUTE,
        buffer: sb(true)
      },
      {
        binding: 6,
        visibility: GPUShaderStage.COMPUTE,
        buffer: sb(true)
      }
    ] });
    const mod = this.device.createShaderModule({ code: PcmTess_default });
    this.pcmPipe = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [this.pcmBgl]
      }),
      compute: { module: mod, entryPoint: "main" }
    });
  }
  pendingMaps = [];
  reducePipe;
  reduceBgl;
  ensureReduce() {
    if (this.reducePipe) return;
    this.reduceBgl = this.device.createBindGroupLayout({ entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "uniform" }
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "read-only-storage" }
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "storage" }
      }
    ] });
    const mod = this.device.createShaderModule({ code: ReduceMinMax_default });
    this.reducePipe = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [this.reduceBgl]
      }),
      compute: { module: mod, entryPoint: "cs" }
    });
  }
  /** After submit: map staging buffers and deliver mailbox results. */
  flushMailbox() {
    const jobs = this.pendingMaps.splice(0);
    const bulk = this.pendingBulk.splice(0);
    for (const { buf, slot, bytes } of bulk) {
      void buf.mapAsync(GPUMapMode.READ).then(() => {
        this.onMailboxBytes?.(
          slot,
          new Uint8Array(buf.getMappedRange()).slice(0, bytes)
        );
        buf.unmap();
        buf.destroy();
      });
    }
    for (const { buf, out, slot } of jobs) {
      void buf.mapAsync(GPUMapMode.READ).then(() => {
        const u = new Uint32Array(buf.getMappedRange());
        const dv = new DataView(new ArrayBuffer(4));
        const dec = (k) => {
          dv.setUint32(
            0,
            k & 2147483648 ? k & 2147483647 : ~k >>> 0,
            true
          );
          return dv.getFloat32(0, true);
        };
        this.onMailbox?.(
          slot,
          [dec(u[0]), dec(u[1]), dec(u[2]), dec(u[3])]
        );
        buf.unmap();
        buf.destroy();
        out.destroy();
      });
    }
  }
  /** Render a frame into an offscreen texture and read the pixels
   * back — used by tests (avoids compositing/readback ambiguity on
   * WebGPU canvases). Returns RGBA8 bytes. */
  async capture(frame, w, h) {
    const tex = this.device.createTexture({
      size: { width: w, height: h },
      format: this.format,
      // must match the pipeline targets
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
    });
    this.draw(frame, tex.createView());
    const bpr = Math.ceil(w * 4 / 256) * 256;
    const rb = this.device.createBuffer({
      size: bpr * h,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: tex },
      { buffer: rb, bytesPerRow: bpr },
      { width: w, height: h }
    );
    this.device.queue.submit([enc.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(rb.getMappedRange());
    const out = new Uint8Array(w * h * 4);
    const bgra = this.format.startsWith("bgra");
    for (let y = 0; y < h; y++) {
      const row = src.subarray(y * bpr, y * bpr + w * 4);
      out.set(row, y * w * 4);
      if (bgra) {
        for (let i = y * w * 4; i < (y + 1) * w * 4; i += 4) {
          const t = out[i];
          out[i] = out[i + 2];
          out[i + 2] = t;
        }
      }
    }
    rb.unmap();
    rb.destroy();
    tex.destroy();
    return out;
  }
  execResource(r, op, p) {
    switch (op) {
      case 1 /* CreateBuffer */: {
        const h = p.getUint32(0, true);
        const size = Number(p.getBigUint64(4, true));
        const kind = p.getUint8(12);
        let usage = GPUBufferUsage.COPY_DST;
        if (kind & K_VERTEX) usage |= GPUBufferUsage.VERTEX;
        if (kind & K_STORAGE) usage |= GPUBufferUsage.STORAGE;
        if (kind & K_INDEX) usage |= GPUBufferUsage.INDEX;
        if (kind & K_UNIFORM) usage |= GPUBufferUsage.UNIFORM;
        if (kind & K_COPYSRC) usage |= GPUBufferUsage.COPY_SRC;
        if (kind & K_VERTEX) usage |= GPUBufferUsage.STORAGE;
        this.buffers.get(h)?.buf.destroy();
        this.buffers.set(h, {
          buf: this.device.createBuffer({ size, usage }),
          size
        });
        break;
      }
      case 2 /* WriteBuffer */: {
        const h = p.getUint32(0, true);
        const off = Number(p.getBigUint64(4, true));
        this.device.queue.writeBuffer(
          this.bufRef(h),
          off,
          r.bulk(p, 12)
        );
        break;
      }
      case 3 /* ReleaseBuffer */:
        this.buffers.get(p.getUint32(0, true))?.buf.destroy();
        this.buffers.delete(p.getUint32(0, true));
        break;
      case 4 /* CreateTexture */: {
        const h = p.getUint32(0, true);
        this.textures.get(h)?.tex.destroy();
        const w = p.getUint32(4, true), hh = p.getUint32(8, true);
        const fmt = TEXFMTS[p.getUint8(12)] ?? "rgba8unorm";
        const tex = this.device.createTexture({
          size: { width: w, height: hh },
          format: fmt,
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
        });
        this.textures.set(h, { tex, view: tex.createView() });
        break;
      }
      case 5 /* WriteTexture */: {
        const h = p.getUint32(0, true);
        const w = p.getUint32(12, true), hh = p.getUint32(16, true);
        const fmt = this.textures.get(h).tex.format;
        const bpp = fmt === "r32float" || fmt === "rgba8unorm" ? 4 : 1;
        this.device.queue.writeTexture(
          {
            texture: this.textures.get(h).tex,
            origin: [p.getUint32(4, true), p.getUint32(8, true), 0]
          },
          r.bulk(p, 20),
          { bytesPerRow: w * bpp, rowsPerImage: hh },
          { width: w, height: hh }
        );
        break;
      }
      case 6 /* ReleaseTexture */:
        this.textures.get(p.getUint32(0, true))?.tex.destroy();
        this.textures.delete(p.getUint32(0, true));
        break;
    }
  }
  tessPipe = null;
  tessBgl = null;
  ensureTess() {
    if (this.tessPipe) return;
    this.tessBgl = this.device.createBindGroupLayout({ entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "uniform" }
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "read-only-storage" }
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "storage" }
      }
    ] });
    const mod = this.device.createShaderModule({
      code: transform_default + "\n" + TessLines_default
    });
    this.tessPipe = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [this.tessBgl]
      }),
      compute: { module: mod, entryPoint: "cs" }
    });
  }
  execCompute(r, enc, op, p) {
    if (op === 47 /* ViolinKde */) {
      this.ensureKde1();
      const ne = p.getUint32(12, true);
      const bytes = ne * 4;
      if (!p.getUint32(4, true) || !bytes) return;
      const pc2 = new DataView(new ArrayBuffer(32));
      pc2.setUint32(0, p.getUint32(4, true), true);
      pc2.setUint32(4, ne, true);
      pc2.setFloat32(8, p.getFloat32(16, true), true);
      pc2.setFloat32(12, p.getFloat32(20, true), true);
      pc2.setFloat32(16, p.getFloat32(24, true), true);
      const off2 = this.uboWrite(new Uint8Array(pc2.buffer));
      const cpass = enc.beginComputePass();
      cpass.setPipeline(this.kde1Pipe);
      cpass.setBindGroup(0, this.device.createBindGroup({
        layout: this.kde1Bgl,
        entries: [
          { binding: 0, resource: {
            buffer: this.uniformRing,
            offset: off2,
            size: 48
          } },
          { binding: 1, resource: { buffer: this.bufRef(p.getUint32(0, true)) } },
          { binding: 2, resource: { buffer: this.bufRef(p.getUint32(8, true)) } }
        ]
      }));
      cpass.dispatchWorkgroups(Math.ceil(ne / 256));
      cpass.end();
      const staging = this.device.createBuffer({
        size: bytes,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
      });
      enc.copyBufferToBuffer(
        this.bufRef(p.getUint32(8, true)),
        0,
        staging,
        0,
        bytes
      );
      this.pendingBulk.push({
        buf: staging,
        slot: p.getUint32(28, true),
        bytes
      });
      return;
    }
    if (op === 46 /* PcmTess */) {
      this.ensurePcm();
      const gouraud = p.getUint32(32, true);
      const cells = gouraud ? (p.getUint32(24, true) - 1) * (p.getUint32(28, true) - 1) : p.getUint32(24, true) * p.getUint32(28, true);
      if (!cells) return;
      const pc2 = new DataView(new ArrayBuffer(16));
      for (let k = 0; k < 4; k++)
        pc2.setUint32(k * 4, p.getUint32(24 + k * 4, true), true);
      const off2 = this.uboWrite(new Uint8Array(pc2.buffer));
      const cpass = enc.beginComputePass();
      cpass.setPipeline(this.pcmPipe);
      cpass.setBindGroup(0, this.device.createBindGroup({
        layout: this.pcmBgl,
        entries: [
          { binding: 0, resource: {
            buffer: this.uniformRing,
            offset: off2,
            size: 16
          } },
          ...[1, 2, 3, 4, 5, 6].map((binding) => ({ binding, resource: { buffer: this.bufRef(p.getUint32(
            (binding - 1) * 4,
            true
          )) } }))
        ]
      }));
      cpass.dispatchWorkgroups(Math.ceil(cells / 256));
      cpass.end();
      return;
    }
    if (op === 42 /* FuncDef */) {
      this.funcDef(r, p);
      return;
    }
    if (op === 44 /* KdeEval2D */) {
      this.ensureKde();
      const n2 = p.getUint32(4, true);
      const gridW = p.getUint32(12, true), gridH = p.getUint32(16, true);
      const bytes = gridW * gridH * 4;
      if (!n2 || !bytes) return;
      const pc2 = new DataView(new ArrayBuffer(48));
      pc2.setUint32(0, n2, true);
      pc2.setUint32(4, gridW, true);
      pc2.setUint32(8, gridH, true);
      for (let k = 0; k < 6; k++)
        pc2.setFloat32(
          16 + k * 4,
          p.getFloat32(20 + k * 4, true),
          true
        );
      const off2 = this.uboWrite(new Uint8Array(pc2.buffer));
      const cpass = enc.beginComputePass();
      cpass.setPipeline(this.kdePipe);
      cpass.setBindGroup(0, this.device.createBindGroup({
        layout: this.kdeBgl,
        entries: [
          { binding: 0, resource: {
            buffer: this.uniformRing,
            offset: off2,
            size: 48
          } },
          { binding: 1, resource: { buffer: this.bufRef(p.getUint32(0, true)) } },
          { binding: 2, resource: { buffer: this.bufRef(p.getUint32(8, true)) } }
        ]
      }));
      cpass.dispatchWorkgroups(
        Math.ceil(gridW / 8),
        Math.ceil(gridH / 8)
      );
      cpass.end();
      const staging = this.device.createBuffer({
        size: bytes,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
      });
      enc.copyBufferToBuffer(
        this.bufRef(p.getUint32(8, true)),
        0,
        staging,
        0,
        bytes
      );
      this.pendingBulk.push({
        buf: staging,
        slot: p.getUint32(48, true),
        bytes
      });
      return;
    }
    if (op === 41 /* EvalFunc */) {
      const pipe = this.funcPipes.get(p.getUint16(24, true));
      const count = p.getUint32(20, true);
      if (!pipe || !count) return;
      const xMin = p.getFloat64(4, true);
      const xMax = p.getFloat64(12, true);
      const pc2 = new DataView(new ArrayBuffer(16));
      pc2.setFloat32(0, xMin, true);
      pc2.setFloat32(4, count > 1 ? (xMax - xMin) / (count - 1) : 0, true);
      pc2.setUint32(8, count, true);
      const off2 = this.uboWrite(new Uint8Array(pc2.buffer));
      const cpass = enc.beginComputePass();
      cpass.setPipeline(pipe);
      cpass.setBindGroup(0, this.device.createBindGroup({
        layout: this.evalBgl,
        entries: [
          { binding: 0, resource: { buffer: this.bufRef(p.getUint32(0, true)) } },
          { binding: 1, resource: {
            buffer: this.uniformRing,
            offset: off2,
            size: 16
          } }
        ]
      }));
      cpass.dispatchWorkgroups(Math.ceil(count / 256));
      cpass.end();
      return;
    }
    if (op === 43 /* ReduceMinMax */) {
      this.ensureReduce();
      const inBuf = p.getUint32(0, true);
      const count = p.getUint32(4, true);
      const slot = p.getUint32(8, true);
      const out = this.device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
      });
      this.device.queue.writeBuffer(
        out,
        0,
        new Uint32Array([4294967295, 0, 4294967295, 0])
      );
      const staging = this.device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
      });
      const pc2 = new Uint32Array(4);
      pc2[0] = count;
      const off2 = this.uboWrite(pc2);
      const cpass = enc.beginComputePass();
      cpass.setPipeline(this.reducePipe);
      cpass.setBindGroup(0, this.device.createBindGroup({
        layout: this.reduceBgl,
        entries: [
          { binding: 0, resource: {
            buffer: this.uniformRing,
            offset: off2,
            size: 16
          } },
          { binding: 1, resource: { buffer: this.bufRef(inBuf) } },
          { binding: 2, resource: { buffer: out } }
        ]
      }));
      cpass.dispatchWorkgroups(1);
      cpass.end();
      enc.copyBufferToBuffer(out, 0, staging, 0, 16);
      this.pendingMaps.push({ buf: staging, out, slot });
      return;
    }
    if (op !== 40 /* TessLines */) return;
    this.ensureTess();
    const pc = new DataView(new ArrayBuffer(48));
    pc.setUint32(0, p.getUint32(16, true), true);
    pc.setUint32(4, p.getUint32(20, true), true);
    pc.setFloat32(8, p.getFloat32(24, true), true);
    pc.setUint32(12, p.getUint8(28));
    pc.setUint32(16, p.getUint8(29));
    pc.setFloat32(20, p.getFloat32(30, true), true);
    pc.setUint32(24, p.getUint32(4, true), true);
    pc.setUint32(28, p.getUint32(12, true), true);
    pc.setFloat32(32, p.getFloat32(34, true), true);
    pc.setFloat32(36, p.getFloat32(38, true), true);
    pc.setFloat32(40, p.getFloat32(42, true), true);
    pc.setFloat32(44, p.getFloat32(46, true), true);
    const off = this.uboWrite(new Uint8Array(pc.buffer));
    const n = p.getUint32(16, true), nSeg = p.getUint32(20, true);
    if (!n || !nSeg) return;
    const pass = enc.beginComputePass();
    pass.setPipeline(this.tessPipe);
    pass.setBindGroup(0, this.device.createBindGroup({
      layout: this.tessBgl,
      entries: [
        { binding: 0, resource: {
          buffer: this.uniformRing,
          offset: off,
          size: 48
        } },
        { binding: 1, resource: { buffer: this.bufRef(p.getUint32(0, true)) } },
        { binding: 2, resource: { buffer: this.bufRef(p.getUint32(8, true)) } }
      ]
    }));
    pass.dispatchWorkgroups(Math.ceil((n + nSeg) / 256));
    pass.end();
  }
  dispatchDraw(pass, r, canvasWH, op, p) {
    switch (op) {
      // ── pixel-space ──────────────────────────────────────────────
      case 10 /* DrawTrisPx */: {
        this.scissor(pass, p);
        const vOff = this.scratchWrite(r.bulk(p, 16));
        const ubo = new Float32Array(8);
        ubo.set(canvasWH, 0);
        ubo.set([
          p.getFloat32(40, true),
          p.getFloat32(44, true),
          p.getFloat32(48, true),
          p.getFloat32(52, true)
        ], 4);
        const off = this.uboWrite(ubo);
        pass.setPipeline(this.activePipes.get("px.tris"));
        pass.setBindGroup(0, this.bindGroup("px.tris", [
          { binding: 0, resource: {
            buffer: this.uniformRing,
            offset: off,
            size: 32
          } },
          { binding: 1, resource: {
            buffer: this.scratch,
            offset: vOff
          } }
        ]));
        const nVerts = Number(p.getBigUint64(32, true)) / 8;
        pass.draw(nVerts);
        break;
      }
      case 11 /* DrawTrisPxVC */: {
        this.scissor(pass, p);
        const vOff = this.scratchWrite(r.bulk(p, 16));
        const cOff = this.scratchWrite(r.bulk(p, 40));
        const ubo = new Float32Array(6);
        ubo.set(canvasWH, 0);
        const off = this.uboWrite(ubo);
        pass.setPipeline(this.activePipes.get("px.trisvc"));
        pass.setBindGroup(0, this.bindGroup("px.trisvc", [
          { binding: 0, resource: {
            buffer: this.uniformRing,
            offset: off,
            size: 32
          } },
          { binding: 1, resource: {
            buffer: this.scratch,
            offset: vOff
          } },
          { binding: 2, resource: {
            buffer: this.scratch,
            offset: cOff
          } }
        ]));
        pass.draw(Number(p.getBigUint64(24 + 8, true)) / 8);
        break;
      }
      case 12 /* DrawLineStripPx */:
      case 13 /* DrawSegmentsPx */: {
        this.scissor(pass, p);
        const vOff = this.scratchWrite(r.bulk(p, 16));
        const ubo = new Float32Array(8);
        ubo.set(canvasWH, 0);
        ubo.set([
          p.getFloat32(40, true),
          p.getFloat32(44, true),
          p.getFloat32(48, true),
          p.getFloat32(52, true)
        ], 4);
        const off = this.uboWrite(ubo);
        const key = op === 12 /* DrawLineStripPx */ ? "px.lineStrip" : "px.segs";
        pass.setPipeline(this.activePipes.get(key));
        pass.setBindGroup(0, this.bindGroup(key, [
          { binding: 0, resource: {
            buffer: this.uniformRing,
            offset: off,
            size: 32
          } },
          { binding: 1, resource: {
            buffer: this.scratch,
            offset: vOff
          } }
        ]));
        pass.draw(Number(p.getBigUint64(24 + 8, true)) / 8);
        break;
      }
      case 14 /* DrawTextQuads */: {
        this.scissor(pass, p);
        const qOff = this.scratchWrite(r.bulk(p, 20));
        const ubo = new Float32Array(6);
        ubo.set(canvasWH, 0);
        const off = this.uboWrite(ubo);
        pass.setPipeline(this.activePipes.get("text"));
        pass.setBindGroup(0, this.bindGroup("text", [
          { binding: 0, resource: {
            buffer: this.uniformRing,
            offset: off,
            size: 32
          } },
          { binding: 1, resource: {
            buffer: this.scratch,
            offset: qOff
          } },
          { binding: 2, resource: this.texView(p.getUint32(16, true)) },
          { binding: 3, resource: this.sampler }
        ]));
        pass.draw(Number(p.getBigUint64(20 + 16, true)) / 32);
        break;
      }
      case 15 /* DrawInstanced */: {
        this.scissor(pass, p);
        const tOff = this.scratchWrite(r.bulk(p, 16));
        const iOff = this.scratchWrite(r.bulk(p, 40));
        const ubo = new Float32Array(4);
        ubo.set(canvasWH, 0);
        const off = this.uboWrite(ubo);
        pass.setPipeline(this.activePipes.get("instanced"));
        pass.setBindGroup(0, this.bindGroup("instanced", [
          { binding: 0, resource: {
            buffer: this.uniformRing,
            offset: off,
            size: 16
          } },
          { binding: 1, resource: {
            buffer: this.scratch,
            offset: tOff
          } },
          { binding: 2, resource: {
            buffer: this.scratch,
            offset: iOff
          } }
        ]));
        const tplVerts = Number(p.getBigUint64(24 + 8, true)) / 8;
        const nInst = Number(p.getBigUint64(48 + 8, true)) / 32;
        pass.draw(tplVerts, nInst);
        break;
      }
      // ── data-space ───────────────────────────────────────────────
      case 20 /* DrawLines */:
      case 21 /* DrawLineSegs */: {
        this.scissor(pass, p);
        this.viewport(pass, p, 16);
        const off = this.uboWrite(new Uint8Array(
          p.buffer,
          p.byteOffset + 32,
          XFORM_BYTES
        ));
        const key = op === 20 /* DrawLines */ ? "lines" : "linesegs";
        pass.setPipeline(this.activePipes.get(key));
        pass.setBindGroup(0, this.bindGroup(key, [
          { binding: 0, resource: {
            buffer: this.uniformRing,
            offset: off,
            size: XFORM_BYTES
          } },
          { binding: 1, resource: { buffer: this.bufRef(p.getUint32(160, true)) } }
        ]));
        pass.draw(p.getUint32(164, true));
        break;
      }
      case 22 /* DrawPoints */: {
        this.scissor(pass, p);
        this.viewport(pass, p, 16);
        const uboBytes = new Uint8Array(
          p.buffer,
          p.byteOffset + 32,
          XFORM_BYTES
        ).slice();
        uboBytes.set(
          new Uint8Array(p.buffer, p.byteOffset + 180, 16),
          96
        );
        const off = this.uboWrite(uboBytes);
        const posBuf = p.getUint32(160, true);
        const colBuf = p.getUint32(164, true);
        const sizeBuf = p.getUint32(168, true);
        const count = p.getUint32(172, true);
        const flags = p.getUint32(176, true);
        const key = "points" + (flags & 1 ? ".c" : "") + (flags & 2 ? ".s" : "");
        pass.setPipeline(this.activePipes.get(key));
        const entries = [
          { binding: 0, resource: {
            buffer: this.uniformRing,
            offset: off,
            size: XFORM_BYTES
          } },
          { binding: 1, resource: { buffer: this.bufRef(posBuf) } }
        ];
        if (flags & 1)
          entries.push({ binding: 2, resource: {
            buffer: this.bufRef(colBuf)
          } });
        if (flags & 2)
          entries.push({ binding: 3, resource: {
            buffer: this.bufRef(sizeBuf)
          } });
        pass.setBindGroup(0, this.bindGroup(key, entries));
        pass.draw(6, count);
        break;
      }
      case 23 /* DrawTrisData */: {
        this.scissor(pass, p);
        this.viewport(pass, p, 32);
        const off = this.uboWrite(new Uint8Array(
          p.buffer,
          p.byteOffset + 16,
          XFORM_BYTES
        ));
        const colBuf = p.getUint32(148, true);
        const key = colBuf ? "trisData" : "trisData.flat";
        pass.setPipeline(this.activePipes.get(key));
        const entries = [
          { binding: 0, resource: {
            buffer: this.uniformRing,
            offset: off,
            size: XFORM_BYTES
          } },
          { binding: 1, resource: { buffer: this.bufRef(p.getUint32(144, true)) } }
        ];
        if (colBuf)
          entries.push({ binding: 2, resource: {
            buffer: this.bufRef(colBuf)
          } });
        pass.setBindGroup(0, this.bindGroup(key, entries));
        pass.draw(p.getUint32(152, true));
        pass.setViewport(0, 0, canvasWH[0], canvasWH[1], 0, 1);
        break;
      }
      case 24 /* DrawTrisGpu */: {
        this.scissor(pass, p);
        const ubo = new Float32Array(4);
        ubo[0] = p.getFloat32(16, true);
        ubo[1] = p.getFloat32(20, true);
        const dv = new DataView(ubo.buffer);
        dv.setUint32(8, p.getUint32(28, true), true);
        const off = this.uboWrite(ubo);
        pass.setPipeline(this.activePipes.get("trisGpu"));
        pass.setBindGroup(0, this.bindGroup("trisGpu", [
          { binding: 0, resource: {
            buffer: this.uniformRing,
            offset: off,
            size: 16
          } },
          { binding: 1, resource: { buffer: this.bufRef(p.getUint32(24, true)) } }
        ]));
        pass.draw(p.getUint32(36, true));
        break;
      }
      case 25 /* DrawPie */: {
        this.scissor(pass, p);
        const uboBytes = new Uint8Array(
          p.buffer,
          p.byteOffset + 16,
          XFORM_BYTES
        ).slice();
        new DataView(uboBytes.buffer).setFloat32(112, canvasWH[0], true);
        new DataView(uboBytes.buffer).setFloat32(116, canvasWH[1], true);
        const off = this.uboWrite(uboBytes);
        pass.setPipeline(this.activePipes.get("pie"));
        pass.setBindGroup(0, this.bindGroup("pie", [
          { binding: 0, resource: {
            buffer: this.uniformRing,
            offset: off,
            size: XFORM_BYTES
          } },
          { binding: 1, resource: { buffer: this.bufRef(p.getUint32(144, true)) } },
          { binding: 2, resource: { buffer: this.bufRef(p.getUint32(148, true)) } }
        ]));
        pass.draw(p.getUint32(152, true));
        break;
      }
      case 26 /* DrawImage */: {
        this.viewport(pass, p, 0);
        const uboBytes = new Uint8Array(
          p.buffer,
          p.byteOffset + 16,
          XFORM_BYTES
        ).slice();
        uboBytes.set(
          new Uint8Array(p.buffer, p.byteOffset + 152, 32),
          96
        );
        const off = this.uboWrite(uboBytes);
        pass.setPipeline(this.activePipes.get("image"));
        pass.setBindGroup(0, this.bindGroup("image", [
          { binding: 0, resource: {
            buffer: this.uniformRing,
            offset: off,
            size: XFORM_BYTES
          } },
          { binding: 1, resource: this.texView(p.getUint32(144, true)) },
          { binding: 2, resource: this.texView(p.getUint32(148, true)) },
          { binding: 3, resource: this.sampler }
        ]));
        pass.draw(6);
        break;
      }
      case 27 /* DrawSurface */: {
        const cnt = p.getUint32(136, true);
        if (!cnt) break;
        this.scissor(pass, p);
        this.viewport(pass, p, 0);
        const off = this.uboWrite(new Uint8Array(
          p.buffer,
          p.byteOffset + 16,
          128
        ));
        pass.setPipeline(this.activePipes.get("surface"));
        pass.setBindGroup(0, this.bindGroup("surface", [
          { binding: 0, resource: {
            buffer: this.uniformRing,
            offset: off,
            size: 128
          } },
          { binding: 1, resource: { buffer: this.bufRef(p.getUint32(128, true)) } },
          { binding: 2, resource: { buffer: this.bufRef(p.getUint32(132, true)) } }
        ]));
        pass.draw(cnt);
        break;
      }
      case 28 /* DrawGrid3D */: {
        this.scissor(pass, p);
        this.viewport(pass, p, 0);
        const off = this.uboWrite(new Uint8Array(
          p.buffer,
          p.byteOffset + 16,
          176
        ));
        pass.setPipeline(this.activePipes.get("grid3d"));
        pass.setBindGroup(0, this.bindGroup("grid3d", [
          { binding: 0, resource: {
            buffer: this.uniformRing,
            offset: off,
            size: 176
          } }
        ]));
        pass.draw(3);
        break;
      }
      default:
        break;
    }
  }
};

// src/fallback.ts
var asinh = (x) => Math.log(x + Math.sqrt(x * x + 1));
function scaleFwd(v, s) {
  const c = Math.round(s[0]);
  if (c === 1) return Math.log(Math.max(v, 1e-30)) / Math.LN10;
  if (c === 2) {
    const [lt, ls, b0] = [s[1], s[2], Math.max(s[3], 1.000001)];
    const adj = ls / (1 - Math.pow(b0, -1)), a = Math.abs(v);
    if (a <= lt) return adj * v;
    return Math.sign(v) * lt * (adj + Math.log(a / lt) / Math.log(b0));
  }
  if (c === 3) {
    const q = Math.min(Math.max(v, 1e-7), 1 - 1e-7);
    return Math.log(q / (1 - q));
  }
  if (c === 4) {
    const a = Math.max(s[1], 1e-30);
    return a * asinh(v / a);
  }
  if (c === 5) {
    const phi = Math.min(Math.max(v, -1.48442223), 1.48442223);
    return Math.log(Math.tan(0.7853981633974483 + phi * 0.5));
  }
  return v;
}
function projFwd(x, y, pr) {
  const c = Math.round(pr[0]);
  if (c === 0) return [x, y];
  if (c === 1) {
    const th = pr[2] * x + pr[1];
    return [y * Math.cos(th), y * Math.sin(th)];
  }
  const lon = Math.min(Math.max(x, -Math.PI), Math.PI);
  const lat = Math.min(Math.max(y, -Math.PI / 2), Math.PI / 2);
  if (c === 2) {
    const al = Math.acos(Math.min(Math.max(
      Math.cos(lat) * Math.cos(lon * 0.5),
      -1
    ), 1));
    const sa = Math.abs(al) < 1e-7 ? 1 : Math.sin(al) / al;
    return [
      2 * Math.cos(lat) * Math.sin(lon * 0.5) / sa,
      Math.sin(lat) / sa
    ];
  }
  if (c === 3) {
    const z = Math.sqrt(Math.max(
      1 + Math.cos(lat) * Math.cos(lon * 0.5),
      1e-12
    ));
    return [
      2.8284271 * Math.cos(lat) * Math.sin(lon * 0.5) / z,
      1.41421356 * Math.sin(lat) / z
    ];
  }
  if (c === 4) {
    const k = Math.sqrt(Math.max(
      2 / (1 + Math.cos(lat) * Math.cos(lon)),
      0
    ));
    return [k * Math.cos(lat) * Math.sin(lon), k * Math.sin(lat)];
  }
  if (c === 5) {
    const s = Math.min(Math.max(Math.sin(lat), -1), 1);
    let th = lat;
    for (let i = 0; i < 8; i++) {
      const fp = 2 + 2 * Math.cos(2 * th);
      if (Math.abs(fp) < 1e-12) break;
      th -= (2 * th + Math.sin(2 * th) - Math.PI * s) / fp;
    }
    return [0.9003163 * lon * Math.cos(th), 1.41421356 * Math.sin(th)];
  }
  return [x, y];
}
var XformView = class {
  f;
  constructor(p, at) {
    this.f = [];
    for (let i = 0; i < 32; i++) this.f.push(p.getFloat32(at + i * 4, true));
  }
  /** data coords → pixel coords (Y-down) */
  toPx(x, y) {
    const f = this.f;
    const [px, py] = projFwd(
      scaleFwd(x, f.slice(12, 16)),
      scaleFwd(y, f.slice(16, 20)),
      f.slice(20, 23)
    );
    const tx = (px - f[0]) / f[2], ty = (py - f[1]) / f[3];
    return [f[4] + tx * f[6], f[5] + f[7] - ty * f[7]];
  }
  get color() {
    return [this.f[8], this.f[9], this.f[10], this.f[11]];
  }
};
var css = (c) => `rgba(${c[0] * 255 | 0},${c[1] * 255 | 0},${c[2] * 255 | 0},${c[3]})`;
var Canvas2DInterpreter = class {
  constructor(onMailbox) {
    this.onMailbox = onMailbox;
  }
  onMailbox;
  buffers = /* @__PURE__ */ new Map();
  textures = /* @__PURE__ */ new Map();
  atlasCanvas;
  draw(frame, ctx) {
    const r = new OpReader(frame);
    const [cr, cg, cb, ca] = r.clearRGBA().map((v) => v * 255);
    if (!r.header.loadOp) {
      ctx.fillStyle = `rgba(${cr},${cg},${cb},${ca / 255})`;
      ctx.fillRect(0, 0, r.header.canvasW, r.header.canvasH);
    }
    for (const { op, p } of r.ops()) {
      if (op <= 6 /* ReleaseTexture */) this.execResource(r, op, p);
      else if (op >= 40 /* TessLines */) this.execCompute(r, p, op);
      else this.dispatchDraw(r, ctx, op, p);
    }
  }
  execResource(r, op, p) {
    switch (op) {
      case 1 /* CreateBuffer */:
        this.buffers.set(
          p.getUint32(0, true),
          new Uint8Array(Number(p.getBigUint64(4, true)))
        );
        break;
      case 2 /* WriteBuffer */: {
        const h = p.getUint32(0, true);
        const off = Number(p.getBigUint64(4, true));
        const buf = this.buffers.get(h);
        if (buf) buf.set(r.bulk(p, 12), off);
        break;
      }
      case 3 /* ReleaseBuffer */:
        this.buffers.delete(p.getUint32(0, true));
        break;
      case 4 /* CreateTexture */:
        this.textures.set(p.getUint32(0, true), {
          w: p.getUint32(4, true),
          h: p.getUint32(8, true),
          fmt: p.getUint8(12),
          data: new Uint8Array(0)
        });
        break;
      case 5 /* WriteTexture */: {
        const h = p.getUint32(0, true);
        const t = this.textures.get(h);
        if (!t) break;
        const x = p.getUint32(4, true), y = p.getUint32(8, true), w = p.getUint32(12, true), hh = p.getUint32(16, true);
        const src = r.bulk(p, 20);
        const bpt = t.fmt === 0 ? 1 : t.fmt === 1 ? 4 : 4;
        if (t.data.length !== t.w * t.h * bpt)
          t.data = new Uint8Array(t.w * t.h * bpt);
        for (let row = 0; row < hh; row++)
          t.data.set(
            src.subarray(row * w * bpt, (row + 1) * w * bpt),
            ((y + row) * t.w + x) * bpt
          );
        t.canvas = void 0;
        break;
      }
      case 6 /* ReleaseTexture */:
        this.textures.delete(p.getUint32(0, true));
        break;
    }
  }
  // ── compute (CPU equivalents) ────────────────────────────────────
  execCompute(r, p, op) {
    if (op === 40 /* TessLines */) {
      const inB = this.buffers.get(p.getUint32(0, true));
      const outH = p.getUint32(8, true);
      const n = p.getUint32(16, true);
      const nSeg = p.getUint32(20, true);
      const hw = p.getFloat32(24, true);
      const color = [
        p.getFloat32(34, true),
        p.getFloat32(38, true),
        p.getFloat32(42, true),
        p.getFloat32(46, true)
      ];
      const out = this.buffers.get(outH);
      if (!inB || !out) return;
      const iv = new Float32Array(inB.buffer, inB.byteOffset + p.getUint32(4, true));
      const ov = new DataView(out.buffer, out.byteOffset + p.getUint32(12, true));
      for (let s = 0; s < nSeg; s++) {
        const x0 = iv[s * 2], y0 = iv[s * 2 + 1];
        const x1 = iv[s * 2 + 2], y1 = iv[s * 2 + 3];
        const dx = x1 - x0, dy = y1 - y0;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len * hw, ny = dx / len * hw;
        const quad = [
          x0 - nx,
          y0 - ny,
          x1 - nx,
          y1 - ny,
          x1 + nx,
          y1 + ny,
          x0 - nx,
          y0 - ny,
          x1 + nx,
          y1 + ny,
          x0 + nx,
          y0 + ny
        ];
        for (let v = 0; v < 6; v++) {
          const o = (s * 6 + v) * 24;
          ov.setFloat32(o, quad[v * 2], true);
          ov.setFloat32(o + 4, quad[v * 2 + 1], true);
          for (let k = 0; k < 4; k++)
            ov.setFloat32(o + 8 + k * 4, color[k], true);
        }
      }
      return;
    }
    if (op === 43 /* ReduceMinMax */) {
      const inB = this.buffers.get(p.getUint32(0, true));
      const count = p.getUint32(4, true);
      if (!inB || !count) return;
      const iv = new Float32Array(
        inB.buffer,
        inB.byteOffset,
        Math.floor(inB.byteLength / 4)
      );
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let i = 0; i < count; i++) {
        const x = iv[i * 2], y = iv[i * 2 + 1];
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      this.onMailbox?.(p.getUint32(8, true), [x0, x1, y0, y1]);
      return;
    }
  }
  // ── draws ────────────────────────────────────────────────────────
  clip(r, p) {
    const x = p.getFloat32(0, true), y = p.getFloat32(4, true), w = p.getFloat32(8, true), h = p.getFloat32(12, true);
    r.save();
    r.beginPath();
    r.rect(x, y, w, h);
    r.clip();
    return 0;
  }
  tris(ctx, verts, stride, colAt) {
    for (let i = 0; i + 2 * stride < verts.length; i += 3 * stride) {
      ctx.fillStyle = css(colAt(i));
      ctx.beginPath();
      ctx.moveTo(verts[i], verts[i + 1]);
      ctx.lineTo(verts[i + stride], verts[i + stride + 1]);
      ctx.lineTo(verts[i + stride * 2], verts[i + stride * 2 + 1]);
      ctx.closePath();
      ctx.fill();
    }
  }
  atlas() {
    if (this.atlasCanvas) return this.atlasCanvas;
    let at;
    for (const t of this.textures.values())
      if ((t.fmt === 0 || t.fmt === 1) && (!at || t.w * t.h > at.w * at.h))
        at = t;
    if (!at) return void 0;
    const cv = document.createElement("canvas");
    cv.width = at.w;
    cv.height = at.h;
    const c = cv.getContext("2d");
    const img = c.createImageData(at.w, at.h);
    if (at.fmt === 0)
      for (let i = 0; i < at.w * at.h; i++) {
        img.data[i * 4 + 3] = at.data[i];
        img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 255;
      }
    else img.data.set(at.data);
    c.putImageData(img, 0, 0);
    this.atlasCanvas = cv;
    return cv;
  }
  dispatchDraw(r, ctx, op, p) {
    switch (op) {
      case 10 /* DrawTrisPx */: {
        this.clip(ctx, p);
        const b = r.bulk(p, 16);
        this.tris(
          ctx,
          new Float32Array(b.buffer, b.byteOffset, b.length / 4),
          2,
          () => [
            p.getFloat32(40, true),
            p.getFloat32(44, true),
            p.getFloat32(48, true),
            p.getFloat32(52, true)
          ]
        );
        ctx.restore();
        break;
      }
      case 11 /* DrawTrisPxVC */: {
        this.clip(ctx, p);
        const v = r.bulk(p, 16), c = r.bulk(p, 40);
        const vf = new Float32Array(
          v.buffer,
          v.byteOffset,
          v.length / 4
        );
        const cf = new Float32Array(
          c.buffer,
          c.byteOffset,
          c.length / 4
        );
        this.tris(ctx, vf, 2, (i) => cf.slice(i * 2, i * 2 + 4));
        ctx.restore();
        break;
      }
      case 12 /* DrawLineStripPx */:
      case 13 /* DrawSegmentsPx */: {
        this.clip(ctx, p);
        const b = r.bulk(p, 16);
        const vf = new Float32Array(
          b.buffer,
          b.byteOffset,
          b.length / 4
        );
        ctx.strokeStyle = css([
          p.getFloat32(40, true),
          p.getFloat32(44, true),
          p.getFloat32(48, true),
          p.getFloat32(52, true)
        ]);
        ctx.lineWidth = Math.max(p.getFloat32(56, true), 0.5);
        ctx.beginPath();
        if (op === 12 /* DrawLineStripPx */) {
          ctx.moveTo(vf[0], vf[1]);
          for (let i = 2; i < vf.length; i += 2)
            ctx.lineTo(vf[i], vf[i + 1]);
        } else
          for (let i = 0; i + 3 < vf.length; i += 4) {
            ctx.moveTo(vf[i], vf[i + 1]);
            ctx.lineTo(vf[i + 2], vf[i + 3]);
          }
        ctx.stroke();
        ctx.restore();
        break;
      }
      case 14 /* DrawTextQuads */: {
        this.clip(ctx, p);
        const at = this.atlas();
        const b = r.bulk(p, 20);
        if (!at) {
          ctx.restore();
          break;
        }
        const texH = this.textures.get(p.getUint32(16, true));
        const aw = texH?.w ?? at.width, ah = texH?.h ?? at.height;
        const q = new Float32Array(
          b.buffer,
          b.byteOffset,
          b.length / 4
        );
        const tmp = document.createElement("canvas");
        const tc = tmp.getContext("2d");
        for (let i = 0; i + 47 < q.length; i += 48) {
          const vts = q.slice(i, i + 48);
          let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, u0 = 1e9, v0 = 1e9, u1 = -1e9, v1 = -1e9;
          for (let k = 0; k < 6; k++) {
            const V = k * 8;
            x0 = Math.min(x0, vts[V]);
            x1 = Math.max(x1, vts[V]);
            y0 = Math.min(y0, vts[V + 1]);
            y1 = Math.max(y1, vts[V + 1]);
            u0 = Math.min(u0, vts[V + 2]);
            u1 = Math.max(u1, vts[V + 2]);
            v0 = Math.min(v0, vts[V + 3]);
            v1 = Math.max(v1, vts[V + 3]);
          }
          const w = Math.max(x1 - x0, 0.5), h = Math.max(y1 - y0, 0.5);
          tmp.width = Math.ceil(w);
          tmp.height = Math.ceil(h);
          tc.globalCompositeOperation = "copy";
          tc.drawImage(
            at,
            u0 * aw,
            v0 * ah,
            Math.max((u1 - u0) * aw, 1),
            Math.max((v1 - v0) * ah, 1),
            0,
            0,
            w,
            h
          );
          tc.globalCompositeOperation = "source-in";
          tc.fillStyle = css([q[i + 4], q[i + 5], q[i + 6], 1]);
          tc.globalAlpha = q[i + 7];
          tc.fillRect(0, 0, w, h);
          tc.globalAlpha = 1;
          ctx.drawImage(tmp, x0, y0);
        }
        ctx.restore();
        break;
      }
      case 15 /* DrawInstanced */: {
        this.clip(ctx, p);
        const tpl = new Float32Array(
          r.bulk(p, 16).buffer,
          r.bulk(p, 16).byteOffset,
          r.bulk(p, 16).length / 4
        );
        const inst = new Float32Array(
          r.bulk(p, 40).buffer,
          r.bulk(p, 40).byteOffset,
          r.bulk(p, 40).length / 4
        );
        for (let i = 0; i + 7 < inst.length; i += 8) {
          const [ox, oy, sx, sy] = [
            inst[i],
            inst[i + 1],
            inst[i + 2],
            inst[i + 3]
          ];
          ctx.fillStyle = css(inst.slice(i + 4, i + 8));
          ctx.beginPath();
          for (let k = 0; k + 1 < tpl.length; k += 2) {
            const X = ox + tpl[k] * sx, Y = oy + tpl[k + 1] * sy;
            if (k === 0) ctx.moveTo(X, Y);
            else ctx.lineTo(X, Y);
          }
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
        break;
      }
      case 20 /* DrawLines */:
      case 21 /* DrawLineSegs */: {
        this.clip(ctx, p);
        const xf = new XformView(p, 32);
        const buf = this.buffers.get(p.getUint32(160, true));
        const n = p.getUint32(164, true);
        if (!buf) {
          ctx.restore();
          break;
        }
        const vf = new Float32Array(buf.buffer, buf.byteOffset, n * 2);
        ctx.strokeStyle = css([
          p.getFloat32(168, true),
          p.getFloat32(172, true),
          p.getFloat32(176, true),
          p.getFloat32(180, true)
        ]);
        ctx.lineWidth = Math.max(p.getFloat32(184, true), 0.5);
        ctx.beginPath();
        if (op === 20 /* DrawLines */) {
          const [x0, y0] = xf.toPx(vf[0], vf[1]);
          ctx.moveTo(x0, y0);
          for (let i = 1; i < n; i++) {
            const [x, y] = xf.toPx(vf[i * 2], vf[i * 2 + 1]);
            ctx.lineTo(x, y);
          }
        } else
          for (let i = 0; i + 3 < n * 2; i += 4) {
            const [x0, y0] = xf.toPx(vf[i], vf[i + 1]);
            const [x1, y1] = xf.toPx(vf[i + 2], vf[i + 3]);
            ctx.moveTo(x0, y0);
            ctx.lineTo(x1, y1);
          }
        ctx.stroke();
        ctx.restore();
        break;
      }
      case 22 /* DrawPoints */: {
        this.clip(ctx, p);
        const xf = new XformView(p, 32);
        const pos = this.buffers.get(p.getUint32(160, true));
        const col = this.buffers.get(p.getUint32(164, true));
        const siz = this.buffers.get(p.getUint32(168, true));
        const n = p.getUint32(172, true);
        const flags = p.getUint32(176, true);
        if (!pos) {
          ctx.restore();
          break;
        }
        const pv = new Float32Array(pos.buffer, pos.byteOffset, n * 2);
        const cv = col && flags & 1 ? new Float32Array(col.buffer, col.byteOffset, n * 4) : void 0;
        const sv = siz && flags & 2 ? new Float32Array(siz.buffer, siz.byteOffset, n) : void 0;
        for (let i = 0; i < n; i++) {
          const [x, y] = xf.toPx(pv[i * 2], pv[i * 2 + 1]);
          const sz = sv ? Math.max(sv[i], 0.5) : 6;
          ctx.fillStyle = css(cv ? Array.from(cv.slice(i * 4, i * 4 + 4)) : xf.color);
          ctx.beginPath();
          ctx.arc(x, y, sz * 0.5, 0, 6.2832);
          ctx.fill();
        }
        ctx.restore();
        break;
      }
      case 23 /* DrawTrisData */:
      case 25 /* DrawPie */: {
        this.clip(ctx, p);
        const xf = new XformView(p, 16);
        const pos = this.buffers.get(p.getUint32(144, true));
        const col = this.buffers.get(p.getUint32(148, true));
        const n = p.getUint32(152, true);
        if (!pos) {
          ctx.restore();
          break;
        }
        const pv = new Float32Array(pos.buffer, pos.byteOffset, n * 2);
        const cv = col ? new Float32Array(col.buffer, col.byteOffset, n * 4) : void 0;
        for (let i = 0; i + 2 < n; i += 3) {
          const P = [[0, 0], [0, 0], [0, 0]].map((_, k) => xf.toPx(pv[(i + k) * 2], pv[(i + k) * 2 + 1]));
          ctx.fillStyle = css(cv ? Array.from(cv.slice(i * 4, i * 4 + 4)) : [
            p.getFloat32(156, true),
            p.getFloat32(160, true),
            p.getFloat32(164, true),
            p.getFloat32(168, true)
          ]);
          ctx.beginPath();
          ctx.moveTo(P[0][0], P[0][1]);
          ctx.lineTo(P[1][0], P[1][1]);
          ctx.lineTo(P[2][0], P[2][1]);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
        break;
      }
      case 24 /* DrawTrisGpu */: {
        this.clip(ctx, p);
        const buf = this.buffers.get(p.getUint32(24, true));
        if (!buf) {
          ctx.restore();
          break;
        }
        const off = Number(p.getBigUint64(28, true));
        const cnt = p.getUint32(36, true);
        const vf = new Float32Array(
          buf.buffer,
          buf.byteOffset + off,
          cnt * 6
        );
        this.tris(ctx, vf, 6, (i) => Array.from(vf.slice(i + 2, i + 6)));
        ctx.restore();
        break;
      }
      case 26 /* DrawImage */: {
        const xf = new XformView(p, 16);
        const gt = this.textures.get(p.getUint32(144, true));
        const lt = this.textures.get(p.getUint32(148, true));
        if (!gt) break;
        const rgba = gt.fmt === 1 || p.getFloat32(152, true) > 0.5;
        const lower = p.getFloat32(156, true) > 0.5;
        const nanT = p.getFloat32(160, true) > 0.5;
        const vMin = p.getFloat32(164, true), vMax = p.getFloat32(168, true);
        const cv = document.createElement("canvas");
        cv.width = gt.w;
        cv.height = gt.h;
        const cc = cv.getContext("2d");
        const img = cc.createImageData(gt.w, gt.h);
        const lut = lt ? lt.data : void 0;
        const gf = rgba ? void 0 : new Float32Array(
          gt.data.buffer,
          gt.data.byteOffset,
          gt.data.length / 4
        );
        const span = Math.max(vMax - vMin, 1e-30);
        for (let i = 0; i < gt.w * gt.h; i++) {
          if (rgba) {
            img.data.set(gt.data.subarray(i * 4, i * 4 + 4), i * 4);
            continue;
          }
          const v = gf[i];
          if (Number.isNaN(v)) {
            if (!nanT) img.data.set([255, 0, 255, 255], i * 4);
            continue;
          }
          const t = Math.min(Math.max((v - vMin) / span, 0), 1);
          const li = lut ? Math.min(t * 255, 255) | 0 : 0;
          const px = lut ? [
            lut[li * 4],
            lut[li * 4 + 1],
            lut[li * 4 + 2],
            lut[li * 4 + 3]
          ] : [t * 255, t * 255, t * 255, 255];
          img.data.set(px, i * 4);
        }
        cc.putImageData(img, 0, 0);
        const f = xf.f;
        this.clip(ctx, p);
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        if (lower) {
          ctx.translate(0, f[5] + f[7] * 2);
          ctx.scale(1, -1);
        }
        ctx.drawImage(cv, f[4], f[5], f[6], f[7]);
        ctx.restore();
        ctx.restore();
        break;
      }
      default:
        break;
    }
  }
};

// src/svg.ts
var hex = (c) => "#" + [c[0], c[1], c[2]].map((v) => Math.round(Math.min(Math.max(v, 0), 1) * 255).toString(16).padStart(2, "0")).join("");
var alpha = (c) => c[3] ?? 1;
var SvgExporter = class {
  buffers = /* @__PURE__ */ new Map();
  textures = /* @__PURE__ */ new Map();
  out = [];
  clips = /* @__PURE__ */ new Map();
  nClip = 0;
  toSvg(frame) {
    this.out = [];
    this.clips.clear();
    this.nClip = 0;
    this.buffers.clear();
    this.textures.clear();
    const r = new OpReader(frame);
    for (const { op, p } of r.ops()) {
      if (op <= 6 /* ReleaseTexture */) this.execResource(r, op, p);
      else if (op >= 40 /* TessLines */) this.execCompute(r, p, op);
      else this.draw(r, op, p);
    }
    let defs = "";
    for (const [rc, id] of this.clips) {
      const [x, y, w, h] = rc.split(",").map(Number);
      defs += `<clipPath id="c${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}"/></clipPath>`;
    }
    const [cr, cg, cb, ca] = r.clearRGBA();
    const bg = `<rect width="100%" height="100%" fill="${hex(
      [cr, cg, cb]
    )}" fill-opacity="${ca}"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${r.header.canvasW}" height="${r.header.canvasH}" viewBox="0 0 ${r.header.canvasW} ${r.header.canvasH}">` + (defs ? `<defs>${defs}</defs>` : "") + bg + this.out.join("") + `</svg>`;
  }
  // ── resources / compute — same as Canvas2D path ─────────────────
  execResource(r, op, p) {
    switch (op) {
      case 1 /* CreateBuffer */:
        this.buffers.set(
          p.getUint32(0, true),
          new Uint8Array(Number(p.getBigUint64(4, true)))
        );
        break;
      case 2 /* WriteBuffer */: {
        const b = this.buffers.get(p.getUint32(0, true));
        if (b) b.set(
          r.bulk(p, 12),
          Number(p.getBigUint64(4, true))
        );
        break;
      }
      case 3 /* ReleaseBuffer */:
        this.buffers.delete(p.getUint32(0, true));
        break;
      case 4 /* CreateTexture */:
        this.textures.set(p.getUint32(0, true), {
          w: p.getUint32(4, true),
          h: p.getUint32(8, true),
          fmt: p.getUint8(12),
          data: new Uint8Array(0)
        });
        break;
      case 5 /* WriteTexture */: {
        const t = this.textures.get(p.getUint32(0, true));
        if (!t) break;
        const x = p.getUint32(4, true), y = p.getUint32(8, true), w = p.getUint32(12, true), hh = p.getUint32(16, true);
        const src = r.bulk(p, 20);
        const bpt = t.fmt === 0 ? 1 : 4;
        if (t.data.length !== t.w * t.h * bpt)
          t.data = new Uint8Array(t.w * t.h * bpt);
        for (let row = 0; row < hh; row++)
          t.data.set(
            src.subarray(row * w * bpt, (row + 1) * w * bpt),
            ((y + row) * t.w + x) * bpt
          );
        break;
      }
      case 6 /* ReleaseTexture */:
        this.textures.delete(p.getUint32(0, true));
        break;
    }
  }
  execCompute(r, p, op) {
    if (op !== 40 /* TessLines */) return;
    const inB = this.buffers.get(p.getUint32(0, true));
    const out = this.buffers.get(p.getUint32(8, true));
    const nSeg = p.getUint32(20, true);
    const hw = p.getFloat32(24, true);
    const color = [
      p.getFloat32(34, true),
      p.getFloat32(38, true),
      p.getFloat32(42, true),
      p.getFloat32(46, true)
    ];
    if (!inB || !out) return;
    const iv = new Float32Array(inB.buffer, inB.byteOffset + p.getUint32(4, true));
    const ov = new DataView(out.buffer, out.byteOffset + p.getUint32(12, true));
    for (let s = 0; s < nSeg; s++) {
      const x0 = iv[s * 2], y0 = iv[s * 2 + 1];
      const x1 = iv[s * 2 + 2], y1 = iv[s * 2 + 3];
      const dx = x1 - x0, dy = y1 - y0;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len * hw, ny = dx / len * hw;
      const q = [
        x0 - nx,
        y0 - ny,
        x1 - nx,
        y1 - ny,
        x1 + nx,
        y1 + ny,
        x0 - nx,
        y0 - ny,
        x1 + nx,
        y1 + ny,
        x0 + nx,
        y0 + ny
      ];
      for (let v = 0; v < 6; v++) {
        const o = (s * 6 + v) * 24;
        ov.setFloat32(o, q[v * 2], true);
        ov.setFloat32(o + 4, q[v * 2 + 1], true);
        for (let k = 0; k < 4; k++)
          ov.setFloat32(o + 8 + k * 4, color[k], true);
      }
    }
  }
  // ── SVG emission ────────────────────────────────────────────────
  /** Open a clip group for the payload's clip rect; returns '' or
   * the closing tag handling is via clipEnd(). */
  clipStart(p) {
    const x = p.getFloat32(0, true), y = p.getFloat32(4, true), w = p.getFloat32(8, true), h = p.getFloat32(12, true);
    const key = `${x},${y},${w},${h}`;
    let id = this.clips.get(key);
    if (id === void 0) {
      id = this.nClip++;
      this.clips.set(key, id);
    }
    return `<g clip-path="url(#c${id})">`;
  }
  f32(buf) {
    return new Float32Array(
      buf.buffer,
      buf.byteOffset,
      buf.length / 4
    );
  }
  triPath(pts, col, a) {
    return `<path d="M${pts.join("L")}Z" fill="${col}"` + (a < 1 ? ` fill-opacity="${a}"` : "") + "/>";
  }
  draw(r, op, p) {
    const E = this.out, clip = this.clipStart(p), CE = "</g>";
    switch (op) {
      case 10 /* DrawTrisPx */: {
        const vf = this.f32(r.bulk(p, 16));
        const col = [
          p.getFloat32(40, true),
          p.getFloat32(44, true),
          p.getFloat32(48, true),
          p.getFloat32(52, true)
        ];
        let d = "";
        for (let i = 0; i + 5 < vf.length; i += 6)
          d += `M${vf[i]} ${vf[i + 1]}L${vf[i + 2]} ${vf[i + 3]}L${vf[i + 4]} ${vf[i + 5]}Z`;
        E.push(clip + `<path d="${d}" fill="${hex(col)}" fill-opacity="${alpha(col)}"/>` + CE);
        break;
      }
      case 11 /* DrawTrisPxVC */: {
        const vf = this.f32(r.bulk(p, 16));
        const cf = this.f32(r.bulk(p, 40));
        let s = clip;
        for (let i = 0; i + 5 < vf.length; i += 6) {
          const c = cf.subarray(i * 2, i * 2 + 4);
          s += this.triPath(
            [vf[i], vf[i + 1], vf[i + 2], vf[i + 3], vf[i + 4], vf[i + 5]],
            hex(c),
            alpha(c)
          );
        }
        E.push(s + CE);
        break;
      }
      case 12 /* DrawLineStripPx */:
      case 13 /* DrawSegmentsPx */: {
        const vf = this.f32(r.bulk(p, 16));
        const col = [
          p.getFloat32(40, true),
          p.getFloat32(44, true),
          p.getFloat32(48, true),
          p.getFloat32(52, true)
        ];
        const lw = Math.max(p.getFloat32(56, true), 0.5);
        let d = "";
        if (op === 12 /* DrawLineStripPx */) {
          d = `M${vf[0]} ${vf[1]}`;
          for (let i = 2; i < vf.length; i += 2)
            d += `L${vf[i]} ${vf[i + 1]}`;
        } else
          for (let i = 0; i + 3 < vf.length; i += 4)
            d += `M${vf[i]} ${vf[i + 1]}L${vf[i + 2]} ${vf[i + 3]}`;
        E.push(clip + `<path d="${d}" fill="none" stroke="${hex(col)}" stroke-width="${lw}"` + (alpha(col) < 1 ? ` stroke-opacity="${alpha(col)}"` : "") + `/>` + CE);
        break;
      }
      case 20 /* DrawLines */:
      case 21 /* DrawLineSegs */: {
        const xf = new XformView(p, 32);
        const buf = this.buffers.get(p.getUint32(160, true));
        const n = p.getUint32(164, true);
        if (!buf) break;
        const vf = new Float32Array(buf.buffer, buf.byteOffset, n * 2);
        const col = [
          p.getFloat32(168, true),
          p.getFloat32(172, true),
          p.getFloat32(176, true),
          p.getFloat32(180, true)
        ];
        const lw = Math.max(p.getFloat32(184, true), 0.5);
        let d = "";
        if (op === 20 /* DrawLines */) {
          const [x, y] = xf.toPx(vf[0], vf[1]);
          d = `M${x} ${y}`;
          for (let i = 1; i < n; i++) {
            const [px, py] = xf.toPx(vf[i * 2], vf[i * 2 + 1]);
            d += `L${px} ${py}`;
          }
        } else
          for (let i = 0; i + 3 < n * 2; i += 4) {
            const [a, b] = xf.toPx(vf[i], vf[i + 1]);
            const [c, dd] = xf.toPx(vf[i + 2], vf[i + 3]);
            d += `M${a} ${b}L${c} ${dd}`;
          }
        E.push(clip + `<path d="${d}" fill="none" stroke="${hex(col)}" stroke-width="${lw}"/>` + CE);
        break;
      }
      case 22 /* DrawPoints */: {
        const xf = new XformView(p, 32);
        const pos = this.buffers.get(p.getUint32(160, true));
        const col = this.buffers.get(p.getUint32(164, true));
        const siz = this.buffers.get(p.getUint32(168, true));
        const n = p.getUint32(172, true);
        const flags = p.getUint32(176, true);
        if (!pos) break;
        const pv = new Float32Array(pos.buffer, pos.byteOffset, n * 2);
        const cv = col && flags & 1 ? new Float32Array(col.buffer, col.byteOffset, n * 4) : void 0;
        const sv = siz && flags & 2 ? new Float32Array(siz.buffer, siz.byteOffset, n) : void 0;
        let s = clip;
        for (let i = 0; i < n; i++) {
          const [x, y] = xf.toPx(pv[i * 2], pv[i * 2 + 1]);
          const c = cv ? cv.subarray(i * 4, i * 4 + 4) : xf.color;
          s += `<circle cx="${x}" cy="${y}" r="${(sv ? sv[i] : 6) / 2}" fill="${hex(c)}"` + (alpha(c) < 1 ? ` fill-opacity="${alpha(c)}"` : "") + "/>";
        }
        E.push(s + CE);
        break;
      }
      case 23 /* DrawTrisData */:
      case 25 /* DrawPie */: {
        const xf = new XformView(p, 16);
        const pos = this.buffers.get(p.getUint32(144, true));
        const col = this.buffers.get(p.getUint32(148, true));
        const n = p.getUint32(152, true);
        if (!pos) break;
        const pv = new Float32Array(pos.buffer, pos.byteOffset, n * 2);
        const cv = col ? new Float32Array(col.buffer, col.byteOffset, n * 4) : void 0;
        let s = clip;
        for (let i = 0; i + 2 < n; i += 3) {
          const pts = [];
          for (let k = 0; k < 3; k++) {
            const [x, y] = xf.toPx(pv[(i + k) * 2], pv[(i + k) * 2 + 1]);
            pts.push(x, y);
          }
          const c = cv ? cv.subarray(i * 4, i * 4 + 4) : [
            p.getFloat32(156, true),
            p.getFloat32(160, true),
            p.getFloat32(164, true),
            p.getFloat32(168, true)
          ];
          s += this.triPath(pts, hex(c), alpha(c));
        }
        E.push(s + CE);
        break;
      }
      case 24 /* DrawTrisGpu */: {
        const buf = this.buffers.get(p.getUint32(24, true));
        if (!buf) break;
        const off = Number(p.getBigUint64(28, true));
        const cnt = p.getUint32(36, true);
        const vf = new Float32Array(
          buf.buffer,
          buf.byteOffset + off,
          cnt * 6
        );
        let s = clip;
        for (let i = 0; i + 17 < vf.length; i += 18) {
          const c = vf.subarray(i + 2, i + 6);
          s += this.triPath(
            [vf[i], vf[i + 1], vf[i + 6], vf[i + 7], vf[i + 12], vf[i + 13]],
            hex(c),
            alpha(c)
          );
        }
        E.push(s + CE);
        break;
      }
      case 15 /* DrawInstanced */: {
        const tpl = this.f32(r.bulk(p, 16));
        const inst = this.f32(r.bulk(p, 40));
        let s = clip;
        for (let i = 0; i + 7 < inst.length; i += 8) {
          const [ox, oy, sx, sy] = [
            inst[i],
            inst[i + 1],
            inst[i + 2],
            inst[i + 3]
          ];
          let d = "";
          for (let k = 0; k + 1 < tpl.length; k += 2)
            d += `${k ? "L" : "M"}${ox + tpl[k] * sx} ${oy + tpl[k + 1] * sy}`;
          const c = inst.subarray(i + 4, i + 8);
          s += `<path d="${d}Z" fill="${hex(c)}" fill-opacity="${alpha(c)}"/>`;
        }
        E.push(s + CE);
        break;
      }
      case 26 /* DrawImage */: {
        const xf = new XformView(p, 16);
        const gt = this.textures.get(p.getUint32(144, true));
        const lt = this.textures.get(p.getUint32(148, true));
        if (!gt || typeof document === "undefined") break;
        const rgba = gt.fmt === 1 || p.getFloat32(152, true) > 0.5;
        const nanT = p.getFloat32(160, true) > 0.5;
        const vMin = p.getFloat32(164, true), vMax = p.getFloat32(168, true);
        const cv = document.createElement("canvas");
        cv.width = gt.w;
        cv.height = gt.h;
        const cc = cv.getContext("2d");
        const img = cc.createImageData(gt.w, gt.h);
        const lut = lt ? lt.data : void 0;
        const gf = rgba ? void 0 : new Float32Array(
          gt.data.buffer,
          gt.data.byteOffset,
          gt.data.length / 4
        );
        const span = Math.max(vMax - vMin, 1e-30);
        for (let i = 0; i < gt.w * gt.h; i++) {
          if (rgba) {
            img.data.set(gt.data.subarray(i * 4, i * 4 + 4), i * 4);
            continue;
          }
          const v = gf[i];
          if (Number.isNaN(v)) {
            if (!nanT) img.data.set([255, 0, 255, 255], i * 4);
            continue;
          }
          const t = Math.min(Math.max((v - vMin) / span, 0), 1);
          const li = lut ? Math.min(t * 255, 255) | 0 : 0;
          img.data.set(lut ? [lut[li * 4], lut[li * 4 + 1], lut[li * 4 + 2], lut[li * 4 + 3]] : [t * 255, t * 255, t * 255, 255], i * 4);
        }
        cc.putImageData(img, 0, 0);
        const f = xf.f;
        E.push(clip + `<image x="${f[4]}" y="${f[5]}" width="${f[6]}" height="${f[7]}" preserveAspectRatio="none" image-rendering="pixelated" href="${cv.toDataURL("image/png")}"/>` + CE);
        break;
      }
      default:
        break;
    }
  }
};

// src/volcano.ts
var VolcanoCanvas = class {
  constructor(mod, canvas, device, gpuCtx, adapter) {
    this.mod = mod;
    this.canvas = canvas;
    this.adapter = adapter ?? null;
    this.device = device;
    this.gpuCtx = gpuCtx;
    const mb = (slot, v) => mod._vp_mailbox(slot, v[0], v[1], v[2], v[3]);
    const mbBytes = (slot, bytes) => {
      const dst = mod._vp_mailboxDest(slot, bytes.length);
      mod.HEAPU8.set(bytes, dst);
      mod._vp_mailboxDone(slot);
    };
    if (device && gpuCtx) {
      const gpu = new Interpreter(
        device,
        gpuCtx,
        navigator.gpu.getPreferredCanvasFormat(),
        mb,
        mbBytes
      );
      gpu.init();
      this.interp = gpu;
    } else {
      this.ctx2d = canvas.getContext("2d");
      this.interp = new Canvas2DInterpreter(mb);
    }
    device?.lost.then((info) => {
      if (info.reason === "destroyed") return;
      this.dead = true;
      this.onDeviceLost?.(info.reason, info.message);
    });
    this.syncSize();
  }
  mod;
  canvas;
  interp;
  ctx2d;
  devPixelRatio = 1;
  // Retain the adapter: in Dawn's wire client, GC'ing the GPUAdapter
  // can destroy the device ("external Instance reference no longer
  // exists" on later mapAsync).
  adapter = null;
  dead = false;
  /** Called when the WebGPU device is lost. The canvas is then dead:
   * render calls throw until a new VolcanoCanvas is created. */
  onDeviceLost;
  /** Undefined on the Canvas2D fallback path. */
  device;
  gpuCtx;
  checkLive() {
    if (this.dead)
      throw new Error("WebGPU device lost \u2014 recreate the canvas");
  }
  /** Release the GPU device and mark this canvas unusable. */
  destroy() {
    this.dead = true;
    this.device?.destroy();
  }
  /** Follow DPR — call on resize/orientation change. */
  syncSize() {
    this.devPixelRatio = globalThis.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(
      this.canvas.clientWidth * this.devPixelRatio
    ));
    const h = Math.max(1, Math.round(
      this.canvas.clientHeight * this.devPixelRatio
    ));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.mod._vp_resize(w, h);
  }
  /** Render if the figure is stale; replays the op stream. */
  renderIfStale() {
    this.checkLive();
    if (!this.mod._vp_renderIfStale()) return false;
    this.replay();
    return true;
  }
  render() {
    this.checkLive();
    this.mod._vp_render();
    this.replay();
  }
  /** Export the last rendered frame as an SVG string — vector
   * geometry ops become <path>/<circle>/<polyline>; heatmaps embed
   * as raster PNGs; tick-label glyph quads are skipped (text is
   * atlas-rasterized upstream). */
  toSvg() {
    const ptr = this.mod._vp_framePtr(), len = this.mod._vp_frameLen();
    if (!ptr || !len) return "";
    const frame = this.mod.HEAPU8.subarray(ptr, ptr + len);
    return new SvgExporter().toSvg(frame.slice());
  }
  /** Render to an offscreen target and read back RGBA8 pixels —
   * test/debug path; does not touch the canvas. */
  async capture() {
    this.checkLive();
    this.mod._vp_render();
    const ptr = this.mod._vp_framePtr(), len = this.mod._vp_frameLen();
    const frame = this.mod.HEAPU8.subarray(ptr, ptr + len).slice();
    if (this.interp instanceof Canvas2DInterpreter) {
      const cv = document.createElement("canvas");
      cv.width = this.canvas.width;
      cv.height = this.canvas.height;
      const c = cv.getContext("2d");
      this.interp.draw(frame, c);
      const d = c.getImageData(0, 0, cv.width, cv.height).data;
      return new Uint8Array(d.buffer.slice(0));
    }
    return this.interp.capture(
      frame,
      this.canvas.width,
      this.canvas.height
    );
  }
  /** Stage JS data into the WASM heap (zero-copy for C++). */
  stage(data) {
    const ptr = this.mod._vp_alloc(data.length * 4);
    const view = new Float32Array(
      this.mod.HEAPU8.buffer,
      ptr,
      data.length
    );
    view.set(data);
    return view;
  }
  /// Axes index all plot calls target (mpl "current axes").
  cur = 0;
  /** mpl subplot(nrows, ncols, index) — creates the grid on first
   * use and selects the new axes for subsequent plot calls. */
  subplot(nrows, ncols, index) {
    return this.cur = this.mod._vp_subplot(nrows, ncols, index);
  }
  /** Select an existing axes by index (as returned by subplot()). */
  axes(i) {
    this.cur = i;
  }
  detachInteraction;
  /** mpl matshow — nearest-neighbor matrix display. */
  matshow(data, nrows, ncols) {
    const d = this.stage(data);
    try {
      return this.mod._vp_matshow(this.cur, d, nrows, ncols);
    } finally {
      this.mod._vp_free(d.byteOffset);
    }
  }
  /** mpl pcolorfast on a regular grid with the given extent. */
  pcolorfast(C, nCols, nRows, x0 = 0, x1 = nCols, y0 = 0, y1 = nRows) {
    const c = this.stage(C);
    try {
      return this.mod._vp_pcolorfast(
        this.cur,
        c,
        nCols,
        nRows,
        x0,
        x1,
        y0,
        y1
      );
    } finally {
      this.mod._vp_free(c.byteOffset);
    }
  }
  /** mpl broken_barh — flat [xStart, xWidth, yStart, yHeight]* tuples. */
  brokenBarh(segs) {
    const s = this.stage(segs);
    try {
      return this.mod._vp_brokenBarh(this.cur, s);
    } finally {
      this.mod._vp_free(s.byteOffset);
    }
  }
  /** mpl tricontour — Delaunay-triangulates scattered (x,y,z). */
  tricontour(xs, ys, zs) {
    const x = this.stage(xs), y = this.stage(ys), z = this.stage(zs);
    try {
      return this.mod._vp_tricontour(this.cur, x, y, z);
    } finally {
      this.mod._vp_free(x.byteOffset);
      this.mod._vp_free(y.byteOffset);
      this.mod._vp_free(z.byteOffset);
    }
  }
  /** mpl triplot — triangle edges + vertex markers. */
  triplot(xs, ys) {
    const x = this.stage(xs), y = this.stage(ys);
    try {
      return this.mod._vp_triplot(this.cur, x, y);
    } finally {
      this.mod._vp_free(x.byteOffset);
      this.mod._vp_free(y.byteOffset);
    }
  }
  /** mpl specgram — spectrogram of a 1-D signal. */
  specgram(signal, fs = 2) {
    const s = this.stage(signal);
    try {
      return this.mod._vp_specgram(this.cur, s, fs);
    } finally {
      this.mod._vp_free(s.byteOffset);
    }
  }
  /** mpl spectrum — magnitude spectrum of a 1-D signal. */
  spectrum(signal, fs = 2) {
    const s = this.stage(signal);
    try {
      return this.mod._vp_spectrum(this.cur, s, fs);
    } finally {
      this.mod._vp_free(s.byteOffset);
    }
  }
  /** mpl psd — power spectral density. */
  psd(signal, fs = 2) {
    const s = this.stage(signal);
    try {
      return this.mod._vp_psd(this.cur, s, fs);
    } finally {
      this.mod._vp_free(s.byteOffset);
    }
  }
  /** mpl csd — cross power spectral density of two signals. */
  csd(xs, ys, fs = 2) {
    const x = this.stage(xs), y = this.stage(ys);
    try {
      return this.mod._vp_csd(this.cur, x, y, fs);
    } finally {
      this.mod._vp_free(x.byteOffset);
      this.mod._vp_free(y.byteOffset);
    }
  }
  /** mpl xcorr — cross-correlation of two signals. */
  xcorr(xs, ys) {
    const x = this.stage(xs), y = this.stage(ys);
    try {
      return this.mod._vp_xcorr(this.cur, x, y);
    } finally {
      this.mod._vp_free(x.byteOffset);
      this.mod._vp_free(y.byteOffset);
    }
  }
  /** mpl cohere — coherence of two signals. */
  cohere(xs, ys, fs = 2) {
    const x = this.stage(xs), y = this.stage(ys);
    try {
      return this.mod._vp_cohere(this.cur, x, y, fs);
    } finally {
      this.mod._vp_free(x.byteOffset);
      this.mod._vp_free(y.byteOffset);
    }
  }
  /** mpl wireframe — 3-D wireframe of a row-major height grid. */
  wireframe(values, w, h, elev = 30, azim = -60) {
    const v = this.stage(values);
    try {
      return this.mod._vp_wireframe(this.cur, v, w, h, elev, azim);
    } finally {
      this.mod._vp_free(v.byteOffset);
    }
  }
  /** mpl plot_trisurf — triangulated 3-D surface of scattered points. */
  trisurf(xs, ys, zs, elev = 30, azim = -60) {
    const x = this.stage(xs), y = this.stage(ys), z = this.stage(zs);
    try {
      return this.mod._vp_trisurf(this.cur, x, y, z, elev, azim);
    } finally {
      this.mod._vp_free(x.byteOffset);
      this.mod._vp_free(y.byteOffset);
      this.mod._vp_free(z.byteOffset);
    }
  }
  /** mpl Axes3D.plot — 3-D line through (x,y,z). */
  plot3d(xs, ys, zs, elev = 30, azim = -60) {
    const x = this.stage(xs), y = this.stage(ys), z = this.stage(zs);
    try {
      return this.mod._vp_plot3d(this.cur, x, y, z, elev, azim);
    } finally {
      this.mod._vp_free(x.byteOffset);
      this.mod._vp_free(y.byteOffset);
      this.mod._vp_free(z.byteOffset);
    }
  }
  /** mpl Axes3D.scatter — 3-D point cloud. */
  scatter3d(xs, ys, zs, elev = 30, azim = -60) {
    const x = this.stage(xs), y = this.stage(ys), z = this.stage(zs);
    try {
      return this.mod._vp_scatter3d(this.cur, x, y, z, elev, azim);
    } finally {
      this.mod._vp_free(x.byteOffset);
      this.mod._vp_free(y.byteOffset);
      this.mod._vp_free(z.byteOffset);
    }
  }
  /** mpl Axes3D.bar3d — boxes at (x,y) rising by dz. */
  bar3d(xs, ys, zs, dxs, dys, dzs, elev = 30, azim = -60) {
    const x = this.stage(xs), y = this.stage(ys), z = this.stage(zs);
    const dx = this.stage(dxs), dy = this.stage(dys), dz = this.stage(dzs);
    try {
      return this.mod._vp_bar3d(
        this.cur,
        x,
        y,
        z,
        dx,
        dy,
        dz,
        elev,
        azim
      );
    } finally {
      for (const v of [x, y, z, dx, dy, dz])
        this.mod._vp_free(v.byteOffset);
    }
  }
  /** mpl Axes3D.quiver — 3-D vector field. */
  quiver3d(xs, ys, zs, us, vs, ws, elev = 30, azim = -60) {
    const x = this.stage(xs), y = this.stage(ys), z = this.stage(zs);
    const u = this.stage(us), v = this.stage(vs), w = this.stage(ws);
    try {
      return this.mod._vp_quiver3d(
        this.cur,
        x,
        y,
        z,
        u,
        v,
        w,
        elev,
        azim
      );
    } finally {
      for (const b of [x, y, z, u, v, w])
        this.mod._vp_free(b.byteOffset);
    }
  }
  /** mpl Axes3D.errorbar — points with z-error bars. */
  errorbar3d(xs, ys, zs, zerr, elev = 30, azim = -60) {
    const x = this.stage(xs), y = this.stage(ys), z = this.stage(zs);
    const e = this.stage(zerr);
    try {
      return this.mod._vp_errorbar3d(
        this.cur,
        x,
        y,
        z,
        e,
        elev,
        azim
      );
    } finally {
      for (const b of [x, y, z, e])
        this.mod._vp_free(b.byteOffset);
    }
  }
  /** mpl Axes3D.contour/contourf — contours on a projected grid. */
  contour3d(values, w, h, filled = false, elev = 30, azim = -60) {
    const v = this.stage(values);
    try {
      return this.mod._vp_contour3d(
        this.cur,
        v,
        w,
        h,
        filled,
        elev,
        azim
      );
    } finally {
      this.mod._vp_free(v.byteOffset);
    }
  }
  /** mpl Axes3D.voxels — binary occupancy grid (row-major xyz). */
  voxels(filled, nx, ny, nz, elev = 30, azim = -60) {
    const f = new Uint8Array(filled.length);
    for (let i = 0; i < filled.length; i++) f[i] = filled[i] ? 1 : 0;
    return this.mod._vp_voxels(this.cur, f, nx, ny, nz, elev, azim);
  }
  /** mpl ax.text at 3-D coordinates. */
  text3d(x, y, z, txt, elev = 30, azim = -60) {
    return this.mod._vp_text3d(this.cur, x, y, z, txt, elev, azim);
  }
  /** mpl barbs — wind barbs on a regular grid. */
  barbs(xs, ys, us, vs) {
    const x = this.stage(xs), y = this.stage(ys);
    const u = this.stage(us), v = this.stage(vs);
    try {
      return this.mod._vp_barbs(this.cur, x, y, u, v);
    } finally {
      for (const b of [x, y, u, v])
        this.mod._vp_free(b.byteOffset);
    }
  }
  /** mpl grouped bars — heights[series][group]. */
  groupedBar(heights) {
    const staged = heights.map((h) => this.stage(h));
    try {
      return this.mod._vp_groupedBar(this.cur, staged);
    } finally {
      for (const s of staged) this.mod._vp_free(s.byteOffset);
    }
  }
  /** mpl figimage — RGBA8 pixels (Uint32Array) on the figure. */
  figimage(pixels, w, h) {
    return this.mod._vp_figimage(this.cur, pixels, w, h);
  }
  /** Chirp signal demo — swept sinusoid f0→f1 over duration s. */
  chirp(f0, f1, duration, xMax) {
    return this.mod._vp_chirp(this.cur, f0, f1, duration, xMax);
  }
  /** Mexican-hat (Ricker) 3-D surface, |x|,|y| ≤ range. */
  mexicanHat(sigma = 1, range = 10, elev = 30, azim = -60) {
    return this.mod._vp_mexicanHat(
      this.cur,
      sigma,
      range,
      elev,
      azim
    );
  }
  /** mpl bar_label — value labels above bar tops. */
  barLabel(xs, heights, baseline = 0) {
    const x = this.stage(xs), h = this.stage(heights);
    try {
      return this.mod._vp_barLabel(this.cur, x, h, baseline);
    } finally {
      this.mod._vp_free(x.byteOffset);
      this.mod._vp_free(h.byteOffset);
    }
  }
  /** mpl tricontourf — filled contours on scattered (x,y,z). */
  tricontourf(xs, ys, zs) {
    const x = this.stage(xs), y = this.stage(ys), z = this.stage(zs);
    try {
      return this.mod._vp_tricontourf(this.cur, x, y, z);
    } finally {
      this.mod._vp_free(x.byteOffset);
      this.mod._vp_free(y.byteOffset);
      this.mod._vp_free(z.byteOffset);
    }
  }
  /** mpl Axes3D.tricontour — isolines on scattered 3D data. */
  tricontour3d(xs, ys, zs, elev = 30, azim = -60) {
    const x = this.stage(xs), y = this.stage(ys), z = this.stage(zs);
    try {
      return this.mod._vp_tricontour3d(this.cur, x, y, z, elev, azim);
    } finally {
      this.mod._vp_free(x.byteOffset);
      this.mod._vp_free(y.byteOffset);
      this.mod._vp_free(z.byteOffset);
    }
  }
  /** mpl Axes3D.tricontourf — filled contours on scattered 3D data. */
  tricontourf3d(xs, ys, zs, elev = 30, azim = -60) {
    const x = this.stage(xs), y = this.stage(ys), z = this.stage(zs);
    try {
      return this.mod._vp_tricontourf3d(this.cur, x, y, z, elev, azim);
    } finally {
      this.mod._vp_free(x.byteOffset);
      this.mod._vp_free(y.byteOffset);
      this.mod._vp_free(z.byteOffset);
    }
  }
  /** Orientation indicator (Blender/Paraview axis triad) overlaid
   * in a corner of the 3D axes. corner: 'ul'|'ur'|'ll'|'lr',
   * mode: 'triad'|'cube'. */
  navcube(elev = 30, azim = -60, corner = "ul", mode = "triad") {
    const c = { ul: 0, ur: 1, ll: 2, lr: 3 }[corner] ?? 0;
    return this.mod._vp_navcube(
      this.cur,
      elev,
      azim,
      c,
      mode === "cube" ? 1 : 0
    );
  }
  /** mpl quiverkey — reference arrow + label for a quiver plot.
   * `quiverHandle` is the value returned by `quiver()` (0 = unscaled). */
  quiverkey(x, y, u, quiverHandle = 0, label = "") {
    return this.mod._vp_quiverkey(
      this.cur,
      x,
      y,
      u,
      quiverHandle,
      label
    );
  }
  // ── mpl reference lines / spans / annotations ───────────────────
  axhline(y, color = "#000", width = 1) {
    this.mod._vp_axhline(this.cur, y, color, width);
  }
  axvline(x, color = "#000", width = 1) {
    this.mod._vp_axvline(this.cur, x, color, width);
  }
  axhspan(y1, y2, color = "#c8c8c880") {
    this.mod._vp_axhspan(this.cur, y1, y2, color);
  }
  axvspan(x1, x2, color = "#c8c8c880") {
    this.mod._vp_axvspan(this.cur, x1, x2, color);
  }
  hlines(ys, xMin, xMax, color = "#000", width = 1) {
    const v = this.stage(ys);
    try {
      this.mod._vp_hlines(this.cur, v, xMin, xMax, color, width);
    } finally {
      this.mod._vp_free(v.byteOffset);
    }
  }
  vlines(xs, yMin, yMax, color = "#000", width = 1) {
    const v = this.stage(xs);
    try {
      this.mod._vp_vlines(this.cur, v, yMin, yMax, color, width);
    } finally {
      this.mod._vp_free(v.byteOffset);
    }
  }
  /** mpl ax.legend — loc like "upper right", "best", "lower left". */
  legend(loc = "best") {
    this.mod._vp_legend(this.cur, loc);
  }
  /** mpl fig.colorbar — adds the colorbar strip to the axes. */
  colorbar() {
    this.mod._vp_colorbar(this.cur);
  }
  /** mpl ax.text — coords: 'data' | 'axes' | 'figure'. */
  text(x, y, txt, coords = "data") {
    this.mod._vp_text(
      this.cur,
      x,
      y,
      txt,
      coords === "data" ? 0 : coords === "axes" ? 1 : 2
    );
  }
  /** mpl-style interaction: left-drag pans, scroll zooms about the
   * cursor (scale-aware). Event coordinates are converted to device
   * px; the figure re-renders whenever an event touches it. */
  enableInteraction(on = true) {
    this.mod._vp_setInteractive(on);
    this.detachInteraction?.();
    this.detachInteraction = void 0;
    if (!on) return;
    const cv = this.canvas;
    const PRESS = 0, RELEASE = 1, MOTION = 2, SCROLL = 3;
    const pos = (e) => {
      const r = cv.getBoundingClientRect();
      return [
        (e.clientX - r.left) * cv.width / r.width,
        (e.clientY - r.top) * cv.height / r.height
      ];
    };
    const send = (type, x, y, button = 0, step = 0) => {
      if (this.mod._vp_dispatch(type, x, y, button, step))
        this.renderIfStale();
    };
    const down = (e) => {
      if (e.button > 2) return;
      const [x, y] = pos(e);
      send(PRESS, x, y, e.button + 1);
    };
    const move = (e) => {
      const [x, y] = pos(e);
      send(MOTION, x, y);
    };
    const up = (e) => {
      const [x, y] = pos(e);
      send(RELEASE, x, y, e.button + 1);
    };
    const wheel = (e) => {
      e.preventDefault();
      const [x, y] = pos(e);
      send(SCROLL, x, y, 0, e.deltaY < 0 ? 1 : -1);
    };
    cv.addEventListener("mousedown", down);
    cv.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    cv.addEventListener("wheel", wheel, { passive: false });
    cv.addEventListener("contextmenu", (e) => e.preventDefault());
    this.detachInteraction = () => {
      cv.removeEventListener("mousedown", down);
      cv.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      cv.removeEventListener("wheel", wheel);
    };
  }
  // ── mpl axes/figure styling ─────────────────────────────────────
  xlim(lo, hi) {
    this.mod._vp_xlim(this.cur, lo, hi);
  }
  ylim(lo, hi) {
    this.mod._vp_ylim(this.cur, lo, hi);
  }
  /** "linear"|"log"|"symlog"|"logit"|"asinh"|"mercator" */
  xscale(name) {
    this.mod._vp_xscale(this.cur, name);
  }
  yscale(name) {
    this.mod._vp_yscale(this.cur, name);
  }
  title(t) {
    this.mod._vp_title(this.cur, t);
  }
  xlabel(t) {
    this.mod._vp_xlabel(this.cur, t);
  }
  ylabel(t) {
    this.mod._vp_ylabel(this.cur, t);
  }
  grid(on = true) {
    this.mod._vp_grid(this.cur, on);
  }
  /** Figure-level suptitle. */
  suptitle(t) {
    this.mod._vp_suptitle(t);
  }
  line(xs, ys, color = "") {
    const vx = this.stage(xs), vy = this.stage(ys);
    try {
      return this.mod._vp_line(this.cur, vx, vy, color);
    } finally {
      this.mod._vp_free(vx.byteOffset);
      this.mod._vp_free(vy.byteOffset);
    }
  }
  scatter(xs, ys, color = "") {
    const vx = this.stage(xs), vy = this.stage(ys);
    try {
      return this.mod._vp_scatter(this.cur, vx, vy, color);
    } finally {
      this.mod._vp_free(vx.byteOffset);
      this.mod._vp_free(vy.byteOffset);
    }
  }
  /** GPU-evaluated function plot: `body` is a GLSL-ish expression or
   * statements assigning `y` from `x` (e.g. "sin(10.0*x)"). */
  func(body, xMin = 0, xMax = 1, color = "") {
    return this.mod._vp_function(this.cur, body, xMin, xMax, color);
  }
  bar(heights, labels = [], color = "") {
    const v = this.stage(heights);
    try {
      return this.mod._vp_bar(this.cur, v, labels, color);
    } finally {
      this.mod._vp_free(v.byteOffset);
    }
  }
  hist(samples, bins = 10, color = "") {
    const v = this.stage(samples);
    try {
      return this.mod._vp_hist(this.cur, v, bins, color);
    } finally {
      this.mod._vp_free(v.byteOffset);
    }
  }
  pie(values, labels = []) {
    const v = this.stage(values);
    try {
      return this.mod._vp_pie(this.cur, v, labels);
    } finally {
      this.mod._vp_free(v.byteOffset);
    }
  }
  /** Row-major scalar grid rendered through a colormap. */
  heatmap(values, w, h, cmap = "viridis") {
    const v = this.stage(values);
    try {
      return this.mod._vp_heatmap(this.cur, v, w, h, cmap);
    } finally {
      this.mod._vp_free(v.byteOffset);
    }
  }
  /** 3D surface from a row-major height grid. Camera uses mpl
   * viewInit angles (elev=30, azim=-60 by default). */
  surface(values, w, h, elev = 30, azim = -60) {
    const v = this.stage(values);
    try {
      return this.mod._vp_surface(this.cur, v, w, h, elev, azim);
    } finally {
      this.mod._vp_free(v.byteOffset);
    }
  }
  errorbar(xs, ys, yerr, color = "") {
    const a = this.stage(xs), b = this.stage(ys), e = this.stage(yerr);
    try {
      return this.mod._vp_errorbar(this.cur, a, b, e, color);
    } finally {
      for (const v of [a, b, e])
        this.mod._vp_free(v.byteOffset);
    }
  }
  stem(xs, ys) {
    const a = this.stage(xs), b = this.stage(ys);
    try {
      return this.mod._vp_stem(this.cur, a, b);
    } finally {
      this.mod._vp_free(a.byteOffset);
      this.mod._vp_free(b.byteOffset);
    }
  }
  step(xs, ys, where = "pre") {
    const a = this.stage(xs), b = this.stage(ys);
    try {
      return this.mod._vp_step(this.cur, a, b, where);
    } finally {
      this.mod._vp_free(a.byteOffset);
      this.mod._vp_free(b.byteOffset);
    }
  }
  ecdf(samples) {
    const v = this.stage(samples);
    try {
      return this.mod._vp_ecdf(this.cur, v);
    } finally {
      this.mod._vp_free(v.byteOffset);
    }
  }
  fillBetween(xs, y1, y2, color = "") {
    const a = this.stage(xs), b = this.stage(y1), c = this.stage(y2);
    try {
      return this.mod._vp_fillBetween(this.cur, a, b, c, color);
    } finally {
      for (const v of [a, b, c])
        this.mod._vp_free(v.byteOffset);
    }
  }
  boxplot(groups) {
    const staged = groups.map((g) => this.stage(g));
    try {
      return this.mod._vp_boxplot(this.cur, staged);
    } finally {
      for (const v of staged)
        this.mod._vp_free(v.byteOffset);
    }
  }
  hist2d(xs, ys, bins = 10, cmap = "viridis") {
    const a = this.stage(xs), b = this.stage(ys);
    try {
      return this.mod._vp_hist2d(this.cur, a, b, bins, cmap);
    } finally {
      this.mod._vp_free(a.byteOffset);
      this.mod._vp_free(b.byteOffset);
    }
  }
  hexbin(xs, ys) {
    const a = this.stage(xs), b = this.stage(ys);
    try {
      return this.mod._vp_hexbin(this.cur, a, b);
    } finally {
      this.mod._vp_free(a.byteOffset);
      this.mod._vp_free(b.byteOffset);
    }
  }
  quiver(xs, ys, us, vs) {
    const s = [xs, ys, us, vs].map((a) => this.stage(a));
    try {
      return this.mod._vp_quiver(this.cur, s[0], s[1], s[2], s[3]);
    } finally {
      for (const v of s) this.mod._vp_free(v.byteOffset);
    }
  }
  contour(values, w, h, levels = 10, cmap = "viridis") {
    const v = this.stage(values);
    try {
      return this.mod._vp_contour(this.cur, v, w, h, levels, cmap);
    } finally {
      this.mod._vp_free(v.byteOffset);
    }
  }
  /** mpl violinplot — one Float32Array per group. */
  violin(groups, width = 0.5, showBox = false, color = "") {
    const staged = groups.map((g) => this.stage(g));
    try {
      return this.mod._vp_violin(
        this.cur,
        staged,
        width,
        showBox,
        color
      );
    } finally {
      for (const v of staged)
        this.mod._vp_free(v.byteOffset);
    }
  }
  /** mpl stackplot — stacked area; one layer per element of `ys`. */
  stackplot(xs, ys) {
    const a = this.stage(xs);
    const staged = ys.map((g) => this.stage(g));
    try {
      return this.mod._vp_stackplot(this.cur, a, staged);
    } finally {
      this.mod._vp_free(a.byteOffset);
      for (const v of staged)
        this.mod._vp_free(v.byteOffset);
    }
  }
  /** mpl fill — filled polygon. */
  fill(xs, ys, color = "") {
    const a = this.stage(xs), b = this.stage(ys);
    try {
      return this.mod._vp_fill(this.cur, a, b, color);
    } finally {
      this.mod._vp_free(a.byteOffset);
      this.mod._vp_free(b.byteOffset);
    }
  }
  /** mpl spy — sparsity pattern of a row-major matrix. */
  spy(data, nrows, ncols) {
    const v = this.stage(data);
    try {
      return this.mod._vp_spy(this.cur, v, nrows, ncols);
    } finally {
      this.mod._vp_free(v.byteOffset);
    }
  }
  /** mpl tripcolor — Delaunay triangles colored by z. */
  tripcolor(xs, ys, zs) {
    const s = [xs, ys, zs].map((a) => this.stage(a));
    try {
      return this.mod._vp_tripcolor(this.cur, s[0], s[1], s[2]);
    } finally {
      for (const v of s) this.mod._vp_free(v.byteOffset);
    }
  }
  /** mpl streamplot — row-major w×h vector field. */
  streamplot(us, vs, w, h) {
    const a = this.stage(us), b = this.stage(vs);
    try {
      return this.mod._vp_streamplot(this.cur, a, b, w, h);
    } finally {
      this.mod._vp_free(a.byteOffset);
      this.mod._vp_free(b.byteOffset);
    }
  }
  pcolormesh(xs, ys, cs, nCols, nRows) {
    const a = this.stage(xs), b = this.stage(ys), c = this.stage(cs);
    try {
      return this.mod._vp_pcolormesh(this.cur, a, b, c, nCols, nRows);
    } finally {
      for (const v of [a, b, c])
        this.mod._vp_free(v.byteOffset);
    }
  }
  kde(xs, ys, cmap = "viridis") {
    const a = this.stage(xs), b = this.stage(ys);
    try {
      return this.mod._vp_kde(this.cur, a, b, cmap);
    } finally {
      this.mod._vp_free(a.byteOffset);
      this.mod._vp_free(b.byteOffset);
    }
  }
  /** In-place update for a handle from line()/scatter() — the
   * ring-buffer/streaming path; call renderIfStale() after updating. */
  setData(handle, xs, ys) {
    const vx = this.stage(xs), vy = this.stage(ys);
    try {
      this.mod._vp_setData(handle, vx, vy);
    } finally {
      this.mod._vp_free(vx.byteOffset);
      this.mod._vp_free(vy.byteOffset);
    }
  }
  replay() {
    const ptr = this.mod._vp_framePtr();
    const len = this.mod._vp_frameLen();
    if (!ptr || !len) return;
    const frame = this.mod.HEAPU8.subarray(ptr, ptr + len);
    if (this.interp instanceof Canvas2DInterpreter)
      this.interp.draw(frame, this.ctx2d);
    else this.interp.draw(frame);
  }
};
async function createCanvas(canvas, moduleFactory) {
  let device;
  let gpuCtx;
  let adapter;
  if (navigator.gpu) {
    adapter = await navigator.gpu.requestAdapter() ?? void 0;
    if (adapter) {
      device = await adapter.requestDevice();
      gpuCtx = canvas.getContext("webgpu") ?? void 0;
      if (gpuCtx)
        gpuCtx.configure({
          device,
          format: navigator.gpu.getPreferredCanvasFormat(),
          alphaMode: "opaque"
        });
    }
  }
  const mod = await moduleFactory({
    locateFile: (p) => new URL(p, import.meta.resolve("./volcanoplot.js")).href
  });
  return new VolcanoCanvas(mod, canvas, device, gpuCtx, adapter);
}
export {
  VolcanoCanvas,
  createCanvas
};
