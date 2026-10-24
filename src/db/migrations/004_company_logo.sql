-- Company logo for white-label pages (signup link, dashboard sidebar).
-- Small raster images only (PNG / JPEG / WebP, up to 1 MB), checked by content
-- on upload; logo_updated_at versions the public URL so caches refresh.
ALTER TABLE organizations
  ADD COLUMN logo_data       bytea,
  ADD COLUMN logo_mime       text CHECK (logo_mime IN ('image/png', 'image/jpeg', 'image/webp')),
  ADD COLUMN logo_updated_at timestamptz;
