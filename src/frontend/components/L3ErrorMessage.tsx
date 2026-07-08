import type { NormalizedL3Error } from "@/l3/frontend/contract";

interface L3ErrorMessageProps {
  error: NormalizedL3Error | null;
}

export function L3ErrorMessage({ error }: L3ErrorMessageProps) {
  if (!error) return null;

  return (
    <div className={`l3-error l3-error-${error.kind}`} role="alert">
      <div>
        <strong>{error.status === 0 ? "Network" : `HTTP ${error.status}`}</strong>
        <span>{error.message}</span>
      </div>
      <p>Retry hint: {error.retryHint}</p>
      {error.fieldErrors ? (
        <ul>
          {Object.entries(error.fieldErrors).map(([field, messages]) => (
            <li key={field}>
              <strong>{field}</strong>: {messages.join("; ")}
            </li>
          ))}
        </ul>
      ) : null}
      {error.itemErrors ? (
        <ul>
          {error.itemErrors.map((item, index) => (
            <li key={`${item.itemId ?? item.ordinal ?? "item"}-${index}`}>
              {item.itemId ? `${item.itemId}: ` : ""}
              {item.field ? `${item.field}: ` : ""}
              {item.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
