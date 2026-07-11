import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { validateAlertingContract } from "../../scripts/verify-alerting-contract.js";

const root = resolve(import.meta.dirname, "../..");
const template = readFileSync(resolve(root, "docs/operations/alertmanager.yaml"), "utf8");
const validRules = `
groups:
  - name: contract
    rules:
      - alert: ExampleCritical
        expr: vector(1)
        labels:
          severity: critical
          service: vocab_observatory
          component: api
          alert_family: example
        annotations:
          runbook_url: https://runbooks.invalid/example
`;

function errors(alertmanager = template, rules = validRules): string[] {
  return validateAlertingContract({ alertmanager, rules });
}

describe("Alertmanager 路由合同", () => {
  it("接受安全模板、升级路由、隔离 warning 和严格抑制", () => {
    expect(errors()).toEqual([]);
  });

  it.each([
    ["真实 webhook", template.replace("url_file: /run/secrets/alertmanager_routing_contract_violation_webhook_url", "url: https://hooks.example.test/real-token")],
    ["默认 blackhole", template.replace("receiver: routing-contract-violation", "receiver: blackhole")],
    ["宽泛 matcher", template.replace('environment=~"production|staging"', 'environment=~".*"')],
    ["关闭恢复通知", template.replace("send_resolved: true", "send_resolved: false")],
    ["缺少升级", template.replace("critical-escalation", "critical-secondary")],
  ])("拒绝%s", (_name, config) => {
    expect(errors(config)).not.toEqual([]);
  });

  it("拒绝缺 runbook、service 或可路由 severity 的规则", () => {
    const invalid = validRules
      .replace("severity: critical", "team: platform")
      .replace("service: vocab_observatory", "owner: operations")
      .replace("component: api", "subsystem: api")
      .replace("alert_family: example", "family: example")
      .replace("runbook_url: https://runbooks.invalid/example", "description: missing");
    const result = errors(template, invalid).join("\n");
    expect(result).toContain("severity");
    expect(result).toContain("service");
    expect(result).toContain("component");
    expect(result).toContain("alert_family");
    expect(result).toContain("runbook_url");
  });

  it("拒绝可跨环境、跨 component 或隐藏 critical 的抑制", () => {
    const variants = [
      template.replace('    target_matchers:\n      - severity="warning"', '    target_matchers:\n      - severity="critical"'),
      template.replace("equal: [alert_family, service, environment, component]", "equal: [alert_family, service, component]"),
      template.replace("equal: [alert_family, service, environment, component]", "equal: [alert_family, service, environment]"),
    ];
    for (const config of variants) expect(errors(config).join("\n")).toContain("抑制");
  });

  it("注释或路由中的同名文本不能伪造 receiver 定义", () => {
    const receiverBlock = `  - name: critical-escalation\n    webhook_configs:\n      - url_file: /run/secrets/alertmanager_critical_escalation_webhook_url\n        send_resolved: true\n`;
    const config = template
      .replace(receiverBlock, "")
      .replace("# Safe template only.", "# Safe template only. name: critical-escalation");
    expect(errors(config).join("\n")).toContain("receivers 必须且只能");
  });

  it("缺环境标签或未知环境只会落到专用合同违规接收器", () => {
    expect(template).toContain("receiver: routing-contract-violation");
    expect(template).not.toContain("name: operations-triage");
    expect(errors()).toEqual([]);
  });

  it.each([
    ["前置截流", template.replace("  routes:\n", "  routes:\n    - receiver: warning-triage\n      matchers: []\n")],
    ["嵌套路由", template.replace("      continue: true", "      continue: true\n      routes: []")],
    ["额外外泄 receiver", `${template}\n  - name: exfiltration\n    webhook_configs:\n      - url_file: /run/secrets/exfiltration\n        send_resolved: true\n`],
    ["重复 receiver", template.replace("  - name: warning-triage", "  - name: critical-primary")],
    ["未知 route 字段", template.replace("      group_wait: 10s", "      group_wait: 10s\n      mute_time_intervals: [night]")],
    ["未知 receiver 字段", template.replace("  - name: critical-primary", "  - name: critical-primary\n    slack_configs: []")],
    ["未知 webhook 字段", template.replace("        send_resolved: true", "        send_resolved: true\n        max_alerts: 0")],
    ["非布尔 send_resolved", template.replace("send_resolved: true", 'send_resolved: "true"')],
    ["多个 webhook", template.replace("      - url_file: /run/secrets/alertmanager_critical_primary_webhook_url\n        send_resolved: true", "      - url_file: /run/secrets/alertmanager_critical_primary_webhook_url\n        send_resolved: true\n      - url_file: /run/secrets/second\n        send_resolved: true")],
    ["多 YAML 文档", `${template}\n---\nroute: {}`],
    ["alias/merge", template.replace("global:\n  resolve_timeout: 5m", "defaults: &defaults\n  resolve_timeout: 5m\nglobal:\n  <<: *defaults")],
    ["未知顶层字段", `${template}\ntemplates: []\n`],
  ])("拒绝结构绕过：%s", (_name, config) => {
    expect(errors(config)).not.toEqual([]);
  });

  it("要求 Fast/Slow 同 family/component 配对，跨 component 不会抑制", () => {
    const pair = `${validRules}\n      - alert: VocabHttpErrorBudgetBurnSlow\n        labels:\n          severity: warning\n          service: vocab_observatory\n          component: api\n          alert_family: http-error-budget\n        annotations:\n          runbook_url: runbook\n      - alert: VocabHttpErrorBudgetBurnFast\n        labels:\n          severity: critical\n          service: vocab_observatory\n          component: api\n          alert_family: http-error-budget\n        annotations:\n          runbook_url: runbook\n`;
    expect(errors(template, pair)).toEqual([]);
    expect(errors(template, pair.replace("component: api\n          alert_family: http-error-budget\n        annotations:\n          runbook_url: runbook\n", "component: worker\n          alert_family: http-error-budget\n        annotations:\n          runbook_url: runbook\n")).join("\n")).toContain("配对");
  });
});
