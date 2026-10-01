"use client";

import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

type Variant = "primary" | "buy" | "sell" | "ghost" | "outline" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-white hover:brightness-110",
  buy: "bg-up text-white hover:brightness-110",
  sell: "bg-down text-white hover:brightness-110",
  ghost: "text-muted hover:text-fg hover:bg-panel-2",
  outline: "border border-line text-fg hover:bg-panel-2",
  danger: "border border-down/40 text-down hover:bg-down-soft",
};

export function Button({
  variant = "primary",
  size = "md",
  loading,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "lg"; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition select-none",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        "disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98]",
        size === "sm" && "h-9 px-3 text-sm",
        size === "md" && "h-11 px-4 text-sm",
        size === "lg" && "h-12 px-5 text-base",
        VARIANTS[variant],
        className,
      )}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cx("inline-block size-4 animate-spin rounded-full border-2 border-current border-r-transparent", className)}
    />
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("rounded-xl border border-line bg-panel", className)}>{children}</div>;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("animate-pulse rounded-md bg-panel-2", className)} />;
}

export function SideBadge({ side }: { side: "long" | "short" | "buy" | "sell" }) {
  const up = side === "long" || side === "buy";
  return (
    <span
      className={cx(
        "inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide",
        up ? "bg-up-soft text-up" : "bg-down-soft text-down",
      )}
    >
      {side}
    </span>
  );
}

export function LiqBadge() {
  return (
    <span className="inline-flex items-center rounded bg-amber-400/15 px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-amber-400">
      Liquidated
    </span>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  size = "md",
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; activeClass?: string }[];
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <div role="tablist" className={cx("flex rounded-lg bg-bg p-1", className)}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={cx(
              "flex-1 rounded-md font-semibold transition",
              size === "sm" ? "h-8 px-2 text-xs" : "h-10 px-3 text-sm",
              active ? (o.activeClass ?? "bg-panel-2 text-fg shadow-sm") : "text-muted hover:text-fg",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <div className="text-sm font-semibold text-fg">{title}</div>
      {body && <div className="max-w-xs text-sm text-muted">{body}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Bottom sheet on phones, centered dialog on larger screens. */
export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal>
      <div className="animate-fade-in absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="animate-sheet-in pb-safe relative max-h-[92dvh] w-full overflow-y-auto rounded-t-2xl border border-line bg-panel sm:max-w-md sm:rounded-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-panel px-4 py-3">
          <div className="mx-auto h-1 w-10 rounded-full bg-line sm:hidden absolute left-1/2 top-1.5 -translate-x-1/2" />
          <div className="text-base font-semibold">{title}</div>
          <button onClick={onClose} aria-label="Close" className="-mr-2 grid size-10 place-items-center rounded-lg text-muted hover:bg-panel-2 hover:text-fg">
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function LiveDot({ status }: { status: "connecting" | "live" | "reconnecting" }) {
  const label = status === "live" ? "Live" : status === "connecting" ? "Connecting" : "Reconnecting";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted" title={`Market data: ${label}`}>
      <span className="relative flex size-2">
        {status === "live" && <span className="absolute inline-flex size-full animate-ping rounded-full bg-up opacity-50" />}
        <span className={cx("relative inline-flex size-2 rounded-full", status === "live" ? "bg-up" : "bg-amber-400")} />
      </span>
      <span className="hidden sm:inline">{label}</span>
    </span>
  );
}

/** Two-tap confirm for destructive actions: first tap arms, second tap fires. */
export function ConfirmButton({
  onConfirm,
  label,
  confirmLabel,
  loading,
  className,
}: {
  onConfirm: () => void;
  label: string;
  confirmLabel: string;
  loading?: boolean;
  className?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <Button
      size="sm"
      variant={armed ? "sell" : "outline"}
      loading={loading}
      className={cx("min-w-[84px]", className)}
      onClick={(e) => {
        e.stopPropagation();
        if (armed) {
          setArmed(false);
          onConfirm();
        } else setArmed(true);
      }}
    >
      {armed ? confirmLabel : label}
    </Button>
  );
}
