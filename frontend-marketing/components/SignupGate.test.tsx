import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AuthBootstrapStatus } from "../lib/authBootstrap";
import { AuthBootstrapContext } from "./AuthBootstrapProvider";
import { SignupGate } from "./SignupGate";

const validStatus: AuthBootstrapStatus = {
  needsFirstAdmin: false,
  oauthLoginEnabled: true,
  platformMode: "paas",
  signupEnabled: true,
  signupBotProtection: {
    enabled: false,
    provider: "none",
    siteKey: null,
    configured: true,
    configurationError: null,
  },
};

function renderGate(status: AuthBootstrapStatus | null): string {
  return renderToStaticMarkup(
    <AuthBootstrapContext.Provider value={{ status, error: "", loading: false }}>
      <SignupGate>
        <a href="/signup">Create Account</a>
      </SignupGate>
    </AuthBootstrapContext.Provider>,
  );
}

async function renderSignupAccessState({
  loading = false,
  error = "",
  disabled = false,
}: {
  loading?: boolean;
  error?: string;
  disabled?: boolean;
} = {}): Promise<string> {
  const signupModule = await import("../pages/signup");
  assert.equal(
    typeof signupModule.SignupAccessState,
    "function",
    "signup.tsx must export the access-state component used by the page",
  );
  const SignupAccessState = signupModule.SignupAccessState;

  return renderToStaticMarkup(
    <SignupAccessState loading={loading} error={error} disabled={disabled}>
      <div data-testid="enabled-signup-controls">
        <input type="password" />
        <button type="button" data-testid="oauth-signup-control">
          OAuth signup
        </button>
        <div data-testid="signup-bot-protection" />
        <button type="submit">Create Account</button>
      </div>
    </SignupAccessState>,
  );
}

async function renderSignupSupportingPanel(disabled: boolean): Promise<string> {
  const signupModule = await import("../pages/signup");
  assert.equal(
    typeof signupModule.SignupSupportingPanel,
    "function",
    "signup.tsx must export the supporting-panel component used by the page",
  );
  const SignupSupportingPanel = signupModule.SignupSupportingPanel;

  return renderToStaticMarkup(
    <SignupSupportingPanel disabled={disabled}>
      <div data-testid="enabled-signup-promotion">
        Open-source operator signup. Create the operator account. After account creation.
      </div>
    </SignupSupportingPanel>,
  );
}

function assertRegistrationControlsAbsent(markup: string) {
  assert.doesNotMatch(markup, /type="password"/);
  assert.doesNotMatch(markup, /data-testid="oauth-signup-control"/);
  assert.doesNotMatch(markup, /data-testid="signup-bot-protection"/);
  assert.doesNotMatch(markup, /type="submit"/);
  assert.doesNotMatch(markup, /data-testid="enabled-signup-controls"/);
}

test("renders children when signup availability is true", () => {
  assert.match(renderGate(validStatus), /Create Account/);
});

test("renders nothing when signup is explicitly disabled", () => {
  assert.equal(renderGate({ ...validStatus, signupEnabled: false }), "");
});

test("fails open while bootstrap status is unavailable", () => {
  // The backend's SIGNUP_DISABLED guard is the security boundary; while the
  // bootstrap status is loading or failed to fetch, the CTAs must stay in the
  // (server-rendered) markup instead of popping in after hydration.
  assert.match(renderGate(null), /Create Account/);
});

test("public signup destinations are all enclosed by SignupGate", () => {
  const pages: Array<{
    name: string;
    expectedCount: number;
    destination: string;
    dataDrivenDestination?: RegExp;
    gatedDataDrivenDestination?: RegExp;
  }> = [
    { name: "index.tsx", expectedCount: 5, destination: String.raw`\{DEMO_SIGNUP_PATH\}` },
    { name: "login.tsx", expectedCount: 2, destination: '"/signup"' },
    {
      name: "pricing.tsx",
      expectedCount: 3,
      destination: '"/signup"',
      dataDrivenDestination:
        /\{\s*label:\s*"Create account",\s*href:\s*SIGNUP_URL,\s*text:\s*"norafleet\.ai\/signup"\s*\}/g,
      gatedDataDrivenDestination:
        /item\.href\s*===\s*SIGNUP_URL\s*\?\s*\(\s*<SignupGate key=\{item\.label\}>\{entryLink\}<\/SignupGate>\s*\)\s*:\s*\(?\s*entryLink\s*\)?/g,
    },
    { name: "privacy.tsx", expectedCount: 1, destination: '"/signup"' },
    { name: "terms.tsx", expectedCount: 1, destination: '"/signup"' },
  ];

  for (const {
    name,
    expectedCount,
    destination,
    dataDrivenDestination,
    gatedDataDrivenDestination,
  } of pages) {
    const source = readFileSync(path.join(process.cwd(), "pages", name), "utf8");
    const signupDestination = new RegExp(String.raw`<Link\b[^>]*\bhref=${destination}[^>]*>`, "g");
    const gatedSignupDestination = new RegExp(
      String.raw`<SignupGate>\s*(?:<p>\s*Need an account\?\{" "\}\s*)?<Link\b(?=[^>]*\bhref=${destination})[^>]*>[\s\S]*?<\/Link>\s*(?:<\/p>\s*)?<\/SignupGate>`,
      "g",
    );

    const destinationCount =
      (source.match(signupDestination)?.length ?? 0) +
      (dataDrivenDestination ? (source.match(dataDrivenDestination)?.length ?? 0) : 0);
    const gatedDestinationCount =
      (source.match(gatedSignupDestination)?.length ?? 0) +
      (gatedDataDrivenDestination ? (source.match(gatedDataDrivenDestination)?.length ?? 0) : 0);

    assert.equal(destinationCount, expectedCount, `${name} signup destination inventory changed`);
    assert.equal(
      gatedDestinationCount,
      expectedCount,
      `${name} has a signup destination outside its SignupGate wrapper`,
    );
    assert.equal(
      source.match(/<SignupGate(?:\s+key=\{item\.label\})?>/g)?.length ?? 0,
      expectedCount,
      `${name} must contain exactly ${expectedCount} SignupGate wrappers`,
    );
  }
});

test("public login gates the signup lead-in together with its link", () => {
  const source = readFileSync(path.join(process.cwd(), "pages", "login.tsx"), "utf8");

  assert.match(
    source,
    /<SignupGate>\s*<p>\s*Need an account\?\{" "\}\s*<Link\s+href="\/signup"[\s\S]*?<\/Link>\s*<\/p>\s*<\/SignupGate>/,
  );
});

test("public signup page has an explicit disabled-registration branch", () => {
  const source = readFileSync(path.join(process.cwd(), "pages", "signup.tsx"), "utf8");

  assert.match(source, /signupEnabled\s*===\s*false/);
  assert.match(source, />\s*Registration is disabled\s*<\/h2>/);
  assert.match(
    source,
    />\s*This Nora operator is not accepting new accounts\. Contact the administrator for access\.\s*<\/p>/,
  );
  assert.match(
    source,
    /<SignupAccessState\s+loading=\{bootstrapLoading\}\s+error=\{bootstrapError\}\s+disabled=\{signupDisabled\}\s*>/,
  );
  assert.match(source, /<SignupSupportingPanel disabled=\{signupDisabled\}>/);
});

test("public signup access state renders loading without registration controls", async () => {
  const markup = await renderSignupAccessState({ loading: true });

  assert.match(markup, /Loading signup verification configuration/);
  assertRegistrationControlsAbsent(markup);
});

test("public signup access state renders configuration errors without registration controls", async () => {
  const markup = await renderSignupAccessState({ error: "Unable to load signup availability" });

  assert.match(markup, /role="alert"/);
  assert.match(markup, /Unable to load signup availability/);
  assert.match(markup, /href="\/login"/);
  assert.match(markup, /Return to login/);
  assertRegistrationControlsAbsent(markup);
});

test("public signup access state renders disabled guidance without registration controls", async () => {
  const markup = await renderSignupAccessState({ disabled: true });

  assert.match(markup, />Registration is disabled<\/h2>/);
  assert.match(
    markup,
    />This Nora operator is not accepting new accounts\. Contact the administrator for access\.<\/p>/,
  );
  assert.match(markup, /href="\/login"/);
  assert.match(markup, /Return to login/);
  assertRegistrationControlsAbsent(markup);
});

test("public signup access state renders enabled registration controls", async () => {
  const markup = await renderSignupAccessState();

  assert.match(markup, /data-testid="enabled-signup-controls"/);
  assert.match(markup, /type="password"/);
  assert.match(markup, /data-testid="oauth-signup-control"/);
  assert.match(markup, /data-testid="signup-bot-protection"/);
  assert.match(markup, /type="submit"/);
  assert.doesNotMatch(markup, /Registration is disabled/);
});

test("public signup disabled supporting panel replaces account-creation promises", async () => {
  const markup = await renderSignupSupportingPanel(true);

  assert.match(markup, /Registration is disabled on this Nora instance/);
  assert.match(markup, /Contact the administrator for access/);
  assert.match(markup, /href="\/login"/);
  assert.match(markup, /Return to login/);
  assert.doesNotMatch(markup, /data-testid="enabled-signup-promotion"/);
  assert.doesNotMatch(markup, /Open-source operator signup/);
  assert.doesNotMatch(markup, /Create the operator account/);
  assert.doesNotMatch(markup, /After account creation/);
});

test("public signup enabled supporting panel preserves signup guidance", async () => {
  const markup = await renderSignupSupportingPanel(false);

  assert.match(markup, /data-testid="enabled-signup-promotion"/);
  assert.match(markup, /Open-source operator signup/);
  assert.match(markup, /After account creation/);
});
