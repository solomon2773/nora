// @ts-nocheck
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  NORA_SYNC_INTEGRATIONS_CATALOG_FILE,
  NORA_SYNC_INTEGRATIONS_CONFIG_FILE,
  buildSplitIntegrationManifest,
  buildIntegrationSkillMarkdown,
  buildIntegrationToolExecutionMetadata,
  executeIntegrationToolInvocation,
  loadSyncedIntegrations,
  normalizeEmailMessage,
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
      },
    );

    expect(execution).toMatchObject({
      executable: true,
      executionState: "runtime_skill",
      executionSurface: "exec",
      runtimeToolName: "github_list_repositories",
    });
    expect(execution.invokeCommand).toContain("nora-integration-tool github_list_repositories");
  });

  it("marks supported Twitter/X tools as executable via runtime skill", () => {
    const execution = buildIntegrationToolExecutionMetadata(
      { provider: "twitter" },
      {
        name: "twitter_post_tweet",
        operation: "tweets.create",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
          },
          required: ["text"],
        },
      },
    );

    expect(execution).toMatchObject({
      executable: true,
      executionState: "runtime_skill",
      executionSurface: "exec",
      runtimeToolName: "twitter_post_tweet",
    });
    expect(execution.invokeCommand).toContain("nora-integration-tool twitter_post_tweet");
  });

  it("marks supported LinkedIn tools as executable via runtime skill", () => {
    const execution = buildIntegrationToolExecutionMetadata(
      { provider: "linkedin" },
      {
        name: "linkedin_post_share",
        operation: "ugcPosts.create",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
          },
          required: ["text"],
        },
      },
    );

    expect(execution).toMatchObject({
      executable: true,
      executionState: "runtime_skill",
      executionSurface: "exec",
      runtimeToolName: "linkedin_post_share",
    });
    expect(execution.invokeCommand).toContain("nora-integration-tool linkedin_post_share");
  });

  it("loads synced integrations from the split runtime catalog and details files", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nora-integrations-"));
    const catalog = buildSplitIntegrationManifest([
      {
        provider: "twitter",
        name: "Twitter / X",
        config: {
          access_token: "secret-token",
        },
      },
    ]);

    fs.writeFileSync(path.join(tempDir, "integrations.json"), JSON.stringify(catalog.catalog));
    for (const { fileName, integration } of catalog.details) {
      fs.writeFileSync(path.join(tempDir, fileName), JSON.stringify(integration));
    }

    expect(loadSyncedIntegrations(tempDir)).toEqual([
      expect.objectContaining({
        provider: "twitter",
        name: "Twitter / X",
        config: {
          access_token: "secret-token",
        },
      }),
    ]);
    expect(NORA_SYNC_INTEGRATIONS_CONFIG_FILE).toBe(
      "/root/.openclaw/workspace/integrations/integrations.json",
    );
    expect(NORA_SYNC_INTEGRATIONS_CATALOG_FILE).toBe(NORA_SYNC_INTEGRATIONS_CONFIG_FILE);
  });

  it("keeps reading legacy single-file integration manifests", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nora-integrations-"));
    const configAlias = path.join(tempDir, "integrations.config.json");
    fs.writeFileSync(
      configAlias,
      JSON.stringify({
        integrations: [
          {
            provider: "twitter",
            name: "Twitter / X",
          },
        ],
      }),
    );

    expect(loadSyncedIntegrations(configAlias)).toEqual([
      expect.objectContaining({
        provider: "twitter",
        name: "Twitter / X",
      }),
    ]);
  });

  it("exposes an executable manifest tool for any connected provider", async () => {
    const result = await executeIntegrationToolInvocation({
      toolName: "nora_slack_integration",
      integrations: [
        {
          id: "int-slack",
          provider: "slack",
          name: "Slack",
          category: "communication",
          credentialEnv: {
            primary: "SLACK_TOKEN",
            config: { default_channel: "SLACK_DEFAULT_CHANNEL" },
          },
          config: {
            bot_token: "xoxb-secret",
            default_channel: "#ops",
          },
          redactedConfig: {
            bot_token: "[REDACTED]",
            default_channel: "#ops",
          },
          toolSpecs: [],
        },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      provider: "slack",
      operation: "manifest.inspect",
      result: {
        integration: {
          provider: "slack",
          credentialEnv: {
            primary: "SLACK_TOKEN",
          },
          config: {
            bot_token: "[REDACTED]",
            default_channel: "#ops",
          },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("xoxb-secret");
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
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/orgs/openai/repos?per_page=5&sort=updated",
      expect.objectContaining({
        method: "GET",
      }),
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
      }),
    );
    expect(result.result.issue).toEqual(
      expect.objectContaining({
        number: 42,
        title: "Investigate bug",
      }),
    );
  });

  it("posts a tweet through the connected Twitter/X token", async () => {
    const fetchImpl = jest.fn().mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          data: {
            id: "1900000000000000000",
            text: "Hello from Nora",
            edit_history_tweet_ids: ["1900000000000000000"],
          },
        }),
    });

    const result = await executeIntegrationToolInvocation({
      toolName: "twitter_post_tweet",
      input: { text: "Hello from Nora", reply_to_tweet_id: "1899999999999999999" },
      integrations: [
        {
          provider: "twitter",
          name: "Twitter / X",
          config: {
            access_token: "x-user-token",
          },
          toolSpecs: [
            {
              name: "twitter_post_tweet",
              operation: "tweets.create",
            },
          ],
        },
      ],
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.x.com/2/tweets",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer x-user-token",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          text: "Hello from Nora",
          reply: { in_reply_to_tweet_id: "1899999999999999999" },
        }),
      }),
    );
    expect(result.result.tweet).toEqual(
      expect.objectContaining({
        id: "1900000000000000000",
        text: "Hello from Nora",
      }),
    );
  });

  it("posts a LinkedIn share through the connected user token", async () => {
    const fetchImpl = jest.fn().mockResolvedValueOnce({
      ok: true,
      status: 201,
      headers: {
        get: (name: string) =>
          String(name).toLowerCase() === "x-restli-id" ? "urn:li:share:123" : null,
      },
      text: async () => "",
    });

    const result = await executeIntegrationToolInvocation({
      toolName: "linkedin_post_share",
      input: { text: "Hello from Nora", visibility: "PUBLIC" },
      integrations: [
        {
          provider: "linkedin",
          name: "LinkedIn",
          config: {
            access_token: "linkedin-user-token",
            sub: "person-123",
          },
          toolSpecs: [
            {
              name: "linkedin_post_share",
              operation: "ugcPosts.create",
            },
          ],
        },
      ],
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.linkedin.com/v2/ugcPosts",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer linkedin-user-token",
          "Content-Type": "application/json",
          "X-Restli-Protocol-Version": "2.0.0",
        }),
        body: JSON.stringify({
          author: "urn:li:person:person-123",
          lifecycleState: "PUBLISHED",
          specificContent: {
            "com.linkedin.ugc.ShareContent": {
              shareCommentary: { text: "Hello from Nora" },
              shareMediaCategory: "NONE",
            },
          },
          visibility: {
            "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC",
          },
        }),
      }),
    );
    expect(result.result.share).toEqual(
      expect.objectContaining({
        id: "urn:li:share:123",
        author: "urn:li:person:person-123",
        text: "Hello from Nora",
        visibility: "PUBLIC",
      }),
    );
  });

  it("lists tweets for the configured Twitter/X username", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            data: {
              id: "2244994945",
              username: "openai",
              name: "OpenAI",
            },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            data: [
              {
                id: "1900000000000000001",
                text: "Research update",
                author_id: "2244994945",
                created_at: "2026-04-10T00:00:00Z",
              },
            ],
            meta: {
              result_count: 1,
            },
          }),
      });

    const result = await executeIntegrationToolInvocation({
      toolName: "twitter_list_user_tweets",
      input: { max_results: 5, exclude: ["retweets", "replies"] },
      integrations: [
        {
          provider: "twitter",
          name: "Twitter / X",
          config: {
            access_token: "x-user-token",
            default_username: "openai",
          },
          toolSpecs: [
            {
              name: "twitter_list_user_tweets",
              operation: "users.tweets.list",
            },
          ],
        },
      ],
      fetchImpl,
    });

    const lookupUrl = new URL(fetchImpl.mock.calls[0][0]);
    expect(lookupUrl.pathname).toBe("/2/users/by/username/openai");
    expect(lookupUrl.searchParams.get("user.fields")).toBe(
      "description,profile_image_url,public_metrics,verified",
    );

    const tweetsUrl = new URL(fetchImpl.mock.calls[1][0]);
    expect(tweetsUrl.pathname).toBe("/2/users/2244994945/tweets");
    expect(tweetsUrl.searchParams.get("max_results")).toBe("5");
    expect(tweetsUrl.searchParams.get("exclude")).toBe("retweets,replies");
    expect(tweetsUrl.searchParams.get("tweet.fields")).toBe(
      "author_id,conversation_id,created_at,public_metrics",
    );
    expect(result.result.tweets).toEqual([
      expect.objectContaining({
        id: "1900000000000000001",
        text: "Research update",
      }),
    ]);
  });

  it("builds a generated skill that references credentials and executable tools", () => {
    const markdown = buildIntegrationSkillMarkdown([
      {
        provider: "github",
        name: "GitHub",
        capabilities: ["read", "write"],
        credentialEnv: {
          primary: "GITHUB_TOKEN",
          config: { org: "GITHUB_ORG" },
        },
        config: {
          personal_access_token: "ghp_test",
          org: "openai",
        },
        redactedConfig: {
          personal_access_token: "[REDACTED]",
          org: "openai",
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
      {
        provider: "slack",
        name: "Slack",
        credentialEnv: {
          primary: "SLACK_TOKEN",
          config: { default_channel: "SLACK_DEFAULT_CHANNEL" },
        },
        config: {
          bot_token: "xoxb-secret",
          default_channel: "#ops",
        },
        redactedConfig: {
          bot_token: "[REDACTED]",
          default_channel: "#ops",
        },
        api: {
          type: "rest",
          baseUrl: "https://slack.com/api",
        },
        toolSpecs: [],
      },
    ]);

    expect(markdown).toContain("nora-integration-tool");
    expect(markdown).toContain("/root/.openclaw/workspace/integrations/integrations.json");
    expect(markdown).toContain("github_list_repositories");
    expect(markdown).toContain("nora_slack_integration");
    expect(markdown).toContain("GITHUB_TOKEN");
    expect(markdown).toContain("SLACK_TOKEN");
    expect(markdown).toContain("default_channel: #ops");
    expect(markdown).not.toContain("ghp_test");
    expect(markdown).not.toContain("xoxb-secret");
  });

  it("does not expose built-in email processing tools through the runtime skill", () => {
    const emailIntegration = { provider: "email" };
    const ops = [
      { name: "email_list_new_messages", operation: "messages.list_new" },
      { name: "email_get_message", operation: "messages.get" },
      { name: "email_send_message", operation: "messages.send" },
      { name: "email_send_reply", operation: "messages.reply" },
      { name: "email_mark_processed", operation: "messages.mark_processed" },
    ];
    for (const spec of ops) {
      const meta = buildIntegrationToolExecutionMetadata(emailIntegration, spec);
      expect(meta.executable).toBe(false);
      expect(meta.executionState).toBe("manifest_only");
      expect(meta.invokeCommand).toBeNull();
    }
  });

  it("normalizes a plain-text email message", () => {
    const raw = [
      "From: Alice <alice@example.com>",
      "To: Bob <bob@example.com>",
      "Subject: Hello",
      "Date: Thu, 01 Jan 2026 12:00:00 +0000",
      "Message-ID: <abc@example.com>",
      "In-Reply-To: <prev@example.com>",
      "References: <prev@example.com>",
      "",
      "Hi Bob, this is the body.",
    ].join("\r\n");

    const msg = normalizeEmailMessage(101, raw, {});

    expect(msg.uid).toBe(101);
    expect(msg.messageId).toBe("<abc@example.com>");
    expect(msg.subject).toBe("Hello");
    expect(msg.from).toEqual([
      { name: "Alice", address: "alice@example.com", raw: "Alice <alice@example.com>" },
    ]);
    expect(msg.to).toEqual([
      { name: "Bob", address: "bob@example.com", raw: "Bob <bob@example.com>" },
    ]);
    expect(msg.inReplyTo).toBe("<prev@example.com>");
    expect(msg.references).toBe("<prev@example.com>");
    expect(msg.textBody).toBe("Hi Bob, this is the body.");
    expect(msg.htmlBody).toBe("");
    expect(msg.attachments).toEqual([]);
  });

  it("extracts htmlBody and textBody from a multipart/alternative message", () => {
    const boundary = "=_boundary_test";
    const raw = [
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Plain text version.",
      `--${boundary}`,
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>HTML <b>version</b>.</p>",
      `--${boundary}--`,
    ].join("\r\n");

    const msg = normalizeEmailMessage(42, raw, {});

    expect(msg.textBody).toBe("Plain text version.");
    expect(msg.htmlBody).toBe("<p>HTML <b>version</b>.</p>");
    expect(msg.attachments).toEqual([]);
  });

  it("strips script and event handler tags from htmlBody", () => {
    const boundary = "=_xss_boundary";
    const raw = [
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/html; charset=utf-8",
      "",
      '<p onclick="evil()">Hello</p><script>alert(1)</script><style>body{}</style>',
      `--${boundary}--`,
    ].join("\r\n");

    const msg = normalizeEmailMessage(99, raw, {});

    expect(msg.htmlBody).not.toContain("<script>");
    expect(msg.htmlBody).not.toContain("<style>");
    expect(msg.htmlBody).not.toContain("onclick=");
    expect(msg.htmlBody).toContain("<p");
  });

  it("surfaces attachment metadata from a multipart/mixed message", () => {
    const boundary = "=_attach_boundary";
    const raw = [
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "See attached.",
      `--${boundary}`,
      'Content-Type: application/pdf; name="report.pdf"',
      'Content-Disposition: attachment; filename="report.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      "AAAA",
      `--${boundary}--`,
    ].join("\r\n");

    const msg = normalizeEmailMessage(55, raw, {});

    expect(msg.textBody).toBe("See attached.");
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0].filename).toBe("report.pdf");
    expect(msg.attachments[0].contentType).toBe("application/pdf");
    expect(typeof msg.attachments[0].size).toBe("number");
  });

  it("rejects removed email processing tools when invoked directly", async () => {
    await expect(
      executeIntegrationToolInvocation({
        toolName: "email_mark_processed",
        input: { uid: 77, messageId: "<dedupetest@example.com>", status: "processed" },
        integrations: [
          {
            id: "test-email",
            provider: "email",
            name: "Test Email",
            config: {
              auth: { mode: "basic", username: "test@example.com", password: "pass" },
              imap: { host: "imap.example.com", port: 993, secure: true },
              smtp: {
                host: "smtp.example.com",
                port: 465,
                secure: true,
                fromAddress: "test@example.com",
              },
            },
            toolSpecs: [{ name: "email_mark_processed", operation: "messages.mark_processed" }],
          },
        ],
      }),
    ).rejects.toThrow(/not executable/i);
  });
});
