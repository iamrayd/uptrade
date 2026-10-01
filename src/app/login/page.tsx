"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/client";
import { Button, Card, Segmented } from "@/components/ui";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    const sb = createClient();
    try {
      if (mode === "signin") {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.replace("/trade");
        router.refresh();
      } else {
        const { data, error } = await sb.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
        });
        if (error) throw error;
        if (data.session) {
          router.replace("/trade");
          router.refresh();
        } else {
          setInfo("Check your email to confirm your account, then sign in.");
          setMode("signin");
        }
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon.svg" alt="" className="size-14 rounded-2xl" />
          <h1 className="text-2xl font-bold tracking-tight">UpTrade</h1>
          <p className="text-sm text-muted">Paper trade crypto with live prices. Journal every trade.</p>
        </div>

        {!isSupabaseConfigured ? (
          <Card className="p-5 text-sm leading-relaxed">
            <div className="mb-2 font-semibold">Supabase isn’t connected yet</div>
            <p className="text-muted">
              Add <code className="text-fg">NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
              <code className="text-fg">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> to <code className="text-fg">.env.local</code> (or
              Vercel env vars), run <code className="text-fg">supabase/schema.sql</code>, then reload.
            </p>
          </Card>
        ) : (
          <Card className="p-5">
            <Segmented
              value={mode}
              onChange={(m) => {
                setMode(m);
                setError(null);
              }}
              options={[
                { value: "signin", label: "Sign in" },
                { value: "signup", label: "Create account" },
              ]}
              className="mb-5"
            />
            <form onSubmit={submit} className="space-y-4">
              <label className="block">
                <span className="mb-1.5 block text-sm text-muted">Email</span>
                <input
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="h-12 w-full rounded-lg border border-line bg-bg px-3 text-base outline-none focus:border-accent"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-sm text-muted">Password</span>
                <input
                  type="password"
                  required
                  minLength={6}
                  autoComplete={mode === "signin" ? "current-password" : "new-password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-12 w-full rounded-lg border border-line bg-bg px-3 text-base outline-none focus:border-accent"
                />
              </label>
              {error && <p className="rounded-lg bg-down-soft px-3 py-2 text-sm text-down">{error}</p>}
              {info && <p className="rounded-lg bg-up-soft px-3 py-2 text-sm text-up">{info}</p>}
              <Button type="submit" size="lg" loading={busy} className="w-full">
                {mode === "signin" ? "Sign in" : "Create account"}
              </Button>
            </form>
            {mode === "signup" && (
              <p className="mt-4 text-center text-xs text-muted">New accounts start with a $1,000 paper balance.</p>
            )}
          </Card>
        )}
      </div>
    </main>
  );
}
