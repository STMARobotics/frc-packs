// A store is a value plus listeners; `useStore` re-renders a component when it changes. Shared by the site and the
// Battler.
import { useEffect, useState } from "preact/hooks";

export interface Store<T> { get(): T; set(v: T): void; sub(f: (v: T) => void): () => void }

export function store<T>(v: T): Store<T> {
  const subs = new Set<(v: T) => void>();
  return {
    get: () => v,
    set(n) { if (n === v) return; v = n; subs.forEach((f) => f(v)); },
    sub(f) { subs.add(f); return () => subs.delete(f); },
  };
}

export function useStore<T>(s: Store<T>): T {
  const [v, setV] = useState(s.get());
  useEffect(() => { setV(s.get()); return s.sub(setV); }, [s]);
  return v;
}
