import type { Child } from "hono/jsx";

const THEME_OVERRIDE_SCRIPT = `{
  const theme = new URLSearchParams(window.location.search).get("theme");
  if (theme === "light" || theme === "dark") {
    document.documentElement.dataset.theme = \`barestash-\${theme}\`;
  }
}`;

export function AuthPage(props: {
  title: string;
  children: Child;
  script?: string;
}) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <title>{props.title}</title>
        <script
          data-theme-override="true"
          dangerouslySetInnerHTML={{ __html: THEME_OVERRIDE_SCRIPT }}
        />
        <link rel="stylesheet" href="/assets/auth.css" />
        {props.script === undefined ? null : (
          <script type="module" src={props.script} />
        )}
      </head>
      <body class="min-h-svh bg-base-200 font-sans text-base-content antialiased">
        <main class="auth-shell flex min-h-svh items-center justify-center px-4 py-10 sm:px-6">
          <div class="auth-stack flex w-full max-w-lg flex-col items-center">
            <a
              href="/"
              class="auth-wordmark mb-7 inline-flex items-center text-xl font-semibold tracking-tight text-base-content no-underline"
              data-barestash-wordmark="true"
            >
              Barestash
            </a>
            <section class="card auth-card w-full border border-base-300 bg-base-100 shadow-xl shadow-base-content/5">
              <div class="card-body gap-6 p-6 sm:p-8">{props.children}</div>
            </section>
          </div>
        </main>
      </body>
    </html>
  );
}

export function AuthHeading(props: { title: string; description: string }) {
  return (
    <header class="space-y-2 text-center">
      <h1 class="text-2xl font-semibold tracking-tight sm:text-3xl">
        {props.title}
      </h1>
      <p class="text-sm leading-6 text-base-content/65">{props.description}</p>
    </header>
  );
}

export function ProviderSignInButtons(props: { callbackURL?: "/device" }) {
  const callbackQuery =
    props.callbackURL === undefined ? "" : `?callbackURL=${props.callbackURL}`;

  return (
    <div class="space-y-3">
      <form method="post" action={`/sign-in/github${callbackQuery}`}>
        <button class="btn btn-outline h-12 w-full text-base" type="submit">
          <GitHubIcon />
          Continue with GitHub
        </button>
      </form>
      <form method="post" action={`/sign-in/google${callbackQuery}`}>
        <button class="btn btn-outline h-12 w-full text-base" type="submit">
          <GoogleIcon />
          Continue with Google
        </button>
      </form>
    </div>
  );
}

function GitHubIcon() {
  return (
    <svg
      aria-hidden="true"
      class="size-5"
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <path d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.11.79-.25.79-.56v-2.23c-3.22.7-3.9-1.37-3.9-1.37-.52-1.34-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.57-.29-5.27-1.28-5.27-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.47.11-3.05 0 0 .97-.31 3.16 1.18a10.9 10.9 0 0 1 5.76 0c2.19-1.49 3.16-1.18 3.16-1.18.63 1.58.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.71 5.38-5.29 5.67.42.36.78 1.06.78 2.14v3.18c0 .31.21.68.8.56A11.5 11.5 0 0 0 12 .7Z" />
    </svg>
  );
}

function GoogleIcon() {
  return (
    <svg aria-hidden="true" class="size-5" viewBox="0 0 24 24">
      <path
        fill="#4285F4"
        d="M21.6 12.23c0-.71-.06-1.4-.18-2.07H12v3.91h5.38a4.6 4.6 0 0 1-2 3.02v2.54h3.24c1.9-1.75 2.98-4.33 2.98-7.4Z"
      />
      <path
        fill="#34A853"
        d="M12 22c2.7 0 4.98-.9 6.63-2.37l-3.24-2.54c-.9.6-2.05.96-3.39.96-2.61 0-4.82-1.76-5.61-4.13H3.04v2.62A10 10 0 0 0 12 22Z"
      />
      <path
        fill="#FBBC05"
        d="M6.39 13.92A6.02 6.02 0 0 1 6.07 12c0-.67.12-1.31.32-1.92V7.46H3.04A10 10 0 0 0 2 12c0 1.61.38 3.14 1.04 4.54l3.35-2.62Z"
      />
      <path
        fill="#EA4335"
        d="M12 5.95c1.47 0 2.79.5 3.82 1.49l2.88-2.88A9.65 9.65 0 0 0 12 2a10 10 0 0 0-8.96 5.46l3.35 2.62C7.18 7.71 9.39 5.95 12 5.95Z"
      />
    </svg>
  );
}
