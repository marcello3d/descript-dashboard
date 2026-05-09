"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { SiLinear, SiGithub } from "react-icons/si";
import { useToast } from "@/components/Toast";
import { errorMessage } from "@/lib/errors";
import { getPermissionState, requestPermission } from "@/lib/notifications";
import { CursorIcon } from "@/components/icons";

interface KeyInfo {
  set: boolean;
  masked: string;
}

interface NotificationPrefs {
  enabled: boolean;
  reviewRequests: boolean;
  prReviews: boolean;
  syncErrors: boolean;
}

interface SettingsData {
  keys: Record<string, KeyInfo>;
  envOverrides: Record<string, boolean>;
  notifications: NotificationPrefs;
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
    key: "GITHUB_NOTIFICATIONS_TOKEN",
    label: "GitHub Notifications Token",
    icon: <SiGithub className="w-4 h-4 text-text-secondary" />,
    linkUrl: "https://github.com/settings/tokens/new?scopes=notifications&description=descript-dashboard%20notifications",
    linkLabel: "github.com → classic token with 'notifications' scope (optional, enables faster polling)",
    placeholder: "ghp_... (classic PAT with 'notifications' scope)",
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

function NotificationSettings({ data, onToggle }: { data: SettingsData | null; onToggle: (key: keyof NotificationPrefs) => void }) {
  // Lazy initializer reads Notification.permission at mount; "default" is the
  // SSR fallback because the API isn't available there.
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    () => (typeof window === "undefined" ? "default" : getPermissionState()),
  );
  const { toast } = useToast();

  const handleRequestPermission = useCallback(async () => {
    const result = await requestPermission();
    setPermission(result);
    if (result === "granted") {
      toast("success", "Notifications enabled");
    } else if (result === "denied") {
      toast("error", "Notifications blocked — check your browser settings");
    }
  }, [toast]);

  const supported = permission !== "unsupported";
  const granted = permission === "granted";
  const denied = permission === "denied";

  return (
    <div className="mt-8 pt-6 border-t border-border">
      <h2 className="text-sm font-medium text-text-primary mb-1">Desktop Notifications</h2>
      <p className="text-xs text-text-tertiary mb-4">
        Browser notifications shown when the window is not focused. In-app toasts are always enabled.
      </p>

      {!supported && (
        <p className="text-xs text-text-muted">Notifications are not supported in this browser.</p>
      )}

      {supported && !granted && (
        <div className="mb-4">
          {denied ? (
            <p className="text-xs text-text-muted">
              Notifications are blocked. To re-enable, reset the permission in your browser&apos;s site settings.
            </p>
          ) : (
            <button
              onClick={handleRequestPermission}
              className="px-3 py-1.5 text-sm font-medium rounded-md bg-text-primary text-background hover:opacity-90 transition-opacity"
            >
              Enable notifications
            </button>
          )}
        </div>
      )}

      {supported && granted && (
        <div className="space-y-3">
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={data?.notifications?.enabled !== false}
              onChange={() => onToggle("enabled")}
              className="mt-0.5 w-4 h-4 accent-status-green cursor-pointer"
            />
            <span className="text-sm font-medium text-text-primary">Enable desktop notifications</span>
          </label>

          <div className={`space-y-3 pl-7 ${data?.notifications?.enabled === false ? "opacity-40 pointer-events-none" : ""}`}>
            {([
              { key: "reviewRequests" as const, label: "New review requests", description: "When a PR is assigned to you for review" },
              { key: "prReviews" as const, label: "PR approved / changes requested", description: "When one of your PRs is approved or has changes requested" },
            ]).map(({ key, label, description }) => (
              <label key={key} className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={data?.notifications?.[key] !== false}
                  onChange={() => onToggle(key)}
                  className="mt-0.5 w-4 h-4 accent-status-green cursor-pointer"
                />
                <div>
                  <span className="text-sm text-text-primary">{label}</span>
                  <p className="text-xs text-text-tertiary">{description}</p>
                </div>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function SettingsPage() {
  const [data, setData] = useState<SettingsData | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings");
      const json = await res.json();
      setData(json);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    // fetchSettings sets state synchronously (and asynchronously after the
    // network round-trip); the on-mount fetch needs both, and the cascading
    // render hit is acceptable here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchSettings();
  }, [fetchSettings]);

  const handleSave = useCallback(async () => {
    setSaving(true);
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
      toast("success", "Settings saved — redirecting…");
      // Navigate back with fresh=1 so the dashboard re-fetches with new keys
      setTimeout(() => { window.location.href = "/?fresh=1"; }, 800);
    } catch (e) {
      const msg = errorMessage(e);
      setError(msg);
      toast("error", msg);
    } finally {
      setSaving(false);
    }
  }, [values, toast]);

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
        toast("info", "Key removed");
      } catch (e) {
        const msg = errorMessage(e);
        setError(msg);
        toast("error", msg);
      } finally {
        setSaving(false);
      }
    },
    [toast]
  );

  const hasChanges = Object.values(values).some((v) => v !== "");

  const handleToggleNotification = useCallback(async (key: keyof NotificationPrefs) => {
    const current = data?.notifications?.[key] !== false;
    const newValue = !current;
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notifications: { [key]: newValue } }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to update");
      setData((prev) => prev ? { ...prev, notifications: json.notifications } : prev);
    } catch (e) {
      toast("error", errorMessage(e));
    }
  }, [data, toast]);

  return (
    <div className="w-full max-w-xl mx-auto px-4 py-8">
      <div className="h-[38px]" />
      <div className="flex items-center gap-3 mb-6">
        <Link
          href="/"
          className="text-text-tertiary hover:text-text-secondary transition-colors text-sm"
        >
          &larr; Dashboard
        </Link>
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

      {/* Desktop Notifications */}
      <NotificationSettings data={data} onToggle={handleToggleNotification} />

      <div className="mt-8 flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving || !hasChanges}
          className="px-4 py-1.5 text-sm font-medium rounded-md bg-text-primary text-background hover:opacity-90 disabled:opacity-40 transition-opacity"
        >
          {saving ? "Saving..." : "Save"}
        </button>
        <Link
          href="/"
          className="text-sm text-text-tertiary hover:text-text-secondary transition-colors ml-auto"
        >
          Back to Dashboard
        </Link>
      </div>

      {/* Danger Zone */}
      <div className="mt-8 pt-6 border-t border-border">
        <h2 className="text-sm font-medium text-text-primary mb-1">Danger Zone</h2>
        <p className="text-xs text-text-tertiary mb-4">
          This clears the local cache and all work item data. API keys are not affected.
        </p>
        <button
          onClick={async () => {
            if (!window.confirm("Reset all local data? This clears the cache and work items.")) return;
            await fetch("/api/reset", { method: "DELETE" });
            window.location.href = "/";
          }}
          className="text-sm font-medium text-status-red hover:text-red-400 transition-colors"
        >
          Delete local data
        </button>
      </div>
    </div>
  );
}
