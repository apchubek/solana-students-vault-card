use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

declare_id!("GTNevcsACWZWWH1PMYbKmtcZCS5NJfgqUGnjNunqwNfT");

#[program]
pub mod simple_vault {
    use super::*;

    /// Создать vault для конкретного SPL-токена.
    /// Создаёт: VaultState PDA, vault_token_account PDA, share_mint PDA.
    pub fn initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
        let vault = &mut ctx.accounts.vault_state;
        vault.admin = ctx.accounts.admin.key();
        vault.token_mint = ctx.accounts.token_mint.key();
        vault.vault_token_account = ctx.accounts.vault_token_account.key();
        vault.share_mint = ctx.accounts.share_mint.key();
        vault.total_tokens = 0;
        vault.total_shares = 0;
        vault.bump = ctx.bumps.vault_state;
        vault.fee_wallet = ctx.accounts.admin.key();
        vault.min_deposit = 1;
        vault.is_paused = false;

        msg!("Vault initialized for mint: {}", vault.token_mint);
        Ok(())
    }

    /// Создать личную «карточку» пользователя в vault.
    /// У каждого пользователя ровно одна карточка (PDA от vault + user).
    pub fn create_user_card(ctx: Context<CreateUserCard>) -> Result<()> {
        let card = &mut ctx.accounts.user_card;
        card.vault = ctx.accounts.vault_state.key();
        card.owner = ctx.accounts.user.key();
        card.bump = ctx.bumps.user_card;

        msg!("User card created for: {}", card.owner);
        Ok(())
    }

    /// Установить статус паузы (Задание 3)
    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        let vault = &mut ctx.accounts.vault_state;
        vault.is_paused = paused;
        Ok(())
    }

    /// Установить минимальный депозит
    pub fn set_min_deposit(ctx: Context<SetPaused>, min_deposit: u64) -> Result<()> {
        let vault = &mut ctx.accounts.vault_state;
        vault.min_deposit = min_deposit;
        Ok(())
    }

    /// Установить кошелёк комиссии
    pub fn set_fee_wallet(ctx: Context<SetPaused>, fee_wallet: Pubkey) -> Result<()> {
        let vault = &mut ctx.accounts.vault_state;
        vault.fee_wallet = fee_wallet;
        Ok(())
    }

    /// Пользователь вносит `amount` токенов → получает share-токены.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        let vault = &mut ctx.accounts.vault_state;
        let user_card = &mut ctx.accounts.user_card;

        // 1. Проверка флага pause (Задание 3)
        require!(!vault.is_paused, VaultError::VaultPaused);

        // 2. Проверка минимального депозита (Задание 2)
        require!(amount >= vault.min_deposit, VaultError::DepositTooSmall);
        require!(amount > 0, VaultError::ZeroAmount);

        // 3. Расчёт комиссии 1% (Задание 1)
        let fee_amount = amount.checked_div(100).ok_or(VaultError::MathOverflow)?;
        let net_amount = amount.checked_sub(fee_amount).ok_or(VaultError::MathOverflow)?;

        // 4. Расчёт shares исходя из чистой суммы (net_amount)
        let shares = if vault.total_tokens == 0 || vault.total_shares == 0 {
            net_amount
        } else {
            (net_amount as u128)
                .checked_mul(vault.total_shares as u128)
                .ok_or(VaultError::MathOverflow)?
                .checked_div(vault.total_tokens as u128)
                .ok_or(VaultError::MathOverflow)? as u64
        };
        require!(shares > 0, VaultError::SharesTooSmall);

        // 5. Перевод net_amount в vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token_account.to_account_info(),
                    to: ctx.accounts.vault_token_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            net_amount,
        )?;

        // 6. Перевод комиссии (fee_amount) на fee_token_account
        if fee_amount > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.user_token_account.to_account_info(),
                        to: ctx.accounts.fee_token_account.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                    },
                ),
                fee_amount,
            )?;
        }

        // 7. Минт shares пользователю с PDA authority
        let token_mint_key = vault.token_mint;
        let seeds = &[
            b"vault".as_ref(),
            token_mint_key.as_ref(),
            &[vault.bump],
        ];
        let signer = &[&seeds[..]];

        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.share_mint.to_account_info(),
                    to: ctx.accounts.user_share_account.to_account_info(),
                    authority: vault.to_account_info(),
                },
                signer,
            ),
            shares,
        )?;

        // 8. Обновление состояния
        vault.total_tokens = vault.total_tokens.checked_add(net_amount).ok_or(VaultError::MathOverflow)?;
        vault.total_shares = vault.total_shares.checked_add(shares).ok_or(VaultError::MathOverflow)?;

        user_card.deposited = user_card.deposited.checked_add(net_amount).ok_or(VaultError::MathOverflow)?;
        user_card.shares = user_card.shares.checked_add(shares).ok_or(VaultError::MathOverflow)?;

        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Accounts
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    /// VaultState PDA — seeds: ["vault", token_mint]
    #[account(
        init,
        payer = admin,
        space = VaultState::LEN,
        seeds = [b"vault", token_mint.key().as_ref()],
        bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    /// Token account, принадлежащий vault PDA
    #[account(
        init,
        payer = admin,
        token::mint = token_mint,
        token::authority = vault_state,
        seeds = [b"vault_tokens", token_mint.key().as_ref()],
        bump,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// Mint для shares — выпускается vault PDA
    #[account(
        init,
        payer = admin,
        mint::decimals = 6,
        mint::authority = vault_state,
        seeds = [b"share_mint", token_mint.key().as_ref()],
        bump,
    )]
    pub share_mint: Account<'info, Mint>,

    /// SPL-токен, который принимает vault
    pub token_mint: Account<'info, Mint>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct CreateUserCard<'info> {
    #[account(
        seeds = [b"vault", vault_state.token_mint.as_ref()],
        bump = vault_state.bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    /// UserCard PDA — seeds: ["user_card", vault_state, user]
    #[account(
        init,
        payer = user,
        space = UserCard::LEN,
        seeds = [b"user_card", vault_state.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub user_card: Account<'info, UserCard>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPaused<'info> {
    #[account(
        mut,
        has_one = admin @ VaultError::Unauthorized
    )]
    pub vault_state: Account<'info, VaultState>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault_state.token_mint.as_ref()],
        bump = vault_state.bump
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(
        mut,
        seeds = [b"user_card", vault_state.key().as_ref(), user.key().as_ref()],
        bump = user_card.bump
    )]
    pub user_card: Account<'info, UserCard>,

    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"vault_tokens", vault_state.token_mint.as_ref()],
        bump
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = fee_token_account.owner == vault_state.fee_wallet
    )]
    pub fee_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"share_mint", vault_state.token_mint.as_ref()],
        bump
    )]
    pub share_mint: Account<'info, Mint>,

    #[account(mut)]
    pub user_share_account: Account<'info, TokenAccount>,

    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

#[account]
#[derive(Default)]
pub struct VaultState {
    pub admin: Pubkey,               // 32
    pub token_mint: Pubkey,          // 32 — SPL-токен vault'а
    pub vault_token_account: Pubkey, // 32 — PDA для токенов
    pub share_mint: Pubkey,          // 32 — mint для shares
    pub total_tokens: u64,           // 8  — всего токенов в vault
    pub total_shares: u64,           // 8  — всего выпущено shares
    pub bump: u8,                    // 1
    // --- Новые поля для заданий 1, 2, 3 ---
    pub fee_wallet: Pubkey,          // 32
    pub min_deposit: u64,            // 8
    pub is_paused: bool,             // 1
}

impl VaultState {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 32 + 8 + 8 + 1 + 32 + 8 + 1;
}

/// Карточка пользователя в vault.
#[account]
#[derive(Default)]
pub struct UserCard {
    pub vault: Pubkey,  // 32 — к какому vault относится
    pub owner: Pubkey,  // 32 — владелец карточки
    pub deposited: u64, // 8 — сколько токенов внёс пользователь
    pub shares: u64,    // 8 — сколько shares у пользователя
    pub bump: u8,       // 1
}

impl UserCard {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 8 + 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

#[error_code]
pub enum VaultError {
    #[msg("Vault is paused")]
    VaultPaused,
    #[msg("Deposit amount is below minimum")]
    DepositTooSmall,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Zero amount")]
    ZeroAmount,
    #[msg("Calculated shares are too small")]
    SharesTooSmall,
    #[msg("Math overflow")]
    MathOverflow,
}
