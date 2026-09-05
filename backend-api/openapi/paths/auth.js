// @ts-nocheck
// Auth routes (mounted at /auth). Drift-checked against routes/auth.ts.
// These are session endpoints — API keys do not apply here.

const ok = (description, schema) => ({
  200: { description, ...(schema ? { content: { "application/json": { schema } } } : {}) },
});

const signupDisabledResponse = (description) => ({
  description,
  content: {
    "application/json": {
      schema: {
        type: "object",
        required: ["error"],
        properties: {
          error: { type: "string" },
          code: {
            type: "string",
            enum: ["SIGNUP_DISABLED"],
            description: "Stable code returned when registration is disabled by the operator.",
          },
        },
      },
    },
  },
});

const credentialsBody = {
  required: true,
  content: {
    "application/json": {
      schema: {
        type: "object",
        required: ["email", "password"],
        properties: {
          email: { type: "string", format: "email" },
          password: { type: "string", minLength: 8 },
        },
      },
    },
  },
};

const signupBody = {
  required: true,
  content: {
    "application/json": {
      schema: {
        ...credentialsBody.content["application/json"].schema,
        properties: {
          ...credentialsBody.content["application/json"].schema.properties,
          botProtectionToken: {
            type: "string",
            description:
              "Turnstile or reCAPTCHA token when signup bot protection is enabled by the operator.",
          },
        },
      },
    },
  },
};

module.exports = {
  "/auth/bootstrap-status": {
    get: {
      tags: ["Auth"],
      summary: "Public runtime authentication bootstrap status",
      description:
        "Reports self-hosted first-account admin claim state plus safe runtime OAuth, signup availability, platform-mode, and signup-challenge metadata. Hosted PaaS requires an explicit bootstrap administrator and never exposes public admin claim. Public; never exposes verification secrets.",
      security: [],
      responses: ok("Status", {
        type: "object",
        required: [
          "needsFirstAdmin",
          "oauthLoginEnabled",
          "platformMode",
          "signupEnabled",
          "signupBotProtection",
        ],
        properties: {
          needsFirstAdmin: { type: "boolean" },
          oauthLoginEnabled: { type: "boolean" },
          platformMode: { type: "string", enum: ["selfhosted", "paas"] },
          signupEnabled: { type: "boolean" },
          signupBotProtection: {
            type: "object",
            required: ["enabled", "provider", "siteKey", "configured", "configurationError"],
            properties: {
              enabled: { type: "boolean" },
              provider: {
                type: ["string", "null"],
                enum: ["none", "turnstile", "recaptcha", null],
              },
              siteKey: { type: ["string", "null"] },
              configured: { type: "boolean" },
              configurationError: { type: ["string", "null"] },
            },
          },
        },
      }),
    },
  },
  "/auth/signup": {
    post: {
      tags: ["Auth"],
      summary: "Create an operator account",
      description:
        "The first registered user becomes platform admin only on an empty self-hosted installation. Hosted PaaS requires a pre-seeded administrator, so public signup creates regular users. Rate-limited and challenge-protected when configured.",
      security: [],
      requestBody: signupBody,
      responses: {
        ...ok("Created user"),
        403: signupDisabledResponse(
          "Registration is disabled by the operator. This status is also used when signup bot-protection verification fails.",
        ),
      },
    },
  },
  "/auth/login": {
    post: {
      tags: ["Auth"],
      summary: "Log in and receive a JWT + HttpOnly session cookie",
      security: [],
      requestBody: credentialsBody,
      responses: ok("Token + user"),
    },
  },
  "/auth/oauth-login": {
    post: {
      tags: ["Auth"],
      summary: "Exchange a verified OAuth identity for a Nora session",
      security: [],
      responses: {
        ...ok("Token + user"),
        403: signupDisabledResponse(
          "OAuth login is disabled, or registration is disabled and a verified identity is not linked to an existing Nora user. Existing linked OAuth users can still authenticate when registration alone is disabled.",
        ),
      },
    },
  },
  "/auth/logout": {
    post: {
      tags: ["Auth"],
      summary: "Clear the session cookie",
      security: [],
      responses: ok("Logout result"),
    },
  },
  "/auth/me": {
    get: {
      tags: ["Auth"],
      summary: "Current user profile",
      responses: ok("Profile"),
    },
  },
  "/auth/profile": {
    patch: {
      tags: ["Auth"],
      summary: "Update profile fields (name, preferred locale)",
      responses: ok("Updated profile"),
    },
  },
  "/auth/password": {
    patch: {
      tags: ["Auth"],
      summary: "Change password",
      responses: ok("Result"),
    },
  },
  "/auth/session-upgrade": {
    post: {
      tags: ["Auth"],
      summary: "Mirror a bearer-token session into the HttpOnly cookie",
      responses: ok("Result"),
    },
  },
};
