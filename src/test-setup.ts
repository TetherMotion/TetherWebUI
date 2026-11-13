// Node >=22 ships a stub `localStorage`/`sessionStorage` on globalThis
// that is unusable without `--localstorage-file`, and vitest's jsdom
// populateGlobal skips keys already present (window === globalThis, so
// jsdom's own Storage is unreachable). Install a minimal in-memory
// Storage so tests get working persistence semantics.
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    const v = this.map.get(String(key));
    return v === undefined ? null : v;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(String(key));
  }
  setItem(key: string, value: string): void {
    this.map.set(String(key), String(value));
  }
}

for (const key of ['localStorage', 'sessionStorage'] as const) {
  Object.defineProperty(globalThis, key, {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
}
