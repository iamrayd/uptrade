import { cx } from "./ui";

/** Explains where prices come from and why MEXC isn't the source. */
export function DataSourceNote({ className, detailed }: { className?: string; detailed?: boolean }) {
  return (
    <div className={cx("rounded-lg border border-line bg-bg p-3 text-xs leading-relaxed text-muted", className)}>
      <span className="font-semibold text-fg">Prices come from Binance.</span> MEXC is blocked in our region, so its API
      can’t be reached from this app. Coins listed only on MEXC aren’t available here.
      {detailed && (
        <>
          {" "}
          Most large coins trade on both exchanges at nearly the same price, so paper results on Binance data are a close
          stand-in. Small price differences between exchanges are normal. Live data uses Binance’s public market-data
          servers (<code>data-api.binance.vision</code>), which need no account or API key.
        </>
      )}
    </div>
  );
}
