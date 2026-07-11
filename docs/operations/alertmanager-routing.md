# Alertmanager routing contract

`alertmanager.yaml` is a safe repository template, not a deployable secret bundle.

## Deployment boundary

- Provision each `/run/secrets/alertmanager_*_webhook_url` file from the environment's secret manager. Each file contains exactly one receiver URL and is readable only by Alertmanager.
- Never commit receiver URLs, API keys, bearer tokens, chat channel identifiers, or copied production configuration. Do not convert `url_file` to inline `url`.
- Render only environment identity outside the template. Every alert sent to this Alertmanager must carry `environment=production` or `environment=staging`; development alerts use a separate non-production Alertmanager.
- Validate the rendered config with `amtool check-config` in the deployment pipeline, then run `npm run alerting:verify` before rollout.

## Routing behavior

- The root receiver is the dedicated `routing-contract-violation` destination, never a business triage route or blackhole. Only alerts missing/violating `environment` or `severity` reach it; operators treat each notification as a labeling/configuration defect, not as successful business-alert delivery.
- `critical` reaches the primary receiver quickly and continues to the escalation receiver. `warning` has its own triage route and slower grouping/repeat cadence.
- Every receiver sends resolved notifications. A notification system must treat delivery failures as failures; a `2xx` from a discard endpoint is not acceptable.
- Grouping includes `alertname`, `service`, and `environment`, preventing unrelated services or environments from sharing an incident notification.
- A critical alert inhibits only a warning with the same `alert_family`, `service`, `environment`, and `component`. `alert_family` deliberately links fast/slow burn alerts whose alert names differ. Warning can never inhibit critical; distinct components or environments cannot suppress one another. Do not use optional `instance` as an inhibition identity.

## Rule contract

Every alert must provide `severity` (`critical` or `warning`), `service`, `component`, `alert_family`, and `annotations.runbook_url`. The runbook must identify diagnosis, mitigation, escalation owner, and recovery verification. Run the static contract test whenever rules or routing change:

```sh
npm run alerting:verify
npm run alerting:contract
```
