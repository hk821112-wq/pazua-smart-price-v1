import { json, cleanModel, searchProducts } from '../_lib/common.js';

export const onRequestGet = async (context) => {
  const url = new URL(context.request.url);
  const q = (url.searchParams.get('q') || '').trim().slice(0, 300);
  const model = cleanModel(url.searchParams.get('model') || '');
  const sku = cleanModel(url.searchParams.get('sku') || '');
  const brand = (url.searchParams.get('brand') || '').trim().slice(0, 100);
  const limit = Number(url.searchParams.get('limit') || 12);

  if (!q && !model && !sku && !brand) {
    return json({ ok: true, query: '', results: [] });
  }

  try {
    const query = q || [brand, model, sku].filter(Boolean).join(' ');
    const results = await searchProducts(context.env.DB, query, { brand, model, sku }, limit);
    return json({ ok: true, query, results });
  } catch (error) {
    return json({ ok: false, error: String(error?.message || error), results: [] }, 500);
  }
};
