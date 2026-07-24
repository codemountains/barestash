import { AuthHeading, AuthPage, ProviderSignInButtons } from "./auth-page.js";

/** @public */
export function SignInPage() {
  return (
    <AuthPage title="Sign in to Barestash">
      <AuthHeading
        title="Sign in to Barestash"
        description="Use your preferred account to continue."
      />
      <ProviderSignInButtons />
      <p class="text-center text-base text-base-content/65">
        Signing in from the CLI?{" "}
        <a class="link link-primary font-medium" href="/device">
          Enter a one-time code
        </a>
      </p>
    </AuthPage>
  );
}
