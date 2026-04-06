"use client";

import { useState, useEffect, useCallback } from "react";
import type { ServiceResponse } from "@/types";

export function useServiceData<T>(endpoint: string, intervalMs = 60000) {
  const [data, setData] = useState<T[] | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(endpoint);
      const json: ServiceResponse<T> = await res.json();
      setConnected(json.connected);
      setData(json.data ?? null);
      setError(json.error ?? null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, intervalMs);
    return () => clearInterval(id);
  }, [refresh, intervalMs]);

  return { data, connected, error, loading, refresh };
}
