import { setConfig } from "@/lib/config";
import { getEnv, invalidateEnvCache } from "@/lib/env";
import { linearRedirectUri, readStateCookie, STATE_COOKIE } from "../oauth";

const CLEAR_STATE_COOKIE = `${STATE_COOKIE}=; Path=/api/auth/linear; HttpOnly; SameSite=Lax; Max-Age=0`;

function redirectToSettings(request: Request, params: Record<string, string>): Response {
  const url = new URL("/settings", request.url);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new Response(null, {
    status: 302,
    headers: { Location: url.toString(), "Set-Cookie": CLEAR_STATE_COOKIE },
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const fail = (msg: string) => redirectToSettings(request, { linear_error: msg });

  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    return fail(url.searchParams.get("error_description") ?? oauthError);
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || state !== readStateCookie(request)) {
    return fail("OAuth state mismatch — try connecting again");
  }

  const clientId = getEnv("LINEAR_CLIENT_ID");
  const clientSecret = getEnv("LINEAR_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    return fail("Linear OAuth client ID and secret must be configured first");
  }

  const res = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: linearRedirectUri(request),
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.access_token) {
    const detail = json?.error_description ?? json?.error ?? `token exchange failed (HTTP ${res.status})`;
    return fail(`Linear: ${detail}`);
  }

  setConfig({ LINEAR_API_KEY: json.access_token });
  invalidateEnvCache();
  return redirectToSettings(request, { linear: "connected" });
}
