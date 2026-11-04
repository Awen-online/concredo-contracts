import { describe, expect, it } from "vitest";
import { FallbackProvider, type ChainProvider } from "../src/provider.js";

function fake(name: string, fail: boolean): ChainProvider {
  const boom = async () => { throw new Error(`${name} down`); };
  const ok = (v: unknown) => async () => v;
  return {
    name,
    getTip: fail ? boom : ok({ slot: 1, hash: name }),
    getUtxos: fail ? boom : ok([]),
  } as unknown as ChainProvider;
}

describe("FallbackProvider", () => {
  it("uses the primary when it works", async () => {
    const p = FallbackProvider.wrap(fake("a", false), fake("b", false), () => {});
    expect((await p.getTip()).hash).toBe("a");
    expect(p.name).toBe("a>b");
  });

  it("falls back when the primary throws", async () => {
    const logs: string[] = [];
    const p = FallbackProvider.wrap(fake("a", true), fake("b", false), (m) => logs.push(m));
    expect((await p.getTip()).hash).toBe("b");
    expect(logs[0]).toContain("a.getTip failed");
  });

  it("surfaces the error when both fail", async () => {
    const p = FallbackProvider.wrap(fake("a", true), fake("b", true), () => {});
    await expect(p.getUtxos("addr_test1")).rejects.toThrow("b down");
  });
});
