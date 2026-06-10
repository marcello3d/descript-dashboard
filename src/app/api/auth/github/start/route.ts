import { getEnv } from "@/lib/env";
import { makeState, redirectToSettings, redirectUri, stateCookie } from "../../oauth";

// Kicks off the GitHub OAuth authorization code flow. Requires a GitHub OAuth
// App (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET) whose callback URL is
// registered as <origin>/api/auth/github/callback.
export async function GET(request: Request) {
  const clientId = getEnv("GITHUB_CLIENT_ID");
  const clientSecret = getEnv("GITHUB_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    return redirectToSettings(request, "github", {
      oauth_error: "GitHub OAuth client ID and secret must be configured first",
    });
  }

  const state = makeState();
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri(request, "github"));
  authorize.searchParams.set("scope", "repo notifications");
  authorize.searchParams.set("state", state);

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.toString(),
      "Set-Cookie": stateCookie("github", state),
    },
  });
}
