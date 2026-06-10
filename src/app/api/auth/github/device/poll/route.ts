import { setConfig } from "@/lib/config";
import { getEnv, invalidateEnvCache } from "@/lib/env";

// Polls GitHub once for the result of a device flow started via ../device.
// On success the access token is stored as GITHUB_TOKEN in the local config.
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const deviceCode = body?.deviceCode;
  if (typeof deviceCode !== "string" || !deviceCode) {
    return Response.json({ error: "Missing deviceCode" }, { status: 400 });
  }
  const clientId = getEnv("GITHUB_CLIENT_ID");
  if (!clientId) {
    return Response.json({ error: "GITHUB_CLIENT_ID not configured" }, { status: 400 });
  }

  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  const json = await res.json().catch(() => null);

  if (json?.access_token) {
    setConfig({ GITHUB_TOKEN: json.access_token });
    invalidateEnvCache();
    return Response.json({ status: "complete" });
  }
  if (json?.error === "authorization_pending" || json?.error === "slow_down") {
    // slow_down includes a new minimum interval the client should adopt
    return Response.json({ status: "pending", interval: json.interval });
  }
  const detail = json?.error_description ?? json?.error ?? "Device flow failed";
  return Response.json({ status: "error", error: `GitHub: ${detail}` }, { status: 400 });
}
