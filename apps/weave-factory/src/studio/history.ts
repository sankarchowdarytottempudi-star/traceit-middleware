// Undo/redo as plain data so it can be unit tested. `push` records a new present; pushes that
// carry the same coalesce key within a short window replace the present instead of adding a
// step (typing in a field is one undo step, not one per keystroke).
export interface History<T> {
  past: T[];
  present: T;
  future: T[];
  lastKey?: string;
  lastAt?: number;
}
export const HISTORY_LIMIT = 100;
export const COALESCE_MS = 1500;

export function historyInit<T>(present: T): History<T> {
  return { past: [], present, future: [] };
}
export function historyPush<T>(h: History<T>, next: T, key?: string, now: number = Date.now()): History<T> {
  if (key && h.lastKey === key && h.lastAt !== undefined && now - h.lastAt < COALESCE_MS && h.past.length > 0) {
    return { past: h.past, present: next, future: [], lastKey: key, lastAt: now };
  }
  const past = [...h.past, h.present];
  if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT);
  return { past, present: next, future: [], lastKey: key, lastAt: key ? now : undefined };
}
export function historyUndo<T>(h: History<T>): History<T> {
  if (!h.past.length) return h;
  const past = h.past.slice(0, -1);
  return { past, present: h.past[h.past.length - 1], future: [h.present, ...h.future] };
}
export function historyRedo<T>(h: History<T>): History<T> {
  if (!h.future.length) return h;
  return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) };
}
export const canUndo = <T,>(h: History<T>) => h.past.length > 0;
export const canRedo = <T,>(h: History<T>) => h.future.length > 0;
