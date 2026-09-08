import { describe, expect, it, vi } from "vitest";
import {
  KEYCHAIN_SERVICE,
  deleteKeychainToken,
  deleteTokenArgs,
  readKeychainToken,
  readTokenArgs,
  writeKeychainToken,
  writeTokenArgs,
  writeTokenInput,
  type Exec,
} from "../../../src/lib/auth/keychain";

const SECRET = "a-token-value";

function exec(result: Partial<{ stdout: string; stderr: string; code: number }>): Exec {
  return vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0, ...result });
}

describe("argv construction", () => {
  it("reads with find-generic-password", () => {
    expect(readTokenArgs("i1")).toEqual(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", "i1", "-w"]);
  });

  it("writes with an upsert and never puts the token in argv", () => {
    const args = writeTokenArgs("i1");
    expect(args).toContain("-U");
    expect(args).toContain("add-generic-password");
    expect(args.slice(args.indexOf("-s"), args.indexOf("-s") + 2)).toEqual(["-s", KEYCHAIN_SERVICE]);
    expect(args.slice(args.indexOf("-a"), args.indexOf("-a") + 2)).toEqual(["-a", "i1"]);
    expect(args).not.toContain(SECRET);
    expect(args.at(-1)).toBe("-w");
  });

  it("deletes with delete-generic-password", () => {
    expect(deleteTokenArgs("i1")).toEqual(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", "i1"]);
  });
});

describe("readKeychainToken", () => {
  it("returns the trimmed token", async () => {
    await expect(readKeychainToken("i1", exec({ stdout: `${SECRET}\n` }))).resolves.toBe(SECRET);
  });

  it("returns undefined when the item does not exist", async () => {
    await expect(readKeychainToken("i1", exec({ code: 44, stderr: "not found" }))).resolves.toBeUndefined();
  });

  it("returns undefined when the stored value is empty", async () => {
    await expect(readKeychainToken("i1", exec({ stdout: "  \n" }))).resolves.toBeUndefined();
  });

  it("throws on any other failure without echoing the token", async () => {
    const failing = exec({ code: 1, stderr: `something broke near ${SECRET}` });
    await expect(readKeychainToken("i1", failing)).rejects.toThrowError(/exit 1/);
  });

  it("calls the system security binary with an argument array", async () => {
    const spy = exec({ stdout: SECRET });
    await readKeychainToken("i1", spy);
    expect(spy).toHaveBeenCalledWith("/usr/bin/security", readTokenArgs("i1"));
  });
});

/**
 * Behaves like the real /usr/bin/security: `add-generic-password -w` with no value prompts
 * twice, and if it does not get the same value twice it stores an empty password and still
 * exits 0. Reproducing that is the only way a test can catch the bug it caused.
 */
function fakeSecurity() {
  const store = new Map<string, string>();
  const exec: Exec = vi.fn(async (_file, args, opts) => {
    const account = args[args.indexOf("-a") + 1] ?? "";
    if (args[0] === "add-generic-password") {
      const lines = (opts?.input ?? "").split("\n");
      const first = lines[0] ?? "";
      const second = lines[1] ?? "";
      store.set(account, first === second && first.length > 0 ? first : "");
      const stderr = first === second ? "" : "passwords don't match\n";
      return { stdout: "", stderr, code: 0 };
    }
    if (args[0] === "find-generic-password") {
      const value = store.get(account);
      return value === undefined
        ? { stdout: "", stderr: "not found", code: 44 }
        : { stdout: `${value}\n`, stderr: "", code: 0 };
    }
    if (args[0] === "delete-generic-password") {
      const existed = store.delete(account);
      return { stdout: "", stderr: "", code: existed ? 0 : 44 };
    }
    return { stdout: "", stderr: "unexpected", code: 1 };
  });
  return { exec, store };
}

describe("writeTokenInput", () => {
  it("feeds the value twice, because security -w prompts twice", () => {
    expect(writeTokenInput(SECRET)).toBe(`${SECRET}\n${SECRET}\n`);
  });
});

describe("writeKeychainToken", () => {
  it("actually stores the token, verified by reading it back", async () => {
    const { exec, store } = fakeSecurity();
    await writeKeychainToken("i1", SECRET, exec);
    expect(store.get("i1")).toBe(SECRET);
    await expect(readKeychainToken("i1", exec)).resolves.toBe(SECRET);
  });

  it("passes the token on stdin, never in argv", async () => {
    const { exec } = fakeSecurity();
    await writeKeychainToken("i1", SECRET, exec);
    const [, args, opts] = (exec as unknown as { mock: { calls: [string, string[], { input?: string }?][] } })
      .mock.calls[0]!;
    expect(args).not.toContain(SECRET);
    expect(opts?.input).toContain(SECRET);
  });

  it("throws when security exits 0 having stored nothing", async () => {
    // The real failure: one prompt fed, "passwords don't match", empty password, exit 0.
    const { store } = fakeSecurity();
    const halfFeeding: Exec = vi.fn(async (_file, args) => {
      const account = args[args.indexOf("-a") + 1] ?? "";
      if (args[0] === "add-generic-password") {
        store.set(account, "");
        return { stdout: "", stderr: "passwords don't match", code: 0 };
      }
      return { stdout: "\n", stderr: "", code: 0 };
    });
    await expect(writeKeychainToken("i1", SECRET, halfFeeding)).rejects.toThrowError(/did not store/);
  });

  it("throws when security fails outright", async () => {
    const failing: Exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 1 });
    await expect(writeKeychainToken("i1", SECRET, failing)).rejects.toThrowError(/exit 1/);
  });

  it("refuses a token carrying a line break, which would corrupt the second prompt", async () => {
    const { exec } = fakeSecurity();
    await expect(writeKeychainToken("i1", `${SECRET}\nmore`, exec)).rejects.toThrowError(/line break/);
    expect(exec).not.toHaveBeenCalled();
  });

  it("refuses an empty token", async () => {
    const { exec } = fakeSecurity();
    await expect(writeKeychainToken("i1", "", exec)).rejects.toThrowError(/empty/);
    expect(exec).not.toHaveBeenCalled();
  });

  it("round-trips through delete", async () => {
    const { exec } = fakeSecurity();
    await writeKeychainToken("i1", SECRET, exec);
    await deleteKeychainToken("i1", exec);
    await expect(readKeychainToken("i1", exec)).resolves.toBeUndefined();
  });
});

describe("deleteKeychainToken", () => {
  it("succeeds when the item was there", async () => {
    await expect(deleteKeychainToken("i1", exec({}))).resolves.toBeUndefined();
  });

  it("tolerates an already absent item", async () => {
    await expect(deleteKeychainToken("i1", exec({ code: 44 }))).resolves.toBeUndefined();
  });

  it("throws on any other failure", async () => {
    await expect(deleteKeychainToken("i1", exec({ code: 51 }))).rejects.toThrowError(/exit 51/);
  });
});
