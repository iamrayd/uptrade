"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { dataVersion, useStore } from "@/lib/store";

type Supabase = ReturnType<typeof createClient>;

interface QueryState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
}

/**
 * Runs `fetcher` on mount, whenever `key` changes, and after every mutation
 * (bumpData). Keeps showing the previous data while refetching.
 */
export function useQuery<T>(key: string | null, fetcher: (sb: Supabase) => Promise<T>) {
  const version = useStore(dataVersion);
  const fetcherRef = useRef(fetcher);
  const [state, setState] = useState<QueryState<T> & { key: string | null }>({
    data: undefined,
    error: null,
    loading: key !== null,
    key,
  });

  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    if (key === null) return;
    let alive = true;
    fetcherRef
      .current(createClient())
      .then((data) => alive && setState({ data, error: null, loading: false, key }))
      .catch((e: Error) => alive && setState((s) => ({ ...s, error: e.message, loading: false, key })));
    return () => {
      alive = false;
    };
  }, [key, version]);

  // Data from a different key is stale; don't show it.
  const sameKey = state.key === key;
  return {
    data: sameKey ? state.data : undefined,
    error: sameKey ? state.error : null,
    loading: key !== null && (!sameKey || state.loading),
  };
}

export function unwrap<T>({ data, error }: { data: T | null; error: { message: string } | null }): T {
  if (error) throw new Error(error.message);
  return data as T;
}
