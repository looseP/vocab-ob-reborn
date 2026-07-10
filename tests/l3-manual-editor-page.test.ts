/// <reference lib="dom" />
// @vitest-environment jsdom

import { createElement, type ReactElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent } from "@testing-library/dom";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error -- importing the component under test from a tsx module in a ts test
import { L3ManualEditorPage } from "@/frontend/pages/L3ManualEditorPage";
import { normalizeL3Error, type L3FrontendClient, type L3ManualDeleteResponse } from "@/l3/frontend/contract";

type DeleteMethodName = "deleteOccurrence" | "deleteContextLink" | "deleteSource" | "deleteContext";

interface RenderedPage {
  container: HTMLDivElement;
  root: Root;
  onManualChanged: ReturnType<typeof vi.fn>;
  onNavigate: ReturnType<typeof vi.fn>;
}

interface ManualDeleteClientStub {
  client: L3FrontendClient;
  deleteOccurrence: ReturnType<typeof vi.fn>;
  deleteContextLink: ReturnType<typeof vi.fn>;
  deleteSource: ReturnType<typeof vi.fn>;
  deleteContext: ReturnType<typeof vi.fn>;
}

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: RenderedPage[] = [];

afterEach(() => {
  act(() => {
    for (const mounted of mountedRoots.splice(0)) {
      mounted.root.unmount();
    }
  });
  document.body.innerHTML = "";
});

function makeManualDeleteClientStub(response: L3ManualDeleteResponse): ManualDeleteClientStub {
  const deleteOccurrence = vi.fn(async () => response);
  const deleteContextLink = vi.fn(async () => response);
  const deleteSource = vi.fn(async () => response);
  const deleteContext = vi.fn(async () => response);

  const client = {
    createSource: vi.fn(),
    createContext: vi.fn(),
    createOccurrence: vi.fn(),
    createContextLink: vi.fn(),
    deleteOccurrence,
    deleteContextLink,
    deleteSource,
    deleteContext,
    createRawTextImport: vi.fn(),
    createStructuredImport: vi.fn(),
    createProposal: vi.fn(),
    listProposals: vi.fn(),
    getProposal: vi.fn(),
    validateProposal: vi.fn(),
    confirmProposal: vi.fn(),
    rejectProposal: vi.fn(),
    generateRecommendations: vi.fn(),
    listRecommendations: vi.fn(),
    getRecommendation: vi.fn(),
    acceptRecommendation: vi.fn(),
    rejectRecommendation: vi.fn(),
    getContextDetail: vi.fn(),
    getWordSpace: vi.fn(),
    getSourceSpace: vi.fn(),
    getGraph: vi.fn(),
  } as unknown as L3FrontendClient;

  return { client, deleteOccurrence, deleteContextLink, deleteSource, deleteContext };
}

function renderManualEditorPage(client: L3FrontendClient): RenderedPage {
  const container = document.createElement("div");
  document.body.appendChild(container);

  const root = createRoot(container);
  const onManualChanged = vi.fn();
  const onNavigate = vi.fn();

  act(() => {
    root.render(createElement(L3ManualEditorPage, { client, onManualChanged, onNavigate }) as ReactElement);
  });

  const rendered = { container, root, onManualChanged, onNavigate };
  mountedRoots.push(rendered);
  return rendered;
}

function getDeleteForm(container: HTMLElement): HTMLFormElement {
  const form = Array.from(container.querySelectorAll("form")).find((candidate) =>
    candidate.textContent?.includes("Delete active row"),
  );
  if (!form) throw new Error("Delete form not found");
  return form as HTMLFormElement;
}

function getDeleteSpan(form: HTMLFormElement): HTMLSpanElement {
  const span = form.querySelector("header span");
  if (!span) throw new Error("Delete status span not found");
  return span as HTMLSpanElement;
}

function getDeleteResult(form: HTMLFormElement): HTMLElement | null {
  return form.querySelector("code");
}

function getDeleteInputs(form: HTMLFormElement): {
  entityType: HTMLSelectElement;
  id: HTMLInputElement;
  confirmed: HTMLInputElement;
  submit: HTMLButtonElement;
} {
  const entityType = form.querySelector("select");
  const id = form.querySelector("input:not([type='checkbox'])");
  const confirmed = form.querySelector('input[type="checkbox"]');
  const submit = form.querySelector('button[type="submit"]');
  if (!entityType || !id || !confirmed || !submit) {
    throw new Error("Delete form controls not found");
  }
  return {
    entityType: entityType as HTMLSelectElement,
    id: id as HTMLInputElement,
    confirmed: confirmed as HTMLInputElement,
    submit: submit as HTMLButtonElement,
  };
}

async function setInputValue(input: HTMLInputElement | HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(input, { target: { value } });
    await Promise.resolve();
  });
}

async function setCheckboxValue(input: HTMLInputElement, checked: boolean): Promise<void> {
  await act(async () => {
    if (input.checked !== checked) {
      fireEvent.click(input);
      await Promise.resolve();
    }
  });
}

async function submitForm(form: HTMLFormElement): Promise<void> {
  await act(async () => {
    fireEvent.submit(form);
    await Promise.resolve();
  });
}

function deleteMockFor(stub: ManualDeleteClientStub, method: DeleteMethodName): ReturnType<typeof vi.fn> {
  return stub[method];
}

describe("L3ManualEditorPage delete panel", () => {
  it.each([
    {
      entityType: "occurrence" as const,
      id: " occ-1 ",
      method: "deleteOccurrence" as const,
      response: {
        deleted: { entityType: "occurrence" as const, id: "occ-1" },
        activeReadInvalidation: true as const,
      },
    },
    {
      entityType: "context_link" as const,
      id: " link-1 ",
      method: "deleteContextLink" as const,
      response: {
        deleted: { entityType: "context_link" as const, id: "link-1" },
        activeReadInvalidation: true as const,
      },
    },
    {
      entityType: "source" as const,
      id: " src-1 ",
      method: "deleteSource" as const,
      response: {
        deleted: { entityType: "source" as const, id: "src-1" },
        activeReadInvalidation: true as const,
      },
    },
    {
      entityType: "context" as const,
      id: " ctx-1 ",
      method: "deleteContext" as const,
      response: {
        deleted: { entityType: "context" as const, id: "ctx-1" },
        activeReadInvalidation: true as const,
      },
    },
  ])("submits $entityType deletes only after explicit confirmation", async ({ entityType, id, method, response }) => {
    const stub = makeManualDeleteClientStub(response);
    const { container, onManualChanged } = renderManualEditorPage(stub.client);
    const form = getDeleteForm(container);
    const { entityType: entitySelect, id: idInput, confirmed, submit } = getDeleteInputs(form);

    expect(getDeleteSpan(form).textContent).toBe("Status: editing");

    await setInputValue(entitySelect, entityType);
    await setInputValue(idInput, id);

    await submitForm(form);

    expect(getDeleteSpan(form).textContent).toBe("Status: failed");
    expect(stub.deleteOccurrence).not.toHaveBeenCalled();
    expect(stub.deleteContextLink).not.toHaveBeenCalled();
    expect(stub.deleteSource).not.toHaveBeenCalled();
    expect(stub.deleteContext).not.toHaveBeenCalled();
    expect(onManualChanged).not.toHaveBeenCalled();

    await setCheckboxValue(confirmed, true);

    await submitForm(form);

    const expectedId = id.trim();
    const expectedDeleteMock = deleteMockFor(stub, method);

    expect(getDeleteSpan(form).textContent).toBe("Status: deleted");
    expect(submit.disabled).toBe(true);
    expect(expectedDeleteMock).toHaveBeenCalledTimes(1);
    expect(expectedDeleteMock).toHaveBeenCalledWith(expectedId);
    expect(onManualChanged).toHaveBeenCalledWith("manual_active_l3_deleted");
    expect(getDeleteResult(form)?.textContent).toBe(`Deleted ${entityType}: ${expectedId}`);

    await submitForm(form);

    expect(expectedDeleteMock).toHaveBeenCalledTimes(1);
  });

  it("shows parent delete blocker rows for 409 conflicts without marking manual data changed", async () => {
    const stub = makeManualDeleteClientStub({
      deleted: { entityType: "context" as const, id: "ctx-1" },
      activeReadInvalidation: true as const,
    });
    stub.deleteContext.mockRejectedValueOnce(normalizeL3Error(409, {
      code: "CONFLICT",
      message: "Cannot delete L3 context with active dependencies",
      details: {
        entityType: "context",
        id: "ctx-1",
        blockers: {
          occurrenceCount: 4,
          contextLinkCount: 2,
          inboundContextLinkCount: 1,
        },
      },
    }));

    const { container, onManualChanged } = renderManualEditorPage(stub.client);
    const form = getDeleteForm(container);
    const { entityType, id, confirmed } = getDeleteInputs(form);

    await setInputValue(entityType, "context");
    await setInputValue(id, " ctx-1 ");
    await setCheckboxValue(confirmed, true);

    await submitForm(form);

    expect(getDeleteSpan(form).textContent).toBe("Status: failed");
    expect(stub.deleteContext).toHaveBeenCalledWith("ctx-1");
    expect(onManualChanged).not.toHaveBeenCalled();
    expect(form.textContent).toContain("Active dependencies must be removed before retrying context ctx-1.");
    expect(form.textContent).toContain("Occurrences: 4");
    expect(form.textContent).toContain("Context links: 2");
    expect(form.textContent).toContain("Inbound context links: 1");
    expect(getDeleteResult(form)).toBeNull();
  });
});
