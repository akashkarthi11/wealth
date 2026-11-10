-- Interest source registry: canonical FK links, no duplicated principal/balance.
-- Apply to development first; production promotion requires a reviewed approval.
BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS wealth_users_id_uidx
  ON public.wealth_users(id);
CREATE UNIQUE INDEX IF NOT EXISTS wealth_accounts_id_uidx
  ON public.wealth_accounts(id);
CREATE UNIQUE INDEX IF NOT EXISTS wealth_positions_id_uidx
  ON public.wealth_positions(id);

CREATE TABLE IF NOT EXISTS public.wealth_interest_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.wealth_users(id) ON DELETE CASCADE,
  source_key text NOT NULL,
  source_name text NOT NULL,
  provider text NOT NULL,
  product_key text NOT NULL,
  account_id uuid NULL REFERENCES public.wealth_accounts(id) ON DELETE RESTRICT,
  position_id uuid NULL REFERENCES public.wealth_positions(id) ON DELETE RESTRICT,
  current_rate_id uuid NULL REFERENCES public.wealth_interest_rates(id) ON DELETE SET NULL,
  link_status text NOT NULL DEFAULT 'linked',
  is_active boolean NOT NULL DEFAULT true,
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wealth_interest_sources_user_source_key_uniq UNIQUE (user_id, source_key),
  CONSTRAINT wealth_interest_sources_link_status_check
    CHECK (link_status IN ('linked', 'needs_link', 'inactive')),
  CONSTRAINT wealth_interest_sources_one_asset_fk_check CHECK (
    (account_id IS NOT NULL AND position_id IS NULL) OR
    (account_id IS NULL AND position_id IS NOT NULL) OR
    (account_id IS NULL AND position_id IS NULL AND link_status = 'needs_link')
  )
);

CREATE INDEX IF NOT EXISTS wealth_interest_sources_user_active_idx
  ON public.wealth_interest_sources(user_id, is_active);
CREATE INDEX IF NOT EXISTS wealth_interest_sources_rate_idx
  ON public.wealth_interest_sources(current_rate_id);

-- Store rate history separately; rates are decimal fractions.
INSERT INTO public.wealth_interest_rates
  (provider, product_key, annual_rate, effective_from, source_url, notes)
SELECT 'Slice Small Finance Bank', 'slice-fd', 0.0775, DATE '2026-11-10',
       'user-provided-screenshot://slice-fd/2026-11-10',
       'User screenshot: current value ₹3,004.41; displayed rate 7.75% p.a.; not assumed to be original principal.'
WHERE NOT EXISTS (
  SELECT 1 FROM public.wealth_interest_rates
  WHERE provider = 'Slice Small Finance Bank'
    AND product_key = 'slice-fd'
    AND effective_from = DATE '2026-11-10'
);

INSERT INTO public.wealth_interest_rates
  (provider, product_key, annual_rate, effective_from, source_url, notes)
SELECT 'Angel One', 'angel-one-fd', 0.08, DATE '2026-11-10',
       'user-confirmed://angel-one-fd/2026-11-10',
       'User-confirmed rate 8.00% p.a.; tenure and payout terms still need verification.'
WHERE NOT EXISTS (
  SELECT 1 FROM public.wealth_interest_rates
  WHERE provider = 'Angel One'
    AND product_key = 'angel-one-fd'
    AND effective_from = DATE '2026-11-10'
);

-- Reuse existing account/position PKs. Do not insert duplicate assets.
INSERT INTO public.wealth_interest_sources
  (user_id, source_key, source_name, provider, product_key,
   account_id, current_rate_id, link_status, notes)
SELECT u.id, 'slice-savings', 'Slice Savings', 'Slice Small Finance Bank',
       'slice-savings', a.id, r.id, 'linked',
       'FK to existing Slice Savings account; principal is read through the FK.'
FROM public.wealth_users u
JOIN public.wealth_accounts a
  ON a.user_id = u.id AND a.account_key = 'slice-savings-3731'
LEFT JOIN public.wealth_interest_rates r
  ON r.provider = 'Slice Small Finance Bank'
 AND r.product_key = 'slice-savings' AND r.effective_to IS NULL
WHERE NOT EXISTS (
  SELECT 1 FROM public.wealth_interest_sources s
  WHERE s.user_id = u.id AND s.source_key = 'slice-savings'
);

INSERT INTO public.wealth_interest_sources
  (user_id, source_key, source_name, provider, product_key,
   account_id, current_rate_id, link_status, notes)
SELECT u.id, 'atom-savings', 'Slice Atom Savings', 'Slice Small Finance Bank',
       'atom-savings', a.id, r.id, 'linked',
       'FK to existing Atom Savings account; separate from Slice Savings.'
FROM public.wealth_users u
JOIN public.wealth_accounts a
  ON a.user_id = u.id AND a.account_key = 'atom-savings'
LEFT JOIN public.wealth_interest_rates r
  ON r.provider = 'Slice Small Finance Bank'
 AND r.product_key = 'atom-savings' AND r.effective_to IS NULL
WHERE NOT EXISTS (
  SELECT 1 FROM public.wealth_interest_sources s
  WHERE s.user_id = u.id AND s.source_key = 'atom-savings'
);

INSERT INTO public.wealth_interest_sources
  (user_id, source_key, source_name, provider, product_key,
   position_id, current_rate_id, link_status, notes)
SELECT u.id, 'angel-one-fd', 'Angel One FD', 'Angel One',
       'angel-one-fd', p.id, r.id, 'linked',
       'FK to existing Angel One FD position; no duplicate principal.'
FROM public.wealth_users u
JOIN public.wealth_positions p
  ON p.user_id = u.id
 AND p.id = '43bf77a2-817e-4b9c-bc26-6c3d91cdf9c9'::uuid
LEFT JOIN public.wealth_interest_rates r
  ON r.provider = 'Angel One' AND r.product_key = 'angel-one-fd'
 AND r.effective_from = DATE '2026-11-10'
WHERE NOT EXISTS (
  SELECT 1 FROM public.wealth_interest_sources s
  WHERE s.user_id = u.id AND s.source_key = 'angel-one-fd'
);

INSERT INTO public.wealth_interest_sources
  (user_id, source_key, source_name, provider, product_key,
   current_rate_id, link_status, notes)
SELECT u.id, 'slice-fd', 'Slice FD', 'Slice Small Finance Bank',
       'slice-fd', r.id, 'needs_link',
       'Needs canonical Slice FD position link if not present; never guess or duplicate an FD position.'
FROM public.wealth_users u
LEFT JOIN public.wealth_interest_rates r
  ON r.provider = 'Slice Small Finance Bank'
 AND r.product_key = 'slice-fd'
 AND r.effective_from = DATE '2026-11-10'
WHERE NOT EXISTS (
  SELECT 1 FROM public.wealth_interest_sources s
  WHERE s.user_id = u.id AND s.source_key = 'slice-fd'
);

COMMIT;
