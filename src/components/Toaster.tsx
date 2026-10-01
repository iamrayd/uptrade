"use client";

import { dismissToast, toasts, useStore } from "@/lib/store";
import { cx } from "./ui";

export function Toaster() {
  const list = useStore(toasts);
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex flex-col items-center gap-2 p-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:items-end"
    >
      {list.map((t) => (
        <button
          key={t.id}
          onClick={() => dismissToast(t.id)}
          className={cx(
            "animate-toast-in pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border bg-panel-2/95 px-4 py-3 text-left shadow-2xl backdrop-blur",
            t.kind === "success" && "border-up/30",
            t.kind === "error" && "border-down/40",
            t.kind === "info" && "border-line",
          )}
        >
          <span
            className={cx(
              "mt-1.5 size-2 shrink-0 rounded-full",
              t.kind === "success" ? "bg-up" : t.kind === "error" ? "bg-down" : "bg-accent",
            )}
          />
          <span className="min-w-0">
            <span className="block text-sm font-semibold">{t.title}</span>
            {t.body && <span className="num block text-sm text-muted">{t.body}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}
