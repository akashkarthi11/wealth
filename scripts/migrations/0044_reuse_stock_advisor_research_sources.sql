-- Reuse the existing advisor research-source table for independently collected evidence.
-- NULL run_id distinguishes scheduled collection from a per-advisor-run source snapshot.
ALTER TABLE wealth_stock_advisor_research_sources ALTER COLUMN run_id DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS wealth_stock_advisor_research_sources_ticker_url_uidx
  ON wealth_stock_advisor_research_sources(ticker,url);
