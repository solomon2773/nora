// @ts-nocheck
const {
  computeMissingSavedSkills,
  normalizeSavedSkillEntries,
} = require("../../agent-runtime/lib/clawhubReconciliation");

describe("clawhub reconciliation helpers", () => {
  it("returns no missing skills when nothing is saved", () => {
    expect(computeMissingSavedSkills([], [{ slug: "github", version: "1.0.0" }])).toEqual([]);
  });

  it("returns no missing skills when all saved skills are already installed", () => {
    const savedSkills = [
      { installSlug: "github", author: "steipete" },
      { installSlug: "notion", author: "dimagious" },
    ];
    const installedSkills = [
      { slug: "github", version: "1.0.0" },
      { slug: "notion", version: "2.0.0" },
    ];

    expect(computeMissingSavedSkills(savedSkills, installedSkills)).toEqual([]);
  });

  it("returns only the saved skills missing from the new container", () => {
    const savedSkills = [
      { installSlug: "github", author: "steipete" },
      { installSlug: "notion", author: "dimagious" },
      { installSlug: "slack", author: "acme" },
    ];
    const installedSkills = [{ slug: "github", version: "1.0.0" }];

    expect(computeMissingSavedSkills(savedSkills, installedSkills)).toEqual([
      expect.objectContaining({ installSlug: "notion", author: "dimagious" }),
      expect.objectContaining({ installSlug: "slack", author: "acme" }),
    ]);
  });

  it("deduplicates repeated saved entries and ignores invalid ones", () => {
    const normalized = normalizeSavedSkillEntries([
      { installSlug: "github", author: "steipete" },
      { installSlug: "github", author: "steipete" },
      { slug: "github", author: "steipete" },
      { installSlug: "notion", author: "dimagious" },
      { installSlug: "", author: "nobody" },
      null,
    ]);

    expect(normalized).toHaveLength(2);
    expect(normalized).toEqual([
      expect.objectContaining({ installSlug: "github", author: "steipete" }),
      expect.objectContaining({ installSlug: "notion", author: "dimagious" }),
    ]);
  });
});
