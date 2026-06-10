import crypto from "crypto";
import { getEnv } from "@/lib/env";
import { linearRedirectUri, STATE_COOKIE } from "../oauth";

// Kicks off the Linear OAuth authorization code flow. Requires a Linear OAuth
// application (LINEAR_CLIENT_ID / LINEAR_CLIENT_SECRET) whose callback URL is
// registered as <origin>/api/auth/linear/callback.
export async function GET(request: Request) {
  const clientId = getEnv("LINEAR_CLIENT_ID");
  const clientSecret = getEnv("LINEAR_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    const msg = encodeURIComponent("Linear OAuth client ID and secret must be configured first");
    return Response.redirect(new URL(`/settings?linear_error=${msg}`, request.url), 302);
  }

  const state = crypto.randomBytes(16).toString("hex");
  const authorize = new URL("https://linear.app/oauth/authorize");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", linearRedirectUri(request));
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", "read,write");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("actor", "user");
  authorize.searchParams.set("prompt", "consent");

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.toString(),
      "Set-Cookie": `${STATE_COOKIE}=${state}; Path=/api/auth/linear; HttpOnly; SameSite=Lax; Max-Age=600`,
    },
  });
}
