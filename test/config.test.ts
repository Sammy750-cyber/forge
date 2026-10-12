import { describe, expect, it } from "vitest";
import { MemoryFileSystem } from "../src/adapters/memory-fs.js";
import {
  findProjectConfig,
  loadConfigFile,
  loadEnvLayer,
  parseConfigObject,
} from "../src/core/config/load.js";
import { resolveConfig } from "../src/core/config/resolve.js";
import { DEFAULT_CONFIG } from "../src/core/config/schema.js";
import { ConfigError } from "../src/errors/index.js";
import { posix } from "./helpers/fixtures.js";

describe("resolveConfig", () => {
  it("uses defaults and reports them as the source", () => {
    const { values, sources } = resolveConfig([]);
    expect(values).toEqual(DEFAULT_CONFIG);
    expect(Object.values(sources).every((s) => s === "default")).toBe(true);
  });

  it("applies layers lowest to highest and tracks provenance per key", () => {
    const { values, sources } = resolveConfig([
      {
        source: "user",
        values: { ci: "gitlab", cloud: "aws", logLevel: "warn" },
      },
      { source: "project", values: { ci: "github", cloud: "gcp" } },
      { source: "env", values: { cloud: "azure" } },
      { source: "flag", values: { logLevel: "debug" } },
    ]);
    expect(values.ci).toBe("github");
    expect(values.cloud).toBe("azure");
    expect(values.logLevel).toBe("debug");
    expect(sources.ci).toBe("project");
    expect(sources.cloud).toBe("env");
    expect(sources.logLevel).toBe("flag");
    expect(sources.template).toBe("default");
  });
});

describe("nested doctor settings", () => {
  it("merge per key across layers, so waivers cannot reset failOn", () => {
    const { values, sources } = resolveConfig([
      { source: "user", values: { doctor: { failOn: "warn" } } },
      {
        source: "project",
        values: {
          doctor: { waivers: [{ rule: "a/b", reason: "a stated reason" }] },
        },
      },
    ]);
    expect(values.doctor.failOn).toBe("warn");
    expect(values.doctor.waivers).toHaveLength(1);
    expect(sources.doctor).toBe("project");
    expect(
      resolveConfig([{ source: "p", values: { doctor: { waivers: [] } } }])
        .values.doctor.failOn,
    ).toBe("error");
  });
});

describe("parseConfigObject", () => {
  it("warns about unknown keys but keeps valid ones", () => {
    const { layer, warnings } = parseConfigObject(
      { ci: "gitlab", nope: 1 },
      "f.json",
    );
    expect(layer.values).toEqual({ ci: "gitlab" });
    expect(warnings).toEqual(['f.json: ignoring unknown key "nope".']);
  });
  it("rejects bad values with a path to the key", () => {
    expect(() => parseConfigObject({ ci: "jenkins" }, "f.json")).toThrow(/ci/);
    expect(() => parseConfigObject([], "f.json")).toThrow(ConfigError);
  });
});

describe("config files", () => {
  it("returns null for a missing file and reports invalid JSON", async () => {
    const fs = new MemoryFileSystem();
    fs.seed({ "/bad.json": "{nope" });
    expect(await loadConfigFile(fs, "/missing.json")).toBeNull();
    await expect(loadConfigFile(fs, "/bad.json")).rejects.toThrow(
      /not valid JSON/,
    );
  });
  it("finds forge.config.json in an ancestor directory", async () => {
    const fs = new MemoryFileSystem();
    fs.seed({
      "/work/forge.config.json": '{"ci":"gitlab"}',
      "/work/a/b/keep": "",
    });
    expect(posix((await findProjectConfig(fs, "/work/a/b")) ?? "")).toBe(
      "/work/forge.config.json",
    );
    // expect(posix((await findProjectConfig(fs, "/elsewhere")) ?? "")).toBeNull();
    expect(await findProjectConfig(fs, '/elsewhere')).toBeNull();
  });
});

describe("loadEnvLayer", () => {
  it("maps FORGE_* variables and NO_COLOR", () => {
    const { layer } = loadEnvLayer({
      FORGE_CI: "gitlab",
      FORGE_LOG_LEVEL: "debug",
      FORGE_NO_INPUT: "true",
      NO_COLOR: "1",
      FORGE_CLOUD: "",
    });
    expect(layer.values).toEqual({
      ci: "gitlab",
      logLevel: "debug",
      noInput: true,
      color: false,
    });
  });
  it("rejects malformed values", () => {
    expect(() => loadEnvLayer({ FORGE_NO_INPUT: "maybe" })).toThrow(
      ConfigError,
    );
    expect(() => loadEnvLayer({ FORGE_CI: "bogus" })).toThrow(ConfigError);
  });
});
