import { json, buildSearchText, cleanModel } from '../_lib/common.js';

function unauthorized() {
  return json({ ok: false, error: 'Unauthorized' }, 401);
}

function safeInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

export const onRequestPost = async (context) => {
  const secret = context.env.SYNC_SECRET;
  if (!secret) return json({ ok: false, error: 'Cloudflare 尚未設定 SYNC_SECRET' }, 503);
  const auth = context.request.headers.get('authorization') || '';
  if (auth !== `Bearer ${secret}`) return unauthorized();

  let body;
  try { body = await context.request.json(); }
  catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }

  const mode = body.mode || 'upsert';
  const syncId = String(body.sync_id || '').slice(0, 100);
  const source = String(body.source || 'pazua.easy.co').slice(0, 120);
  if (!syncId) return json({ ok: false, error: 'sync_id is required' }, 400);

  try {
    if (mode === 'finalize') {
      await context.env.DB.batch([
        context.env.DB.prepare('UPDATE products SET active = 0 WHERE source = ? AND (last_sync_id IS NULL OR last_sync_id <> ?)').bind(source, syncId),
        context.env.DB.prepare(`INSERT INTO sync_meta(key, value, updated_at)
          VALUES('last_successful_sync', ?, datetime('now'))
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).bind(new Date().toISOString()),
        context.env.DB.prepare(`INSERT INTO sync_meta(key, value, updated_at)
          VALUES('last_sync_id', ?, datetime('now'))
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).bind(syncId),
      ]);
      const row = await context.env.DB.prepare('SELECT COUNT(*) AS count FROM products WHERE active = 1 AND source = ?').bind(source).first();
      return json({ ok: true, mode, active_products: Number(row?.count || 0) });
    }

    const products = Array.isArray(body.products) ? body.products : [];
    if (!products.length) return json({ ok: false, error: 'products is empty' }, 400);
    if (products.length > 80) return json({ ok: false, error: '單批最多 80 個商品' }, 400);

    const statements = [];
    const now = new Date().toISOString();
    for (const item of products) {
      const productUrl = String(item.product_url || '').trim();
      const title = String(item.title || '').trim();
      if (!productUrl || !title) continue;
      const imageUrls = Array.isArray(item.image_urls) ? [...new Set(item.image_urls.filter(Boolean).map(String))].slice(0, 30) : [];
      const product = {
        title,
        brand: String(item.brand || '').trim().slice(0, 120),
        model: cleanModel(item.model || ''),
        sku: cleanModel(item.sku || ''),
        keywords: Array.isArray(item.keywords) ? item.keywords : [],
      };
      const id = String(item.id || productUrl).slice(0, 500);
      const searchText = buildSearchText(product);
      statements.push(context.env.DB.prepare(`
        INSERT INTO products(
          id, source, title, brand, model, sku, price, compare_at_price, currency,
          image_url, image_urls_json, product_url, search_text, active, last_sync_id, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(product_url) DO UPDATE SET
          id = excluded.id,
          source = excluded.source,
          title = excluded.title,
          brand = excluded.brand,
          model = excluded.model,
          sku = excluded.sku,
          price = excluded.price,
          compare_at_price = excluded.compare_at_price,
          currency = excluded.currency,
          image_url = excluded.image_url,
          image_urls_json = excluded.image_urls_json,
          search_text = excluded.search_text,
          active = 1,
          last_sync_id = excluded.last_sync_id,
          updated_at = excluded.updated_at
      `).bind(
        id, source, title, product.brand || null, product.model || null, product.sku || null,
        safeInt(item.price), safeInt(item.compare_at_price), String(item.currency || 'TWD').slice(0, 10),
        String(item.image_url || imageUrls[0] || '').slice(0, 1500) || null,
        JSON.stringify(imageUrls), productUrl.slice(0, 1500), searchText, syncId, now
      ));
    }

    if (!statements.length) return json({ ok: false, error: '沒有可寫入的有效商品' }, 400);
    await context.env.DB.batch(statements);
    return json({ ok: true, mode: 'upsert', written: statements.length, sync_id: syncId });
  } catch (error) {
    return json({ ok: false, error: String(error?.message || error) }, 500);
  }
};
