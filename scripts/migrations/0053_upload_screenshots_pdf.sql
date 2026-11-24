-- The screenshot-upload table only ever allowed image mime types, so a PDF bank/card statement could not be stored at
-- all (owner's request 2026-11-24: read PDF statements with AI, same as a payment screenshot already is). Additive
-- only: widens the existing check constraint, drops no column, loses no data.
ALTER TABLE wealth_upload_screenshots DROP CONSTRAINT IF EXISTS wealth_upload_screenshots_mime_type_check;
ALTER TABLE wealth_upload_screenshots ADD CONSTRAINT wealth_upload_screenshots_mime_type_check
  CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp', 'application/pdf'));
