/**
 * Devnet keypair handling. The key lives ONLY at KEYPAIR_PATH (gitignored
 * via keypairs/); it is never logged, never printed, never committed.
 * If the file doesn't exist it is generated — acceptable for devnet where
 * funds come from the faucet.
 */
import { Keypair } from "@solana/web3.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function loadOrCreateKeypair(path: string): Keypair {
  if (existsSync(path)) {
    const secret = Uint8Array.from(JSON.parse(readFileSync(path, "utf8")));
    return Keypair.fromSecretKey(secret);
  }
  const kp = Keypair.generate();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  console.log(
    `[wallet] generated new devnet keypair at ${path} (pubkey ${kp.publicKey.toBase58()})`,
  );
  return kp;
}
