export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

export function normalizeText(value = '') {
  return String(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/[|｜/\\,，.。:：;；()（）\[\]【】{}<>《》「」『』“”"'`~!！?？@#$%^&*_+=]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function compactText(value = '') {
  return normalizeText(value).replace(/\s+/g, '');
}

export function cleanModel(value = '') {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/^[型號\s:：]+/i, '')
    .replace(/[，,。.;；]+$/g, '')
    .slice(0, 120);
}

export function modelSearchVariants(value = '') {
  const original = cleanModel(value);
  if (!original) return [];

  const variants = [original];
  const colorSuffix = original.match(/^(.+?\d)([a-z]{1,4})$/i);

  if (colorSuffix && /[a-z]/i.test(colorSuffix[1])) {
    variants.push(colorSuffix[1]);
  }

  return [...new Set(variants)];
}

export function buildSearchText(product) {
  const parts = [
    product.title,
    product.brand,
    product.model,
    product.sku,
    ...(Array.isArray(product.keywords) ? product.keywords : []),
  ].filter(Boolean);
  const normalized = normalizeText(parts.join(' '));
  return `${normalized} ${normalized.replace(/\s+/g, '')}`.trim();
}

function includesCompact(haystack, needle) {
  if (!needle) return false;
  return compactText(haystack).includes(compactText(needle));
}

export function scoreProduct(product, query, hints = {}) {
  const q = normalizeText(query);
  const qc = compactText(query);
  const title = normalizeText(product.title || '');
  const search = normalizeText(product.search_text || '');
  const model = normalizeText(product.model || '');
  const sku = normalizeText(product.sku || '');
  const brand = normalizeText(product.brand || '');
  const hintModel = normalizeText(hints.model || '');
  const hintSku = normalizeText(hints.sku || '');
  const hintBrand = normalizeText(hints.brand || '');

  let score = 0;
  const reasons = [];

  if (hintModel && (model === hintModel || sku === hintModel || includesCompact(product.search_text, hintModel))) {
    score += 125;
    reasons.push('型號完全命中');
  }
  if (hintSku && (sku === hintSku || model === hintSku || includesCompact(product.search_text, hintSku))) {
    score += 125;
    reasons.push('SKU 完全命中');
  }
  if (hintBrand && brand && (brand.includes(hintBrand) || hintBrand.includes(brand))) {
    score += 22;
    reasons.push('品牌相符');
  }
  if (q && title === q) {
    score += 90;
    reasons.push('商品名稱完全一致');
  }
  if (q && title.includes(q)) {
    score += 58;
    reasons.push('商品名稱高度相符');
  }
  if (qc && compactText(title).includes(qc)) score += 38;
  if (q && model && (model.includes(q) || q.includes(model))) {
    score += 70;
    reasons.push('型號文字相符');
  }
  if (q && sku && (sku.includes(q) || q.includes(sku))) {
    score += 70;
    reasons.push('SKU 文字相符');
  }

  const tokens = q.split(' ').filter(t => t.length >= 2);
  let hits = 0;
  for (const token of tokens) {
    if (search.includes(token) || compactText(search).includes(compactText(token))) hits += 1;
  }
  score += hits * 11;
  if (tokens.length && hits === tokens.length) score += 18;

  if (!score && qc && compactText(search).includes(qc)) score = 35;

  return { score, reasons };
}

export async function searchProducts(db, query, hints = {}, limit = 12) {
  const q = normalizeText(query);
  const queryTokens = String(query || '').split(/\s+/).filter(Boolean);
  const hinted = [hints.model, hints.sku, hints.brand].filter(Boolean);
  const tokens = [...new Set(
    [...queryTokens, ...hinted]
      .flatMap(modelSearchVariants)
      .map(normalizeText)
  )]
    .filter(t => t && t.length >= 2)
    .slice(0, 8);

  let rows = [];
  if (tokens.length) {
    const clauses = tokens.map(() => 'search_text LIKE ?').join(' OR ');
    const binds = tokens.map(t => `%${t}%`);
    const result = await db.prepare(
      `SELECT id, title, brand, model, sku, price, compare_at_price, currency,
              image_url, image_urls_json, product_url, search_text, updated_at
       FROM products
       WHERE active = 1 AND (${clauses})
       LIMIT 180`
    ).bind(...binds).all();
    rows = result.results || [];
  }

  // If OCR/model strings are unusual and LIKE found nothing, use a bounded fallback.
  if (!rows.length) {
    const result = await db.prepare(
      `SELECT id, title, brand, model, sku, price, compare_at_price, currency,
              image_url, image_urls_json, product_url, search_text, updated_at
       FROM products
       WHERE active = 1
       ORDER BY updated_at DESC
       LIMIT 350`
    ).all();
    rows = result.results || [];
  }

  const scored = rows
    .map(product => ({ ...product, ...scoreProduct(product, q, hints) }))
    .filter(product => product.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(limit, 20)));

  const topScore = scored[0]?.score || 0;
  const secondScore = scored[1]?.score || 0;
  return scored.map((product, index) => {
    const margin = index === 0 ? Math.max(0, topScore - secondScore) : 0;
    const match = Math.max(1, Math.min(99, Math.round(34 + product.score * 0.38 + margin * 0.08)));
    let imageUrls = [];
    try { imageUrls = JSON.parse(product.image_urls_json || '[]'); } catch {}
    return {
      id: product.id,
      title: product.title,
      brand: product.brand,
      model: product.model,
      sku: product.sku,
      price: product.price,
      compare_at_price: product.compare_at_price,
      currency: product.currency || 'TWD',
      image_url: product.image_url,
      image_urls: imageUrls,
      product_url: product.product_url,
      updated_at: product.updated_at,
      match,
      reasons: product.reasons,
    };
  });
}
