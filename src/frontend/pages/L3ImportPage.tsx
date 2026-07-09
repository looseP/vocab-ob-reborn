import { useState, type FormEvent } from "react";
import { L3ErrorMessage } from "../components/L3ErrorMessage";
import {
  applyImportSuccess,
  isNormalizedL3Error,
  normalizeL3TransportError,
  type L3FrontendClient,
  type L3ImportFlowState,
  type L3ImportProposalResponse,
  type L3RawTextImportInput,
  type NormalizedL3Error,
} from "@/l3/frontend/contract";
import { buildRawTextImportPayload, summarizeImportProposalItem } from "../viewModels/l3ImportViewModel";

interface L3ImportPageProps {
  client: L3FrontendClient;
  onOpenProposal(proposalId: string): void;
  onOpenProposalQueue(): void;
}

const sourceTypes: L3RawTextImportInput["source"]["sourceType"][] = ["manual", "article", "book", "video", "audio", "chat", "web", "other"];

function proposalIdFromResult(result: L3ImportProposalResponse | null): string | null {
  return typeof result?.proposal.id === "string" ? result.proposal.id : null;
}

function normalizeUnknownError(error: unknown): NormalizedL3Error {
  return isNormalizedL3Error(error) ? error : normalizeL3TransportError(error);
}

export function L3ImportPage({ client, onOpenProposal, onOpenProposalQueue }: L3ImportPageProps) {
  const [sourceTitle, setSourceTitle] = useState("Manual note");
  const [sourceType, setSourceType] = useState<L3RawTextImportInput["source"]["sourceType"]>("manual");
  const [sourceLanguage, setSourceLanguage] = useState("en");
  const [wordbookId, setWordbookId] = useState("");
  const [text, setText] = useState("");
  const [targetWords, setTargetWords] = useState("");
  const [contextType, setContextType] = useState<"sentence" | "paragraph">("sentence");
  const [flowState, setFlowState] = useState<L3ImportFlowState>("editing");
  const [result, setResult] = useState<L3ImportProposalResponse | null>(null);
  const [error, setError] = useState<NormalizedL3Error | null>(null);

  const proposalId = proposalIdFromResult(result);
  const canSubmit = flowState !== "submitting";

  const submitImport = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setResult(null);

    let payload: L3RawTextImportInput;
    try {
      payload = buildRawTextImportPayload({
        sourceTitle,
        sourceType,
        sourceLanguage,
        wordbookId,
        text,
        targetWords,
        contextType,
      });
    } catch (caught) {
      setError(normalizeUnknownError(caught));
      setFlowState("submitFailed");
      return;
    }

    setFlowState("submitting");
    try {
      const data = await client.createRawTextImport(payload);
      const transition = applyImportSuccess(data);
      setResult(transition.data);
      setFlowState(transition.nextState as L3ImportFlowState);
    } catch (caught) {
      setError(normalizeUnknownError(caught));
      setFlowState("submitFailed");
    }
  };

  return (
    <section className="l3-page">
      <p className="eyebrow">Raw Import</p>
      <h2>Submit raw context text into a pending proposal.</h2>
      <p className="lede">Import creates an import job and proposal preview only. Active L3 changes wait for proposal confirmation.</p>
      <form className="l3-form" onSubmit={submitImport}>
        <label>
          Source title
          <input onChange={(event) => setSourceTitle(event.target.value)} required value={sourceTitle} />
        </label>
        <div className="form-row">
          <label>
            Source type
            <select onChange={(event) => setSourceType(event.target.value as L3RawTextImportInput["source"]["sourceType"])} value={sourceType}>
              {sourceTypes.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <label>
            Language
            <input onChange={(event) => setSourceLanguage(event.target.value)} value={sourceLanguage} />
          </label>
        </div>
        <label>
          Wordbook id (optional)
          <input onChange={(event) => setWordbookId(event.target.value)} placeholder="wordbook id" value={wordbookId} />
        </label>
        <label>
          Raw text
          <textarea onChange={(event) => setText(event.target.value)} placeholder="Paste sentence or paragraph context text." required value={text} />
        </label>
        <label>
          Target words
          <textarea
            className="compact-textarea"
            onChange={(event) => setTargetWords(event.target.value)}
            placeholder="comma or newline separated slugs"
            value={targetWords}
          />
        </label>
        <label>
          Context parsing
          <select onChange={(event) => setContextType(event.target.value as "sentence" | "paragraph")} value={contextType}>
            <option value="sentence">sentence</option>
            <option value="paragraph">paragraph</option>
          </select>
        </label>
        <button disabled={!canSubmit} type="submit">
          {flowState === "submitting" ? "Submitting..." : "Create proposal"}
        </button>
      </form>

      <L3ErrorMessage error={error} />

      {result ? (
        <div className="l3-result-panel">
          <div>
            <p className="eyebrow">Pending Proposal Created</p>
            <h3>{result.proposal.title ?? result.proposal.id ?? "Untitled proposal"}</h3>
            <span>No active L3 source, context, occurrence, or link has been written.</span>
          </div>
          <dl className="result-meta">
            <div>
              <dt>Import job</dt>
              <dd>{result.importJob.id ?? "unknown"} / {result.importJob.status ?? "unknown"}</dd>
            </div>
            <div>
              <dt>Proposal</dt>
              <dd>{result.proposal.id ?? "unknown"} / {result.proposal.status ?? "unknown"}</dd>
            </div>
          </dl>
          <dl className="stats-grid">
            <div>
              <dt>Contexts</dt>
              <dd>{result.parseStats.contextCount}</dd>
            </div>
            <div>
              <dt>Occurrences</dt>
              <dd>{result.parseStats.occurrenceCount}</dd>
            </div>
            <div>
              <dt>Links</dt>
              <dd>{result.parseStats.linkCount}</dd>
            </div>
            <div>
              <dt>Skipped</dt>
              <dd>{result.parseStats.skippedContextCount}</dd>
            </div>
          </dl>
          {result.parseStats.warnings.length > 0 ? (
            <ul className="warning-list">
              {result.parseStats.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
          <div className="proposal-preview-list">
            {result.items.slice(0, 5).map((item, index) => (
              <code key={index}>{summarizeImportProposalItem(item, index)}</code>
            ))}
          </div>
          <div className="action-row">
            <button disabled={!proposalId} onClick={() => proposalId && onOpenProposal(proposalId)} type="button">
              Open proposal review
            </button>
            <button onClick={onOpenProposalQueue} type="button">
              Back to proposal queue
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
