/**
 * Minimal context-menu helper — a fixed-position overlay appended to
 * document.body. Closes on outside pointerdown, Escape, scroll or
 * resize, and after any item activation.
 */

export type CtxItem =
  | { sep: true }
  | {
      sep?: false;
      label: string;
      /** explanatory tooltip for the item */
      title?: string;
      /** right-aligned shortcut/annotation text (e.g. "Ctrl+C") */
      hint?: string;
      /** destructive styling */
      danger?: boolean;
      disabled?: boolean;
      action?: () => void;
    };

let open: { el: HTMLElement; cleanup: () => void } | undefined;

export function hideContextMenu(): void {
  if (!open) return;
  open.cleanup();
  open.el.remove();
  open = undefined;
}

export function showContextMenu(x: number, y: number, items: CtxItem[]): void {
  hideContextMenu();
  if (!items.length) return;
  const menu = document.createElement('div');
  menu.className = 'ctxmenu';
  menu.setAttribute('role', 'menu');
  for (const it of items) {
    if (it.sep) {
      const s = document.createElement('div');
      s.className = 'ctx-sep';
      menu.appendChild(s);
      continue;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `ctx-item${it.danger ? ' danger' : ''}`;
    b.setAttribute('role', 'menuitem');
    b.disabled = !!it.disabled;
    if (it.title) b.title = it.title;
    const label = document.createElement('span');
    label.className = 'ctx-label';
    label.textContent = it.label;
    b.appendChild(label);
    if (it.hint) {
      const h = document.createElement('span');
      h.className = 'ctx-hint';
      h.textContent = it.hint;
      b.appendChild(h);
    }
    b.addEventListener('click', () => {
      hideContextMenu();
      it.action?.();
    });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  /* clamp into the viewport */
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;

  const onDown = (e: PointerEvent) => {
    if (!menu.contains(e.target as Node)) hideContextMenu();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      hideContextMenu();
    }
  };
  const cleanup = () => {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', hideContextMenu, true);
    window.removeEventListener('resize', hideContextMenu);
  };
  /* defer arming so the gesture that opened the menu can't close it */
  requestAnimationFrame(() => {
    if (open?.el !== menu) return;
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', hideContextMenu, true);
    window.addEventListener('resize', hideContextMenu);
  });
  open = { el: menu, cleanup };
}
