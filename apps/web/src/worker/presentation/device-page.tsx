import type {
  BrowserDeviceAccount,
  BrowserDeviceAuthorization,
} from "../application/device-approval.js";
import { AuthHeading, AuthPage, ProviderSignInButtons } from "./auth-page.js";

/** @public */
export function DeviceCodePage(props: { error?: string } = {}) {
  return (
    <AuthPage
      title="Enter your one-time code | Barestash"
      script="/assets/device-code.js"
    >
      <AuthHeading
        title="Enter your one-time code"
        description="Type the code displayed in your terminal to continue."
      />
      {props.error === undefined ? null : (
        <div class="alert alert-error alert-soft" role="alert">
          <ErrorIcon />
          <span>{props.error}</span>
        </div>
      )}
      <form method="get" action="/device" data-device-code-form="true">
        <fieldset class="space-y-5" data-device-code-fields="true" hidden>
          <legend class="sr-only">One-time code</legend>
          <div class="device-code-grid">
            <div class="device-code-group" data-code-group="first">
              {Array.from({ length: 4 }, (_, index) => (
                <DeviceCodeInput index={index} />
              ))}
            </div>
            <span
              aria-hidden="true"
              class="device-code-separator"
              data-code-separator="true"
            >
              -
            </span>
            <div class="device-code-group" data-code-group="second">
              {Array.from({ length: 4 }, (_, index) => (
                <DeviceCodeInput index={index + 4} />
              ))}
            </div>
          </div>
          <input
            data-device-code-value="true"
            disabled
            name="code"
            type="hidden"
          />
          <p
            class="min-h-5 text-center text-sm text-error"
            data-device-code-message="true"
            aria-live="polite"
          />
          <button
            class="btn btn-primary h-14 w-full"
            data-device-code-submit="true"
            disabled
            hidden
            type="submit"
          >
            Continue
          </button>
        </fieldset>
        <fieldset class="space-y-5" data-device-code-fallback="true">
          <label class="fieldset">
            <span class="fieldset-legend">One-time code</span>
            <input
              autocomplete="one-time-code"
              class="input input-bordered h-12 w-full font-mono uppercase tracking-[0.3em]"
              maxlength={9}
              name="code"
              pattern="[A-HJ-KM-NP-Za-hj-km-np-z]{4}-?[A-HJ-KM-NP-Za-hj-km-np-z]{4}"
              placeholder="XXXX-XXXX"
              required
            />
          </label>
          <button class="btn btn-primary h-14 w-full" type="submit">
            Continue
          </button>
        </fieldset>
      </form>
    </AuthPage>
  );
}

function DeviceCodeInput(props: { index: number }) {
  return (
    <input
      aria-label={`Character ${props.index + 1} of 8`}
      autocapitalize="characters"
      autocomplete={props.index === 0 ? "one-time-code" : "off"}
      class="input input-bordered device-code-input"
      data-device-code-input={props.index}
      inputmode="text"
      maxlength={1}
      pattern="[A-HJ-KM-NP-Z]"
      spellcheck={false}
      type="text"
    />
  );
}

/** @public */
export function DeviceSignInPage(props: { userCode: string }) {
  return (
    <AuthPage title="Sign in to authorize | Barestash">
      <AuthHeading
        title="Sign in to authorize a device"
        description="Choose an account, then review this Device Authorization."
      />
      <div class="flex justify-center">
        <span class="badge badge-soft badge-primary h-auto px-4 py-2 font-mono text-sm tracking-[0.18em]">
          {props.userCode}
        </span>
      </div>
      <ProviderSignInButtons callbackURL="/device" />
    </AuthPage>
  );
}

/** @public */
export function DeviceApprovalPage(props: {
  account: BrowserDeviceAccount;
  authorization: BrowserDeviceAuthorization;
  userCode: string;
  csrfToken: string;
}) {
  return (
    <AuthPage title="Authorize this device? | Barestash">
      <AuthHeading
        title="Authorize this device?"
        description="Confirm the CLI and permissions before granting access."
      />
      <dl class="divide-y divide-base-300 overflow-hidden rounded-box border border-base-300 bg-base-200/45">
        <Detail label="Account">
          <span class="font-medium">
            {props.account.display_name ?? "Barestash account"}
          </span>
          {props.account.primary_email === null ? null : (
            <span class="block text-sm text-base-content/60">
              {props.account.primary_email}
            </span>
          )}
        </Detail>
        <Detail label="Client">
          {props.authorization.client_name}
          {props.authorization.client_version === null ? null : (
            <span class="ml-2 text-sm text-base-content/55">
              {props.authorization.client_version}
            </span>
          )}
        </Detail>
        {props.authorization.device_name === null ? null : (
          <Detail label="Device">{props.authorization.device_name}</Detail>
        )}
        <Detail label="Code">
          <span class="font-mono tracking-[0.16em]">{props.userCode}</span>
        </Detail>
        <Detail label="Expires">
          <time dateTime={props.authorization.expires_at}>
            {formatUtcDate(props.authorization.expires_at)}
          </time>
        </Detail>
        <Detail label="Requested scopes">
          <ul class="flex flex-wrap gap-2">
            {props.authorization.requested_scopes.map((scope) => (
              <li class="badge badge-outline font-mono text-xs" key={scope}>
                {scope}
              </li>
            ))}
          </ul>
        </Detail>
      </dl>
      <div class="space-y-3">
        <DeviceDecisionForm
          action="approve"
          authorizationId={props.authorization.id}
          csrfToken={props.csrfToken}
          label="Approve"
          primary
        />
        <DeviceDecisionForm
          action="deny"
          authorizationId={props.authorization.id}
          csrfToken={props.csrfToken}
          label="Deny"
        />
      </div>
    </AuthPage>
  );
}

/** @public */
export function DeviceDecisionPage(props: { approved: boolean }) {
  return (
    <AuthPage
      title={`${props.approved ? "Device approved" : "Device denied"} | Barestash`}
    >
      <div class="flex justify-center">
        <div
          class={`auth-state-icon ${
            props.approved ? "auth-state-icon-success" : "auth-state-icon-muted"
          }`}
        >
          {props.approved ? <CheckIcon /> : <DenyIcon />}
        </div>
      </div>
      <AuthHeading
        title={props.approved ? "Device approved" : "Device denied"}
        description="You can return to the terminal."
      />
    </AuthPage>
  );
}

/** @public */
export function BrowserErrorPage(props: {
  title: string;
  message: string;
  actionHref?: string;
  actionLabel?: string;
}) {
  return (
    <AuthPage title={`${props.title} | Barestash`}>
      <div class="flex justify-center">
        <div class="auth-state-icon auth-state-icon-error">
          <ErrorIcon />
        </div>
      </div>
      <AuthHeading title={props.title} description={props.message} />
      {props.actionHref === undefined ||
      props.actionLabel === undefined ? null : (
        <a class="btn btn-primary h-12 w-full" href={props.actionHref}>
          {props.actionLabel}
        </a>
      )}
    </AuthPage>
  );
}

function Detail(props: { label: string; children: unknown }) {
  return (
    <div class="grid gap-1 px-4 py-3 sm:grid-cols-[9rem_1fr] sm:gap-4">
      <dt class="text-sm font-medium text-base-content/55">{props.label}</dt>
      <dd class="min-w-0 text-sm">{props.children}</dd>
    </div>
  );
}

function DeviceDecisionForm(props: {
  action: "approve" | "deny";
  authorizationId: string;
  csrfToken: string;
  label: string;
  primary?: boolean;
}) {
  return (
    <form method="post" action={`/device/${props.action}`}>
      <input
        type="hidden"
        name="authorization_id"
        value={props.authorizationId}
      />
      <input type="hidden" name="csrf_token" value={props.csrfToken} />
      <button
        class={`btn h-12 w-full ${props.primary === true ? "btn-primary" : "btn-outline"}`}
        type="submit"
      >
        {props.label}
      </button>
    </form>
  );
}

function formatUtcDate(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  })
    .format(new Date(value))
    .concat(" UTC");
}

function CheckIcon() {
  return (
    <svg aria-hidden="true" class="size-7" viewBox="0 0 24 24" fill="none">
      <path
        d="m5 12.5 4.2 4.2L19 7"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="2"
      />
    </svg>
  );
}

function DenyIcon() {
  return (
    <svg aria-hidden="true" class="size-7" viewBox="0 0 24 24" fill="none">
      <path
        d="M7 7l10 10M17 7 7 17"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-width="2"
      />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg
      aria-hidden="true"
      class="size-5 shrink-0"
      viewBox="0 0 24 24"
      fill="none"
    >
      <path
        d="M12 8v4m0 4h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-width="2"
      />
    </svg>
  );
}
