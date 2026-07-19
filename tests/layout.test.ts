import { describe, expect, it } from "vitest";
import { readU32 } from "../src/decode/layout.js";

describe("readU32", () => {
  it("reads a little-endian u32", () => {
    const buf = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    expect(readU32(buf, 0)).toBe(0x04030201);
  });

  it("reads at a non-zero offset", () => {
    const buf = new Uint8Array([0x00, 0x00, 0xff, 0xff, 0xff, 0xff]);
    expect(readU32(buf, 2)).toBe(0xffffffff);
  });
});
