"use client";

import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle } from "@/lib/types";

export interface ChartLine {
  price: number;
  color: string;
  title: string;
  dashed?: boolean;
}

// lightweight-charts renders in UTC; shift bars so the axis shows local time.
const TZ_SHIFT = -new Date().getTimezoneOffset() * 60;
const toBar = (c: Candle) => ({ ...c, time: (c.time + TZ_SHIFT) as UTCTimestamp });

export function Chart({
  history,
  last,
  priceDecimals,
  tickSize,
  lines,
  fit = false,
}: {
  history: Candle[] | null;
  last: Candle | null;
  priceDecimals: number;
  tickSize: number;
  lines: ChartLine[];
  /** Fit all bars in view (static charts) instead of following the latest bar. */
  fit?: boolean;
}) {
  const el = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);

  // Create once.
  useEffect(() => {
    if (!el.current) return;
    const chart = createChart(el.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#8b95a5",
        fontSize: 11,
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.03)" },
        horzLines: { color: "rgba(255,255,255,0.03)" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.08 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 6 },
      handleScale: { axisPressedMouseMove: { time: true, price: true } },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#16c784",
      downColor: "#ea3943",
      wickUpColor: "#16c784",
      wickDownColor: "#ea3943",
      borderVisible: false,
    });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      linesRef.current = [];
    };
  }, []);

  useEffect(() => {
    seriesRef.current?.applyOptions({
      priceFormat: { type: "price", precision: priceDecimals, minMove: tickSize },
    });
  }, [priceDecimals, tickSize]);

  // Full history (new symbol/interval).
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    series.setData(history ? history.map(toBar) : []);
    if (!history) return;
    if (fit) chartRef.current?.timeScale().fitContent();
    else chartRef.current?.timeScale().scrollToRealTime();
  }, [history, fit]);

  // Live bar.
  useEffect(() => {
    if (!last || !history) return;
    try {
      seriesRef.current?.update(toBar(last));
    } catch {
      /* stale bar from previous stream; ignore */
    }
  }, [last, history]);

  // Entry / limit lines.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    linesRef.current.forEach((l) => series.removePriceLine(l));
    linesRef.current = lines.map((l) =>
      series.createPriceLine({
        price: l.price,
        color: l.color,
        lineWidth: 1,
        lineStyle: l.dashed ? LineStyle.Dashed : LineStyle.Solid,
        axisLabelVisible: true,
        title: l.title,
      }),
    );
  }, [lines]);

  return <div ref={el} className="h-full w-full" />;
}
