/** Little-endian primitive readers over raw account data. */

export function readU16(data: Uint8Array, offset: number): number {
  return data[offset]! | (data[offset + 1]! << 8);
}

export function readI32(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset + offset, 4).getInt32(0, true);
}

export function readU64(data: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(data[offset + i]!);
  return v;
}

export function readU128(data: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(data[offset + i]!);
  return v;
}

export function readPubkeyBytes(data: Uint8Array, offset: number): Uint8Array {
  return data.slice(offset, offset + 32);
}
