import { getEnv } from "@/lib/env";

// Starts a GitHub device authorization flow. Requires a GitHub OAuth App
// client ID with "Device Flow" enabled (no client secret needed).
export async function POST() {
  const clientId = getEnv("GITHUB_CLIENT_ID");
  if (!clientId) {
    return Response.json({ error: "GITHUB_CLIENT_ID not configured" }, { status: 400 });
  }

  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, scope: "repo notifications" }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.device_code) {
    const detail = json?.error_description ?? json?.error;
    return Response.json(
      { error: detail ? `GitHub: ${detail}` : "Failed to start device flow" },
      { status: 502 },
    );
  }

  return Response.json({
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUri: json.verification_uri,
    interval: json.interval ?? 5,
    expiresIn: json.expires_in,
  });
}
