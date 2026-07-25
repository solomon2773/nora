// @ts-nocheck
const {
  DEFAULT_CLAWHUB_BASE_URL,
  normalizeSkillSummary,
  normalizeSkillListPayload,
  normalizeSkillDetailPayload,
  parseSkillMarkdown,
  normalizeInstallEntry,
  normalizeRequirements,
} = require("../clawhubClient");

describe("DEFAULT_CLAWHUB_BASE_URL", () => {
  it("is the public clawhub.ai URL", () => {
    expect(DEFAULT_CLAWHUB_BASE_URL).toBe("https://clawhub.ai");
  });
});

describe("normalizeSkillSummary", () => {
  it("normalizes a fully populated source object", () => {
    const summary = normalizeSkillSummary({
      slug: "gh-cli",
      name: "GitHub CLI",
      description: "Work with GitHub PRs",
      downloads: 1234,
      stars: 56,
      updatedAt: "2026-06-01T00:00:00.000Z",
    });

    expect(summary).toEqual({
      slug: "gh-cli",
      name: "GitHub CLI",
      description: "Work with GitHub PRs",
      downloads: 1234,
      stars: 56,
      updatedAt: "2026-06-01T00:00:00.000Z",
    });
  });

  it("falls back through alternate slug keys", () => {
    expect(normalizeSkillSummary({ installSlug: "a" }).slug).toBe("a");
    expect(normalizeSkillSummary({ pagePath: "b" }).slug).toBe("b");
    expect(normalizeSkillSummary({ id: "c" }).slug).toBe("c");
  });

  it("falls back through alternate name and description keys", () => {
    const summary = normalizeSkillSummary({ slug: "x", displayName: "X", summary: "desc" });
    expect(summary.name).toBe("X");
    expect(summary.description).toBe("desc");
  });

  it("uses the slug as the name fallback when name is missing", () => {
    expect(normalizeSkillSummary({ slug: "gh-cli" }).name).toBe("gh-cli");
  });

  it("falls back through alternate download and star keys", () => {
    expect(normalizeSkillSummary({ slug: "x", download_count: 7 }).downloads).toBe(7);
    expect(normalizeSkillSummary({ slug: "x", downloadCount: 8 }).downloads).toBe(8);
    expect(normalizeSkillSummary({ slug: "x", stats: { downloads: 9 } }).downloads).toBe(9);
    expect(normalizeSkillSummary({ slug: "x", star_count: 1 }).stars).toBe(1);
    expect(normalizeSkillSummary({ slug: "x", starCount: 2 }).stars).toBe(2);
    expect(normalizeSkillSummary({ slug: "x", stats: { stars: 3 } }).stars).toBe(3);
  });

  it("falls back through alternate updated keys", () => {
    expect(
      normalizeSkillSummary({ slug: "x", updated_at: "2026-01-01T00:00:00.000Z" }).updatedAt,
    ).toBe("2026-01-01T00:00:00.000Z");
    expect(
      normalizeSkillSummary({ slug: "x", updated_at_at: "2026-02-01T00:00:00.000Z" }).updatedAt,
    ).toBe("2026-02-01T00:00:00.000Z");
    expect(
      normalizeSkillSummary({ slug: "x", updated: "2026-03-01T00:00:00.000Z" }).updatedAt,
    ).toBe("2026-03-01T00:00:00.000Z");
  });

  it("reads fields from item.skill when present", () => {
    const summary = normalizeSkillSummary({
      skill: { slug: "nested", name: "Nested", downloads: 3 },
    });
    expect(summary.slug).toBe("nested");
    expect(summary.name).toBe("Nested");
    expect(summary.downloads).toBe(3);
  });

  it("returns null when no slug can be derived", () => {
    expect(normalizeSkillSummary({})).toBeNull();
    expect(normalizeSkillSummary({ name: "no slug" })).toBeNull();
  });

  it("returns null for null input", () => {
    expect(normalizeSkillSummary(null)).toBeNull();
  });

  it("returns null for undefined input via default param", () => {
    // undefined triggers the default param (item = {}), so no slug is found.
    expect(normalizeSkillSummary(undefined)).toBeNull();
  });

  it("trims whitespace from slug and description", () => {
    const summary = normalizeSkillSummary({
      slug: "  spaced  ",
      description: "  trim me  ",
    });
    expect(summary.slug).toBe("spaced");
    expect(summary.description).toBe("trim me");
  });

  it("coerces numeric downloads/stars to numbers and rejects negatives", () => {
    expect(normalizeSkillSummary({ slug: "x", downloads: "42" }).downloads).toBe(42);
    expect(normalizeSkillSummary({ slug: "x", stars: "7" }).stars).toBe(7);
    expect(normalizeSkillSummary({ slug: "x", downloads: -1 }).downloads).toBeNull();
    expect(normalizeSkillSummary({ slug: "x", stars: -5 }).stars).toBeNull();
  });

  it("returns null for non-finite numeric values", () => {
    expect(normalizeSkillSummary({ slug: "x", downloads: Infinity }).downloads).toBeNull();
    expect(normalizeSkillSummary({ slug: "x", stars: NaN }).stars).toBeNull();
  });

  it("returns null updatedAt for invalid dates", () => {
    expect(normalizeSkillSummary({ slug: "x", updatedAt: "not-a-date" }).updatedAt).toBeNull();
  });
});

describe("normalizeSkillListPayload", () => {
  it("maps an array payload through normalizeSkillSummary", () => {
    const result = normalizeSkillListPayload([
      { slug: "a", name: "A" },
      { slug: "b", name: "B" },
    ]);
    expect(result.skills).toHaveLength(2);
    expect(result.skills[0].slug).toBe("a");
    expect(result.skills[1].slug).toBe("b");
    expect(result.cursor).toBeNull();
  });

  it("reads lists from alternate container keys", () => {
    expect(normalizeSkillListPayload({ skills: [{ slug: "a" }] }).skills).toHaveLength(1);
    expect(normalizeSkillListPayload({ results: [{ slug: "a" }] }).skills).toHaveLength(1);
    expect(normalizeSkillListPayload({ items: [{ slug: "a" }] }).skills).toHaveLength(1);
  });

  it("extracts the cursor from alternate keys", () => {
    expect(normalizeSkillListPayload({ cursor: "abc" }).cursor).toBe("abc");
    expect(normalizeSkillListPayload({ nextCursor: "abc" }).cursor).toBe("abc");
    expect(normalizeSkillListPayload({ next_cursor: "abc" }).cursor).toBe("abc");
    expect(normalizeSkillListPayload({ next: "abc" }).cursor).toBe("abc");
  });

  it("filters out items that fail normalization", () => {
    const result = normalizeSkillListPayload([
      { slug: "valid" },
      { name: "missing slug" },
      {},
      null,
    ]);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].slug).toBe("valid");
  });

  it("returns an empty list for nullish or non-array payloads", () => {
    expect(normalizeSkillListPayload(null)).toEqual({ skills: [], cursor: null });
    expect(normalizeSkillListPayload(undefined)).toEqual({ skills: [], cursor: null });
    expect(normalizeSkillListPayload({})).toEqual({ skills: [], cursor: null });
    expect(normalizeSkillListPayload("not-an-array")).toEqual({ skills: [], cursor: null });
  });

  it("trims whitespace from the cursor", () => {
    expect(normalizeSkillListPayload({ cursor: "  x  " }).cursor).toBe("x");
  });

  it("returns null cursor when the value is empty after trimming", () => {
    expect(normalizeSkillListPayload({ cursor: "   " }).cursor).toBeNull();
  });
});

describe("normalizeSkillDetailPayload", () => {
  it("builds a detail object from metadata and readme", () => {
    const detail = normalizeSkillDetailPayload(
      { slug: "gh-cli", name: "GitHub CLI", description: "PRs" },
      "# GitHub CLI\n\nDo things.",
    );
    expect(detail).toMatchObject({
      slug: "gh-cli",
      name: "GitHub CLI",
      description: "PRs",
      author: "",
      pagePath: "gh-cli",
      readme: "# GitHub CLI\n\nDo things.",
    });
  });

  it("builds pagePath as author/slug when owner.handle is present", () => {
    const detail = normalizeSkillDetailPayload(
      {
        slug: "gh-cli",
        name: "GitHub CLI",
        owner: { handle: "octocat" },
      },
      "",
    );
    expect(detail.author).toBe("octocat");
    expect(detail.pagePath).toBe("octocat/gh-cli");
  });

  it("reads metadata from metadata.skill when present", () => {
    const detail = normalizeSkillDetailPayload({ skill: { slug: "nested", name: "Nested" } }, "");
    expect(detail.slug).toBe("nested");
    expect(detail.name).toBe("Nested");
  });

  it("returns null when no slug can be derived", () => {
    expect(normalizeSkillDetailPayload({}, "")).toBeNull();
    expect(normalizeSkillDetailPayload({ name: "no slug" }, "")).toBeNull();
  });

  it("returns null for null metadata", () => {
    expect(normalizeSkillDetailPayload(null, "")).toBeNull();
  });

  it("returns null for undefined metadata via default param", () => {
    // undefined triggers the default param (metadata = {}), so no slug is found.
    expect(normalizeSkillDetailPayload(undefined, "")).toBeNull();
  });

  it("falls back to metadata requirements when readme has none", () => {
    const detail = normalizeSkillDetailPayload(
      {
        slug: "gh-cli",
        metadata: {
          openclaw: {
            requires: { bins: ["gh"], env: ["GITHUB_TOKEN"] },
          },
        },
      },
      "# Plain readme",
    );
    expect(detail.requirements).toEqual({
      bins: ["gh"],
      env: ["GITHUB_TOKEN"],
      config: [],
      install: [],
    });
  });

  it("prefers readme requirements over metadata requirements", () => {
    const detail = normalizeSkillDetailPayload(
      {
        slug: "gh-cli",
        metadata: {
          openclaw: { requires: { bins: ["ignored"] } },
        },
      },
      `---
metadata:
  openclaw:
    requires:
      bins:
        - gh
---
# Readme
`,
    );
    expect(detail.requirements.bins).toStrictEqual(["gh"]);
  });

  it("trims the author handle", () => {
    const detail = normalizeSkillDetailPayload({ slug: "x", owner: { handle: "  octocat  " } }, "");
    expect(detail.author).toBe("octocat");
    expect(detail.pagePath).toBe("octocat/x");
  });
});

describe("parseSkillMarkdown", () => {
  it("parses frontmatter and content from a SKILL.md", () => {
    const result = parseSkillMarkdown(`---
metadata:
  openclaw:
    requires:
      bins:
        - gh
      env:
        - GITHUB_TOKEN
      config: []
    install:
      - kind: node
        package: "@github/gh-cli"
---
# GitHub Skill

Ship PRs.
`);
    expect(result.readme).toBe("# GitHub Skill\n\nShip PRs.");
    expect(result.requirements).toEqual({
      bins: ["gh"],
      env: ["GITHUB_TOKEN"],
      config: [],
      install: [{ kind: "node", package: "@github/gh-cli" }],
    });
  });

  it("returns requirements null when no frontmatter exists", () => {
    const result = parseSkillMarkdown("# Just a readme\n\nNo frontmatter.");
    expect(result.readme).toBe("# Just a readme\n\nNo frontmatter.");
    expect(result.requirements).toBeNull();
  });

  it("returns requirements null when frontmatter has no openclaw", () => {
    const result = parseSkillMarkdown(`---
name: something
---
# Hi
`);
    expect(result.requirements).toBeNull();
  });

  it("supports top-level openclaw frontmatter key", () => {
    const result = parseSkillMarkdown(`---
openclaw:
  requires:
    bins:
      - gh
---
# Hi
`);
    expect(result.requirements).toEqual({
      bins: ["gh"],
      env: [],
      config: [],
      install: [],
    });
  });

  it("returns safe fallback for empty input", () => {
    expect(parseSkillMarkdown("")).toEqual({ readme: "", requirements: null });
  });

  it("returns safe fallback for non-string input", () => {
    expect(parseSkillMarkdown(null)).toEqual({ readme: "", requirements: null });
    expect(parseSkillMarkdown(undefined)).toEqual({ readme: "", requirements: null });
  });

  it("falls back to raw readme when gray-matter throws", () => {
    const malformed = `---
metadata: [
---
# Invalid frontmatter`;
    const result = parseSkillMarkdown(malformed);
    expect(result.readme).toBe(malformed);
    expect(result.requirements).toBeNull();
  });

  it("trims parsed readme content", () => {
    const result = parseSkillMarkdown(`---
---
# Hi


`);
    expect(result.readme).toBe("# Hi");
  });
});

describe("normalizeInstallEntry", () => {
  it("normalizes a well-formed entry", () => {
    expect(normalizeInstallEntry({ kind: "node", package: "@github/gh-cli" })).toEqual({
      kind: "node",
      package: "@github/gh-cli",
    });
  });

  it("falls back through alternate kind and package keys", () => {
    expect(normalizeInstallEntry({ type: "python", name: "requests" })).toEqual({
      kind: "python",
      package: "requests",
    });
    // "value" is in the skip list; only "manager" is preserved as an extra key.
    expect(normalizeInstallEntry({ manager: "brew", value: "gh" })).toEqual({
      kind: "brew",
      package: "gh",
      manager: "brew",
    });
  });

  it("defaults kind to unknown when missing", () => {
    expect(normalizeInstallEntry({ package: "gh" })).toEqual({
      kind: "unknown",
      package: "gh",
    });
  });

  it("preserves extra keys", () => {
    expect(normalizeInstallEntry({ kind: "node", package: "gh", version: "1.0" })).toEqual({
      kind: "node",
      package: "gh",
      version: "1.0",
    });
  });

  it("drops null-valued extra keys", () => {
    expect(normalizeInstallEntry({ kind: "node", package: "gh", extra: null })).toEqual({
      kind: "node",
      package: "gh",
    });
  });

  it("returns an unknown-kind entry for empty objects", () => {
    // An empty object yields no package, so only the default kind remains.
    expect(normalizeInstallEntry({})).toEqual({ kind: "unknown" });
  });

  it("returns null for nullish input", () => {
    expect(normalizeInstallEntry(null)).toBeNull();
    expect(normalizeInstallEntry(undefined)).toBeNull();
  });

  it("returns null for array input", () => {
    expect(normalizeInstallEntry([])).toBeNull();
  });

  it("coerces a non-object scalar into an unknown entry when truthy", () => {
    expect(normalizeInstallEntry("gh")).toEqual({ kind: "unknown", package: "gh" });
  });

  it("coerces a finite number scalar into an unknown entry", () => {
    // normalizeText(0) returns "0" because 0 is finite.
    expect(normalizeInstallEntry(0)).toEqual({ kind: "unknown", package: "0" });
  });
});

describe("normalizeRequirements", () => {
  it("returns null for nullish input", () => {
    expect(normalizeRequirements(null)).toBeNull();
    expect(normalizeRequirements(undefined)).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(normalizeRequirements("nope")).toBeNull();
  });

  it("returns null when no requirements are present", () => {
    expect(normalizeRequirements({})).toBeNull();
  });

  it("normalizes bins, env, and config arrays", () => {
    expect(
      normalizeRequirements({
        requires: { bins: ["gh"], env: ["TOKEN"], config: ["key"] },
      }),
    ).toEqual({
      bins: ["gh"],
      env: ["TOKEN"],
      config: ["key"],
      install: [],
    });
  });

  it("reads bins/env/config from top-level openclaw keys", () => {
    expect(
      normalizeRequirements({
        bins: ["gh"],
        env: ["TOKEN"],
        config: ["key"],
      }),
    ).toEqual({
      bins: ["gh"],
      env: ["TOKEN"],
      config: ["key"],
      install: [],
    });
  });

  it("coerces a single string bin/env/config entry into an array", () => {
    expect(
      normalizeRequirements({ requires: { bins: "gh", env: "TOKEN", config: "key" } }),
    ).toEqual({
      bins: ["gh"],
      env: ["TOKEN"],
      config: ["key"],
      install: [],
    });
  });

  it("filters out invalid entries from bins/env/config", () => {
    // Empty strings and whitespace are dropped; finite numbers are coerced to
    // strings (so 0 -> "0", 42 -> "42"); non-object entries are dropped.
    expect(
      normalizeRequirements({
        requires: {
          bins: ["gh", "", null, 0, "  "],
          env: ["TOKEN", 42],
          config: [{}],
        },
      }),
    ).toEqual({
      bins: ["gh", "0"],
      env: ["TOKEN", "42"],
      config: [],
      install: [],
    });
  });

  it("normalizes install entries and drops nulls", () => {
    // null entries are filtered; empty objects yield { kind: "unknown" }.
    expect(
      normalizeRequirements({
        install: [{ kind: "node", package: "gh" }, null, {}, { package: "valid-only" }],
      }),
    ).toEqual({
      bins: [],
      env: [],
      config: [],
      install: [
        { kind: "node", package: "gh" },
        { kind: "unknown" },
        { kind: "unknown", package: "valid-only" },
      ],
    });
  });

  it("returns a populated object when only install is set", () => {
    expect(
      normalizeRequirements({
        install: [{ kind: "node", package: "gh" }],
      }),
    ).toEqual({
      bins: [],
      env: [],
      config: [],
      install: [{ kind: "node", package: "gh" }],
    });
  });
});
