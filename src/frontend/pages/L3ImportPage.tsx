import type { L3FrontendClient } from "@/l3/frontend/contract";

interface L3ImportPageProps {
  client: L3FrontendClient;
}

export function L3ImportPage({ client }: L3ImportPageProps) {
  return (
    <section className="l3-page">
      <p className="eyebrow">Import Placeholder</p>
      <h2>Raw and structured imports create proposals, not active L3.</h2>
      <p className="lede">
        Phase 4C can wire this skeleton to <code>client.createRawTextImport</code> and <code>client.createStructuredImport</code>.
      </p>
      <div className="form-skeleton" aria-label="Raw import skeleton">
        <label>
          Source title
          <input readOnly value="Manual note" />
        </label>
        <label>
          Raw text
          <textarea readOnly value="Paste context text here in Phase 4C." />
        </label>
        <button disabled type="button">Submit import in Phase 4C</button>
      </div>
      <p className="contract-note">Client methods available: {typeof client.createRawTextImport === "function" ? "contract wired" : "missing"}</p>
    </section>
  );
}
