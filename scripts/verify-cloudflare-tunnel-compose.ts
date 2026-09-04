import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function verifyCloudflareTunnelCompose(
  baseCompose: string,
  tunnelCompose: string,
  tunnelCaddyfile: string,
  environment: string,
): void {
  const requirePattern = (source: string, pattern: RegExp, label: string): void => {
    if (!pattern.test(source)) throw new Error(`${label} is missing or malformed`);
  };

  requirePattern(baseCompose, /^  caddy:$/m, "Base Caddy service");
  requirePattern(baseCompose, /^  app:\n    internal: true$/m, "Internal app network");
  requirePattern(baseCompose, /^  database:\n    internal: true$/m, "Internal database network");
  requirePattern(tunnelCompose, /^  cloudflared:$/m, "Cloudflared service");
  requirePattern(tunnelCompose, /image: \$\{CLOUDFLARED_IMAGE:\?CLOUDFLARED_IMAGE is required\}/, "Fail-fast pinned cloudflared image");
  requirePattern(tunnelCompose, /CLOUDFLARE_TUNNEL_TOKEN:\?CLOUDFLARE_TUNNEL_TOKEN is required/, "Fail-fast Cloudflare tunnel token");
  requirePattern(tunnelCompose, /- --no-autoupdate/, "Cloudflared auto-update disabled");
  requirePattern(tunnelCompose, /read_only: true/, "Read-only cloudflared filesystem");
  requirePattern(tunnelCompose, /no-new-privileges:true/, "Cloudflared no-new-privileges hardening");
  requirePattern(tunnelCompose, /cap_drop:\n      - ALL/, "Cloudflared capabilities dropped");
  requirePattern(tunnelCompose, /networks:\n      - public/, "Cloudflared public-network-only attachment");
  if (/\n      - (?:app|database)\n/.test(tunnelCompose)) {
    throw new Error("Cloudflared must not attach to app or database networks");
  }
  requirePattern(tunnelCompose, /caddy:\n        condition: service_healthy/, "Cloudflared Caddy health dependency");
  requirePattern(tunnelCompose, /caddy:\n    ports: !reset \[\]/, "Tunnel overlay removes host port publication");
  requirePattern(tunnelCaddyfile, /^http:\/\/\{\$CADDY_SITE_ADDRESS\} \{$/m, "HTTP-only Caddy tunnel origin");
  if (/tls internal/.test(tunnelCaddyfile)) {
    throw new Error("Tunnel origin must not use the local internal TLS profile");
  }
  requirePattern(tunnelCaddyfile, /reverse_proxy web:3001/, "Caddy to web upstream");
  requirePattern(tunnelCaddyfile, /health_uri \/readyz/, "Caddy readiness health check");
  requirePattern(tunnelCaddyfile, /Strict-Transport-Security/, "Caddy HSTS header");

  requirePattern(environment, /^CLOUDFLARED_IMAGE=cloudflare\/cloudflared@sha256:REPLACE_WITH_64_HEX_DIGEST$/m, "Immutable cloudflared image template");
  requirePattern(environment, /^CLOUDFLARE_TUNNEL_TOKEN=REPLACE_WITH_CLOUDFLARE_TUNNEL_TOKEN$/m, "Cloudflare tunnel token template");
  requirePattern(environment, /^CADDY_SITE_ADDRESS=[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/mi, "Public hostname template");
  requirePattern(environment, /^APP_ORIGIN=https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/mi, "Public HTTPS origin template");
  requirePattern(environment, /^CADDY_CONFIG_FILE=\.\/Caddyfile\.cloudflare-tunnel$/m, "Tunnel Caddyfile template");
}

const isDirectExecution = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  const root = resolve(import.meta.dirname, "..");
  verifyCloudflareTunnelCompose(
    readFileSync(resolve(root, "compose.single-host.yaml"), "utf8"),
    readFileSync(resolve(root, "compose.cloudflare-tunnel.yaml"), "utf8"),
    readFileSync(resolve(root, "Caddyfile.cloudflare-tunnel"), "utf8"),
    readFileSync(resolve(root, ".env.cloudflare-tunnel.example"), "utf8"),
  );
  console.log(JSON.stringify({ ok: true, deployment: "cloudflare-tunnel", hostPorts: "none", tunnelNetwork: "public" }));
}
