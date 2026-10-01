"use client";

import { useSyncExternalStore } from "react";

/** Tiny observable used for the "data changed, refetch" signal and for toasts. */
export function createStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T | ((prev: T) => T)) {
      value = typeof next === "function" ? (next as (prev: T) => T)(value) : next;
      listeners.forEach((l) => l());
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

export function useStore<T>(store: ReturnType<typeof createStore<T>>) {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

// ── Data version: bump after any mutation so every query hook refetches ──

export const dataVersion = createStore(0);
export const bumpData = () => dataVersion.set((v) => v + 1);

if (typeof window !== "undefined") {
  // Refetch when returning to the tab (e.g. traded on phone, back on desktop).
  window.addEventListener("focus", bumpData);
}

// ── Toasts ──

export interface Toast {
  id: number;
  kind: "success" | "error" | "info";
  title: string;
  body?: string;
}

export const toasts = createStore<Toast[]>([]);
let toastId = 0;

export function toast(kind: Toast["kind"], title: string, body?: string) {
  const id = ++toastId;
  toasts.set((list) => [...list.slice(-3), { id, kind, title, body }]);
  setTimeout(() => dismissToast(id), kind === "error" ? 6000 : 3500);
}

export function dismissToast(id: number) {
  toasts.set((list) => list.filter((t) => t.id !== id));
}
