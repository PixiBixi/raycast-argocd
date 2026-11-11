import { describe, expect, it } from "vitest";
import { settleWithError } from "../../../src/lib/model/settle";

describe("settleWithError", () => {
  const failure = new Error("LocalStorage is unavailable");

  it("stops every entry still loading and gives it the reason", () => {
    const settled = settleWithError(
      [
        { id: "a", loading: true, error: undefined },
        { id: "b", loading: true, error: undefined },
      ],
      failure,
    );
    expect(settled).toEqual([
      { id: "a", loading: false, error: failure },
      { id: "b", loading: false, error: failure },
    ]);
  });

  it("leaves an entry that already settled as it was", () => {
    const done = { id: "a", loading: false, error: undefined };
    expect(settleWithError([done], failure)[0]).toBe(done);
  });

  it("turns a non-Error rejection into an Error", () => {
    const [settled] = settleWithError([{ loading: true, error: undefined as Error | undefined }], "boom");
    expect(settled?.error).toBeInstanceOf(Error);
    expect(settled?.error?.message).toBe("boom");
  });
});
