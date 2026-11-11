import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const LIB_ROOT = join(process.cwd(), "src", "lib");

function walk(dir: string): string[] {
  let out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out = out.concat(walk(full));
    } else if (full.endsWith(".ts") || full.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

describe("lib boundary", () => {
  const files = walk(LIB_ROOT);

  it("finds source files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s does not import Raycast or React", (file) => {
    const source = readFileSync(file, "utf8");
    expect(source).not.toMatch(/from ["']@raycast\//);
    expect(source).not.toMatch(/from ["']react["']/);
    expect(source).not.toMatch(/require\(["']@raycast\//);
  });
});

describe("persistent hook caches", () => {
  // useCachedPromise keys its on-disk cache on the function source and its arguments only, so
  // two instances serving an application of the same name would share one entry.
  const files = walk(join(process.cwd(), "src")).filter((file) => file.endsWith(".tsx"));
  const calls = files.flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return [...source.matchAll(/useCachedPromise\(/g)].map((match) => {
      const after = source.slice(match.index);
      const args = /\n\s*(\[[^\]\n]*\])\s*,/.exec(after)?.[1] ?? "";
      return [file, args] as const;
    });
  });

  it("finds hook calls to check", () => {
    expect(calls.length).toBeGreaterThan(0);
  });

  it.each(calls)("%s keys its cache on the instance: %s", (_file, args) => {
    expect(args).toMatch(/^\[instance\.id\b/);
  });
});
