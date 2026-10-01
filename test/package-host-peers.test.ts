import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface PackageDependencies {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const manifest: PackageDependencies = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lock: { packages: Record<string, PackageDependencies & { version?: string }> } = JSON.parse(
  readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
);

// Native Pi supplies both names through its extension loader. Local tests still
// need their own pinned development copies; those are not runtime dependencies.
describe("host-provided TypeBox packaging", () => {
  it.each(["@sinclair/typebox", "typebox"])("declares %s as a host peer, not a runtime dependency", name => {
    expect(manifest.peerDependencies?.[name]).toBe("*");
    expect(manifest.dependencies).not.toHaveProperty(name);
  });

  it.each(["@sinclair/typebox", "typebox"])("retains the qualified %s development version in the lockfile", name => {
    expect(manifest.devDependencies?.[name]).toBe(lock.packages[`node_modules/${name}`].version);
    expect(lock.packages[""]).toMatchObject({
      devDependencies: { [name]: manifest.devDependencies?.[name] },
      peerDependencies: { [name]: "*" },
    });
    expect(lock.packages[""].dependencies).not.toHaveProperty(name);
  });
});
