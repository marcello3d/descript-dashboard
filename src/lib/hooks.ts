"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { ServiceResponse } from "@/types";

export function useServiceData<T>(endpoint: string, intervalMs = 300000) {
  const [data, setData] = useState<T[] | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [rateLimit, setRateLimit] = useState<{ cost?: number; remaining: number; limit: number; resetAt: string } | null>(null);
  const lastFetchRef = useRef(0);
  const fetchingRef = useRef(false);

  const doFetch = useCallback(
    async (bypassCache: boolean) => {
      // Prevent concurrent duplicate fetches (e.g. React StrictMode double-mount)
      if (fetchingRef.current) return;

      // Skip if we fetched recently and not bypassing cache
      const now = Date.now();
      if (!bypassCache && now - lastFetchRef.current < intervalMs) {
        return;
      }

      fetchingRef.current = true;
      setLoading(true);
      try {
        const url = bypassCache ? `${endpoint}${endpoint.includes("?") ? "&" : "?"}fresh=1` : endpoint;
        const res = await fetch(url, {
          cache: bypassCache ? "no-store" : "default",
        });
        const json: ServiceResponse<T> = await res.json();
        setConnected(json.connected);
        setData(json.data ?? null);
        setError(json.error ?? null);
        setRateLimit(json.rateLimit ?? null);
        lastFetchRef.current = Date.now();
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
        fetchingRef.current = false;
      }
    },
    [endpoint, intervalMs]
  );

  // Manual refresh always bypasses cache
  const refresh = useCallback(() => doFetch(true), [doFetch]);

  // Initial load + interval uses cache
  useEffect(() => {
    doFetch(false);
    const id = setInterval(() => doFetch(false), intervalMs);
    return () => clearInterval(id);
  }, [doFetch, intervalMs]);

  return { data, connected, error, loading, refresh, rateLimit };
}
