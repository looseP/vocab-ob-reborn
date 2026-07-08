import {
  canNavigate,
  type L3NavigationAction,
  type L3NavigationIntent,
} from "../viewModels/l3NavigationViewModel";

interface L3NavigationActionsProps {
  actions: L3NavigationAction[];
  onNavigate(intent: L3NavigationIntent): void;
}

export function L3NavigationActions({ actions, onNavigate }: L3NavigationActionsProps) {
  if (actions.length === 0) return null;

  return (
    <div className="navigation-actions">
      {actions.map((action) => (
        <span className={canNavigate(action) ? "navigation-action" : "navigation-action disabled"} key={`${action.label}-${action.reason ?? "ready"}`}>
          <button
            disabled={!canNavigate(action)}
            onClick={() => action.intent && onNavigate(action.intent)}
            type="button"
          >
            {action.label}
          </button>
          {action.reason ? <small>{action.reason}</small> : null}
        </span>
      ))}
    </div>
  );
}
