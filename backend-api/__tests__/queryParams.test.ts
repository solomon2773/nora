// @ts-nocheck

const { queryArrayParam } = require("../lib/queryParams");

describe("queryArrayParam", () => {
  it("returns undefined when the parameter is absent in every spelling", () => {
    expect(queryArrayParam({}, "levels")).toBeUndefined();
    expect(queryArrayParam(undefined, "levels")).toBeUndefined();
  });

  it("reads a single value and a comma-separated list", () => {
    expect(queryArrayParam({ levels: "ERROR" }, "levels")).toEqual(["ERROR"]);
    expect(queryArrayParam({ levels: "ERROR, WARN" }, "levels")).toEqual(["ERROR", "WARN"]);
  });

  it("reads repeated parameters (parsed by Express as an array)", () => {
    expect(queryArrayParam({ streams: ["runtime", "gateway"] }, "streams")).toEqual([
      "runtime",
      "gateway",
    ]);
  });

  it("reads the bracket form, which Express 5 leaves as a literal 'name[]' key", () => {
    expect(queryArrayParam({ "levels[]": "ERROR" }, "levels")).toEqual(["ERROR"]);
    expect(queryArrayParam({ "streams[]": ["runtime", "gateway"] }, "streams")).toEqual([
      "runtime",
      "gateway",
    ]);
  });

  it("merges both spellings when a caller mixes them", () => {
    expect(queryArrayParam({ levels: "ERROR", "levels[]": "WARN" }, "levels")).toEqual([
      "ERROR",
      "WARN",
    ]);
  });

  it("drops empty entries instead of producing a filter that matches nothing by accident", () => {
    expect(queryArrayParam({ levels: " , " }, "levels")).toEqual([]);
  });
});
