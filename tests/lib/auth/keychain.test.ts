import { describe, expect, it, vi } from "vitest";
import {
  KEYCHAIN_SERVICE,
  deleteKeychainToken,
  deleteTokenArgs,
  readKeychainToken,
  readTokenArgs,
  writeKeychainToken,
  writeTokenArgs,
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

  it("writes with an upsert, carrying the value after -w", () => {
    const args = writeTokenArgs("i1", SECRET);
    expect(args).toContain("-U");
    expect(args).toContain("add-generic-password");
    expect(args.slice(args.indexOf("-s"), args.indexOf("-s") + 2)).toEqual(["-s", KEYCHAIN_SERVICE]);
    expect(args.slice(args.indexOf("-a"), args.indexOf("-a") + 2)).toEqual(["-a", "i1"]);
    // security cannot read a password from a file descriptor, and the -w prompt form does not
    // receive stdin inside Raycast. See the module comment for the trade this represents.
    expect(args.slice(-2)).toEqual(["-w", SECRET]);
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

/** Behaves like the real /usr/bin/security for the three subcommands used here. */
function fakeSecurity() {
  const store = new Map<string, string>();
  const exec: Exec = vi.fn(async (_file, args) => {
    const account = args[args.indexOf("-a") + 1] ?? "";
    if (args[0] === "add-generic-password") {
      store.set(account, args[args.indexOf("-w") + 1] ?? "");
      return { stdout: "", stderr: "", code: 0 };
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

describe("writeKeychainToken", () => {
  it("actually stores the token, verified by reading it back", async () => {
    const { exec, store } = fakeSecurity();
    await writeKeychainToken("i1", SECRET, exec);
    expect(store.get("i1")).toBe(SECRET);
    await expect(readKeychainToken("i1", exec)).resolves.toBe(SECRET);
  });

  it("throws when security exits 0 having stored an empty password", async () => {
    // What actually happened inside Raycast with the stdin prompt form: item created, empty
    // password, exit 0, success reported.
    const storingNothing: Exec = vi.fn(async (_file, args) =>
      args[0] === "add-generic-password"
        ? { stdout: "", stderr: "", code: 0 }
        : { stdout: "\n", stderr: "", code: 0 },
    );
    await expect(writeKeychainToken("i1", SECRET, storingNothing)).rejects.toThrowError(
      /reported no item/,
    );
  });

  it("throws when the keychain stored a different value, naming lengths and not values", async () => {
    const storingOther: Exec = vi.fn(async (_file, args) =>
      args[0] === "add-generic-password"
        ? { stdout: "", stderr: "", code: 0 }
        : { stdout: "truncated\n", stderr: "", code: 0 },
    );
    const rejection = writeKeychainToken("i1", SECRET, storingOther);
    await expect(rejection).rejects.toThrowError(/9 characters instead of 13/);
    await expect(rejection).rejects.not.toThrowError(new RegExp(SECRET));
  });

  it("distinguishes a write that landed from a read-back that failed", async () => {
    const unreadable: Exec = vi.fn(async (_file, args) =>
      args[0] === "add-generic-password"
        ? { stdout: "", stderr: "", code: 0 }
        : { stdout: "", stderr: "authorization denied", code: 51 },
    );
    await expect(writeKeychainToken("i1", SECRET, unreadable)).rejects.toThrowError(
      /could not be read back/,
    );
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
