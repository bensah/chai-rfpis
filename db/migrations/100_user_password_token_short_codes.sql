-- 100 — a six-digit code beside the long token, for people to type.
--
-- The link still carries the 43-character token from migration 093. This adds a
-- SHORT code for the case the link cannot be followed, because asking somebody to
-- copy 43 characters off a phone screen is how a reset gets abandoned.
--
-- A six-digit code is one in a million, which is nothing like the token's 256 bits,
-- so it is only safe under two conditions that the long token never needed:
--
--   * it is checked against ONE named account, never looked up on its own. The
--     holder must know the email address too, and a code that matches a different
--     account is simply wrong rather than a way in. Without that, an attacker
--     sweeping a million codes against a global index would hit whichever live
--     token happened to collide, belonging to anybody.
--
--   * it is attempt-limited. `attempts` counts every check and the code is burned
--     once it passes the limit, so a code is worth at most a handful of guesses
--     rather than the million its length implies.
--
-- Only the SHA-256 of the code is stored, for the same reason as token_hash: the
-- code exists in the email and nowhere else, so this table leaking yields nothing
-- usable.
--
-- Nullable on purpose. Tokens issued before this migration have no code and keep
-- working through their links, so nobody holding an invite is cut off by it.

alter table user_password_tokens
    add column if not exists code_hash text,
    add column if not exists attempts  integer not null default 0;

-- The lookup a code redemption performs: this account's live tokens. The partial
-- index from 093 covers user_id where used_at is null; this one adds the code so a
-- redemption does not read rows that have no code to check.
create index if not exists idx_user_password_tokens_user_code_live
    on user_password_tokens (user_id)
    where used_at is null and code_hash is not null;

comment on column user_password_tokens.code_hash is
    'SHA-256 of the short typed code. Only ever checked against one named account, '
    'and only while attempts is under the limit.';

comment on column user_password_tokens.attempts is
    'Failed and successful checks of the short code. The code is burned once this '
    'passes the limit, which is what makes six digits defensible.';
