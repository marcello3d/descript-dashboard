export const STATE_COOKIE = "linear_oauth_state";

// The redirect URI must byte-match what's registered on the Linear OAuth app,
// so derive it from the request origin the user is actually browsing on
// (localhost:4080 in the normal case).
export function linearRedirectUri(request: Request): string {
  return `${new URL(request.url).origin}/api/auth/linear/callback`;
}

export function readStateCookie(request: Request): string | undefined {
  const cookies = request.headers.get("cookie") ?? "";
  for (const part of cookies.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === STATE_COOKIE) return rest.join("=");
  }
  return undefined;
}
