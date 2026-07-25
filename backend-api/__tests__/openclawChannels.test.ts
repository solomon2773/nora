// @ts-nocheck
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const mockRpcCall = jest.fn();
const mockRunContainerCommand = jest.fn();
const mockDbQuery = jest.fn();

jest.mock("../gatewayProxy", () => ({
  rpcCall: (...args) => mockRpcCall(...args),
}));

jest.mock("../authSync", () => ({
  runContainerCommand: (...args) => mockRunContainerCommand(...args),
}));

jest.mock("../db", () => ({
  query: (...args) => mockDbQuery(...args),
}));

const {
  connectOpenClawChannel,
  getOpenClawChannelType,
  listOpenClawChannels,
  saveOpenClawChannel,
  startOpenClawChannelLogin,
  waitOpenClawChannelLogin,
} = require("../channels/openclaw");

describe("openclaw channel catalog compatibility", () => {
  const agent = {
    id: "agent-openclaw-1",
    runtime_family: "openclaw",
    status: "running",
  };

  beforeEach(() => {
    mockRpcCall.mockReset();
    mockRunContainerCommand.mockReset();
  });

  it("builds available channel types from metadata maps when channel order is missing", async () => {
    mockRpcCall
      .mockResolvedValueOnce({
        channelMeta: [
          {
            id: "telegram",
            label: "Telegram",
            detailLabel: "Telegram (Bot API)",
          },
        ],
        channelLabels: {
          whatsapp: "WhatsApp (QR link)",
        },
        channelDetailLabels: {
          whatsapp: "WhatsApp (QR link)",
        },
        channelSystemImages: {
          whatsapp: "systems/whatsapp.png",
        },
      })
      .mockResolvedValueOnce({
        hash: "cfg-1",
        config: { channels: {} },
      });

    const payload = await listOpenClawChannels(agent);

    expect(payload.runtime).toBe("openclaw");
    expect(payload.channels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "telegram",
          configured: false,
          enabled: false,
          actions: expect.objectContaining({ canDelete: false }),
        }),
        expect.objectContaining({
          type: "whatsapp",
          configured: false,
          enabled: false,
          actions: expect.objectContaining({ canQrLogin: true, canDelete: false }),
        }),
      ]),
    );
    expect(payload.availableTypes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "telegram",
          label: "Telegram (Bot API)",
          detailLabel: "Telegram (Bot API)",
        }),
        expect.objectContaining({
          type: "whatsapp",
          label: "WhatsApp (QR link)",
          detailLabel: "WhatsApp (QR link)",
          systemImage: "systems/whatsapp.png",
        }),
      ]),
    );
  });

  it("merges schema channel types when runtime status only reports active providers", async () => {
    mockRpcCall
      .mockResolvedValueOnce({
        channelOrder: ["qqbot"],
        channelMeta: [{ id: "qqbot", label: "QQ Bot" }],
        channels: {
          qqbot: {
            configured: false,
          },
        },
      })
      .mockResolvedValueOnce({
        hash: "cfg-partial",
        config: { channels: {} },
      })
      .mockResolvedValueOnce({
        children: [
          {
            key: "telegram",
            path: "channels.telegram",
            hint: { label: "Telegram", help: "Telegram bot API." },
          },
          {
            key: "whatsapp",
            path: "channels.whatsapp",
            hint: { label: "WhatsApp", help: "QR login." },
          },
        ],
      });

    const payload = await listOpenClawChannels(agent);

    expect(payload.availableTypes.map((entry) => entry.type)).toEqual(
      expect.arrayContaining(["qqbot", "telegram", "whatsapp"]),
    );
    expect(payload.availableTypes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "telegram",
          label: "Telegram (Bot API)",
        }),
        expect.objectContaining({
          type: "whatsapp",
          label: "WhatsApp (QR link)",
        }),
      ]),
    );
  });

  it("keeps runtime channel types when schema lookup is unavailable", async () => {
    mockRpcCall
      .mockResolvedValueOnce({
        channelMeta: [{ id: "qqbot", label: "QQ Bot" }],
      })
      .mockResolvedValueOnce({
        hash: "cfg-schema-unavailable",
        config: { channels: {} },
      })
      .mockRejectedValueOnce(new Error("schema lookup unavailable"));

    const payload = await listOpenClawChannels(agent);

    expect(payload.availableTypes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "qqbot",
          label: "QQ Bot",
        }),
      ]),
    );
  });

  it.each(["__proto__", "constructor", "prototype"])(
    "rejects the unsafe OpenClaw channel id %s before gateway access",
    async (channelId) => {
      await expect(
        saveOpenClawChannel(agent, channelId, { enabled: true }, { create: true }),
      ).rejects.toMatchObject({
        statusCode: 400,
        message: "Invalid OpenClaw channel type.",
      });

      expect(mockRpcCall).not.toHaveBeenCalled();
    },
  );

  it("allows creating a metadata-only OpenClaw channel", async () => {
    mockRpcCall
      .mockResolvedValueOnce({
        channelMeta: [{ id: "telegram", label: "Telegram" }],
      })
      .mockResolvedValueOnce({
        hash: "cfg-2",
        config: { channels: {} },
      })
      .mockResolvedValueOnce({
        restart: "requested",
      });

    const result = await saveOpenClawChannel(
      agent,
      "telegram",
      {
        config: {
          botToken: "secret-token",
        },
      },
      { create: true },
    );

    expect(result).toEqual({
      success: true,
      channel: "telegram",
      restart: "requested",
    });
    // The saved patch is also persisted (encrypted) so redeploys can reseed
    // channel config — the runtime's openclaw.json dies with the container.
    const persistCall = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes("openclaw_channel_state"),
    );
    expect(persistCall).toBeTruthy();
    expect(persistCall[1][0]).toBe("agent-openclaw-1");
    expect(persistCall[1][1]).toBe("telegram");
    expect(String(persistCall[1][2])).not.toContain("secret-token");
    expect(mockRpcCall).toHaveBeenCalledTimes(3);
    expect(mockRpcCall).toHaveBeenNthCalledWith(
      3,
      agent,
      "config.patch",
      {
        raw: JSON.stringify({
          channels: {
            telegram: {
              enabled: true,
              botToken: "secret-token",
            },
          },
        }),
        baseHash: "cfg-2",
      },
      undefined,
    );
  });

  it("seeds WhatsApp config before starting QR login", async () => {
    mockRpcCall
      .mockResolvedValueOnce({
        channelMeta: [{ id: "whatsapp", label: "WhatsApp" }],
      })
      .mockResolvedValueOnce({
        hash: "cfg-connect",
        config: { channels: {} },
      })
      .mockResolvedValueOnce({
        restart: "requested",
      })
      .mockResolvedValueOnce({
        qrDataUrl: "data:image/png;base64,qr",
        message: "Scan this QR in WhatsApp.",
      });

    const result = await connectOpenClawChannel(agent, "whatsapp", {
      force: true,
      timeoutMs: 30000,
    });

    expect(result).toMatchObject({
      success: true,
      channel: "whatsapp",
      restart: "requested",
      qrDataUrl: "data:image/png;base64,qr",
      login: {
        qrDataUrl: "data:image/png;base64,qr",
      },
    });
    expect(mockRpcCall).toHaveBeenNthCalledWith(
      3,
      agent,
      "config.patch",
      {
        raw: JSON.stringify({
          plugins: {
            entries: {
              whatsapp: {
                enabled: true,
              },
            },
          },
          channels: {
            whatsapp: {
              enabled: true,
              accounts: {
                default: {
                  enabled: true,
                },
              },
            },
          },
        }),
        baseHash: "cfg-connect",
      },
      undefined,
    );
    expect(mockRpcCall).toHaveBeenNthCalledWith(
      4,
      agent,
      "web.login.start",
      {
        force: true,
        timeoutMs: 30000,
      },
      undefined,
    );
  });

  it("retries QR login when the channel config restart briefly closes the gateway", async () => {
    mockRpcCall
      .mockResolvedValueOnce({
        channelMeta: [{ id: "whatsapp", label: "WhatsApp" }],
      })
      .mockResolvedValueOnce({
        hash: "cfg-connect-restart",
        config: { channels: {} },
      })
      .mockResolvedValueOnce({
        restart: "requested",
      })
      .mockRejectedValueOnce(new Error("Gateway connection closed"))
      .mockResolvedValueOnce({
        qrDataUrl: "data:image/png;base64,qr-after-restart",
        message: "Scan this QR in WhatsApp.",
      });

    const result = await connectOpenClawChannel(agent, "whatsapp", {
      force: true,
      timeoutMs: 30000,
    });

    expect(result).toMatchObject({
      success: true,
      channel: "whatsapp",
      restart: "requested",
      qrDataUrl: "data:image/png;base64,qr-after-restart",
    });
    expect(mockRpcCall).toHaveBeenNthCalledWith(
      4,
      agent,
      "web.login.start",
      {
        force: true,
        timeoutMs: 30000,
      },
      undefined,
    );
    expect(mockRpcCall).toHaveBeenNthCalledWith(
      5,
      agent,
      "web.login.start",
      {
        force: true,
        timeoutMs: 30000,
      },
      undefined,
    );
  });

  it("waits for the config restart when QR login is not loaded immediately after connect", async () => {
    mockRpcCall
      .mockResolvedValueOnce({
        channelMeta: [{ id: "whatsapp", label: "WhatsApp" }],
      })
      .mockResolvedValueOnce({
        hash: "cfg-connect-install",
        config: { channels: {} },
      })
      .mockResolvedValueOnce({
        restart: "requested",
      })
      .mockRejectedValueOnce(
        Object.assign(new Error("web login provider is not available"), {
          code: "INVALID_REQUEST",
        }),
      )
      .mockResolvedValueOnce({
        qrDataUrl: "data:image/png;base64,qr-after-install",
        message: "Scan this QR in WhatsApp.",
      });
    const result = await connectOpenClawChannel(agent, "whatsapp", {
      force: true,
      accountId: "default",
      timeoutMs: 30000,
    });

    expect(result).toMatchObject({
      success: true,
      channel: "whatsapp",
      qrDataUrl: "data:image/png;base64,qr-after-install",
    });
    expect(mockRunContainerCommand).not.toHaveBeenCalled();
    expect(mockRpcCall).toHaveBeenNthCalledWith(
      5,
      agent,
      "web.login.start",
      {
        force: true,
        accountId: "default",
        timeoutMs: 30000,
      },
      undefined,
    );
  });

  it("enables and restarts the bundled WhatsApp provider when QR login is still unavailable", async () => {
    mockRpcCall
      .mockRejectedValueOnce(
        Object.assign(new Error("web login provider is not available"), {
          code: "INVALID_REQUEST",
        }),
      )
      .mockResolvedValueOnce({
        qrDataUrl: "data:image/png;base64,qr-after-enable",
        message: "Scan this QR in WhatsApp.",
      });
    mockRunContainerCommand.mockResolvedValueOnce({
      exitCode: 0,
      output: "enabled",
    });

    const result = await startOpenClawChannelLogin(agent, "whatsapp", {
      force: true,
      accountId: "default",
      timeoutMs: 30000,
    });

    expect(result).toMatchObject({
      qrDataUrl: "data:image/png;base64,qr-after-enable",
    });
    expect(mockRunContainerCommand).toHaveBeenCalledWith(
      agent,
      expect.stringContaining('plugins enable "$plugin_id"'),
      { timeout: 240000 },
    );
    expect(mockRunContainerCommand.mock.calls[0][1]).toContain("PLUGIN_ID='whatsapp'");
    expect(mockRunContainerCommand.mock.calls[0][1]).toContain(
      "OPENCLAW_PLUGIN_INSTALL_MAX_OLD_SPACE_MB:-256",
    );
    expect(mockRunContainerCommand.mock.calls[0][1]).toContain('kill -USR1 "$pid"');
    expect(mockRunContainerCommand.mock.calls[0][1]).toContain("gateway restart");
    expect(mockRpcCall).toHaveBeenNthCalledWith(
      2,
      agent,
      "web.login.start",
      {
        force: true,
        accountId: "default",
        timeoutMs: 30000,
      },
      undefined,
    );
  });

  it("explains code 137 WhatsApp provider enable failures as a killed activation helper", async () => {
    mockRpcCall.mockRejectedValueOnce(
      Object.assign(new Error("web login provider is not available"), {
        code: "INVALID_REQUEST",
      }),
    );
    const killed = new Error("Container command exited with code 137");
    killed.exitCode = 137;
    mockRunContainerCommand.mockRejectedValueOnce(killed);

    await expect(
      startOpenClawChannelLogin(agent, "whatsapp", {
        force: true,
        timeoutMs: 30000,
      }),
    ).rejects.toMatchObject({
      statusCode: 502,
      message: expect.stringContaining("container restarted or the host killed the helper"),
    });
  });

  it("lists channel types from the config schema when runtime status exposes no catalog", async () => {
    mockRpcCall
      .mockResolvedValueOnce({
        channelMeta: [],
        channelOrder: [],
        channels: {},
      })
      .mockResolvedValueOnce({
        hash: "cfg-2b",
        config: { channels: {} },
      })
      .mockResolvedValueOnce({
        path: "channels",
        children: [
          {
            key: "signal",
            path: "channels.signal",
            required: false,
            hasChildren: true,
            hint: {
              label: "Signal",
              help: "Signal bridge settings.",
            },
          },
          {
            key: "telegram",
            path: "channels.telegram",
            required: false,
            hasChildren: true,
            hint: {
              label: "Telegram",
              help: "Telegram bot settings.",
            },
          },
        ],
      });

    const payload = await listOpenClawChannels(agent);

    expect(payload.availableTypes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "signal",
        }),
        expect.objectContaining({
          type: "telegram",
        }),
      ]),
    );
  });

  it("allows creating a schema-only OpenClaw channel", async () => {
    mockRpcCall
      .mockResolvedValueOnce({
        channelMeta: [],
        channelOrder: [],
        channels: {},
      })
      .mockResolvedValueOnce({
        hash: "cfg-2c",
        config: { channels: {} },
      })
      .mockResolvedValueOnce({
        path: "channels",
        children: [
          {
            key: "customchat",
            path: "channels.customchat",
            required: false,
            hasChildren: true,
            hint: {
              label: "Custom Chat",
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        restart: "requested",
      });

    const result = await saveOpenClawChannel(
      agent,
      "customchat",
      {
        config: {
          socketPath: "/tmp/signal.sock",
        },
      },
      { create: true },
    );

    expect(result).toEqual({
      success: true,
      channel: "customchat",
      restart: "requested",
    });
    expect(mockRpcCall).toHaveBeenNthCalledWith(
      4,
      agent,
      "config.patch",
      {
        raw: JSON.stringify({
          channels: {
            customchat: {
              enabled: true,
              socketPath: "/tmp/signal.sock",
            },
          },
        }),
        baseHash: "cfg-2c",
      },
      undefined,
    );
  });

  it("connects non-QR OpenClaw channels by saving setup and enabling them", async () => {
    mockRpcCall
      .mockResolvedValueOnce({
        channelMeta: [{ id: "telegram", label: "Telegram" }],
      })
      .mockResolvedValueOnce({
        hash: "cfg-connect-telegram",
        config: { channels: {} },
      })
      .mockResolvedValueOnce({
        restart: "requested",
      });

    const result = await connectOpenClawChannel(agent, "telegram", {
      config: { botToken: "secret-token" },
    });

    expect(result).toEqual({
      success: true,
      channel: "telegram",
      restart: "requested",
      linked: true,
    });
    expect(mockRpcCall).toHaveBeenNthCalledWith(
      3,
      agent,
      "config.patch",
      {
        raw: JSON.stringify({
          channels: {
            telegram: {
              enabled: true,
              botToken: "secret-token",
            },
          },
        }),
        baseHash: "cfg-connect-telegram",
      },
      undefined,
    );
  });

  it("returns docs-backed setup fields when gateway schema has no editable fields", async () => {
    mockRpcCall
      .mockResolvedValueOnce({
        channelMeta: [{ id: "telegram", label: "Telegram" }],
      })
      .mockResolvedValueOnce({
        hash: "cfg-type-telegram",
        config: { channels: {} },
      });

    const result = await getOpenClawChannelType(agent, "telegram");

    expect(result).toMatchObject({
      type: "telegram",
      description: expect.stringContaining("Telegram bot"),
      configFields: [
        expect.objectContaining({
          key: "botToken",
          type: "password",
          required: true,
        }),
      ],
    });
    expect(mockRpcCall).toHaveBeenCalledTimes(2);
  });

  it("returns minimum Slack setup fields with conditional credential requirements", async () => {
    mockRpcCall
      .mockResolvedValueOnce({
        channelMeta: [{ id: "slack", label: "Slack" }],
      })
      .mockResolvedValueOnce({
        hash: "cfg-type-slack",
        config: { channels: {} },
      });

    const result = await getOpenClawChannelType(agent, "slack");

    expect(result.configFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "mode",
          type: "select",
          defaultValue: "socket",
        }),
        expect.objectContaining({
          key: "botToken",
          type: "password",
          required: true,
        }),
        expect.objectContaining({
          key: "appToken",
          requiredWhen: { key: "mode", value: "socket" },
        }),
        expect.objectContaining({
          key: "signingSecret",
          requiredWhen: { key: "mode", value: "http" },
        }),
      ]),
    );
    expect(mockRpcCall).toHaveBeenCalledTimes(2);
  });

  it("returns QR login metadata without schema walking for pairing-only channels", async () => {
    mockRpcCall
      .mockResolvedValueOnce({
        channelMeta: [{ id: "feishu", label: "Feishu" }],
      })
      .mockResolvedValueOnce({
        hash: "cfg-type-feishu",
        config: { channels: {} },
      });

    const result = await getOpenClawChannelType(agent, "feishu");

    expect(result).toMatchObject({
      type: "feishu",
      configFields: [],
      actions: {
        canQrLogin: true,
        loginKind: "cli",
      },
      hasComplexFields: false,
    });
    expect(mockRpcCall).toHaveBeenCalledTimes(2);
  });

  it("starts and polls allowlisted OpenClaw CLI login channels", async () => {
    mockRunContainerCommand
      .mockResolvedValueOnce({
        exitCode: 0,
        output:
          '__NORA_OPENCLAW_LOGIN_OUTPUT__\nScan this Feishu QR\n__NORA_OPENCLAW_LOGIN_STATUS__\n{"status":"running"}',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        output:
          '__NORA_OPENCLAW_LOGIN_OUTPUT__\nFeishu linked\n__NORA_OPENCLAW_LOGIN_STATUS__\n{"status":"complete","exitCode":0}',
      });

    const start = await connectOpenClawChannel(agent, "feishu", {
      accountId: "default",
    });
    const wait = await waitOpenClawChannelLogin(agent, "feishu");

    expect(start).toMatchObject({
      success: true,
      channel: "feishu",
      qrText: "Scan this Feishu QR",
      login: expect.objectContaining({
        success: false,
        status: "running",
      }),
    });
    expect(wait).toMatchObject({
      success: true,
      channel: "feishu",
      linked: true,
      connected: true,
      status: "complete",
    });
    expect(mockRunContainerCommand).toHaveBeenNthCalledWith(
      1,
      agent,
      expect.stringContaining('channels login --channel "$channel_id"'),
      { timeout: 15000 },
    );
    expect(mockRunContainerCommand.mock.calls[0][1]).toContain("CHANNEL_ID='feishu'");
    expect(mockRunContainerCommand.mock.calls[1][1]).toContain(
      "/tmp/nora-openclaw-channel-login/feishu",
    );
  });

  it("rejects CLI login for setup-only channels", async () => {
    await expect(startOpenClawChannelLogin(agent, "telegram")).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("does not expose QR login"),
    });
    expect(mockRunContainerCommand).not.toHaveBeenCalled();
  });
});
