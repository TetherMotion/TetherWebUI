import {
  ChannelInfo,
  formatTick,
  MARGIN_BOTTOM,
  MARGIN_LEFT,
  MARGIN_RIGHT,
  MARGIN_TOP,
  niceStep,
  WINDOW_SEC,
} from './config';

export interface ScopeOverlayState {
  canvas: HTMLCanvasElement;
  overlay: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  cssWidth: number;
  cssHeight: number;
  pixelRatio: number;
  activeCurrentTime: number;
  viewTimeMin: number | null;
  viewTimeSpan: number;
  yMin: number;
  yMax: number;
  zoomYMin: number | null;
  zoomYMax: number | null;
  channels: ChannelInfo[];
  highlightedChannel: number | null;
  dragActive: boolean;
  dragStartX: number;
  dragStartY: number;
  dragCurrentX: number;
  dragCurrentY: number;
  /** Hover crosshair position in CSS pixels, or null when outside the plot. */
  crosshairX: number | null;
  crosshairY: number | null;
  /** Readout lines for the hover crosshair (time + per-channel values). */
  crosshairLines: string[];
  /** Pinned measurement cursors: CSS-pixel X plus a short label (A/B). */
  cursors: { x: number; label: string }[];
  /** Delta-measurement lines shown when two cursors are pinned. */
  measureLines: string[];
}

export function drawScopeOverlay(state: ScopeOverlayState): void {
  const { canvas, overlay, context, pixelRatio: dpr } = state;
  const width = canvas.width;
  const height = canvas.height;
  if (overlay.width !== width || overlay.height !== height) {
    overlay.width = width;
    overlay.height = height;
  }
  context.clearRect(0, 0, width, height);
  context.save();
  context.scale(dpr, dpr);

  const styles = getComputedStyle(canvas.parentElement ?? canvas);
  const textColor = styles.getPropertyValue('--text').trim() || '#1a2a3a';
  const mutedColor = styles.getPropertyValue('--text-muted').trim() || '#5a7088';
  const plotX = MARGIN_LEFT;
  const plotY = MARGIN_TOP;
  const plotWidth = state.cssWidth - MARGIN_LEFT - MARGIN_RIGHT;
  const plotHeight = state.cssHeight - MARGIN_TOP - MARGIN_BOTTOM;
  const viewMin = state.viewTimeMin ?? state.activeCurrentTime - WINDOW_SEC;
  const viewSpan = state.viewTimeSpan;
  const yMin = state.zoomYMin ?? state.yMin;
  const yMax = state.zoomYMax ?? state.yMax;

  context.strokeStyle = textColor;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(plotX, plotY);
  context.lineTo(plotX, plotY + plotHeight);
  context.lineTo(plotX + plotWidth, plotY + plotHeight);
  context.stroke();

  context.font = '11px sans-serif';
  context.fillStyle = mutedColor;
  const xStep = niceStep(viewSpan, 8);
  const xStart = Math.ceil(viewMin / xStep) * xStep;
  context.textAlign = 'center';
  context.textBaseline = 'top';
  for (let value = xStart; value <= viewMin + viewSpan + xStep * 0.001; value += xStep) {
    const screenX = plotX + ((value - viewMin) / viewSpan) * plotWidth;
    if (screenX < plotX - 1 || screenX > plotX + plotWidth + 1) continue;
    context.beginPath();
    context.moveTo(screenX, plotY + plotHeight);
    context.lineTo(screenX, plotY + plotHeight + 4);
    context.stroke();
    context.fillText(`${(value - viewMin).toFixed(2)}s`, screenX, plotY + plotHeight + 8);
  }

  const yStep = niceStep(yMax - yMin, 6);
  const yStart = Math.ceil(yMin / yStep) * yStep;
  context.textAlign = 'right';
  context.textBaseline = 'middle';
  for (let value = yStart; value <= yMax + yStep * 0.001; value += yStep) {
    const screenY = plotY + ((yMax - value) / (yMax - yMin)) * plotHeight;
    if (screenY < plotY - 1 || screenY > plotY + plotHeight + 1) continue;
    context.beginPath();
    context.moveTo(plotX, screenY);
    context.lineTo(plotX - 4, screenY);
    context.stroke();
    context.fillText(formatTick(value), plotX - 8, screenY);
  }

  context.font = '13px sans-serif';
  context.fillStyle = textColor;
  context.textAlign = 'center';
  context.textBaseline = 'bottom';
  context.fillText('t (s, relative)', MARGIN_LEFT + plotWidth / 2, state.cssHeight - 4);
  context.save();
  context.translate(12, MARGIN_TOP + plotHeight / 2);
  context.rotate(-Math.PI / 2);
  context.textAlign = 'center';
  context.textBaseline = 'top';
  context.fillText('value', 0, 0);
  context.restore();

  drawLegend(context, state, plotX + plotWidth + 8, plotY + 4, plotWidth, textColor, mutedColor);
  drawDragSelection(context, state);
  drawCursors(context, state, plotY, plotHeight, textColor, mutedColor);
  drawCrosshair(context, state, plotX, plotY, plotWidth, plotHeight, textColor, mutedColor);
  context.restore();
}

function drawCrosshair(
  context: CanvasRenderingContext2D,
  state: ScopeOverlayState,
  plotX: number,
  plotY: number,
  plotWidth: number,
  plotHeight: number,
  textColor: string,
  mutedColor: string,
): void {
  if (state.crosshairX === null || state.crosshairY === null) return;
  const x = state.crosshairX;
  const y = state.crosshairY;
  context.save();
  context.strokeStyle = 'rgba(90, 112, 136, 0.6)';
  context.setLineDash([4, 3]);
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(x, plotY);
  context.lineTo(x, plotY + plotHeight);
  context.moveTo(plotX, y);
  context.lineTo(plotX + plotWidth, y);
  context.stroke();
  context.restore();
  if (state.crosshairLines.length)
    drawReadoutBox(context, state.crosshairLines, x + 10, plotY + 6, textColor, mutedColor);
}

function drawCursors(
  context: CanvasRenderingContext2D,
  state: ScopeOverlayState,
  plotY: number,
  plotHeight: number,
  textColor: string,
  mutedColor: string,
): void {
  for (const cursor of state.cursors) {
    context.strokeStyle = 'rgba(200, 90, 30, 0.85)';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(cursor.x, plotY);
    context.lineTo(cursor.x, plotY + plotHeight);
    context.stroke();
    context.font = 'bold 10px sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'top';
    context.fillStyle = 'rgba(200, 90, 30, 0.95)';
    context.fillText(cursor.label, cursor.x, plotY + 2);
  }
  if (state.cursors.length >= 2 && state.measureLines.length) {
    const x = Math.max(state.cursors[0]!.x, state.cursors[1]!.x) + 10;
    drawReadoutBox(context, state.measureLines, x, plotY + 6, textColor, mutedColor);
  }
}

function drawReadoutBox(
  context: CanvasRenderingContext2D,
  lines: string[],
  x: number,
  y: number,
  textColor: string,
  mutedColor: string,
): void {
  context.font = '11px sans-serif';
  context.textAlign = 'left';
  context.textBaseline = 'top';
  const padding = 6;
  const lineHeight = 15;
  const width = Math.max(...lines.map((line) => context.measureText(line).width)) + padding * 2;
  const height = lines.length * lineHeight + padding * 2;
  const maxX = context.canvas.width / context.getTransform().a - 4;
  if (x + width > maxX) x = Math.max(4, maxX - width);
  context.fillStyle = 'rgba(255, 255, 255, 0.9)';
  context.strokeStyle = mutedColor;
  context.fillRect(x, y, width, height);
  context.strokeRect(x, y, width, height);
  context.fillStyle = textColor;
  lines.forEach((line, i) => context.fillText(line, x + padding, y + padding + i * lineHeight));
}

function drawLegend(
  context: CanvasRenderingContext2D,
  state: ScopeOverlayState,
  legendX: number,
  legendY: number,
  plotWidth: number,
  textColor: string,
  mutedColor: string,
): void {
  context.font = '11px sans-serif';
  context.textAlign = 'left';
  context.textBaseline = 'middle';
  for (let index = 0; index < state.channels.length; index += 1) {
    const channel = state.channels[index]!;
    const isHighlighted = state.highlightedChannel === index;
    const isDimmed = state.highlightedChannel !== null && !isHighlighted;
    const [red, green, blue] = isDimmed ? dimColor(channel.color, 0.7) : channel.color;
    const rowY = legendY + index * 18;
    if (isHighlighted) {
      context.fillStyle = 'rgba(0,0,0,0.06)';
      context.fillRect(legendX - 4, rowY - 9, plotWidth + 12 - (legendX - MARGIN_LEFT), 18);
    }
    context.fillStyle = `rgb(${Math.round(red * 255)},${Math.round(green * 255)},${Math.round(blue * 255)})`;
    context.fillRect(legendX, rowY - 5, 12, 10);
    context.fillStyle = isDimmed ? mutedColor : textColor;
    context.font = isHighlighted ? 'bold 11px sans-serif' : '11px sans-serif';
    context.fillText(channel.name, legendX + 16, rowY);
  }
}

function drawDragSelection(context: CanvasRenderingContext2D, state: ScopeOverlayState): void {
  if (!state.dragActive) return;
  const x0 = Math.min(state.dragStartX, state.dragCurrentX);
  const x1 = Math.max(state.dragStartX, state.dragCurrentX);
  const y0 = Math.min(state.dragStartY, state.dragCurrentY);
  const y1 = Math.max(state.dragStartY, state.dragCurrentY);
  context.fillStyle = 'rgba(0, 100, 200, 0.15)';
  context.fillRect(x0, y0, x1 - x0, y1 - y0);
  context.strokeStyle = 'rgba(0, 100, 200, 0.8)';
  context.lineWidth = 1;
  context.strokeRect(x0, y0, x1 - x0, y1 - y0);
}

function dimColor(color: [number, number, number], factor: number): [number, number, number] {
  const background = 0.97;
  const gray = 0.299 * color[0] + 0.587 * color[1] + 0.114 * color[2];
  return color.map((channel) => {
    const desaturated = 0.5 * channel + 0.5 * gray;
    return desaturated + (background - desaturated) * factor;
  }) as [number, number, number];
}
