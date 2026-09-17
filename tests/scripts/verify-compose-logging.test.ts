import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseComposeServices, verifyComposeLogRotation } from "../../scripts/verify-compose-logging";

const root = resolve(import.meta.dirname, "..", "..");
const read = (file: string): string => readFileSync(resolve(root, file), "utf8");

describe("container log rotation contract", () => {
  it("parses every service block, including profiled ones", () => {
    const names = parseComposeServices(read("compose.yaml")).map((service) => service.name);
    expect(names).toContain("web");
    expect(names).toContain("backup-scheduler");
    expect(names).toContain("data-lifecycle");
  });

  it("accepts each shipped deployable compose file", () => {
    for (const file of ["compose.yaml", "compose.single-host.yaml", "compose.production.yaml"]) {
      expect(() => verifyComposeLogRotation(read(file), file)).not.toThrow();
    }
  });

  it("accepts the tunnel overlay when only cloudflared is required", () => {
    expect(() =>
      verifyComposeLogRotation(read("compose.cloudflare-tunnel.yaml"), "overlay", ["cloudflared"]),
    ).not.toThrow();
  });

  it("rejects a service that drops rotation", () => {
    const compose = read("compose.yaml").replace("    logging: *default-logging\n", "");
    expect(() => verifyComposeLogRotation(compose, "Compose")).toThrow(/service postgres log rotation/);
  });

  it("rejects an anchor without bounded retention", () => {
    const compose = read("compose.yaml").replace('    max-file: "5"', '    max-file: "0"');
    expect(() => verifyComposeLogRotation(compose, "Compose")).toThrow(/max-file rotation/);
  });

  it("rejects a missing or renamed rotation anchor", () => {
    const compose = read("compose.yaml").replace("x-logging: &default-logging", "x-logging: &other");
    expect(() => verifyComposeLogRotation(compose, "Compose")).toThrow(/log rotation anchor/);
  });

  it("rejects a required overlay service that is not present", () => {
    expect(() =>
      verifyComposeLogRotation(read("compose.cloudflare-tunnel.yaml"), "overlay", ["cloudflared", "web"]),
    ).toThrow(/service web is missing/);
  });
});
