import { api } from "./api.ts";
import type { EventDraft, EventDraftResult, WriterInput } from "../../src/event-writer.ts";

/** Drafts are previews. A delayed reply never overwrites the host's form. */
export function installEventWriter(form: HTMLFormElement, dialog: HTMLDialogElement, timezone: () => string): { reset(): void } {
  const write = form.querySelector<HTMLButtonElement>("#event-ai-write")!;
  const cancel = form.querySelector<HTMLButtonElement>("#event-ai-cancel")!;
  const apply = form.querySelector<HTMLButtonElement>("#event-ai-apply")!;
  const preview = form.querySelector<HTMLElement>("#event-ai-preview")!;
  const status = form.querySelector<HTMLElement>("#event-ai-status")!;
  const fields = {
    title: form.querySelector<HTMLInputElement>("#event-ai-title")!,
    description: form.querySelector<HTMLTextAreaElement>("#event-ai-description")!,
    topic: form.querySelector<HTMLInputElement>("#event-ai-topic")!,
  };
  let request: AbortController | null = null;
  let proposed: EventDraft | null = null;
  let source: WriterInput | null = null;
  const fieldValue = (name: string) => (form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
  const currentInput = (): WriterInput => ({
    title: fieldValue("title"), description: fieldValue("description"), topic: fieldValue("topic"),
    hostName: fieldValue("hostName"), startsAt: fieldValue("startsAt"), timezone: timezone(),
    duration: fieldValue("expectedDurationMinutes"), recurrence: fieldValue("recurrence"),
  });
  function reset(): void {
    request?.abort(); request = null; proposed = null; source = null;
    preview.hidden = true; preview.removeAttribute("aria-busy"); cancel.hidden = true;
    write.textContent = "Write with AI"; write.removeAttribute("aria-disabled");
    apply.textContent = "Use these details"; apply.setAttribute("aria-disabled", "true");
    status.textContent = "";
    for (const field of Object.values(fields)) field.value = "";
  }
  write.addEventListener("click", async () => {
    if (request || form.getAttribute("aria-busy") === "true") return;
    const input = currentInput();
    if (![input.title, input.description, input.topic].some(value => value.trim())) {
      status.textContent = "Add a title, description, or topic first. Your words become the prompt."; return;
    }
    const controller = new AbortController(); request = controller;
    source = input; proposed = null;
    write.setAttribute("aria-disabled", "true"); write.textContent = "Writing…";
    cancel.hidden = false; cancel.textContent = "Cancel";
    preview.hidden = false; preview.setAttribute("aria-busy", "true");
    apply.textContent = "Use these details"; apply.setAttribute("aria-disabled", "true");
    for (const field of Object.values(fields)) field.value = "";
    status.textContent = "Writing a draft from your event details… You can keep editing.";
    try {
      const result = await api<EventDraftResult>("/api/v1/events/ai-draft", {
        method: "POST", body: JSON.stringify(input), signal: controller.signal,
      });
      if (request !== controller || !dialog.open) return;
      proposed = result.draft;
      for (const key of ["title", "description", "topic"] as const) fields[key].value = proposed[key];
      apply.removeAttribute("aria-disabled");
      status.textContent = "Draft ready. Review it below, then use these details if you like them.";
    } catch (error) {
      if (request !== controller || controller.signal.aborted) return;
      status.textContent = error instanceof Error ? error.message : "Could not write a draft. Your text is unchanged.";
    } finally {
      if (request === controller) {
        request = null; preview.removeAttribute("aria-busy");
        write.removeAttribute("aria-disabled"); write.textContent = "Write again"; cancel.textContent = "Discard draft";
      }
    }
  });
  cancel.addEventListener("click", () => {
    const pending = Boolean(request); reset();
    status.textContent = pending ? "Draft cancelled. Your text is unchanged." : "Draft discarded. Your text is unchanged.";
    // Keep the explicitly clicked control present and focused until the next action.
    cancel.hidden = false; cancel.textContent = "Dismiss";
  });
  apply.addEventListener("click", () => {
    if (!proposed || !source || request || apply.getAttribute("aria-disabled") === "true") return;
    if (JSON.stringify(currentInput()) !== JSON.stringify(source)) {
      status.textContent = "Your inputs changed while this draft was being written. Click Write again to include those edits, or copy text from the preview.";
      return;
    }
    for (const key of ["title", "description", "topic"] as const) {
      (form.elements.namedItem(key) as HTMLInputElement | HTMLTextAreaElement).value = proposed[key];
    }
    apply.setAttribute("aria-disabled", "true"); apply.textContent = "Details applied";
    status.textContent = "Draft applied to your form. Review your event and save when you’re ready.";
  });
  dialog.addEventListener("close", reset);
  form.addEventListener("submit", () => { if (request) reset(); });
  return {reset};
}
