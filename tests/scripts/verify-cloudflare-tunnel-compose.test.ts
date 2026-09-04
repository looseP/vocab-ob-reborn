import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyCloudflareTunnelCompose } from "../../scripts/verify-cloudflare-tunnel-compose";

const root = resolve(import.meta.dirname, "..", "..");
const baseCompose = readFileSync(resolve(root, "compose.single-host.yaml"), "utf8");
const tunnelCompose = readFileSync(resolve(root, "compose.cloudflare-tunnel.yaml"), "utf8");
const tunnelCaddyfile = readFileSync(resolve(root, "Caddyfile.cloudflare-tunnel"), "utf8");
const environment = readFileSync(resolve(root, ".env.cloudflare-tunnel.example"), "utf8");

describe("Cloudflare Tunnel Compose contract", () => {
  it("accepts the public-tunnel overlay without host port publication", () => {
    expect(() => verifyCloudflareTunnelCompose(baseCompose, tunnelCompose, tunnelCaddyfile, environment)).not.toThrow();
  });

  it("rejects a mutable cloudflared image or missing token gate", () => {
    expect(() => verifyCloudflareTunnelCompose(
      baseCompose,
      tunnelCompose,
      tunnelCaddyfile,
      environment.replace("CLOUDFLARED_IMAGE=cloudflare/cloudflared@sha256:REPLACE_WITH_64_HEX_DIGEST", "CLOUDFLARED_IMAGE=cloudflare/cloudflared:latest"),
    )).toThrow(/Immutable cloudflared image template/);
    expect(() => verifyCloudflareTunnelCompose(
      baseCompose,
      tunnelCompose.replace("CLOUDFLARE_TUNNEL_TOKEN:?CLOUDFLARE_TUNNEL_TOKEN is required", "CLOUDFLARE_TUNNEL_TOKEN:-"),
      tunnelCaddyfile,
      environment,
    )).toThrow(/tunnel token/);
  });

  it("rejects cloudflared access to an internal application network", () => {
    expect(() => verifyCloudflareTunnelCompose(
      baseCompose,
      tunnelCompose.replace("    networks:\n      - public", "    networks:\n      - public\n      - app"),
      tunnelCaddyfile,
      environment,
    )).toThrow(/must not attach/);
  });

  it("rejects host ports or a local-only Caddy profile in tunnel mode", () => {
    expect(() => verifyCloudflareTunnelCompose(
      baseCompose,
      tunnelCompose.replace("    ports: !reset []", "    ports:\n      - \"443:443\""),
      tunnelCaddyfile,
      environment,
    )).toThrow(/removes host port publication/);
    expect(() => verifyCloudflareTunnelCompose(
      baseCompose,
      tunnelCompose,
      tunnelCaddyfile.replace("  encode zstd gzip", "  tls internal\n  encode zstd gzip"),
      environment,
    )).toThrow(/must not use the local internal TLS profile/);
  });
});
