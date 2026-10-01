"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { bumpData, toast } from "@/lib/store";
import type { JournalEntry, Position } from "@/lib/types";
import { Button, Spinner, cx } from "./ui";

const SUGGESTED = ["breakout", "pullback", "reversal", "trend", "range", "news", "scalp", "fomo", "revenge", "a-plus"];
const MAX_MB = 8;

const normalizeTag = (t: string) =>
  t
    .trim()
    .toLowerCase()
    .replace(/^#/, "")
    .replace(/[^a-z0-9-_ ]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 32);

export function JournalEditor({
  position,
  initial,
  allTags,
}: {
  position: Position;
  initial: JournalEntry | null;
  allTags: string[];
}) {
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [tags, setTags] = useState<string[]>(initial?.tags ?? []);
  const [rating, setRating] = useState<number | null>(initial?.rating ?? null);
  const [shots, setShots] = useState<string[]>(initial?.screenshots ?? []);
  const [tagInput, setTagInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(initial?.updated_at ?? null);
  const [dirty, setDirty] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const touch = () => setDirty(true);

  async function persist(next?: Partial<Pick<JournalEntry, "screenshots">>) {
    const sb = createClient();
    const { error } = await sb.from("journal_entries").upsert({
      position_id: position.id,
      notes,
      tags,
      rating,
      screenshots: next?.screenshots ?? shots,
      updated_at: new Date().toISOString(),
    });
    if (error) throw new Error(error.message);
    setSavedAt(new Date().toISOString());
    setDirty(false);
    bumpData();
  }

  async function save() {
    setSaving(true);
    try {
      await persist();
      toast("success", "Journal saved");
    } catch (e) {
      toast("error", "Couldn't save", (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  // Cmd/Ctrl+S to save; warn before leaving with unsaved edits.
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function addTag(raw: string) {
    const t = normalizeTag(raw);
    if (!t || tags.includes(t)) return setTagInput("");
    setTags([...tags, t]);
    setTagInput("");
    touch();
  }

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    const sb = createClient();
    const {
      data: { user },
    } = await sb.auth.getUser();
    if (!user) return setUploading(false);
    const added: string[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) {
        toast("error", "Images only", file.name);
        continue;
      }
      if (file.size > MAX_MB * 1024 * 1024) {
        toast("error", `Max ${MAX_MB} MB per image`, file.name);
        continue;
      }
      const ext = file.name.split(".").pop()?.toLowerCase() || "png";
      const path = `${user.id}/${position.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const { error } = await sb.storage.from("journal").upload(path, file, { contentType: file.type });
      if (error) toast("error", "Upload failed", error.message);
      else added.push(path);
    }
    if (added.length) {
      const next = [...shots, ...added];
      setShots(next);
      try {
        await persist({ screenshots: next });
        toast("success", added.length > 1 ? `${added.length} screenshots added` : "Screenshot added");
      } catch (e) {
        toast("error", "Couldn't save", (e as Error).message);
      }
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function removeShot(path: string) {
    const next = shots.filter((s) => s !== path);
    setShots(next);
    await createClient().storage.from("journal").remove([path]);
    try {
      await persist({ screenshots: next });
    } catch (e) {
      toast("error", "Couldn't save", (e as Error).message);
    }
  }

  const suggestions = [...new Set([...allTags, ...SUGGESTED])].filter(
    (t) => !tags.includes(t) && (!tagInput || t.includes(normalizeTag(tagInput))),
  );

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Journal</h2>
        <span className="text-xs text-faint">
          {dirty ? "Unsaved changes" : savedAt ? `Saved ${new Date(savedAt).toLocaleString()}` : "Not journaled yet"}
        </span>
      </div>

      <div>
        <div className="mb-1.5 text-xs text-muted">How well did you execute?</div>
        <div className="flex gap-1" role="radiogroup" aria-label="Execution rating">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              role="radio"
              aria-checked={rating === n}
              aria-label={`${n} star${n > 1 ? "s" : ""}`}
              onClick={() => {
                setRating(rating === n ? null : n);
                touch();
              }}
              className={cx("grid size-11 place-items-center rounded-lg text-2xl transition hover:bg-panel-2", rating && n <= rating ? "text-amber-400" : "text-line")}
            >
              ★
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-1.5 text-xs text-muted">Setup tags</div>
        <div className="flex flex-wrap gap-1.5">
          {tags.map((t) => (
            <button
              key={t}
              onClick={() => {
                setTags(tags.filter((x) => x !== t));
                touch();
              }}
              className="inline-flex h-8 items-center gap-1 rounded-md bg-accent-soft px-2 text-sm text-accent hover:brightness-125"
              aria-label={`Remove tag ${t}`}
            >
              #{t} <span className="text-xs opacity-70">✕</span>
            </button>
          ))}
          <input
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                addTag(tagInput);
              } else if (e.key === "Backspace" && !tagInput && tags.length) {
                setTags(tags.slice(0, -1));
                touch();
              }
            }}
            onBlur={() => tagInput && addTag(tagInput)}
            placeholder={tags.length ? "Add tag" : "e.g. breakout"}
            className="h-8 min-w-24 flex-1 rounded-md border border-line bg-bg px-2 text-base outline-none focus:border-accent sm:text-sm"
            enterKeyHint="done"
          />
        </div>
        {suggestions.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {suggestions.slice(0, 10).map((t) => (
              <button
                key={t}
                onClick={() => addTag(t)}
                className="h-8 rounded-md border border-dashed border-line px-2 text-xs text-muted hover:border-accent hover:text-accent"
              >
                + {t}
              </button>
            ))}
          </div>
        )}
      </div>

      <label className="block">
        <span className="mb-1.5 block text-xs text-muted">Notes</span>
        <textarea
          value={notes}
          onChange={(e) => {
            setNotes(e.target.value);
            touch();
          }}
          rows={8}
          placeholder={"Why did you take it?\nWhat was the plan (entry, stop, target)?\nWhat went well, what would you change?"}
          className="w-full resize-y rounded-lg border border-line bg-bg p-3 text-base leading-relaxed outline-none focus:border-accent sm:text-sm"
        />
      </label>

      <div>
        <div className="mb-1.5 flex items-center justify-between text-xs text-muted">
          <span>Screenshots</span>
          {uploading && <Spinner className="size-3" />}
        </div>
        <Screenshots paths={shots} onRemove={removeShot} />
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => upload(e.target.files)} />
        <Button variant="outline" size="sm" className="mt-2 w-full" loading={uploading} onClick={() => fileRef.current?.click()}>
          Add screenshots
        </Button>
      </div>

      <Button size="lg" className="w-full" loading={saving} onClick={save} disabled={!dirty && !!savedAt}>
        {dirty || !savedAt ? "Save journal" : "Saved"}
      </Button>
    </div>
  );
}

function Screenshots({ paths, onRemove }: { paths: string[]; onRemove: (p: string) => void }) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [zoom, setZoom] = useState<string | null>(null);

  const key = paths.join("|");
  useEffect(() => {
    if (!key) return;
    let alive = true;
    createClient()
      .storage.from("journal")
      .createSignedUrls(key.split("|"), 3600)
      .then(({ data }) => {
        if (!alive || !data) return;
        const next: Record<string, string> = {};
        data.forEach((d) => {
          if (d.path && d.signedUrl) next[d.path] = d.signedUrl;
        });
        setUrls(next);
      });
    return () => {
      alive = false;
    };
  }, [key]);

  if (!paths.length) return <div className="rounded-lg border border-dashed border-line p-4 text-center text-xs text-faint">No screenshots yet</div>;

  return (
    <>
      <div className="grid grid-cols-3 gap-2">
        {paths.map((p) => (
          <div key={p} className="group relative aspect-video overflow-hidden rounded-lg border border-line bg-bg">
            {urls[p] ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={urls[p]} alt="Trade screenshot" className="size-full cursor-zoom-in object-cover" onClick={() => setZoom(urls[p])} />
            ) : (
              <div className="size-full animate-pulse bg-panel-2" />
            )}
            <button
              onClick={() => onRemove(p)}
              aria-label="Remove screenshot"
              className="absolute right-1 top-1 grid size-7 place-items-center rounded-md bg-black/70 text-xs text-white opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      {zoom && (
        <div className="animate-fade-in fixed inset-0 z-50 grid place-items-center bg-black/90 p-4" onClick={() => setZoom(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={zoom} alt="Trade screenshot" className="max-h-full max-w-full rounded-lg" />
        </div>
      )}
    </>
  );
}
