export type WsStatus = "connecting" | "live" | "reconnecting";

/**
 * Opens a WebSocket that reconnects with exponential backoff (1s → 30s) and
 * reconnects immediately when the tab becomes visible again (phones suspend sockets).
 * Returns a function that closes it for good.
 */
export function connectWs(
  url: string,
  onMessage: (data: unknown) => void,
  onStatus?: (s: WsStatus) => void,
): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const open = () => {
    if (closed) return;
    onStatus?.(attempt === 0 ? "connecting" : "reconnecting");
    ws = new WebSocket(url);
    ws.onopen = () => {
      attempt = 0;
      onStatus?.("live");
    };
    ws.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data as string));
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      if (closed) return;
      onStatus?.("reconnecting");
      const delay = Math.min(30_000, 1000 * 2 ** attempt++);
      timer = setTimeout(open, delay);
    };
    ws.onerror = () => ws?.close();
  };

  const onVisible = () => {
    if (document.visibilityState !== "visible" || closed) return;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      clearTimeout(timer);
      attempt = 0;
      open();
    }
  };

  document.addEventListener("visibilitychange", onVisible);
  open();

  return () => {
    closed = true;
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisible);
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
  };
}
