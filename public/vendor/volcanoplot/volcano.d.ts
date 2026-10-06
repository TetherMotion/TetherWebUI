interface VolcanoModule {
    _vp_framePtr(): number;
    _vp_frameLen(): number;
    _vp_resize(w: number, h: number): void;
    _vp_render(): boolean;
    _vp_renderIfStale(): boolean;
    _vp_line(axes: number, xs: Float32Array, ys: Float32Array, color: string): number;
    _vp_scatter(axes: number, xs: Float32Array, ys: Float32Array, color: string): number;
    _vp_alloc(nbytes: number): number;
    _vp_free(ptr: number): void;
    _vp_mailboxDest(slot: number, bytes: number): number;
    _vp_mailboxDone(slot: number): void;
    _vp_mailbox(slot: number, v0: number, v1: number, v2: number, v3: number): void;
    _vp_setData(handle: number, xs: Float32Array, ys: Float32Array): void;
    _vp_function(axes: number, body: string, xMin: number, xMax: number, color: string): number;
    _vp_bar(axes: number, heights: Float32Array, labels: string[], color: string): number;
    _vp_hist(axes: number, samples: Float32Array, bins: number, color: string): number;
    _vp_pie(axes: number, values: Float32Array, labels: string[]): number;
    _vp_heatmap(axes: number, values: Float32Array, w: number, h: number, cmap: string): number;
    _vp_surface(axes: number, values: Float32Array, w: number, h: number, elev: number, azim: number): number;
    _vp_errorbar(axes: number, xs: Float32Array, ys: Float32Array, yerr: Float32Array, color: string): number;
    _vp_stem(axes: number, xs: Float32Array, ys: Float32Array): number;
    _vp_step(axes: number, xs: Float32Array, ys: Float32Array, where: string): number;
    _vp_ecdf(axes: number, samples: Float32Array): number;
    _vp_fillBetween(axes: number, xs: Float32Array, y1: Float32Array, y2: Float32Array, color: string): number;
    _vp_boxplot(axes: number, groups: Float32Array[]): number;
    _vp_hist2d(axes: number, xs: Float32Array, ys: Float32Array, bins: number, cmap: string): number;
    _vp_hexbin(axes: number, xs: Float32Array, ys: Float32Array): number;
    _vp_quiver(axes: number, xs: Float32Array, ys: Float32Array, us: Float32Array, vs: Float32Array): number;
    _vp_contour(axes: number, values: Float32Array, w: number, h: number, levels: number, cmap: string): number;
    _vp_pcolormesh(axes: number, xs: Float32Array, ys: Float32Array, cs: Float32Array, nCols: number, nRows: number): number;
    _vp_kde(axes: number, xs: Float32Array, ys: Float32Array, cmap: string): number;
    _vp_violin(axes: number, groups: Float32Array[], width: number, showBox: boolean, color: string): number;
    _vp_stackplot(axes: number, xs: Float32Array, ys: Float32Array[]): number;
    _vp_fill(axes: number, xs: Float32Array, ys: Float32Array, color: string): number;
    _vp_spy(axes: number, data: Float32Array, nrows: number, ncols: number): number;
    _vp_tripcolor(axes: number, xs: Float32Array, ys: Float32Array, zs: Float32Array): number;
    _vp_streamplot(axes: number, us: Float32Array, vs: Float32Array, w: number, h: number): number;
    _vp_subplot(nrows: number, ncols: number, index: number): number;
    _vp_setInteractive(on: boolean): void;
    _vp_dispatch(type: number, x: number, y: number, button: number, step: number): boolean;
    _vp_xlim(a: number, lo: number, hi: number): void;
    _vp_ylim(a: number, lo: number, hi: number): void;
    _vp_xscale(a: number, name: string): void;
    _vp_yscale(a: number, name: string): void;
    _vp_title(a: number, t: string): void;
    _vp_xlabel(a: number, t: string): void;
    _vp_ylabel(a: number, t: string): void;
    _vp_grid(a: number, on: boolean): void;
    _vp_suptitle(t: string): void;
    _vp_matshow(a: number, data: Float32Array, nrows: number, ncols: number): number;
    _vp_pcolorfast(a: number, C: Float32Array, nCols: number, nRows: number, x0: number, x1: number, y0: number, y1: number): number;
    _vp_brokenBarh(a: number, segs: Float32Array): number;
    _vp_tricontour(a: number, xs: Float32Array, ys: Float32Array, zs: Float32Array): number;
    _vp_triplot(a: number, xs: Float32Array, ys: Float32Array): number;
    _vp_specgram(a: number, signal: Float32Array, fs: number): number;
    _vp_spectrum(a: number, signal: Float32Array, fs: number): number;
    _vp_psd(a: number, signal: Float32Array, fs: number): number;
    _vp_csd(a: number, xs: Float32Array, ys: Float32Array, fs: number): number;
    _vp_xcorr(a: number, xs: Float32Array, ys: Float32Array): number;
    _vp_cohere(a: number, xs: Float32Array, ys: Float32Array, fs: number): number;
    _vp_wireframe(a: number, values: Float32Array, w: number, h: number, elev: number, azim: number): number;
    _vp_trisurf(a: number, xs: Float32Array, ys: Float32Array, zs: Float32Array, elev: number, azim: number): number;
    _vp_axhline(a: number, y: number, color: string, width: number): void;
    _vp_axvline(a: number, x: number, color: string, width: number): void;
    _vp_axhspan(a: number, y1: number, y2: number, color: string): void;
    _vp_axvspan(a: number, x1: number, x2: number, color: string): void;
    _vp_hlines(a: number, ys: Float32Array, xMin: number, xMax: number, color: string, width: number): void;
    _vp_vlines(a: number, xs: Float32Array, yMin: number, yMax: number, color: string, width: number): void;
    _vp_legend(a: number, loc: string): void;
    _vp_colorbar(a: number): void;
    _vp_text(a: number, x: number, y: number, txt: string, coords: number): void;
    _vp_plot3d(a: number, xs: Float32Array, ys: Float32Array, zs: Float32Array, elev: number, azim: number): number;
    _vp_scatter3d(a: number, xs: Float32Array, ys: Float32Array, zs: Float32Array, elev: number, azim: number): number;
    _vp_bar3d(a: number, xs: Float32Array, ys: Float32Array, zs: Float32Array, dxs: Float32Array, dys: Float32Array, dzs: Float32Array, elev: number, azim: number): number;
    _vp_quiver3d(a: number, xs: Float32Array, ys: Float32Array, zs: Float32Array, us: Float32Array, vs: Float32Array, ws: Float32Array, elev: number, azim: number): number;
    _vp_errorbar3d(a: number, xs: Float32Array, ys: Float32Array, zs: Float32Array, zerr: Float32Array, elev: number, azim: number): number;
    _vp_contour3d(a: number, values: Float32Array, w: number, h: number, filled: boolean, elev: number, azim: number): number;
    _vp_voxels(a: number, filled: Uint8Array, nx: number, ny: number, nz: number, elev: number, azim: number): number;
    _vp_text3d(a: number, x: number, y: number, z: number, txt: string, elev: number, azim: number): number;
    _vp_barbs(a: number, xs: Float32Array, ys: Float32Array, us: Float32Array, vs: Float32Array): number;
    _vp_groupedBar(a: number, heights: Float32Array[]): number;
    _vp_figimage(a: number, pixels: Uint32Array, w: number, h: number): number;
    _vp_chirp(a: number, f0: number, f1: number, duration: number, xMax: number): number;
    _vp_mexicanHat(a: number, sigma: number, range: number, elev: number, azim: number): number;
    _vp_barLabel(a: number, xs: Float32Array, heights: Float32Array, baseline: number): number;
    _vp_tricontourf(a: number, xs: Float32Array, ys: Float32Array, zs: Float32Array): number;
    _vp_tricontour3d(a: number, xs: Float32Array, ys: Float32Array, zs: Float32Array, elev: number, azim: number): number;
    _vp_tricontourf3d(a: number, xs: Float32Array, ys: Float32Array, zs: Float32Array, elev: number, azim: number): number;
    _vp_navcube(a: number, elev: number, azim: number, corner: number, mode: number): number;
    _vp_quiverkey(a: number, x: number, y: number, u: number, quiverHandle: number, label: string): number;
    HEAPU8: Uint8Array<ArrayBuffer>;
}
type ModuleFactory = (opts?: unknown) => Promise<VolcanoModule>;
export declare class VolcanoCanvas {
    private mod;
    private canvas;
    private interp;
    private ctx2d?;
    private devPixelRatio;
    private adapter;
    private dead;
    /** Called when the WebGPU device is lost. The canvas is then dead:
     * render calls throw until a new VolcanoCanvas is created. */
    onDeviceLost?: (reason: string, message: string) => void;
    /** Undefined on the Canvas2D fallback path. */
    readonly device?: GPUDevice;
    readonly gpuCtx?: GPUCanvasContext;
    constructor(mod: VolcanoModule, canvas: HTMLCanvasElement, device?: GPUDevice, gpuCtx?: GPUCanvasContext, adapter?: GPUAdapter);
    private checkLive;
    /** Release the GPU device and mark this canvas unusable. */
    destroy(): void;
    /** Follow DPR — call on resize/orientation change. */
    syncSize(): void;
    /** Render if the figure is stale; replays the op stream. */
    renderIfStale(): boolean;
    render(): void;
    /** Export the last rendered frame as an SVG string — vector
     * geometry ops become <path>/<circle>/<polyline>; heatmaps embed
     * as raster PNGs; tick-label glyph quads are skipped (text is
     * atlas-rasterized upstream). */
    toSvg(): string;
    /** Render to an offscreen target and read back RGBA8 pixels —
     * test/debug path; does not touch the canvas. */
    capture(): Promise<Uint8Array<ArrayBuffer>>;
    /** Stage JS data into the WASM heap (zero-copy for C++). */
    private stage;
    private cur;
    /** mpl subplot(nrows, ncols, index) — creates the grid on first
     * use and selects the new axes for subsequent plot calls. */
    subplot(nrows: number, ncols: number, index: number): number;
    /** Select an existing axes by index (as returned by subplot()). */
    axes(i: number): void;
    private detachInteraction?;
    /** mpl matshow — nearest-neighbor matrix display. */
    matshow(data: ArrayLike<number>, nrows: number, ncols: number): number;
    /** mpl pcolorfast on a regular grid with the given extent. */
    pcolorfast(C: ArrayLike<number>, nCols: number, nRows: number, x0?: number, x1?: number, y0?: number, y1?: number): number;
    /** mpl broken_barh — flat [xStart, xWidth, yStart, yHeight]* tuples. */
    brokenBarh(segs: ArrayLike<number>): number;
    /** mpl tricontour — Delaunay-triangulates scattered (x,y,z). */
    tricontour(xs: ArrayLike<number>, ys: ArrayLike<number>, zs: ArrayLike<number>): number;
    /** mpl triplot — triangle edges + vertex markers. */
    triplot(xs: ArrayLike<number>, ys: ArrayLike<number>): number;
    /** mpl specgram — spectrogram of a 1-D signal. */
    specgram(signal: ArrayLike<number>, fs?: number): number;
    /** mpl spectrum — magnitude spectrum of a 1-D signal. */
    spectrum(signal: ArrayLike<number>, fs?: number): number;
    /** mpl psd — power spectral density. */
    psd(signal: ArrayLike<number>, fs?: number): number;
    /** mpl csd — cross power spectral density of two signals. */
    csd(xs: ArrayLike<number>, ys: ArrayLike<number>, fs?: number): number;
    /** mpl xcorr — cross-correlation of two signals. */
    xcorr(xs: ArrayLike<number>, ys: ArrayLike<number>): number;
    /** mpl cohere — coherence of two signals. */
    cohere(xs: ArrayLike<number>, ys: ArrayLike<number>, fs?: number): number;
    /** mpl wireframe — 3-D wireframe of a row-major height grid. */
    wireframe(values: ArrayLike<number>, w: number, h: number, elev?: number, azim?: number): number;
    /** mpl plot_trisurf — triangulated 3-D surface of scattered points. */
    trisurf(xs: ArrayLike<number>, ys: ArrayLike<number>, zs: ArrayLike<number>, elev?: number, azim?: number): number;
    /** mpl Axes3D.plot — 3-D line through (x,y,z). */
    plot3d(xs: ArrayLike<number>, ys: ArrayLike<number>, zs: ArrayLike<number>, elev?: number, azim?: number): number;
    /** mpl Axes3D.scatter — 3-D point cloud. */
    scatter3d(xs: ArrayLike<number>, ys: ArrayLike<number>, zs: ArrayLike<number>, elev?: number, azim?: number): number;
    /** mpl Axes3D.bar3d — boxes at (x,y) rising by dz. */
    bar3d(xs: ArrayLike<number>, ys: ArrayLike<number>, zs: ArrayLike<number>, dxs: ArrayLike<number>, dys: ArrayLike<number>, dzs: ArrayLike<number>, elev?: number, azim?: number): number;
    /** mpl Axes3D.quiver — 3-D vector field. */
    quiver3d(xs: ArrayLike<number>, ys: ArrayLike<number>, zs: ArrayLike<number>, us: ArrayLike<number>, vs: ArrayLike<number>, ws: ArrayLike<number>, elev?: number, azim?: number): number;
    /** mpl Axes3D.errorbar — points with z-error bars. */
    errorbar3d(xs: ArrayLike<number>, ys: ArrayLike<number>, zs: ArrayLike<number>, zerr: ArrayLike<number>, elev?: number, azim?: number): number;
    /** mpl Axes3D.contour/contourf — contours on a projected grid. */
    contour3d(values: ArrayLike<number>, w: number, h: number, filled?: boolean, elev?: number, azim?: number): number;
    /** mpl Axes3D.voxels — binary occupancy grid (row-major xyz). */
    voxels(filled: ArrayLike<number>, nx: number, ny: number, nz: number, elev?: number, azim?: number): number;
    /** mpl ax.text at 3-D coordinates. */
    text3d(x: number, y: number, z: number, txt: string, elev?: number, azim?: number): number;
    /** mpl barbs — wind barbs on a regular grid. */
    barbs(xs: ArrayLike<number>, ys: ArrayLike<number>, us: ArrayLike<number>, vs: ArrayLike<number>): number;
    /** mpl grouped bars — heights[series][group]. */
    groupedBar(heights: ArrayLike<number>[]): number;
    /** mpl figimage — RGBA8 pixels (Uint32Array) on the figure. */
    figimage(pixels: Uint32Array, w: number, h: number): number;
    /** Chirp signal demo — swept sinusoid f0→f1 over duration s. */
    chirp(f0: number, f1: number, duration: number, xMax: number): number;
    /** Mexican-hat (Ricker) 3-D surface, |x|,|y| ≤ range. */
    mexicanHat(sigma?: number, range?: number, elev?: number, azim?: number): number;
    /** mpl bar_label — value labels above bar tops. */
    barLabel(xs: ArrayLike<number>, heights: ArrayLike<number>, baseline?: number): number;
    /** mpl tricontourf — filled contours on scattered (x,y,z). */
    tricontourf(xs: ArrayLike<number>, ys: ArrayLike<number>, zs: ArrayLike<number>): number;
    /** mpl Axes3D.tricontour — isolines on scattered 3D data. */
    tricontour3d(xs: ArrayLike<number>, ys: ArrayLike<number>, zs: ArrayLike<number>, elev?: number, azim?: number): number;
    /** mpl Axes3D.tricontourf — filled contours on scattered 3D data. */
    tricontourf3d(xs: ArrayLike<number>, ys: ArrayLike<number>, zs: ArrayLike<number>, elev?: number, azim?: number): number;
    /** Orientation indicator (Blender/Paraview axis triad) overlaid
     * in a corner of the 3D axes. corner: 'ul'|'ur'|'ll'|'lr',
     * mode: 'triad'|'cube'. */
    navcube(elev?: number, azim?: number, corner?: string, mode?: string): number;
    /** mpl quiverkey — reference arrow + label for a quiver plot.
     * `quiverHandle` is the value returned by `quiver()` (0 = unscaled). */
    quiverkey(x: number, y: number, u: number, quiverHandle?: number, label?: string): number;
    axhline(y: number, color?: string, width?: number): void;
    axvline(x: number, color?: string, width?: number): void;
    axhspan(y1: number, y2: number, color?: string): void;
    axvspan(x1: number, x2: number, color?: string): void;
    hlines(ys: ArrayLike<number>, xMin: number, xMax: number, color?: string, width?: number): void;
    vlines(xs: ArrayLike<number>, yMin: number, yMax: number, color?: string, width?: number): void;
    /** mpl ax.legend — loc like "upper right", "best", "lower left". */
    legend(loc?: string): void;
    /** mpl fig.colorbar — adds the colorbar strip to the axes. */
    colorbar(): void;
    /** mpl ax.text — coords: 'data' | 'axes' | 'figure'. */
    text(x: number, y: number, txt: string, coords?: 'data' | 'axes' | 'figure'): void;
    /** mpl-style interaction: left-drag pans, scroll zooms about the
     * cursor (scale-aware). Event coordinates are converted to device
     * px; the figure re-renders whenever an event touches it. */
    enableInteraction(on?: boolean): void;
    xlim(lo: number, hi: number): void;
    ylim(lo: number, hi: number): void;
    /** "linear"|"log"|"symlog"|"logit"|"asinh"|"mercator" */
    xscale(name: string): void;
    yscale(name: string): void;
    title(t: string): void;
    xlabel(t: string): void;
    ylabel(t: string): void;
    grid(on?: boolean): void;
    /** Figure-level suptitle. */
    suptitle(t: string): void;
    line(xs: ArrayLike<number>, ys: ArrayLike<number>, color?: string): number;
    scatter(xs: ArrayLike<number>, ys: ArrayLike<number>, color?: string): number;
    /** GPU-evaluated function plot: `body` is a GLSL-ish expression or
     * statements assigning `y` from `x` (e.g. "sin(10.0*x)"). */
    func(body: string, xMin?: number, xMax?: number, color?: string): number;
    bar(heights: ArrayLike<number>, labels?: string[], color?: string): number;
    hist(samples: ArrayLike<number>, bins?: number, color?: string): number;
    pie(values: ArrayLike<number>, labels?: string[]): number;
    /** Row-major scalar grid rendered through a colormap. */
    heatmap(values: ArrayLike<number>, w: number, h: number, cmap?: string): number;
    /** 3D surface from a row-major height grid. Camera uses mpl
     * viewInit angles (elev=30, azim=-60 by default). */
    surface(values: ArrayLike<number>, w: number, h: number, elev?: number, azim?: number): number;
    errorbar(xs: ArrayLike<number>, ys: ArrayLike<number>, yerr: ArrayLike<number>, color?: string): number;
    stem(xs: ArrayLike<number>, ys: ArrayLike<number>): number;
    step(xs: ArrayLike<number>, ys: ArrayLike<number>, where?: 'pre' | 'post' | 'mid'): number;
    ecdf(samples: ArrayLike<number>): number;
    fillBetween(xs: ArrayLike<number>, y1: ArrayLike<number>, y2: ArrayLike<number>, color?: string): number;
    boxplot(groups: ArrayLike<number>[]): number;
    hist2d(xs: ArrayLike<number>, ys: ArrayLike<number>, bins?: number, cmap?: string): number;
    hexbin(xs: ArrayLike<number>, ys: ArrayLike<number>): number;
    quiver(xs: ArrayLike<number>, ys: ArrayLike<number>, us: ArrayLike<number>, vs: ArrayLike<number>): number;
    contour(values: ArrayLike<number>, w: number, h: number, levels?: number, cmap?: string): number;
    /** mpl violinplot — one Float32Array per group. */
    violin(groups: ArrayLike<number>[], width?: number, showBox?: boolean, color?: string): number;
    /** mpl stackplot — stacked area; one layer per element of `ys`. */
    stackplot(xs: ArrayLike<number>, ys: ArrayLike<number>[]): number;
    /** mpl fill — filled polygon. */
    fill(xs: ArrayLike<number>, ys: ArrayLike<number>, color?: string): number;
    /** mpl spy — sparsity pattern of a row-major matrix. */
    spy(data: ArrayLike<number>, nrows: number, ncols: number): number;
    /** mpl tripcolor — Delaunay triangles colored by z. */
    tripcolor(xs: ArrayLike<number>, ys: ArrayLike<number>, zs: ArrayLike<number>): number;
    /** mpl streamplot — row-major w×h vector field. */
    streamplot(us: ArrayLike<number>, vs: ArrayLike<number>, w: number, h: number): number;
    pcolormesh(xs: ArrayLike<number>, ys: ArrayLike<number>, cs: ArrayLike<number>, nCols: number, nRows: number): number;
    kde(xs: ArrayLike<number>, ys: ArrayLike<number>, cmap?: string): number;
    /** In-place update for a handle from line()/scatter() — the
     * ring-buffer/streaming path; call renderIfStale() after updating. */
    setData(handle: number, xs: ArrayLike<number>, ys: ArrayLike<number>): void;
    private replay;
}
export declare function createCanvas(canvas: HTMLCanvasElement, moduleFactory: ModuleFactory): Promise<VolcanoCanvas>;
export {};
