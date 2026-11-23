-- Keep scheduled-source de-duplication separate from per-advisor-run source snapshots.
DROP INDEX IF EXISTS wealth_stock_advisor_research_sources_ticker_url_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS wealth_stock_advisor_research_sources_scheduled_ticker_url_uidx
  ON wealth_stock_advisor_research_sources(ticker,url) WHERE run_id IS NULL;
