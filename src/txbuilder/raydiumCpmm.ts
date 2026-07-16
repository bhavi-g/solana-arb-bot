/**
 * Raydium CP-Swap swap_base_input instruction.
 * Account order verified 2026-07-16 against
 * cp-swap/src/instructions/swap_base_input.rs (master).
 */
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { createHash } from "node:crypto";

/** Anchor: sha256("global:swap_base_input")[0..8]. */
export const SWAP_BASE_INPUT_DISCRIMINATOR = createHash("sha256")
  .update("global:swap_base_input")
  .digest()
  .subarray(0, 8);

export const CPMM_AUTH_SEED = "vault_and_lp_mint_auth_seed";

export function cpmmAuthority(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(CPMM_AUTH_SEED)],
    programId,
  )[0];
}

export interface CpmmSwapParams {
  programId: PublicKey;
  payer: PublicKey;
  ammConfig: PublicKey;
  poolState: PublicKey;
  inputTokenAccount: PublicKey;
  outputTokenAccount: PublicKey;
  inputVault: PublicKey;
  outputVault: PublicKey;
  inputTokenProgram: PublicKey;
  outputTokenProgram: PublicKey;
  inputMint: PublicKey;
  outputMint: PublicKey;
  observationState: PublicKey;
  amountIn: bigint;
  minimumAmountOut: bigint;
}

export function buildCpmmSwapBaseInputIx(
  p: CpmmSwapParams,
): TransactionInstruction {
  const data = Buffer.alloc(8 + 8 + 8);
  data.set(SWAP_BASE_INPUT_DISCRIMINATOR, 0);
  data.writeBigUInt64LE(p.amountIn, 8);
  data.writeBigUInt64LE(p.minimumAmountOut, 16);

  return new TransactionInstruction({
    programId: p.programId,
    keys: [
      { pubkey: p.payer, isSigner: true, isWritable: false },
      { pubkey: cpmmAuthority(p.programId), isSigner: false, isWritable: false },
      { pubkey: p.ammConfig, isSigner: false, isWritable: false },
      { pubkey: p.poolState, isSigner: false, isWritable: true },
      { pubkey: p.inputTokenAccount, isSigner: false, isWritable: true },
      { pubkey: p.outputTokenAccount, isSigner: false, isWritable: true },
      { pubkey: p.inputVault, isSigner: false, isWritable: true },
      { pubkey: p.outputVault, isSigner: false, isWritable: true },
      { pubkey: p.inputTokenProgram, isSigner: false, isWritable: false },
      { pubkey: p.outputTokenProgram, isSigner: false, isWritable: false },
      { pubkey: p.inputMint, isSigner: false, isWritable: false },
      { pubkey: p.outputMint, isSigner: false, isWritable: false },
      { pubkey: p.observationState, isSigner: false, isWritable: true },
    ],
    data,
  });
}
