import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const rootFile = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const packageJson = JSON.parse(readFileSync(rootFile("package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const ci = readFileSync(rootFile(".github/workflows/ci.yml"), "utf8");

describe("official alerting syntax CI gate", () => {
  it("runs the real alerting contract verifier in the engineering gate", () => {
    expect(packageJson.scripts["verify:engineering"]).toContain("npm run alerting:verify");
  });

  it("pins official Prometheus and Alertmanager images by digest", () => {
    expect(ci).toContain(
      "prom/prometheus@sha256:3b1d5be5c3eef4f027665ddaa3b1a7de8a58d96a0a6de5dd45629afd267ecaf0",
    );
    expect(ci).toContain(
      "prom/alertmanager@sha256:27c475db5fb156cab31d5c18a4251ac7ed567746a2483ff264516437a39b15ba",
    );
    expect(ci).not.toMatch(/prom\/(?:prometheus|alertmanager):(?:latest|v[0-9])/);
  });

  it("blocks CI on both rule files and the Alertmanager template", () => {
    expect(ci).toContain("check rules /rules/alerting-rules.yaml /rules/optional-platform-alerting-rules.yaml");
    expect(ci).toContain("check-config /rules/alertmanager.yaml");
    expect(ci).toContain("--entrypoint /bin/promtool");
    expect(ci).toContain("--entrypoint /bin/amtool");
  });
});
