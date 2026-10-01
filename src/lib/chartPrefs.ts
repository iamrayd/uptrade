"use client";

import { useSyncExternalStore } from "react";
import { DEFAULT_INDICATORS, type IndicatorConfig } from "./indicators";

// Indicator choices are a per-device convenience, so they live in localStorage.
const KEY = "uptrade:indicators";
const listeners = new Set<() => void>();
let cached: IndicatorConfig | null = null;

function read(): IndicatorConfig {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(KEY);
    // Merge so new indicator keys get defaults after an update.
    cached = raw ? { ...DEFAULT_INDICATORS, ...(JSON.parse(raw) as Partial<IndicatorConfig>) } : DEFAULT_INDICATORS;
  } catch {
    cached = DEFAULT_INDICATORS;
  }
  return cached;
}

export function setIndicators(next: IndicatorConfig) {
  cached = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: keep in memory */
  }
  listeners.forEach((l) => l());
}

export function useIndicators() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    read,
    () => DEFAULT_INDICATORS,
  );
}
