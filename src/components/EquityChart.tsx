"use client";

import { useEffect, useRef } from "react";
import { BaselineSeries, ColorType, CrosshairMode, LineStyle, createChart, type UTCTimestamp } from "lightweight-charts";

const TZ_SHIFT = -new Date().getTimezoneOffset() * 60;

/** Realized equity curve; green above the starting balance, red below. */
export function EquityChart({ points, start, goal }: { points: { time: number; equity: number }[]; start: number; goal?: number }) {
  const el = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!el.current) return;
    const chart = createChart(el.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#8b95a5", fontSize: 11, attributionLogo: true },
      grid: { vertLines: { visible: false }, horzLines: { color: "rgba(255,255,255,0.04)" } },
      crosshair: { mode: CrosshairMode.Magnet },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.15, bottom: 0.1 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      handleScroll: false,
      handleScale: false,
    });
    const series = chart.addSeries(BaselineSeries, {
      baseValue: { type: "price", price: start },
      topLineColor: "#16c784",
      topFillColor1: "rgba(22,199,132,0.22)",
      topFillColor2: "rgba(22,199,132,0.02)",
      bottomLineColor: "#ea3943",
      bottomFillColor1: "rgba(234,57,67,0.02)",
      bottomFillColor2: "rgba(234,57,67,0.22)",
      lineWidth: 2,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
      priceLineVisible: false,
    });
    series.setData(points.map((p) => ({ time: (p.time + TZ_SHIFT) as UTCTimestamp, value: p.equity })));
    series.createPriceLine({ price: start, color: "#5c6675", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "Start" });
    if (goal && points.some((p) => p.equity > goal * 0.6))
      series.createPriceLine({ price: goal, color: "#f5c542", lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: "Goal" });
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [points, start, goal]);

  return <div ref={el} className="h-full w-full" />;
}
