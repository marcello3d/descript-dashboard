import crypto from "crypto";

export type OAuthProvider = "github" | "linear";

function stateCookieName(provider: OAuthProvider): string {
  return `${provider}_oauth_state`;
}

export function makeState(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function stateCookie(provider: OAuthProvider, state: string): string {
  return `${stateCookieName(provider)}=${state}; Path=/api/auth/${provider}; HttpOnly; SameSite=Lax; Max-Age=600`;
}

function clearStateCookie(provider: OAuthProvider): string {
  return `${stateCookieName(provider)}=; Path=/api/auth/${provider}; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function readStateCookie(request: Request, provider: OAuthProvider): string | undefined {
  const cookies = request.headers.get("cookie") ?? "";
  for (const part of cookies.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === stateCookieName(provider)) return rest.join("=");
  }
  return undefined;
}

// The redirect URI must byte-match what's registered on the provider's OAuth
// app, so derive it from the request origin the user is actually browsing on
// (localhost:4080 in the normal case).
export function redirectUri(request: Request, provider: OAuthProvider): string {
  return `${new URL(request.url).origin}/api/auth/${provider}/callback`;
}

// Redirect back to the settings page (clearing the state cookie), with either
// ?connected=<provider> or ?oauth_error=<message> for the UI to toast.
export function redirectToSettings(
  request: Request,
  provider: OAuthProvider,
  params: Record<string, string>,
): Response {
  const url = new URL("/settings", request.url);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new Response(null, {
    status: 302,
    headers: { Location: url.toString(), "Set-Cookie": clearStateCookie(provider) },
  });
}
