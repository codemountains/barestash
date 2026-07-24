// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeDeviceCodeForms } from "./device-code.js";

describe("initializeDeviceCodeForms", () => {
  beforeEach(() => {
    document.body.innerHTML = segmentedCodeForm();
  });

  it("reveals the segmented fields, normalizes input, and moves focus", () => {
    initializeDeviceCodeForms(document);
    const fields = codeFields();
    const group = document.querySelector<HTMLElement>(
      "[data-device-code-fields]",
    );

    expect(group?.hidden).toBe(false);
    expect(fallback().hidden).toBe(true);
    expect(fallback().disabled).toBe(true);
    expect(
      new FormData(
        requiredElement<HTMLFormElement>("[data-device-code-form]"),
      ).getAll("code"),
    ).toHaveLength(1);
    expect(fields[0]).toBe(document.activeElement);

    codeField(0).value = "a";
    codeField(0).dispatchEvent(new InputEvent("input", { bubbles: true }));

    expect(codeField(0).value).toBe("A");
    expect(fields[1]).toBe(document.activeElement);
  });

  it("distributes a formatted paste without automatically submitting", () => {
    const submit = vi.fn((event: Event) => event.preventDefault());
    const form = document.querySelector<HTMLFormElement>(
      "[data-device-code-form]",
    );
    form?.addEventListener("submit", submit);
    initializeDeviceCodeForms(document);
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { getData: () => "abcd-efgh" },
    });

    codeField(0).dispatchEvent(paste);

    expect(
      codeFields()
        .map((field) => field.value)
        .join(""),
    ).toBe("ABCDEFGH");
    expect(hiddenCode().value).toBe("ABCD-EFGH");
    expect(submitButton().disabled).toBe(false);
    expect(submit).not.toHaveBeenCalled();
  });

  it("distributes a complete code supplied by one-time-code autofill", () => {
    initializeDeviceCodeForms(document);
    codeField(0).value = "abcd-efgh";

    codeField(0).dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertReplacementText",
      }),
    );

    expect(
      codeFields()
        .map((field) => field.value)
        .join(""),
    ).toBe("ABCDEFGH");
    expect(hiddenCode().value).toBe("ABCD-EFGH");
    expect(submitButton().disabled).toBe(false);
  });

  it("moves backward on Backspace and blocks incomplete submission", () => {
    initializeDeviceCodeForms(document);
    const fields = codeFields();
    codeField(0).value = "A";
    codeField(1).focus();
    codeField(1).dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Backspace" }),
    );

    expect(fields[0]).toBe(document.activeElement);
    expect(codeField(0).value).toBe("");

    const submit = new SubmitEvent("submit", {
      bubbles: true,
      cancelable: true,
    });
    document
      .querySelector<HTMLFormElement>("[data-device-code-form]")
      ?.dispatchEvent(submit);

    expect(submit.defaultPrevented).toBe(true);
    expect(message().textContent).toContain("complete 8-character code");
  });

  it("keeps the fallback usable when enhanced controls are incomplete", () => {
    message().remove();

    initializeDeviceCodeForms(document);

    expect(fallback().hidden).toBe(false);
    expect(fallback().disabled).toBe(false);
    expect(
      requiredElement<HTMLFieldSetElement>("[data-device-code-fields]").hidden,
    ).toBe(true);
  });
});

function segmentedCodeForm(): string {
  const fields = Array.from(
    { length: 8 },
    (_, index) => `<input data-device-code-input="${index}" maxlength="1" />`,
  ).join("");

  return `
    <form data-device-code-form>
      <fieldset data-device-code-fields hidden>
        ${fields}
        <input data-device-code-value disabled name="code" type="hidden" />
        <p data-device-code-message></p>
        <button data-device-code-submit disabled hidden type="submit">Continue</button>
      </fieldset>
      <fieldset data-device-code-fallback>
        <input name="code" />
        <button type="submit">Continue</button>
      </fieldset>
    </form>
  `;
}

function codeFields(): HTMLInputElement[] {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>("[data-device-code-input]"),
  );
}

function codeField(index: number): HTMLInputElement {
  const field = codeFields()[index];
  if (field === undefined) throw new Error(`Missing code field ${index}.`);
  return field;
}

function hiddenCode(): HTMLInputElement {
  return requiredElement<HTMLInputElement>("[data-device-code-value]");
}

function submitButton(): HTMLButtonElement {
  return requiredElement<HTMLButtonElement>("[data-device-code-submit]");
}

function message(): HTMLElement {
  return requiredElement<HTMLElement>("[data-device-code-message]");
}

function fallback(): HTMLFieldSetElement {
  return requiredElement<HTMLFieldSetElement>("[data-device-code-fallback]");
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`Missing element: ${selector}`);
  return element;
}
