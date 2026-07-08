import { useState, type FormEvent } from "react";
import { L3ErrorMessage } from "../components/L3ErrorMessage";
import { L3NavigationActions } from "../components/L3NavigationActions";
import type { L3SourceRow, L3ContextRow, L3OccurrenceRow, L3ContextLinkRow } from "@/domain";
import {
  isNormalizedL3Error,
  normalizeL3TransportError,
  type L3FrontendClient,
  type NormalizedL3Error,
} from "@/l3/frontend/contract";
import {
  buildManualContextCreateInput,
  buildManualContextLinkCreateInput,
  buildManualOccurrenceCreateInput,
  buildManualSourceCreateInput,
  canSubmitManualCreate,
  findExactSurfaceMatches,
  initialManualContextFormState,
  initialManualContextLinkFormState,
  initialManualOccurrenceFormState,
  initialManualSourceFormState,
  manualContextTypes,
  manualCreateSuccessActions,
  manualLinkTypes,
  manualSourceTypes,
  manualTargetTypes,
  type ManualContextFormState,
  type ManualContextLinkFormState,
  type ManualCreateStatus,
  type ManualOccurrenceFormState,
  type ManualSourceFormState,
} from "../viewModels/l3ManualEditorViewModel";
import type { L3NavigationIntent } from "../viewModels/l3NavigationViewModel";

interface L3ManualEditorPageProps {
  client: L3FrontendClient;
  onManualCreated(reason?: string): void;
  onNavigate(intent: L3NavigationIntent): void;
}

function normalizeUnknownError(error: unknown): NormalizedL3Error {
  return isNormalizedL3Error(error) ? error : normalizeL3TransportError(error);
}

function createdId(value: { id?: string } | null): string | null {
  return value?.id ?? null;
}

export function L3ManualEditorPage({ client, onManualCreated, onNavigate }: L3ManualEditorPageProps) {
  const [sourceForm, setSourceForm] = useState<ManualSourceFormState>(() => initialManualSourceFormState());
  const [contextForm, setContextForm] = useState<ManualContextFormState>(() => initialManualContextFormState());
  const [occurrenceForm, setOccurrenceForm] = useState<ManualOccurrenceFormState>(() => initialManualOccurrenceFormState());
  const [linkForm, setLinkForm] = useState<ManualContextLinkFormState>(() => initialManualContextLinkFormState());
  const [sourceStatus, setSourceStatus] = useState<ManualCreateStatus>("editing");
  const [contextStatus, setContextStatus] = useState<ManualCreateStatus>("editing");
  const [occurrenceStatus, setOccurrenceStatus] = useState<ManualCreateStatus>("editing");
  const [linkStatus, setLinkStatus] = useState<ManualCreateStatus>("editing");
  const [source, setSource] = useState<L3SourceRow | null>(null);
  const [context, setContext] = useState<L3ContextRow | null>(null);
  const [occurrence, setOccurrence] = useState<L3OccurrenceRow | null>(null);
  const [link, setLink] = useState<L3ContextLinkRow | null>(null);
  const [error, setError] = useState<NormalizedL3Error | null>(null);

  const successActions = manualCreateSuccessActions({
    sourceId: createdId(source) ?? context?.source_id ?? null,
    contextId: createdId(context) ?? occurrence?.context_id ?? link?.context_id ?? null,
    slug: occurrenceForm.slug.trim() || null,
    wordbookId: sourceForm.wordbookId.trim() || source?.wordbook_id || null,
    linkTarget: link
      ? {
        targetType: link.target_type,
        targetId: link.target_id,
        targetRef: link.target_ref && typeof link.target_ref === "object" && !Array.isArray(link.target_ref)
          ? link.target_ref as Record<string, unknown>
          : {},
      }
      : null,
  });
  const surfaceMatches = findExactSurfaceMatches(occurrenceForm.contextText, occurrenceForm.surface);

  const submitSource = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmitManualCreate(sourceStatus)) return;
    setError(null);
    setSourceStatus("submitting");
    try {
      const result = await client.createSource(buildManualSourceCreateInput(sourceForm));
      setSource(result.source);
      setContextForm((current) => ({ ...current, sourceId: result.source.id || current.sourceId }));
      onManualCreated("manual_source_created_active_l3");
      setSourceStatus("created");
    } catch (caught) {
      setError(normalizeUnknownError(caught));
      setSourceStatus("failed");
    }
  };

  const submitContext = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmitManualCreate(contextStatus)) return;
    setError(null);
    setContextStatus("submitting");
    try {
      const result = await client.createContext(buildManualContextCreateInput(contextForm));
      setContext(result.context);
      setOccurrenceForm((current) => ({ ...current, contextId: result.context.id || current.contextId, contextText: result.context.text || current.contextText }));
      setLinkForm((current) => ({ ...current, contextId: result.context.id || current.contextId }));
      onManualCreated("manual_context_created_active_l3");
      setContextStatus("created");
    } catch (caught) {
      setError(normalizeUnknownError(caught));
      setContextStatus("failed");
    }
  };

  const submitOccurrence = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmitManualCreate(occurrenceStatus)) return;
    setError(null);
    setOccurrenceStatus("submitting");
    try {
      const result = await client.createOccurrence(buildManualOccurrenceCreateInput(occurrenceForm));
      setOccurrence(result.occurrence);
      onManualCreated("manual_occurrence_created_active_l3");
      setOccurrenceStatus("created");
    } catch (caught) {
      setError(normalizeUnknownError(caught));
      setOccurrenceStatus("failed");
    }
  };

  const submitLink = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmitManualCreate(linkStatus)) return;
    setError(null);
    setLinkStatus("submitting");
    try {
      const result = await client.createContextLink(buildManualContextLinkCreateInput(linkForm));
      setLink(result.link);
      onManualCreated("manual_context_link_created_active_l3");
      setLinkStatus("created");
    } catch (caught) {
      setError(normalizeUnknownError(caught));
      setLinkStatus("failed");
    }
  };

  const useFirstSurfaceMatch = () => {
    if (surfaceMatches.status !== "one") return;
    const match = surfaceMatches.candidates[0];
    setOccurrenceForm((current) => ({
      ...current,
      startOffset: String(match.startOffset),
      endOffset: String(match.endOffset),
    }));
  };

  return (
    <section className="l3-page manual-editor-page">
      <p className="eyebrow">Manual Editor</p>
      <h2>Create active L3 rows with explicit single-record commands.</h2>
      <p className="lede">This page writes active L3 directly for trusted manual creates only. Bulk, import, recommendation, agent, and external content still require proposal review.</p>

      <L3ErrorMessage error={error} />

      <div className="manual-editor-grid">
        <form className="l3-form manual-card" onSubmit={submitSource}>
          <header>
            <p className="eyebrow">Step 1</p>
            <h3>Source</h3>
            <span>Status: {sourceStatus}</span>
          </header>
          <label>
            Source type
            <select onChange={(event) => setSourceForm({ ...sourceForm, sourceType: event.target.value as ManualSourceFormState["sourceType"] })} value={sourceForm.sourceType}>
              {manualSourceTypes.map((type) => <option key={type} value={type}>{type}</option>)}
            </select>
          </label>
          <label>
            Title
            <input onChange={(event) => setSourceForm({ ...sourceForm, title: event.target.value })} value={sourceForm.title} />
          </label>
          <div className="form-row">
            <label>
              Wordbook id
              <input onChange={(event) => setSourceForm({ ...sourceForm, wordbookId: event.target.value })} value={sourceForm.wordbookId} />
            </label>
            <label>
              Language
              <input onChange={(event) => setSourceForm({ ...sourceForm, language: event.target.value })} value={sourceForm.language} />
            </label>
          </div>
          <div className="form-row">
            <label>
              Author
              <input onChange={(event) => setSourceForm({ ...sourceForm, author: event.target.value })} value={sourceForm.author} />
            </label>
            <label>
              URL
              <input onChange={(event) => setSourceForm({ ...sourceForm, url: event.target.value })} value={sourceForm.url} />
            </label>
          </div>
          <label>
            Metadata JSON
            <textarea className="compact-textarea" onChange={(event) => setSourceForm({ ...sourceForm, metadataJson: event.target.value })} value={sourceForm.metadataJson} />
          </label>
          <button disabled={!canSubmitManualCreate(sourceStatus)} type="submit">{sourceStatus === "submitting" ? "Creating..." : "Create source"}</button>
          {source ? <code>Created source: {source.id}</code> : null}
        </form>

        <form className="l3-form manual-card" onSubmit={submitContext}>
          <header>
            <p className="eyebrow">Step 2</p>
            <h3>Context</h3>
            <span>Status: {contextStatus}</span>
          </header>
          <label>
            Source id
            <input onChange={(event) => setContextForm({ ...contextForm, sourceId: event.target.value })} value={contextForm.sourceId} />
          </label>
          <label>
            Context type
            <select onChange={(event) => setContextForm({ ...contextForm, contextType: event.target.value as ManualContextFormState["contextType"] })} value={contextForm.contextType}>
              {manualContextTypes.map((type) => <option key={type} value={type}>{type}</option>)}
            </select>
          </label>
          <label>
            Text
            <textarea onChange={(event) => setContextForm({ ...contextForm, text: event.target.value })} value={contextForm.text} />
          </label>
          <div className="form-row">
            <label>
              Normalized text
              <input onChange={(event) => setContextForm({ ...contextForm, normalizedText: event.target.value })} value={contextForm.normalizedText} />
            </label>
            <label>
              Language
              <input onChange={(event) => setContextForm({ ...contextForm, language: event.target.value })} value={contextForm.language} />
            </label>
          </div>
          <label>
            Position JSON
            <textarea className="compact-textarea" onChange={(event) => setContextForm({ ...contextForm, positionJson: event.target.value })} value={contextForm.positionJson} />
          </label>
          <label>
            Metadata JSON
            <textarea className="compact-textarea" onChange={(event) => setContextForm({ ...contextForm, metadataJson: event.target.value })} value={contextForm.metadataJson} />
          </label>
          <button disabled={!canSubmitManualCreate(contextStatus)} type="submit">{contextStatus === "submitting" ? "Creating..." : "Create context"}</button>
          {context ? <code>Created context: {context.id}</code> : null}
        </form>

        <form className="l3-form manual-card" onSubmit={submitOccurrence}>
          <header>
            <p className="eyebrow">Step 3</p>
            <h3>Occurrence</h3>
            <span>Status: {occurrenceStatus}</span>
          </header>
          <label>
            Context id
            <input onChange={(event) => setOccurrenceForm({ ...occurrenceForm, contextId: event.target.value })} value={occurrenceForm.contextId} />
          </label>
          <div className="form-row">
            <label>
              Word id
              <input onChange={(event) => setOccurrenceForm({ ...occurrenceForm, wordId: event.target.value })} value={occurrenceForm.wordId} />
            </label>
            <label>
              Slug
              <input onChange={(event) => setOccurrenceForm({ ...occurrenceForm, slug: event.target.value })} value={occurrenceForm.slug} />
            </label>
          </div>
          <label>
            Surface
            <input onChange={(event) => setOccurrenceForm({ ...occurrenceForm, surface: event.target.value })} value={occurrenceForm.surface} />
          </label>
          <label>
            Context text helper
            <textarea className="compact-textarea" onChange={(event) => setOccurrenceForm({ ...occurrenceForm, contextText: event.target.value })} value={occurrenceForm.contextText} />
          </label>
          <div className="surface-helper">
            <span>Exact matches: {surfaceMatches.candidates.length} ({surfaceMatches.status})</span>
            <button disabled={surfaceMatches.status !== "one"} onClick={useFirstSurfaceMatch} type="button">Use unique match</button>
          </div>
          {surfaceMatches.status === "multiple" ? (
            <ul className="warning-list">
              {surfaceMatches.candidates.map((match) => (
                <li key={`${match.startOffset}-${match.endOffset}`}>{match.startOffset}-{match.endOffset}: {match.preview}</li>
              ))}
            </ul>
          ) : null}
          <div className="form-row">
            <label>
              Start offset
              <input onChange={(event) => setOccurrenceForm({ ...occurrenceForm, startOffset: event.target.value })} value={occurrenceForm.startOffset} />
            </label>
            <label>
              End offset
              <input onChange={(event) => setOccurrenceForm({ ...occurrenceForm, endOffset: event.target.value })} value={occurrenceForm.endOffset} />
            </label>
          </div>
          <div className="form-row">
            <label>
              Lemma
              <input onChange={(event) => setOccurrenceForm({ ...occurrenceForm, lemma: event.target.value })} value={occurrenceForm.lemma} />
            </label>
            <label>
              Confidence
              <input onChange={(event) => setOccurrenceForm({ ...occurrenceForm, confidence: event.target.value })} value={occurrenceForm.confidence} />
            </label>
          </div>
          <label>
            Evidence JSON
            <textarea className="compact-textarea" onChange={(event) => setOccurrenceForm({ ...occurrenceForm, evidenceJson: event.target.value })} value={occurrenceForm.evidenceJson} />
          </label>
          <button disabled={!canSubmitManualCreate(occurrenceStatus)} type="submit">{occurrenceStatus === "submitting" ? "Creating..." : "Create occurrence"}</button>
          {occurrence ? <code>Created occurrence: {occurrence.id}</code> : null}
        </form>

        <form className="l3-form manual-card" onSubmit={submitLink}>
          <header>
            <p className="eyebrow">Step 4</p>
            <h3>Context Link</h3>
            <span>Status: {linkStatus}</span>
          </header>
          <div className="form-row">
            <label>
              Context id
              <input onChange={(event) => setLinkForm({ ...linkForm, contextId: event.target.value })} value={linkForm.contextId} />
            </label>
            <label>
              Anchor word id
              <input onChange={(event) => setLinkForm({ ...linkForm, wordId: event.target.value })} value={linkForm.wordId} />
            </label>
          </div>
          <div className="form-row">
            <label>
              Link type
              <select onChange={(event) => setLinkForm({ ...linkForm, linkType: event.target.value as ManualContextLinkFormState["linkType"] })} value={linkForm.linkType}>
                {manualLinkTypes.map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
            </label>
            <label>
              Target type
              <select onChange={(event) => setLinkForm({ ...linkForm, targetType: event.target.value as ManualContextLinkFormState["targetType"] })} value={linkForm.targetType}>
                {manualTargetTypes.map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
            </label>
          </div>
          <label>
            Target id
            <input onChange={(event) => setLinkForm({ ...linkForm, targetId: event.target.value })} value={linkForm.targetId} />
          </label>
          <label>
            Target ref JSON
            <textarea className="compact-textarea" onChange={(event) => setLinkForm({ ...linkForm, targetRefJson: event.target.value })} value={linkForm.targetRefJson} />
          </label>
          <div className="form-row">
            <label>
              Confidence
              <input onChange={(event) => setLinkForm({ ...linkForm, confidence: event.target.value })} value={linkForm.confidence} />
            </label>
            <label>
              Provenance JSON
              <textarea className="compact-textarea" onChange={(event) => setLinkForm({ ...linkForm, provenanceJson: event.target.value })} value={linkForm.provenanceJson} />
            </label>
          </div>
          <button disabled={!canSubmitManualCreate(linkStatus)} type="submit">{linkStatus === "submitting" ? "Creating..." : "Create link"}</button>
          {link ? <code>Created link: {link.id}</code> : null}
        </form>
      </div>

      <div className="l3-result-panel">
        <div>
          <p className="eyebrow">Follow-up</p>
          <h3>Open updated read surfaces</h3>
          <span>Manual create success marks active read data stale; refresh the relevant read page to consume it.</span>
        </div>
        <L3NavigationActions actions={successActions} onNavigate={onNavigate} />
      </div>
    </section>
  );
}
