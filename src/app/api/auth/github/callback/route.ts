import { setConfig } from "@/lib/config";
import { getEnv, invalidateEnvCache } from "@/lib/env";
import { readStateCookie, redirectToSettings, redirectUri } from "../../oauth";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const fail = (msg: string) => redirectToSettings(request, "github", { oauth_error: msg });

  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    return fail(url.searchParams.get("error_description") ?? oauthError);
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || state !== readStateCookie(request, "github")) {
    return fail("OAuth state mismatch — try connecting again");
  }

  const clientId = getEnv("GITHUB_CLIENT_ID");
  const clientSecret = getEnv("GITHUB_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    return fail("GitHub OAuth client ID and secret must be configured first");
  }

  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri(request, "github"),
    }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.access_token) {
    const detail = json?.error_description ?? json?.error ?? `token exchange failed (HTTP ${res.status})`;
    return fail(`GitHub: ${detail}`);
  }

  setConfig({ GITHUB_TOKEN: json.access_token });
  invalidateEnvCache();
  return redirectToSettings(request, "github", { connected: "github" });
}
