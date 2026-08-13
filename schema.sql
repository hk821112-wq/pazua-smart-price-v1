CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'pazua.easy.co',
  title TEXT NOT NULL,
  brand TEXT,
  model TEXT,
  sku TEXT,
  price INTEGER,
  compare_at_price INTEGER,
  currency TEXT NOT NULL DEFAULT 'TWD',
  image_url TEXT,
  image_urls_json TEXT,
  product_url TEXT NOT NULL UNIQUE,
  search_text TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  last_sync_id TEXT,
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_products_active ON products(active);
CREATE INDEX IF NOT EXISTS idx_products_model ON products(model);
CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
CREATE INDEX IF NOT EXISTS idx_products_source ON products(source);

CREATE TABLE IF NOT EXISTS sync_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
