"use client";

import React, { useCallback, useEffect, useState } from "react";
import { SiLinear, SiGithub } from "react-icons/si";

function CursorIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="400 395 167 190" fill="currentColor">
      <path d="M563.463 439.971L487.344 396.057C484.899 394.646 481.883 394.646 479.439 396.057L403.323 439.971C401.269 441.156 400 443.349 400 445.723V534.276C400 536.647 401.269 538.843 403.323 540.029L479.443 583.943C481.887 585.353 484.903 585.353 487.347 583.943L563.466 540.029C565.521 538.843 566.79 536.651 566.79 534.276V445.723C566.79 443.352 565.521 441.156 563.466 439.971H563.463ZM558.681 449.273L485.199 576.451C484.703 577.308 483.391 576.958 483.391 575.966V492.691C483.391 491.027 482.501 489.488 481.058 488.652L408.887 447.016C408.03 446.52 408.38 445.209 409.373 445.209H556.337C558.424 445.209 559.728 447.47 558.685 449.276H558.681V449.273Z" />
    </svg>
  );
}

interface KeyInfo {
  set: boolean;
  masked: string;
}

interface SettingsData {
  keys: Record<string, KeyInfo>;
  envOverrides: Record<string, boolean>;
}

const KEY_CONFIG = [
  {
    key: "LINEAR_API_KEY",
    label: "Linear API Key",
    icon: <SiLinear className="w-4 h-4 text-[#5E6AD2]" />,
    linkUrl: "https://linear.app/descript/settings/account/security",
    linkLabel: "linear.app → Settings → Security",
    placeholder: "lin_api_...",
  },
  {
    key: "GITHUB_TOKEN",
    label: "GitHub Token",
    icon: <SiGithub className="w-4 h-4 text-text-secondary" />,
    linkUrl: "https://github.com/settings/tokens",
    linkLabel: "github.com → Settings → Tokens",
    placeholder: "ghp_...",
  },
  {
    key: "CURSOR_API_KEY",
    label: "Cursor API Key",
    icon: <CursorIcon className="w-4 h-4 text-text-secondary" />,
    linkUrl: "https://cursor.com/dashboard/cloud-agents",
    linkLabel: "cursor.com → Dashboard → Cloud Agents",
    placeholder: "cur_...",
  },
];

export default function SettingsPage() {
  const [data, setData] = useState<SettingsData | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings");
      const json = await res.json();
      setData(json);
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const body: Record<string, string> = {};
      for (const { key } of KEY_CONFIG) {
        if (values[key] !== undefined && values[key] !== "") {
          body[key] = values[key];
        }
      }
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to save");
      setData((prev) => (prev ? { ...prev, keys: json.keys } : prev));
      setValues({});
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }, [values]);

  const handleClear = useCallback(
    async (key: string) => {
      setSaving(true);
      setError(null);
      try {
        const res = await fetch("/api/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [key]: "" }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Failed to clear");
        setData((prev) => (prev ? { ...prev, keys: json.keys } : prev));
        setValues((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
      } catch (e: any) {
        setError(e.message);
      } finally {
        setSaving(false);
      }
    },
    []
  );

  const hasChanges = Object.values(values).some((v) => v !== "");

  return (
    <div className="w-full max-w-xl mx-auto px-4 py-8">
      <div className="h-[38px]" />
      <div className="flex items-center gap-3 mb-6">
        <a
          href="/"
          className="text-text-tertiary hover:text-text-secondary transition-colors text-sm"
        >
          &larr; Dashboard
        </a>
        <h1 className="text-lg font-bold text-text-primary">Settings</h1>
      </div>

      <p className="text-sm text-text-tertiary mb-6">
        Configure API keys for the services this dashboard connects to. Keys are
        stored locally on this machine. Environment variables (
        <code className="text-xs">.env.local</code>) take priority if set.
      </p>

      {error && (
        <div className="mb-4 text-sm text-status-red">{error}</div>
      )}

      <div className="space-y-6">
        {KEY_CONFIG.map(({ key, label, icon, linkUrl, linkLabel, placeholder }) => {
          const info = data?.keys[key];
          const envOverride = data?.envOverrides[key];
          const currentValue = values[key] ?? "";

          return (
            <div key={key} className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-text-primary flex items-center gap-2">
                  {icon}
                  {label}
                </label>
                <span className="flex items-center gap-2">
                  {envOverride && (
                    <span className="text-[11px] text-status-green">
                      env override
                    </span>
                  )}
                  {info?.set && !envOverride && (
                    <span className="text-[11px] text-status-green">
                      configured
                    </span>
                  )}
                  {!info?.set && !envOverride && (
                    <span className="text-[11px] text-text-muted">
                      not set
                    </span>
                  )}
                </span>
              </div>

              <div className="flex gap-2">
                <input
                  type="text"
                  value={currentValue}
                  onChange={(e) =>
                    setValues((prev) => ({ ...prev, [key]: e.target.value }))
                  }
                  placeholder={
                    info?.set ? info.masked : placeholder
                  }
                  className="flex-1 text-sm bg-surface border border-border rounded-md px-3 py-1.5 text-text-primary placeholder:text-text-muted outline-none focus:border-text-tertiary transition-colors"
                  autoComplete="off"
                />
                {info?.set && !envOverride && (
                  <button
                    onClick={() => handleClear(key)}
                    disabled={saving}
                    className="text-xs text-text-muted hover:text-status-red transition-colors px-2"
                    title="Remove this key"
                  >
                    Clear
                  </button>
                )}
              </div>

              <a
                href={linkUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-text-tertiary hover:text-text-secondary hover:underline transition-colors"
              >
                {linkLabel} &rarr;
              </a>
            </div>
          );
        })}
      </div>

      <div className="mt-8 flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving || !hasChanges}
          className="px-4 py-1.5 text-sm font-medium rounded-md bg-text-primary text-background hover:opacity-90 disabled:opacity-40 transition-opacity"
        >
          {saving ? "Saving..." : "Save"}
        </button>
        {saved && (
          <span className="text-sm text-status-green">Saved</span>
        )}
        <a
          href="/"
          className="text-sm text-text-tertiary hover:text-text-secondary transition-colors ml-auto"
        >
          Back to Dashboard
        </a>
      </div>
    </div>
  );
}
