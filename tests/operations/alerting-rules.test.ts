import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type AlertRule = {
  alert: string;
  expr: string;
  for: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
};
type RuleFile = { groups: Array<{ name: string; rules: AlertRule[] }> };

const operationPath = (file: string) => fileURLToPath(new URL(`../../docs/operations/${file}`, import.meta.url));
const load = (file: string): RuleFile => parse(readFileSync(operationPath(file), "utf8")) as RuleFile;
const rules = (file: RuleFile) => file.groups.flatMap((group) => group.rules);

const emittedApplicationMetrics = new Set([
  "vocab_observatory_http_requests_total",
  "vocab_observatory_http_request_duration_seconds_bucket",
  "vocab_observatory_runtime",
]);
const promqlMetricNames = (expr: string) =>
  [...expr.matchAll(/\b(vocab_[a-z0-9_:]+)\s*\{/g)].map((match) => match[1].replace(/:$/, ""));

describe("Prometheus alerting rule contract", () => {
  it("parses offline and gives every alert stable ownership and runbook metadata", () => {
    for (const file of [load("alerting-rules.yaml"), load("optional-platform-alerting-rules.yaml")]) {
      expect(file.groups.length).toBeGreaterThan(0);
      for (const rule of rules(file)) {
        expect(rule.alert).toMatch(/^Vocab[A-Z][A-Za-z0-9]+$/);
        expect(rule.expr.trim()).not.toBe("");
        expect(rule.for).toMatch(/^\d+[smh]$/);
        expect(rule.labels).toMatchObject({ service: "vocab_observatory", team: "vocab-observatory" });
        expect(["warning", "critical"]).toContain(rule.labels.severity);
        expect(rule.labels.component).toBeTruthy();
        expect(rule.labels.alert_family).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
        expect(Object.keys(rule.labels)).not.toEqual(expect.arrayContaining(["instance", "route", "method", "status_class"]));
        expect(rule.annotations.summary).toBeTruthy();
        expect(rule.annotations.description).toBeTruthy();
        expect(rule.annotations.runbook_url).toMatch(/^docs\/operations\/slo-runbook\.md#[a-z0-9-]+$/);
      }
    }
  });

  it("uses only repository-proven application metrics in the core rule file", () => {
    const core = load("alerting-rules.yaml");
    const referenced = new Set(rules(core).flatMap((rule) => promqlMetricNames(rule.expr)));
    expect([...referenced].sort()).toEqual([...emittedApplicationMetrics].sort());
    expect(readFileSync(operationPath("alerting-rules.yaml"), "utf8")).not.toContain("vocab_platform_");
  });

  it("keeps exporter-dependent alerts isolated and documents their contracts", () => {
    const optional = load("optional-platform-alerting-rules.yaml");
    const referenced = new Set(rules(optional).flatMap((rule) => promqlMetricNames(rule.expr)));
    expect([...referenced].sort()).toEqual([
      "vocab_platform_backup_last_attempt_success",
      "vocab_platform_backup_last_attempt_timestamp_seconds",
      "vocab_platform_backup_last_success_timestamp_seconds",
      "vocab_platform_restore_drill_last_attempt_success",
      "vocab_platform_restore_drill_last_attempt_timestamp_seconds",
      "vocab_platform_restore_drill_last_success_timestamp_seconds",
      "vocab_platform_runner_canary_last_success_timestamp_seconds",
    ]);
    const optionalYaml = readFileSync(operationPath("optional-platform-alerting-rules.yaml"), "utf8");
    for (const rule of rules(optional)) expect(rule.expr).toContain('environment="production"');
    const runbook = readFileSync(operationPath("slo-runbook.md"), "utf8");
    for (const metric of referenced) expect(runbook).toContain(metric);
    expect(optionalYaml).toContain("probe_ssl_earliest_cert_expiry");
    expect(runbook).toContain("probe_ssl_earliest_cert_expiry");
  });

  it("covers availability, HTTP SLO, metrics loss, worker state, and backup boundaries", () => {
    const coreNames = rules(load("alerting-rules.yaml")).map((rule) => rule.alert);
    expect(coreNames).toEqual(
      expect.arrayContaining([
        "VocabTargetDown",
        "VocabMetricsMissing",
        "VocabHttpErrorBudgetBurnFast",
        "VocabHttpErrorBudgetBurnSlow",
        "VocabHighLatencyP95",
        "VocabOutboxStuck",
        "VocabOutboxDeadLetter",
        "VocabLlmReservationAgeHigh",
        "VocabLlmExpiredReservationsHigh",
      ]),
    );
    const optionalNames = rules(load("optional-platform-alerting-rules.yaml")).map((rule) => rule.alert);
    expect(optionalNames).toEqual(
      expect.arrayContaining([
        "VocabBackupStale",
        "VocabBackupFailed",
        "VocabRestoreDrillCollectorMissing",
        "VocabRestoreDrillFailed",
        "VocabRestoreDrillOverdue",
        "VocabRestoreDrillCriticallyOverdue",
        "VocabTlsProbeMetricMissing",
        "VocabTlsCertificateExpiring",
        "VocabTlsCertificateExpiringSoon",
        "VocabRunnerCanaryCollectorMissing",
        "VocabRunnerCanaryStale",
      ]),
    );

    const optionalRules = rules(load("optional-platform-alerting-rules.yaml"));
    const restoreWarning = optionalRules.find((rule) => rule.alert === "VocabRestoreDrillOverdue");
    const restoreCritical = optionalRules.find((rule) => rule.alert === "VocabRestoreDrillCriticallyOverdue");
    const restoreFailed = optionalRules.find((rule) => rule.alert === "VocabRestoreDrillFailed");
    expect(restoreWarning).toMatchObject({
      labels: { severity: "warning", alert_family: "restore-drill-freshness" },
    });
    expect(restoreWarning?.expr).toContain("> 3024000");
    expect(restoreCritical).toMatchObject({
      labels: { severity: "critical", alert_family: "restore-drill-freshness" },
    });
    expect(restoreCritical?.expr).toContain("> 3456000");
    expect(restoreFailed?.labels.alert_family).toBe("restore-drill-attempt");
    expect(restoreFailed?.expr).toContain("on (service, environment)");
    expect(optionalRules.find((rule) => rule.alert === "VocabBackupFailed")?.expr).toContain(
      "on (service, environment)",
    );
  });
});
