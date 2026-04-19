// @ts-nocheck
const {
  buildIntegrationSkillMarkdown,
  buildIntegrationToolExecutionMetadata,
  executeIntegrationToolInvocation,
} = require("../../agent-runtime/lib/integrationTools");

describe("runtime integration tool execution", () => {
  it("marks supported GitHub tools as executable via runtime skill", () => {
    const execution = buildIntegrationToolExecutionMetadata(
      { provider: "github" },
      {
        name: "github_list_repositories",
        operation: "repos.list",
        inputSchema: {
          type: "object",
          properties: {
            owner: { type: "string" },
          },
          required: ["owner"],
        },
      }
    );

    expect(execution).toMatchObject({
      executable: true,
      executionState: "runtime_skill",
      executionSurface: "exec",
      runtimeToolName: "github_list_repositories",
    });
    expect(execution.invokeCommand).toContain("nora-integration-tool github_list_repositories");
  });

  it("lists repositories for the configured GitHub org", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ type: "Organization" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify([
            {
              id: 1,
              name: "nora",
              full_name: "openai/nora",
              private: true,
              description: "Nora repo",
              default_branch: "main",
              html_url: "https://github.com/openai/nora",
              language: "JavaScript",
              archived: false,
              fork: false,
              updated_at: "2026-04-10T00:00:00Z",
            },
          ]),
      });

    const result = await executeIntegrationToolInvocation({
      toolName: "github_list_repositories",
      input: { per_page: 5 },
      integrations: [
        {
          provider: "github",
          name: "GitHub",
          config: {
            personal_access_token: "ghp_test",
            org: "openai",
          },
          toolSpecs: [
            {
              name: "github_list_repositories",
              operation: "repos.list",
            },
          ],
        },
      ],
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "https://api.github.com/users/openai",
      expect.objectContaining({
        method: "GET",
      })
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/orgs/openai/repos?per_page=5&sort=updated",
      expect.objectContaining({
        method: "GET",
      })
    );
    expect(result.result.repositories).toEqual([
      expect.objectContaining({
        full_name: "openai/nora",
        private: true,
      }),
    ]);
  });

  it("creates a GitHub issue using the configured default repo", async () => {
    const fetchImpl = jest.fn().mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          number: 42,
          title: "Investigate bug",
          state: "open",
          html_url: "https://github.com/openai/nora/issues/42",
          created_at: "2026-04-10T00:00:00Z",
          updated_at: "2026-04-10T00:00:00Z",
        }),
    });

    const result = await executeIntegrationToolInvocation({
      toolName: "github_create_issue",
      input: { title: "Investigate bug", body: "Details here" },
      integrations: [
        {
          provider: "github",
          name: "GitHub",
          config: {
            personal_access_token: "ghp_test",
            org: "openai",
            repo: "nora",
          },
          toolSpecs: [
            {
              name: "github_create_issue",
              operation: "issues.create",
            },
          ],
        },
      ],
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/repos/openai/nora/issues",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          title: "Investigate bug",
          body: "Details here",
        }),
      })
    );
    expect(result.result.issue).toEqual(
      expect.objectContaining({
        number: 42,
        title: "Investigate bug",
      })
    );
  });

  it("builds a generated skill that references executable tools", () => {
    const markdown = buildIntegrationSkillMarkdown([
      {
        provider: "github",
        name: "GitHub",
        config: {
          personal_access_token: "ghp_test",
        },
        toolSpecs: [
          {
            name: "github_list_repositories",
            description: "List repos",
            operation: "repos.list",
            inputSchema: {
              type: "object",
              properties: {
                owner: { type: "string" },
              },
              required: ["owner"],
            },
          },
        ],
      },
    ]);

    expect(markdown).toContain("nora-integration-tool");
    expect(markdown).toContain("github_list_repositories");
  });
});
