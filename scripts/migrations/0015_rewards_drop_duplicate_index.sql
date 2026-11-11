-- 0015: 0014 created wealth_reward_balances_latest_idx (program_id, as_of DESC), which duplicates the unique key
-- wealth_reward_balances_point (program_id, as_of) — Postgres reads that index backwards for "newest first".
-- Structural only (TR-4.3: no duplicate indexes); no data changed.
DROP INDEX IF EXISTS wealth_reward_balances_latest_idx;
