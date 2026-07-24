const ALLOWED_CHARACTER = /[A-HJ-KM-NP-Z]/g;

/** @public */
export function initializeDeviceCodeForms(root: ParentNode = document): void {
  for (const form of root.querySelectorAll<HTMLFormElement>(
    "[data-device-code-form]",
  )) {
    initializeDeviceCodeForm(form);
  }
}

function initializeDeviceCodeForm(form: HTMLFormElement): void {
  const group = form.querySelector<HTMLFieldSetElement>(
    "[data-device-code-fields]",
  );
  const fields = Array.from(
    form.querySelectorAll<HTMLInputElement>("[data-device-code-input]"),
  );
  const code = form.querySelector<HTMLInputElement>("[data-device-code-value]");
  const submit = form.querySelector<HTMLButtonElement>(
    "[data-device-code-submit]",
  );
  const message = form.querySelector<HTMLElement>("[data-device-code-message]");
  const fallback = form.querySelector<HTMLFieldSetElement>(
    "[data-device-code-fallback]",
  );

  if (
    group === null ||
    fields.length !== 8 ||
    code === null ||
    submit === null ||
    message === null ||
    fallback === null
  ) {
    return;
  }

  const update = () => {
    const normalized = fields.map((field) => field.value).join("");
    const complete = normalized.length === 8;
    code.value = complete
      ? `${normalized.slice(0, 4)}-${normalized.slice(4)}`
      : "";
    submit.disabled = !complete;
    if (complete) message.textContent = "";
  };

  const distribute = (value: string, start: number) => {
    for (const [offset, character] of Array.from(value).entries()) {
      const target = fields[start + offset];
      if (target === undefined) break;
      target.value = character;
    }
  };

  for (const [index, field] of fields.entries()) {
    field.addEventListener("input", () => {
      const input = normalizeCharacters(field.value);
      if (input.length > 1) {
        distribute(input, input.length === 8 ? 0 : index);
      } else {
        field.value = input;
      }
      message.textContent = "";
      update();
      if (input.length > 1) {
        const nextEmpty = fields.find((candidate) => candidate.value === "");
        (nextEmpty ?? fields.at(-1))?.focus();
      } else if (field.value !== "") {
        fields[index + 1]?.focus();
      }
    });

    field.addEventListener("paste", (event) => {
      const pasted = normalizeCharacters(event.clipboardData?.getData("text"));
      if (pasted === "") return;

      event.preventDefault();
      const start = pasted.length === 8 ? 0 : index;
      distribute(pasted, start);
      message.textContent = "";
      update();
      const nextEmpty = fields.find((candidate) => candidate.value === "");
      (nextEmpty ?? fields.at(-1))?.focus();
    });

    field.addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        fields[index - 1]?.focus();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        fields[index + 1]?.focus();
      } else if (event.key === "Home") {
        event.preventDefault();
        fields[0]?.focus();
      } else if (event.key === "End") {
        event.preventDefault();
        fields.at(-1)?.focus();
      } else if (event.key === "Backspace") {
        event.preventDefault();
        if (field.value !== "") {
          field.value = "";
        } else {
          const previous = fields[index - 1];
          if (previous !== undefined) {
            previous.value = "";
            previous.focus();
          }
        }
        update();
      }
    });
  }

  form.addEventListener("submit", (event) => {
    update();
    if (code.value !== "") return;

    event.preventDefault();
    message.textContent = "Enter the complete 8-character code.";
    fields.find((field) => field.value === "")?.focus();
  });

  update();
  fallback.hidden = true;
  fallback.disabled = true;
  group.hidden = false;
  code.disabled = false;
  submit.hidden = false;
  fields[0]?.focus();
}

function normalizeCharacters(value: string | undefined): string {
  return (value ?? "").toUpperCase().match(ALLOWED_CHARACTER)?.join("") ?? "";
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      initializeDeviceCodeForms();
    });
  } else {
    initializeDeviceCodeForms();
  }
}
