import type { Config } from "jest";

const config: Config = {
  testEnvironment: "node",
  testMatch: ["**/__tests__/**/*.test.ts"],
  moduleFileExtensions: ["ts", "js", "json", "node"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "tsconfig.json", diagnostics: false }],
  },
  testTimeout: 10000,
};

export default config;
