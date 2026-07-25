// @ts-nocheck
// The admin router is intentionally only partially public in OpenAPI. Doctor
// is a stable read-only automation surface; the remaining admin UI endpoints
// are session-only implementation details and are not claimed here.

const { jsonResponse } = require("../common");

module.exports = {
  "/admin/doctor": {
    get: {
      tags: ["Admin"],
      summary: "Run the control-plane doctor self-check",
      description:
        "Checks database/queue reachability, execution targets, secret posture, fleet health, and gateway exposure. The caller must be a platform admin; API keys additionally need admin:read.",
      "x-required-platform-role": "admin",
      "x-required-scopes": ["admin:read"],
      parameters: [
        {
          name: "fresh",
          in: "query",
          description: "Set to true or 1 to bypass the short-lived report cache.",
          schema: { type: "boolean", default: false },
        },
      ],
      responses: jsonResponse("Doctor report", {
        type: "object",
        additionalProperties: true,
      }),
    },
  },
};
