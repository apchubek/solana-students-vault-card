import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SimpleVault } from "../target/types/simple_vault";
import { createMint } from "@solana/spl-token";
import { assert, expect } from "chai";

describe("Simple Vault", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SimpleVault as Program<SimpleVault>;
  const admin = provider.wallet as anchor.Wallet;
  const user = anchor.web3.Keypair.generate();

  let tokenMint: anchor.web3.PublicKey;
  let vaultStatePda: anchor.web3.PublicKey;
  let userCardPda: anchor.web3.PublicKey;

  before(async () => {
    // Пополняем баланс юзера для оплаты создания карточки
    const airdropTx = await provider.connection.requestAirdrop(
      user.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropTx);

    // Создаем тестовый токен
    tokenMint = await createMint(
      provider.connection,
      (admin as any).payer,
      admin.publicKey,
      null,
      6
    );

    [vaultStatePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), tokenMint.toBuffer()],
      program.programId
    );

    [userCardPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("user_card"), vaultStatePda.toBuffer(), user.publicKey.toBuffer()],
      program.programId
    );
  });

  it("initialize_vault: vault создан", async () => {
    const [vaultTokenAccount] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_tokens"), tokenMint.toBuffer()],
      program.programId
    );
    const [shareMint] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("share_mint"), tokenMint.toBuffer()],
      program.programId
    );

    await program.methods
      .initializeVault()
      .accounts({
        admin: admin.publicKey,
        tokenMint: tokenMint,
        vaultState: vaultStatePda,
        vaultTokenAccount: vaultTokenAccount,
        shareMint: shareMint,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const state = await program.account.vaultState.fetch(vaultStatePda);
    assert.ok(state.admin.equals(admin.publicKey));
    assert.isFalse(state.paused);
  });

  it("create_user_card: у каждого пользователя своя карточка", async () => {
    await program.methods
      .createUserCard()
      .accounts({
        user: user.publicKey,
        vaultState: vaultStatePda,
        userCard: userCardPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    const card = await program.account.userCard.fetch(userCardPda);
    assert.ok(card.owner.equals(user.publicKey));
  });

  it("create_user_card: вторая карточка для того же пользователя — ошибка", async () => {
    try {
      await program.methods
        .createUserCard()
        .accounts({
          user: user.publicKey,
          vaultState: vaultStatePda,
          userCard: userCardPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([user])
        .rpc();
      assert.fail("Должна быть ошибка повторного создания");
    } catch (err: any) {
      expect(err.message).to.include("already in use");
    }
  });
});