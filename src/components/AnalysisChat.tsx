"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { RulesText } from "./BotBits";
import { Button, Card, cx } from "./ui";

type Msg = { role: "user" | "assistant"; text: string };

const STORAGE_KEY = "uptrade:analysis-chat";
const SUGGESTIONS = [
  "Which setup is closest to being ready for real money, and what's still missing?",
  "Why are my losing trades failing, and what would fix the most common cause?",
  "What did the bots learn so far, and is it helping?",
  "Which hours or sessions should the bots avoid?",
];

/** Ask Gemini about the analysis. Answers come from the bot-chat edge function, which sees only your own data. */
export function AnalysisChat() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // Keep the conversation across reloads on this device (best effort).
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time restore from storage
      if (saved) setMsgs(JSON.parse(saved) as Msg[]);
    } catch {
      // storage unavailable
    }
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(msgs.slice(-30)));
    } catch {
      // storage unavailable
    }
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [msgs]);

  async function ask(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    const next: Msg[] = [...msgs, { role: "user", text: q }];
    setMsgs(next);
    setInput("");
    setErr(null);
    setBusy(true);
    try {
      const { data, error } = await createClient().functions.invoke<{ reply?: string; error?: string }>("bot-chat", { body: { messages: next } });
      if (error) {
        const status = (error as { context?: Response }).context?.status;
        throw new Error(
          status === 404
            ? "The bot-chat function isn't deployed yet (docs/strategies/ANALYSIS.md)."
            : status === 401
              ? "Your session expired: sign in again."
              : error.message,
        );
      }
      if (!data?.reply) throw new Error(data?.error ?? "No answer");
      setMsgs([...next, { role: "assistant", text: data.reply }]);
    } catch (e) {
      setErr((e as Error).message);
      setMsgs(msgs); // drop the unanswered question so it can be asked again
      setInput(q);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-semibold">Ask about the analysis</h2>
        {msgs.length > 0 && (
          <button className="text-xs text-muted hover:text-fg" onClick={() => setMsgs([])}>
            Clear
          </button>
        )}
      </div>
      <p className="text-xs text-faint">
        Answers come from your latest reports, lessons and recent trades, by Google Gemini (free tier: Google may use these prompts to improve its models).
      </p>

      {msgs.length === 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {SUGGESTIONS.map((s) => (
            <button key={s} onClick={() => ask(s)} disabled={busy} className="rounded-lg border border-line px-3 py-1.5 text-left text-xs text-muted hover:bg-panel-2 hover:text-fg">
              {s}
            </button>
          ))}
        </div>
      ) : (
        <div className="mt-3 max-h-[480px] space-y-3 overflow-y-auto pr-1">
          {msgs.map((m, i) => (
            <div key={i} className={cx("rounded-lg px-3 py-2", m.role === "user" ? "ml-8 bg-accent-soft text-sm" : "mr-4 bg-panel-2")}>
              {m.role === "user" ? m.text : <RulesText text={m.text} />}
            </div>
          ))}
          {busy && <div className="mr-4 rounded-lg bg-panel-2 px-3 py-2 text-sm text-muted">Reading the analysis…</div>}
          <div ref={endRef} />
        </div>
      )}

      {err && <p className="mt-2 text-xs text-amber-400">{err}</p>}

      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          maxLength={2000}
          placeholder="e.g. Why is Donchian 5m losing?"
          className="h-11 min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 text-base sm:text-sm"
        />
        <Button type="submit" loading={busy} disabled={!input.trim()}>
          Ask
        </Button>
      </form>
    </Card>
  );
}
