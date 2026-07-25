// @ts-nocheck
// Small OpenAPI authoring helpers shared by path fragments. They deliberately
// keep responses conservative: route-specific modules only claim fields the
// implementation guarantees and leave provider/runtime-specific payloads open.

const pathParameter = (name, description, format) => ({
  name,
  in: "path",
  required: true,
  description,
  schema: { type: "string", ...(format ? { format } : {}) },
});

const jsonResponse = (description, schema, status = 200) => ({
  [status]: {
    description,
    ...(schema ? { content: { "application/json": { schema } } } : {}),
  },
});

const jsonBody = (schema, required = true) => ({
  required,
  content: { "application/json": { schema } },
});

const successSchema = {
  type: "object",
  required: ["success"],
  properties: { success: { type: "boolean" } },
  additionalProperties: true,
};

const workspaceParam = pathParameter("id", "Workspace UUID.", "uuid");
const agentParam = pathParameter("id", "Agent UUID.", "uuid");

module.exports = {
  agentParam,
  jsonBody,
  jsonResponse,
  pathParameter,
  successSchema,
  workspaceParam,
};
