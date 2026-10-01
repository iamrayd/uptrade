"use client";

import { setIndicators } from "@/lib/chartPrefs";
import { DEFAULT_INDICATORS, IND_COLORS, type IndicatorConfig } from "@/lib/indicators";
import { Button, Sheet, cx } from "./ui";

export function IndicatorsMenu({ open, onClose, cfg }: { open: boolean; onClose: () => void; cfg: IndicatorConfig }) {
  const set = (patch: Partial<IndicatorConfig>) => setIndicators({ ...cfg, ...patch });

  return (
    <Sheet open={open} onClose={onClose} title="Indicators">
      <div className="divide-y divide-line">
        <Row label="Volume" on={cfg.volume} onToggle={() => set({ volume: !cfg.volume })} />

        {(["ma1", "ma2", "ma3"] as const).map((k, i) => {
          const m = cfg[k];
          return (
            <Row
              key={k}
              label={`Moving average ${i + 1}`}
              color={IND_COLORS[k]}
              on={m.on}
              onToggle={() => set({ [k]: { ...m, on: !m.on } })}
            >
              <div className="flex gap-1 rounded-md bg-bg p-0.5">
                {(["EMA", "SMA"] as const).map((type) => (
                  <button
                    key={type}
                    onClick={() => set({ [k]: { ...m, type, on: true } })}
                    className={cx("h-8 rounded px-2 text-xs font-semibold", m.type === type ? "bg-panel-2 text-fg" : "text-muted")}
                  >
                    {type}
                  </button>
                ))}
              </div>
              <NumberInput label="Length" value={m.period} min={2} max={400} onChange={(period) => set({ [k]: { ...m, period, on: true } })} />
            </Row>
          );
        })}

        <Row label="Bollinger Bands" color={IND_COLORS.bb} on={cfg.bb.on} onToggle={() => set({ bb: { ...cfg.bb, on: !cfg.bb.on } })}>
          <NumberInput label="Length" value={cfg.bb.period} min={2} max={200} onChange={(period) => set({ bb: { ...cfg.bb, period, on: true } })} />
          <NumberInput label="StdDev" value={cfg.bb.mult} min={0.5} max={5} step={0.5} onChange={(mult) => set({ bb: { ...cfg.bb, mult, on: true } })} />
        </Row>

        <Row label="VWAP (daily)" color={IND_COLORS.vwap} on={cfg.vwap} onToggle={() => set({ vwap: !cfg.vwap })} />

        <Row label="RSI" color={IND_COLORS.rsi} on={cfg.rsi.on} onToggle={() => set({ rsi: { ...cfg.rsi, on: !cfg.rsi.on } })}>
          <NumberInput label="Length" value={cfg.rsi.period} min={2} max={100} onChange={(period) => set({ rsi: { ...cfg.rsi, period, on: true } })} />
        </Row>

        <Row label="MACD" color={IND_COLORS.macd} on={cfg.macd.on} onToggle={() => set({ macd: { ...cfg.macd, on: !cfg.macd.on } })}>
          <NumberInput label="Fast" value={cfg.macd.fast} min={2} max={100} onChange={(fast) => set({ macd: { ...cfg.macd, fast, on: true } })} />
          <NumberInput label="Slow" value={cfg.macd.slow} min={2} max={200} onChange={(slow) => set({ macd: { ...cfg.macd, slow, on: true } })} />
          <NumberInput label="Signal" value={cfg.macd.signal} min={2} max={100} onChange={(signal) => set({ macd: { ...cfg.macd, signal, on: true } })} />
        </Row>
      </div>
      <div className="flex gap-3 border-t border-line p-4">
        <Button variant="outline" className="flex-1" onClick={() => setIndicators(DEFAULT_INDICATORS)}>
          Reset
        </Button>
        <Button className="flex-1" onClick={onClose}>
          Done
        </Button>
      </div>
    </Sheet>
  );
}

function Row({
  label,
  color,
  on,
  onToggle,
  children,
}: {
  label: string;
  color?: string;
  on: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="px-4 py-3">
      <button onClick={onToggle} className="flex min-h-11 w-full items-center justify-between gap-3 text-left" role="switch" aria-checked={on}>
        <span className="flex items-center gap-2 text-sm font-medium">
          {color && <span className="h-0.5 w-4 rounded-full" style={{ background: color }} />}
          {label}
        </span>
        <span className={cx("relative h-6 w-10 rounded-full transition", on ? "bg-accent" : "bg-line")}>
          <span className={cx("absolute top-0.5 size-5 rounded-full bg-white transition-all", on ? "left-[18px]" : "left-0.5")} />
        </span>
      </button>
      {children && <div className="mt-2 flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

function NumberInput({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted">
      {label}
      {/* Uncontrolled + commit on blur/Enter, so typing "14" isn't rejected at "1". */}
      <input
        key={value}
        type="number"
        inputMode="decimal"
        defaultValue={value}
        min={min}
        max={max}
        step={step}
        onBlur={(e) => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v) && v >= min && v <= max && v !== value) onChange(v);
          else e.target.value = String(value);
        }}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        className="num h-8 w-16 rounded-md border border-line bg-bg px-2 text-base text-fg outline-none focus:border-accent sm:text-sm"
      />
    </label>
  );
}

/** Small legend overlay listing the active indicators. */
export function IndicatorLegend({ cfg }: { cfg: IndicatorConfig }) {
  const items: { label: string; color: string }[] = [];
  (["ma1", "ma2", "ma3"] as const).forEach((k) => cfg[k].on && items.push({ label: `${cfg[k].type} ${cfg[k].period}`, color: IND_COLORS[k] }));
  if (cfg.bb.on) items.push({ label: `BB ${cfg.bb.period} ${cfg.bb.mult}`, color: IND_COLORS.bb });
  if (cfg.vwap) items.push({ label: "VWAP", color: IND_COLORS.vwap });
  if (cfg.rsi.on) items.push({ label: `RSI ${cfg.rsi.period}`, color: IND_COLORS.rsi });
  if (cfg.macd.on) items.push({ label: `MACD ${cfg.macd.fast} ${cfg.macd.slow} ${cfg.macd.signal}`, color: IND_COLORS.macd });
  if (!items.length) return null;
  return (
    <div className="pointer-events-none absolute left-2 top-2 z-10 flex max-w-[70%] flex-wrap gap-x-3 gap-y-1 text-[11px] font-medium">
      {items.map((i) => (
        <span key={i.label} style={{ color: i.color }}>
          {i.label}
        </span>
      ))}
    </div>
  );
}
