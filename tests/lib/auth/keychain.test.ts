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

describe("writeKeychainToken", () => {
  it("passes the token on stdin, not in argv", async () => {
    const spy = exec({});
    await writeKeychainToken("i1", SECRET, spy);
    expect(spy).toHaveBeenCalledWith("/usr/bin/security", writeTokenArgs("i1"), { input: SECRET });
  });

  it("throws when security fails", async () => {
    await expect(writeKeychainToken("i1", SECRET, exec({ code: 1 }))).rejects.toThrowError(/exit 1/);
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
