import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isAlias, isMap, isPair, isScalar, parseAllDocuments, visit } from "yaml";

export type AlertingContractInput = { alertmanager: string; rules: string };
type Dict = Record<string, unknown>;
type AlertRule = { alert?: string; labels?: Record<string, string>; annotations?: Record<string, string> };
type RulesConfig = { groups?: Array<{ rules?: AlertRule[] }> };

const RECEIVER_NAMES = ["routing-contract-violation", "critical-primary", "critical-escalation", "warning-triage"];
const ROUTE_NAMES = ["critical-primary", "critical-escalation", "warning-triage"];
const ENVIRONMENT_MATCHER = 'environment=~"production|staging"';

function object(value: unknown): value is Dict {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Dict, allowed: readonly string[], path: string, errors: string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push(`${path} 包含未知字段 ${key}`);
}

function parseYaml<T>(source: string, label: string, errors: string[]): T | undefined {
  try {
    const documents = parseAllDocuments(source, { merge: false, uniqueKeys: true });
    if (documents.length !== 1) {
      errors.push(`${label} 必须且只能包含一个 YAML 文档`);
      return undefined;
    }
    const document = documents[0];
    if (!document || document.errors.length) {
      errors.push(`${label} 不是有效 YAML：${document?.errors.map((error) => error.message).join("; ") ?? "文档缺失"}`);
      return undefined;
    }
    let forbidden: string | undefined;
    visit(document, (_key, node) => {
      if (forbidden) return;
      if (isAlias(node)) forbidden = "alias";
      else if (object(node) && typeof node.anchor === "string" && node.anchor) forbidden = "anchor";
      else if (object(node) && typeof node.tag === "string" && !node.tag.startsWith("tag:yaml.org,2002:")) forbidden = "custom tag";
      else if (isPair(node) && isScalar(node.key) && node.key.value === "<<") forbidden = "merge key";
    });
    if (forbidden) {
      errors.push(`${label} 禁止使用 ${forbidden}`);
      return undefined;
    }
    if (!isMap(document.contents)) {
      errors.push(`${label} 根节点必须是映射对象`);
      return undefined;
    }
    return document.toJS({ mapAsMap: false }) as T;
  } catch (error) {
    errors.push(`${label} 解析失败：${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function validateRouteShape(route: unknown, path: string, child: boolean, errors: string[]): route is Dict {
  if (!object(route)) {
    errors.push(`${path} 必须是映射对象`);
    return false;
  }
  exactKeys(route, ["receiver", "matchers", "continue", "group_by", "group_wait", "group_interval", "repeat_interval", "routes"], path, errors);
  if (typeof route.receiver !== "string") errors.push(`${path}.receiver 必须是字符串`);
  for (const field of ["group_wait", "group_interval", "repeat_interval"])
    if (route[field] !== undefined && typeof route[field] !== "string") errors.push(`${path}.${field} 必须是字符串`);
  for (const field of ["matchers", "group_by"])
    if (route[field] !== undefined && (!Array.isArray(route[field]) || !(route[field] as unknown[]).every((item) => typeof item === "string"))) errors.push(`${path}.${field} 必须是字符串数组`);
  if (route.continue !== undefined && typeof route.continue !== "boolean") errors.push(`${path}.continue 必须是布尔值`);
  if (route.routes !== undefined && !Array.isArray(route.routes)) errors.push(`${path}.routes 必须是数组`);
  if (child && route.routes !== undefined) errors.push(`${path} 禁止嵌套路由`);
  return true;
}

function validateAlertmanager(value: unknown, errors: string[]): Dict | undefined {
  if (!object(value)) {
    errors.push("Alertmanager 配置根节点必须是映射对象");
    return undefined;
  }
  exactKeys(value, ["global", "route", "inhibit_rules", "receivers"], "Alertmanager 配置", errors);
  if (!object(value.global)) errors.push("global 必须是映射对象");
  else {
    exactKeys(value.global, ["resolve_timeout"], "global", errors);
    if (typeof value.global.resolve_timeout !== "string") errors.push("global.resolve_timeout 必须是字符串");
  }
  validateRouteShape(value.route, "route", false, errors);
  if (!Array.isArray(value.receivers)) errors.push("receivers 必须是数组");
  if (!Array.isArray(value.inhibit_rules)) errors.push("inhibit_rules 必须是数组");
  return value;
}

export function validateAlertingContract(input: AlertingContractInput): string[] {
  const errors: string[] = [];
  const rawConfig = parseYaml<unknown>(input.alertmanager, "Alertmanager 配置", errors);
  const rules = parseYaml<RulesConfig>(input.rules, "告警规则", errors);
  const config = validateAlertmanager(rawConfig, errors);
  if (!config || !rules) return errors;

  const root = object(config.route) ? config.route : {};
  if (root.receiver !== "routing-contract-violation") errors.push("根路由必须进入专用 routing-contract-violation 接收器");
  if (!Array.isArray(root.group_by) || root.group_by.join(",") !== "alertname,service,environment") errors.push("根路由必须按 alertname/service/environment 分组");
  if (root.continue !== undefined) errors.push("根路由不得设置 continue");

  const routes = Array.isArray(root.routes) ? root.routes : [];
  const routeNames = routes.map((route) => object(route) ? route.receiver : undefined);
  if (routeNames.length !== 3 || routeNames.some((name, index) => name !== ROUTE_NAMES[index])) errors.push("顶级子路由必须且只能按 critical-primary、critical-escalation、warning-triage 排列");
  routes.forEach((route, index) => validateRouteShape(route, `route.routes[${index}]`, true, errors));
  const [primary, escalation, warning] = routes.map((route) => object(route) ? route : {});
  if (primary?.continue !== true) errors.push("critical-primary 必须设置 continue: true");
  if (escalation?.continue !== undefined || warning?.continue !== undefined) errors.push("critical-escalation 与 warning-triage 不得设置 continue");
  for (const [route, severity] of [[primary, "critical"], [escalation, "critical"], [warning, "warning"]] as const) {
    if (!Array.isArray(route?.matchers) || route.matchers.length !== 2 || route.matchers[0] !== `severity="${severity}"` || route.matchers[1] !== ENVIRONMENT_MATCHER) errors.push(`路由 ${String(route?.receiver)} 必须仅含严格 severity/environment matcher`);
    if (typeof route?.group_wait !== "string" || typeof route.group_interval !== "string" || typeof route.repeat_interval !== "string") errors.push(`路由 ${String(route?.receiver)} 必须定义三个通知间隔`);
  }

  const receiverList = Array.isArray(config.receivers) ? config.receivers : [];
  const names = receiverList.map((receiver) => object(receiver) ? receiver.name : undefined);
  if (names.length !== 4 || names.some((name, index) => name !== RECEIVER_NAMES[index])) errors.push("receivers 必须且只能按合同定义四个接收器，禁止额外或重复接收器");
  receiverList.forEach((rawReceiver, index) => {
    const path = `receivers[${index}]`;
    if (!object(rawReceiver)) return errors.push(`${path} 必须是映射对象`);
    exactKeys(rawReceiver, ["name", "webhook_configs"], path, errors);
    if (typeof rawReceiver.name !== "string") errors.push(`${path}.name 必须是字符串`);
    if (!Array.isArray(rawReceiver.webhook_configs) || rawReceiver.webhook_configs.length !== 1) return errors.push(`${path} 必须且只能配置一个 webhook_config`);
    const webhook = rawReceiver.webhook_configs[0];
    if (!object(webhook)) return errors.push(`${path}.webhook_configs[0] 必须是映射对象`);
    exactKeys(webhook, ["url_file", "send_resolved"], `${path}.webhook_configs[0]`, errors);
    if (typeof webhook.url_file !== "string" || !/^\/run\/secrets\/[a-z0-9_-]+$/.test(webhook.url_file)) errors.push(`${path} 仅可通过 /run/secrets 下的 url_file 注入地址`);
    if (webhook.send_resolved !== true) errors.push(`${path}.send_resolved 必须是布尔 true`);
  });

  const inhibit = Array.isArray(config.inhibit_rules) ? config.inhibit_rules : [];
  const rule = inhibit[0];
  if (inhibit.length !== 1 || !object(rule)) errors.push("必须且只能定义一条抑制规则");
  else {
    exactKeys(rule, ["source_matchers", "target_matchers", "equal"], "inhibit_rules[0]", errors);
    if (!Array.isArray(rule.source_matchers) || rule.source_matchers.join(",") !== 'severity="critical"' || !Array.isArray(rule.target_matchers) || rule.target_matchers.join(",") !== 'severity="warning"' || !Array.isArray(rule.equal) || rule.equal.join(",") !== "alert_family,service,environment,component") errors.push("抑制仅可由同 alert_family/service/environment/component 的 critical 隐藏 warning");
  }

  const alertRules = (Array.isArray(rules.groups) ? rules.groups : []).flatMap((group) => Array.isArray(group.rules) ? group.rules : []).filter((alert) => alert.alert);
  if (!alertRules.length) errors.push("告警规则文件中没有 alert 路由目标");
  for (const alert of alertRules) {
    const name = alert.alert ?? "<unknown>";
    if (!/^(?:critical|warning)$/.test(alert.labels?.severity ?? "")) errors.push(`${name} 缺少受支持的 severity 标签`);
    for (const label of ["service", "component", "alert_family"]) if (!alert.labels?.[label]) errors.push(`${name} 缺少 ${label} 标签`);
    if (!alert.annotations?.runbook_url) errors.push(`${name} 缺少 annotations.runbook_url`);
  }
  const byName = new Map(alertRules.map((alert) => [alert.alert, alert]));
  for (const [warningName, criticalName] of [["VocabHttpErrorBudgetBurnSlow", "VocabHttpErrorBudgetBurnFast"], ["VocabTlsCertificateExpiring", "VocabTlsCertificateExpiringSoon"], ["VocabRestoreDrillOverdue", "VocabRestoreDrillCriticallyOverdue"]]) {
    const warningAlert = byName.get(warningName), criticalAlert = byName.get(criticalName);
    if (!warningAlert && !criticalAlert) continue;
    if (!warningAlert || !criticalAlert || warningAlert.labels?.severity !== "warning" || criticalAlert.labels?.severity !== "critical" || warningAlert.labels?.alert_family !== criticalAlert.labels?.alert_family || warningAlert.labels?.component !== criticalAlert.labels?.component || warningAlert.labels?.service !== criticalAlert.labels?.service) errors.push(`${warningName}/${criticalName} 必须以相同 service/component/alert_family 配对 warning→critical`);
  }
  return errors;
}

if (process.argv[1]?.endsWith("verify-alerting-contract.ts")) {
  const root = resolve(import.meta.dirname, "..");
  const alertmanager = readFileSync(resolve(root, "docs/operations/alertmanager.yaml"), "utf8");
  const errors = ["alerting-rules.yaml", "optional-platform-alerting-rules.yaml"].flatMap((file) => validateAlertingContract({ alertmanager, rules: readFileSync(resolve(root, "docs/operations", file), "utf8") }));
  if (errors.length) { console.error(errors.map((error) => `- ${error}`).join("\n")); process.exitCode = 1; }
  else console.log("Alertmanager 路由与告警规则合同验证通过");
}
