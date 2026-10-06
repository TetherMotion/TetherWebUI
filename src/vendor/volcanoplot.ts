/**
 * Loader for the vendored @volcanoplot/web bundle (VolcanoPlot WASM engine
 * + WebGPU renderer with Canvas2D fallback).
 *
 * The git submodule at dependencies/VolcanoPlot tracks the sources; the
 * prebuilt Emscripten artifacts live in public/vendor/volcanoplot/ and are
 * served verbatim because the WASM toolchain is not part of this build.
 * Refresh them from the submodule with `cd dependencies/VolcanoPlot/web &&
 * npm run build` (requires emscripten), then copy web/dist/{bundle.mjs,
 * volcanoplot.js,volcanoplot.wasm,volcanoplot.data} here.
 */

/** Subset of the VolcanoCanvas API used by the dashboard. */
export interface VolcanoPlotCanvas {
  line(xs: ArrayLike<number>, ys: ArrayLike<number>, color?: string): number;
  spectrum(signal: ArrayLike<number>, fs?: number): number;
  setData(handle: number, xs: ArrayLike<number>, ys: ArrayLike<number>): void;
  xlim(lo: number, hi: number): void;
  ylim(lo: number, hi: number): void;
  xscale(scale: string): void;
  yscale(scale: string): void;
  title(text: string): void;
  xlabel(text: string): void;
  ylabel(text: string): void;
  grid(on?: boolean): void;
  legend(loc?: string): void;
  enableInteraction(on?: boolean): void;
  render(): void;
  renderIfStale(): boolean;
  resize(): void;
  destroy(): void;
}

interface VolcanoBundleSource {
  createCanvas(
    canvas: HTMLCanvasElement,
    moduleFactory: (arg: Record<string, unknown>) => Promise<unknown>,
  ): Promise<VolcanoPlotCanvas>;
}

/** Bundle facade with the emscripten module factory pre-bound. */
interface VolcanoBundle {
  createCanvas(canvas: HTMLCanvasElement): Promise<VolcanoPlotCanvas>;
}

let bundlePromise: Promise<VolcanoBundle | undefined> | undefined;

function assetUrl(name: string): string {
  return new URL(`${import.meta.env.BASE_URL}vendor/volcanoplot/${name}`, document.baseURI).href;
}

/**
 * Load the WASM bundle once. Resolves to undefined when the dynamic import
 * fails (e.g. assets missing in a dev checkout) — callers degrade to the
 * built-in renderers.
 */
export async function loadVolcanoPlot(): Promise<VolcanoBundle | undefined> {
  bundlePromise ??= (async () => {
    try {
      const bundle = (await import(
        /* @vite-ignore */ assetUrl('bundle.mjs')
      )) as VolcanoBundleSource;
      const glue = (await import(/* @vite-ignore */ assetUrl('volcanoplot.js'))) as {
        default: (arg: Record<string, unknown>) => Promise<unknown>;
      };
      return {
        createCanvas: (canvas) => bundle.createCanvas(canvas, glue.default),
      };
    } catch {
      return undefined;
    }
  })();
  return bundlePromise;
}
