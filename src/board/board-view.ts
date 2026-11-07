/**
 * board-view — the tile grid host.
 *
 * View mode renders tiles on a 12-column grid with zero editing chrome.
 * Edit mode (`.editing`) shows drag handles, resize grips, and tile config —
 * pointer math snaps to grid cells; layout compacts upward after every change.
 */
import { html, TemplateResult } from 'lit';
import { DataHub } from '../data/hub';
import { clampRect, compact, findFreeSpot, resolveCollisions } from '../dash/layout';
import { BoardDoc, GRID_COLS, TileDef } from '../dash/model';
import { TILE_SPECS } from '../dash/registry';
import { TileElement } from '../tiles/base';
import './tile-frame';

export class BoardView extends TileElement {
  private _board?: BoardDoc;

  /** Reactive via accessor — a `static properties` redeclaration would drop
   *  the @customElement registration under the esbuild decorator transform. */
  set board(value: BoardDoc | undefined) {
    if (value === this._board) return;
    this._board = value;
    this.requestUpdate();
  }

  get board(): BoardDoc | undefined {
    return this._board;
  }
  private drag?: {
    id: string;
    mode: 'move' | 'resize';
    startX: number;
    startY: number;
    orig: { x: number; y: number; w: number; h: number };
  };

  protected topics(): never[] {
    return [];
  }

  private gridEl(): HTMLElement | undefined {
    return this.querySelector<HTMLElement>('.board-grid') ?? undefined;
  }

  /** Grid cell metrics in px (col width incl. gap, row height incl. gap). */
  private cellSize(): { col: number; row: number } {
    const grid = this.gridEl();
    if (!grid) return { col: 100, row: 72 };
    const rect = grid.getBoundingClientRect();
    const styles = getComputedStyle(grid);
    const gap = parseFloat(styles.gap) || 8;
    return {
      col: (rect.width + gap) / GRID_COLS,
      row: parseFloat(styles.getPropertyValue('--row-h')) + gap || 72,
    };
  }

  private commit(mutate: () => void): void {
    const board = this.board;
    if (!board) return;
    mutate();
    compact(board.tiles);
    this.requestUpdate();
    this.dispatchEvent(
      new CustomEvent('board-change', { bubbles: true, composed: true, detail: { board } }),
    );
  }

  // ---- Drag / resize -----------------------------------------------------------

  private onGripDown(event: PointerEvent, tile: TileDef, mode: 'move' | 'resize'): void {
    if (!this.editing || !this.board) return;
    event.preventDefault();
    this.drag = {
      id: tile.id,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      orig: { x: tile.x, y: tile.y, w: tile.w, h: tile.h },
    };
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => this.onDragMove(e);
    const up = (e: PointerEvent) => {
      this.removeEventListener('pointermove', move);
      this.removeEventListener('pointerup', up);
      this.onDragEnd(e);
    };
    this.addEventListener('pointermove', move);
    this.addEventListener('pointerup', up);
  }

  private onDragMove(event: PointerEvent): void {
    const drag = this.drag;
    const board = this.board;
    if (!drag || !board) return;
    const tile = board.tiles.find((t) => t.id === drag.id);
    if (!tile) return;
    const { col, row } = this.cellSize();
    const dx = Math.round((event.clientX - drag.startX) / col);
    const dy = Math.round((event.clientY - drag.startY) / row);
    const next =
      drag.mode === 'move'
        ? { x: drag.orig.x + dx, y: drag.orig.y + dy, w: drag.orig.w, h: drag.orig.h }
        : { x: drag.orig.x, y: drag.orig.y, w: drag.orig.w + dx, h: drag.orig.h + dy };
    const clamped = clampRect(next);
    if (
      clamped.x !== tile.x ||
      clamped.y !== tile.y ||
      clamped.w !== tile.w ||
      clamped.h !== tile.h
    ) {
      tile.x = clamped.x;
      tile.y = clamped.y;
      tile.w = clamped.w;
      tile.h = clamped.h;
      resolveCollisions(tile, board.tiles);
      this.requestUpdate();
    }
  }

  private onDragEnd(_event: PointerEvent): void {
    if (!this.drag) return;
    this.drag = undefined;
    this.commit(() => {});
  }

  // ---- Tile ops -------------------------------------------------------------------

  private removeTile(id: string): void {
    this.commit(() => {
      const board = this.board!;
      board.tiles = board.tiles.filter((t) => t.id !== id);
    });
  }

  private onTileConfig(event: CustomEvent): void {
    const def = event.detail?.def as TileDef | undefined;
    const board = this.board;
    if (!def || !board) return;
    this.commit(() => {
      const idx = board.tiles.findIndex((t) => t.id === def.id);
      if (idx >= 0) board.tiles[idx] = def;
    });
  }

  addTile(type: string, extra: Partial<TileDef> = {}, size?: { w: number; h: number }): void {
    const spec = TILE_SPECS.find((s) => s.type === type);
    const board = this.board;
    if (!spec || !board) return;
    const sizeW = size?.w ?? spec.defaultSize.w;
    const sizeH = size?.h ?? spec.defaultSize.h;
    this.commit(() => {
      const spot = findFreeSpot(board.tiles, sizeW, sizeH);
      board.tiles.push({
        id: `t-${crypto.randomUUID().slice(0, 8)}`,
        type,
        x: spot.x,
        y: spot.y,
        w: sizeW,
        h: sizeH,
        ...extra,
      });
    });
  }

  protected render(): TemplateResult {
    const board = this.board;
    if (!board)
      return html`<p class="widget-empty">No board selected — create one from the + tab.</p>`;
    if (!board.tiles.length)
      return html`<div class="board-empty">
        <p>
          ${this.editing ? 'Empty board — open the widget drawer to add tiles.' : 'Empty board.'}
        </p>
      </div>`;
    return html`<div
      class="board-grid${this.editing ? ' editing' : ''}"
      @tile-config=${(e: Event) => this.onTileConfig(e as CustomEvent)}
    >
      ${board.tiles.map(
        (tile) =>
          html`<tile-frame
            .def=${tile}
            .hub=${this.hub}
            .editing=${this.editing}
            .readonly=${board.source === 'profile'}
            style="grid-area: ${tile.y + 1} / ${tile.x + 1} / span ${tile.h} / span ${tile.w}"
            @tile-remove=${() => this.removeTile(tile.id)}
            @grip-move=${(e: CustomEvent) => this.onGripDown(e.detail.event, tile, 'move')}
            @grip-resize=${(e: CustomEvent) => this.onGripDown(e.detail.event, tile, 'resize')}
          ></tile-frame>`,
      )}
    </div>`;
  }
}

customElements.define('board-view', BoardView);
