/**
 * Тесты для Simple Vault на devnet
 *
 * Сценарий:
 *   1. Admin создаёт vault (initialize_vault)
 *   2. Пользователи A и B создают свои карточки (create_user_card)
 *   3. Повторное создание карточки A падает
 *   4. A вносит 100 токенов → получает 99 shares (1% fee), B вносит 50 → 49.5 shares
 *   5. Депозит без карточки и депозит 0 — ошибки
 *   6. Пауза / снятие с паузы (Задание 3)
 *   7. Минимальный депозит (Задание 2)
 *   8. 3 пользователя вносят разные суммы: проверка долей shares (Задание 4)
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { createMint, createAccount, mintTo, getAccount } from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { assert } from "chai";
import { SimpleVault } from "../target/types/simple_vault";

// Переводим SOL от admin → pubkey (обходит rate limit devnet airdrop)
async function fundFromAdmin(
  provider: anchor.AnchorProvider,
  admin: Keypair,
  pubkey: PublicKey,
  lamports = 0.05 * LAMPORTS_PER_SOL
) {
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: pubkey, lamports })
  );
  await provider.sendAndConfirm(tx, [admin]);
}

describe("simple_vault", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SimpleVault as Program<SimpleVault>;
  const admin = (provider.wallet as anchor.Wallet).payer;
  const userA = Keypair.generate();
  const userB = Keypair.generate();

  let tokenMint: PublicKey;
  let vaultStatePDA: PublicKey;
  let vaultTokenAccountPDA: PublicKey;
  let shareMintPDA: PublicKey;
  let feeTokenAccount: PublicKey;

  // Токен-аккаунты (токен vault) и share-аккаунты пользователей
  const userC = Keypair.generate(); // без карточки
  const tokenAcc: Record<string, PublicKey> = {};
  const shareAcc: Record<string, PublicKey> = {};
  const UNIT = 1_000_000; // decimals = 6

  const deposit = (user: Keypair, amount: number) =>
    program.methods
      .deposit(new anchor.BN(amount))
      .accounts({
        vaultState: vaultStatePDA,
        userCard: cardPda(user.publicKey),
        userTokenAccount: tokenAcc[user.publicKey.toBase58()],
        vaultTokenAccount: vaultTokenAccountPDA,
        feeTokenAccount: feeTokenAccount,
        shareMint: shareMintPDA,
        userShareAccount: shareAcc[user.publicKey.toBase58()],
        user: user.publicKey,
      } as any)
      .signers([user])
      .rpc();

  const cardPda = (user: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("user_card"), vaultStatePDA.toBuffer(), user.toBuffer()],
      program.programId
    )[0];

  before(async () => {
    await fundFromAdmin(provider, admin, userA.publicKey);
    await fundFromAdmin(provider, admin, userB.publicKey);
    await fundFromAdmin(provider, admin, userC.publicKey);

    tokenMint = await createMint(provider.connection, admin, admin.publicKey, null, 6);

    [vaultStatePDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), tokenMint.toBuffer()],
      program.programId
    );
    [vaultTokenAccountPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_tokens"), tokenMint.toBuffer()],
      program.programId
    );
    [shareMintPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("share_mint"), tokenMint.toBuffer()],
      program.programId
    );

    // Токен-аккаунт для комиссии (владелец: admin)
    feeTokenAccount = await createAccount(provider.connection, admin, tokenMint, admin.publicKey);
  });

  it("initialize_vault: vault создан", async () => {
    await program.methods
      .initializeVault()
      .accounts({
        vaultState: vaultStatePDA,
        vaultTokenAccount: vaultTokenAccountPDA,
        shareMint: shareMintPDA,
        tokenMint,
        admin: admin.publicKey,
      } as any)
      .rpc();

    const vault = await program.account.vaultState.fetch(vaultStatePDA);
    assert.equal(vault.admin.toBase58(), admin.publicKey.toBase58());
    assert.equal(vault.tokenMint.toBase58(), tokenMint.toBase58());
    assert.equal(vault.shareMint.toBase58(), shareMintPDA.toBase58());
    assert.equal(vault.feeWallet.toBase58(), admin.publicKey.toBase58());
    assert.equal(vault.minDeposit.toNumber(), 1);
    assert.isFalse(vault.isPaused);
  });

  it("create_user_card: у каждого пользователя своя карточка", async () => {
    for (const user of [userA, userB]) {
      const userCard = cardPda(user.publicKey);
      await program.methods
        .createUserCard()
        .accounts({ vaultState: vaultStatePDA, userCard, user: user.publicKey } as any)
        .signers([user])
        .rpc();

      const card = await program.account.userCard.fetch(userCard);
      assert.equal(card.owner.toBase58(), user.publicKey.toBase58());
      assert.equal(card.vault.toBase58(), vaultStatePDA.toBase58());
    }
    assert.notEqual(cardPda(userA.publicKey).toBase58(), cardPda(userB.publicKey).toBase58());
  });

  it("create_user_card: вторая карточка для того же пользователя — ошибка", async () => {
    let failed = false;
    try {
      await program.methods
        .createUserCard()
        .accounts({
          vaultState: vaultStatePDA,
          userCard: cardPda(userA.publicKey),
          user: userA.publicKey,
        } as any)
        .signers([userA])
        .rpc();
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "повторная карточка должна быть отклонена");
  });

  it("deposit: A вносит 100 токенов → получает 99 shares (1% fee)", async () => {
    // Токен-аккаунты пользователей и стартовые токены
    for (const user of [userA, userB, userC]) {
      const key = user.publicKey.toBase58();
      tokenAcc[key] = await createAccount(provider.connection, admin, tokenMint, user.publicKey);
      shareAcc[key] = await createAccount(provider.connection, admin, shareMintPDA, user.publicKey);
      await mintTo(provider.connection, admin, tokenMint, tokenAcc[key], admin, 1000 * UNIT);
    }

    await deposit(userA, 100 * UNIT);

    // 100 * UNIT депозит: 1% комиссия = 1 * UNIT, чистая сумма = 99 * UNIT
    const shares = await getAccount(provider.connection, shareAcc[userA.publicKey.toBase58()]);
    assert.equal(shares.amount, BigInt(99 * UNIT));

    const card = await program.account.userCard.fetch(cardPda(userA.publicKey));
    assert.equal(card.deposited.toNumber(), 99 * UNIT);
    assert.equal(card.shares.toNumber(), 99 * UNIT);

    const feeAccount = await getAccount(provider.connection, feeTokenAccount);
    assert.equal(feeAccount.amount, BigInt(1 * UNIT));
  });

  it("deposit: B вносит 50 токенов → получает пропорциональные shares", async () => {
    await deposit(userB, 50 * UNIT);

    // 50 * UNIT: 1% fee = 0.5 * UNIT = 500_000, чистая сумма = 49.5 * UNIT = 49_500_000
    // Shares = 49_500_000 * 99_000_000 / 99_000_000 = 49_500_000
    const shares = await getAccount(provider.connection, shareAcc[userB.publicKey.toBase58()]);
    assert.equal(shares.amount, BigInt(49_500_000));

    const vault = await program.account.vaultState.fetch(vaultStatePDA);
    assert.equal(vault.totalTokens.toNumber(), 148_500_000);
    assert.equal(vault.totalShares.toNumber(), 148_500_000);

    const vaultTokens = await getAccount(provider.connection, vaultTokenAccountPDA);
    assert.equal(vaultTokens.amount, BigInt(148_500_000));

    const feeAccount = await getAccount(provider.connection, feeTokenAccount);
    assert.equal(feeAccount.amount, BigInt(1_500_000));
  });

  it("deposit: без карточки — ошибка", async () => {
    let failed = false;
    try {
      await deposit(userC, 10 * UNIT);
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "депозит без карточки должен быть отклонён");
  });

  it("deposit: сумма 0 — ошибка", async () => {
    let failed = false;
    try {
      await deposit(userA, 0);
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "нулевой депозит должен быть отклонён");
  });

  it("pause/unpause: админ может приостановить депозиты (Задание 3)", async () => {
    // 1. Ставим на паузу
    await program.methods
      .setPaused(true)
      .accounts({
        vaultState: vaultStatePDA,
        admin: admin.publicKey,
      } as any)
      .rpc();

    let vault = await program.account.vaultState.fetch(vaultStatePDA);
    assert.isTrue(vault.isPaused);

    // 2. Попытка депозита должна вернуть ошибку VaultPaused
    let failed = false;
    try {
      await deposit(userA, 10 * UNIT);
    } catch (e: any) {
      failed = true;
      assert.include(e.toString(), "VaultPaused");
    }
    assert.isTrue(failed, "депозит на паузе должен завершиться ошибкой");

    // 3. Снимаем с паузы
    await program.methods
      .setPaused(false)
      .accounts({
        vaultState: vaultStatePDA,
        admin: admin.publicKey,
      } as any)
      .rpc();

    vault = await program.account.vaultState.fetch(vaultStatePDA);
    assert.isFalse(vault.isPaused);
  });

  it("pause: не-админ не может вызвать set_paused", async () => {
    let failed = false;
    try {
      await program.methods
        .setPaused(true)
        .accounts({
          vaultState: vaultStatePDA,
          admin: userA.publicKey,
        } as any)
        .signers([userA])
        .rpc();
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "не-админ не может ставить на паузу");
  });

  it("min_deposit: проверка минимального депозита (Задание 2)", async () => {
    // Устанавливаем минимальный депозит 10 токенов
    await program.methods
      .setMinDeposit(new anchor.BN(10 * UNIT))
      .accounts({
        vaultState: vaultStatePDA,
        admin: admin.publicKey,
      } as any)
      .rpc();

    let failed = false;
    try {
      await deposit(userA, 5 * UNIT);
    } catch (e: any) {
      failed = true;
      assert.include(e.toString(), "DepositTooSmall");
    }
    assert.isTrue(failed, "депозит ниже минимального должен быть отклонён");

    // Возвращаем min_deposit обратно в 1
    await program.methods
      .setMinDeposit(new anchor.BN(1))
      .accounts({
        vaultState: vaultStatePDA,
        admin: admin.publicKey,
      } as any)
      .rpc();
  });

  // Задание 4: Тест сценария пропорциональных долей (три пользователя)
  describe("Задание 4: 3 пользователя вносят разные суммы: проверка долей shares", () => {
    const user1 = Keypair.generate();
    const user2 = Keypair.generate();
    const user3 = Keypair.generate();
    let tokenMint2: PublicKey;
    let vaultState2: PublicKey;
    let vaultTokenAccount2: PublicKey;
    let shareMint2: PublicKey;
    let feeTokenAcc2: PublicKey;
    let userCard1: PublicKey;
    let userCard2: PublicKey;
    let userCard3: PublicKey;
    const tokenAcc2: Record<string, PublicKey> = {};
    const shareAcc2: Record<string, PublicKey> = {};

    before(async () => {
      await fundFromAdmin(provider, admin, user1.publicKey);
      await fundFromAdmin(provider, admin, user2.publicKey);
      await fundFromAdmin(provider, admin, user3.publicKey);

      tokenMint2 = await createMint(provider.connection, admin, admin.publicKey, null, 6);

      [vaultState2] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), tokenMint2.toBuffer()],
        program.programId
      );
      [vaultTokenAccount2] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault_tokens"), tokenMint2.toBuffer()],
        program.programId
      );
      [shareMint2] = PublicKey.findProgramAddressSync(
        [Buffer.from("share_mint"), tokenMint2.toBuffer()],
        program.programId
      );

      feeTokenAcc2 = await createAccount(provider.connection, admin, tokenMint2, admin.publicKey);

      await program.methods
        .initializeVault()
        .accounts({
          vaultState: vaultState2,
          vaultTokenAccount: vaultTokenAccount2,
          shareMint: shareMint2,
          tokenMint: tokenMint2,
          admin: admin.publicKey,
        } as any)
        .rpc();

      userCard1 = PublicKey.findProgramAddressSync(
        [Buffer.from("user_card"), vaultState2.toBuffer(), user1.publicKey.toBuffer()],
        program.programId
      )[0];
      userCard2 = PublicKey.findProgramAddressSync(
        [Buffer.from("user_card"), vaultState2.toBuffer(), user2.publicKey.toBuffer()],
        program.programId
      )[0];
      userCard3 = PublicKey.findProgramAddressSync(
        [Buffer.from("user_card"), vaultState2.toBuffer(), user3.publicKey.toBuffer()],
        program.programId
      )[0];

      // Пользователи A, B, C с балансами (например, 1000, 2000, 3000)
      for (const [u, balance] of [
        [user1, 1000],
        [user2, 2000],
        [user3, 3000],
      ] as const) {
        const key = u.publicKey.toBase58();
        tokenAcc2[key] = await createAccount(provider.connection, admin, tokenMint2, u.publicKey);
        shareAcc2[key] = await createAccount(provider.connection, admin, shareMint2, u.publicKey);
        await mintTo(provider.connection, admin, tokenMint2, tokenAcc2[key], admin, balance);
      }
    });

    it("3 пользователя вносят разные суммы: проверка долей shares", async () => {
      // Создать для каждого UserCard:
      await program.methods
        .createUserCard()
        .accounts({ vaultState: vaultState2, userCard: userCard1, user: user1.publicKey } as any)
        .signers([user1])
        .rpc();
      await program.methods
        .createUserCard()
        .accounts({ vaultState: vaultState2, userCard: userCard2, user: user2.publicKey } as any)
        .signers([user2])
        .rpc();
      await program.methods
        .createUserCard()
        .accounts({ vaultState: vaultState2, userCard: userCard3, user: user3.publicKey } as any)
        .signers([user3])
        .rpc();

      const depositToVault2 = (user: Keypair, userCard: PublicKey, amount: number) =>
        program.methods
          .deposit(new anchor.BN(amount))
          .accounts({
            vaultState: vaultState2,
            userCard,
            userTokenAccount: tokenAcc2[user.publicKey.toBase58()],
            vaultTokenAccount: vaultTokenAccount2,
            feeTokenAccount: feeTokenAcc2,
            shareMint: shareMint2,
            userShareAccount: shareAcc2[user.publicKey.toBase58()],
            user: user.publicKey,
          } as any)
          .signers([user])
          .rpc();

      // Депозиты (например, 100, 200, 300) с учетом 1% fee
      // Net суммы: 99, 198, 297 токенов
      // User A (первый): получает shares = 99
      // User B: получает shares = 198 * 99 / 99 = 198
      // User C: получает shares = 297 * (99 + 198) / (99 + 198) = 297
      await depositToVault2(user1, userCard1, 100);
      await depositToVault2(user2, userCard2, 200);
      await depositToVault2(user3, userCard3, 300);

      const cardA = await program.account.userCard.fetch(userCard1);
      const cardB = await program.account.userCard.fetch(userCard2);
      const cardC = await program.account.userCard.fetch(userCard3);
      const vault = await program.account.vaultState.fetch(vaultState2);

      // Проверка равенства долей
      // Доля A = 99 / 594 = 1/6 (~16.66%)
      // Доля B = 198 / 594 = 2/6 (~33.33%)
      // Доля C = 297 / 594 = 3/6 (50.00%)
      assert.equal(cardA.shares.toNumber(), 99);
      assert.equal(cardB.shares.toNumber(), 198);
      assert.equal(cardC.shares.toNumber(), 297);
      assert.equal(vault.totalShares.toNumber(), 594);
    });
  });
});
