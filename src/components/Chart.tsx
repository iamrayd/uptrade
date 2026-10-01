"use client";

import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type SeriesType,
  type UTCTimestamp,
} from "lightweight-charts";
import {
  IND_COLORS,
  bollinger,
  macd,
  movingAverage,
  rsi,
  vwap,
  type IndicatorConfig,
} from "@/lib/indicators";
import type { Candle } from "@/lib/types";

export interface ChartLine {
  price: number;
  color: string;
  title: string;
  dashed?: boolean;
}

const UP = "#16c784";
const DOWN = "#ea3943";

// lightweight-charts renders in UTC; shift bars so the axis shows local time.
const TZ_SHIFT = -new Date().getTimezoneOffset() * 60;
const t = (time: number) => (time + TZ_SHIFT) as UTCTimestamp;
const toBar = (c: Candle) => ({ time: t(c.time), open: c.open, high: c.high, low: c.low, close: c.close });

type AnySeries = ISeriesApi<SeriesType>;
type Point = { time: UTCTimestamp; value?: number; color?: string };

/** One indicator series: how to build it and how to compute its points. */
interface IndSpec {
  key: string;
  create: (chart: IChartApi, pane: number) => AnySeries;
  pane: "main" | "rsi" | "macd";
  compute: (candles: Candle[]) => Point[];
}

const line = (values: (number | null)[], candles: Candle[]): Point[] =>
  candles.map((c, i) => (values[i] == null ? { time: t(c.time) } : { time: t(c.time), value: values[i]! }));

const lineOpts = (color: string, width: 1 | 2 = 1, dashed = false) => ({
  color,
  lineWidth: width,
  lineStyle: dashed ? LineStyle.Dashed : LineStyle.Solid,
  priceLineVisible: false,
  lastValueVisible: false,
  crosshairMarkerVisible: false,
});

function buildSpecs(cfg: IndicatorConfig): IndSpec[] {
  const specs: IndSpec[] = [];
  const closes = (c: Candle[]) => c.map((x) => x.close);

  if (cfg.volume)
    specs.push({
      key: "volume",
      pane: "main",
      create: (chart, pane) => {
        const s = chart.addSeries(
          HistogramSeries,
          { priceScaleId: "vol", priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false },
          pane,
        );
        s.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
        return s;
      },
      compute: (c) =>
        c.map((x) => ({
          time: t(x.time),
          value: x.volume,
          color: x.close >= x.open ? "rgba(22,199,132,0.28)" : "rgba(234,57,67,0.28)",
        })),
    });

  (["ma1", "ma2", "ma3"] as const).forEach((k) => {
    const m = cfg[k];
    if (!m.on) return;
    specs.push({
      key: k,
      pane: "main",
      create: (chart, pane) => chart.addSeries(LineSeries, lineOpts(IND_COLORS[k], 2), pane),
      compute: (c) => line(movingAverage(closes(c), m.type, m.period), c),
    });
  });

  if (cfg.bb.on) {
    const bb = (c: Candle[]) => bollinger(closes(c), cfg.bb.period, cfg.bb.mult);
    specs.push(
      { key: "bb-up", pane: "main", create: (ch, p) => ch.addSeries(LineSeries, lineOpts(IND_COLORS.bb), p), compute: (c) => line(bb(c).upper, c) },
      { key: "bb-mid", pane: "main", create: (ch, p) => ch.addSeries(LineSeries, lineOpts(IND_COLORS.bb, 1, true), p), compute: (c) => line(bb(c).mid, c) },
      { key: "bb-lo", pane: "main", create: (ch, p) => ch.addSeries(LineSeries, lineOpts(IND_COLORS.bb), p), compute: (c) => line(bb(c).lower, c) },
    );
  }

  if (cfg.vwap)
    specs.push({
      key: "vwap",
      pane: "main",
      create: (ch, p) => ch.addSeries(LineSeries, lineOpts(IND_COLORS.vwap, 2), p),
      compute: (c) => line(vwap(c), c),
    });

  if (cfg.rsi.on)
    specs.push({
      key: "rsi",
      pane: "rsi",
      create: (chart, pane) => {
        const s = chart.addSeries(LineSeries, { ...lineOpts(IND_COLORS.rsi, 2), lastValueVisible: true }, pane);
        [70, 30].forEach((price) =>
          s.createPriceLine({ price, color: "rgba(139,149,165,0.5)", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "" }),
        );
        return s;
      },
      compute: (c) => line(rsi(closes(c), cfg.rsi.period), c),
    });

  if (cfg.macd.on) {
    const m = (c: Candle[]) => macd(closes(c), cfg.macd.fast, cfg.macd.slow, cfg.macd.signal);
    specs.push(
      {
        key: "macd-hist",
        pane: "macd",
        create: (ch, p) => ch.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, p),
        compute: (c) =>
          m(c).hist.map((v, i) =>
            v == null
              ? { time: t(c[i].time) }
              : { time: t(c[i].time), value: v, color: v >= 0 ? "rgba(22,199,132,0.5)" : "rgba(234,57,67,0.5)" },
          ),
      },
      { key: "macd-line", pane: "macd", create: (ch, p) => ch.addSeries(LineSeries, lineOpts(IND_COLORS.macd, 2), p), compute: (c) => line(m(c).line, c) },
      { key: "macd-sig", pane: "macd", create: (ch, p) => ch.addSeries(LineSeries, lineOpts(IND_COLORS.signal), p), compute: (c) => line(m(c).signal, c) },
    );
  }
  return specs;
}

export function Chart({
  history,
  last,
  priceDecimals,
  tickSize,
  lines,
  indicators,
  fit = false,
}: {
  history: Candle[] | null;
  last: Candle | null;
  priceDecimals: number;
  tickSize: number;
  lines: ChartLine[];
  indicators?: IndicatorConfig;
  /** Fit all bars in view (static charts) instead of following the latest bar. */
  fit?: boolean;
}) {
  const el = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);
  const candlesRef = useRef<Candle[]>([]);
  const indRef = useRef<{ spec: IndSpec; series: AnySeries }[]>([]);

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
        panes: { separatorColor: "#232a35", separatorHoverColor: "rgba(109,140,255,0.3)" },
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
      upColor: UP,
      downColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      borderVisible: false,
    });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      linesRef.current = [];
      indRef.current = [];
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
    candlesRef.current = history ? [...history] : [];
    series.setData(candlesRef.current.map(toBar));
    indRef.current.forEach(({ spec, series: s }) => s.setData(spec.compute(candlesRef.current)));
    if (!history) return;
    if (fit) chartRef.current?.timeScale().fitContent();
    else chartRef.current?.timeScale().scrollToRealTime();
  }, [history, fit]);

  // (Re)build indicator series when the config changes.
  const cfgKey = indicators ? JSON.stringify(indicators) : "";
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    indRef.current.forEach(({ series }) => chart.removeSeries(series));
    indRef.current = [];
    if (!cfgKey) return;

    const specs = buildSpecs(JSON.parse(cfgKey) as IndicatorConfig);
    const paneOrder = (["rsi", "macd"] as const).filter((p) => specs.some((s) => s.pane === p));
    const paneIndex = (p: IndSpec["pane"]) => (p === "main" ? 0 : paneOrder.indexOf(p) + 1);

    indRef.current = specs.map((spec) => {
      const series = spec.create(chart, paneIndex(spec.pane));
      series.setData(spec.compute(candlesRef.current));
      return { spec, series };
    });

    const panes = chart.panes();
    panes.forEach((p, i) => p.setStretchFactor(i === 0 ? 3 : 1));
  }, [cfgKey]);

  // Live bar: merge into the working set, then update candles + indicators' last point.
  useEffect(() => {
    if (!last || !history) return;
    const list = candlesRef.current;
    const tail = list.at(-1);
    if (tail && last.time < tail.time) return; // stale frame from a previous stream
    if (tail && tail.time === last.time) list[list.length - 1] = last;
    else list.push(last);
    try {
      seriesRef.current?.update(toBar(last));
      indRef.current.forEach(({ spec, series }) => {
        const pts = spec.compute(list);
        const p = pts.at(-1);
        if (p) series.update(p);
      });
    } catch {
      /* ignore out-of-order updates */
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
