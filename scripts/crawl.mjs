#!/usr/bin/env node

const BASE = (process.env.SOURCE_SITE || 'https://pazua.easy.co').replace(/\/$/, '');
const PUSH_URL = (process.env.SMART_PRICE_URL || '').replace(/\/$/, '');
const SYNC_SECRET = process.env.SYNC_SECRET || '';
const SHOULD_PUSH = process.argv.includes('--push');
const SHOULD_WRITE = process.argv.includes('--out') || !SHOULD_PUSH;
const MAX_CONCURRENCY = 6;
const USER_AGENT = 'PAZUA-Inventory-Sync/1.0 (+product catalog sync)';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchText(url, options = {}, retries = 3) {
  let lastError;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        ...options,
        headers: { 'user-agent': USER_AGENT, 'accept-language': 'zh-TW,zh;q=0.9,en;q=0.5', ...(options.headers || {}) },
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      await sleep(600 * (attempt + 1));
    }
  }
  throw lastError;
}

function decodeHtml(text = '') {
  return String(text)
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function stripTags(text = '') {
  return decodeHtml(text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function absoluteUrl(href, base = BASE) {
  try { return new URL(decodeHtml(href), base).href.split('#')[0]; } catch { return ''; }
}

function canonicalizeProductUrl(url) {
  try {
    const u = new URL(url);
    const match = u.pathname.match(/\/products\/[^/?#]+/i);
    if (!match) return '';
    return `${u.origin}${match[0]}`;
  } catch { return ''; }
}

function extractLinks(html, baseUrl) {
  const links = [];
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)) {
    const url = absoluteUrl(match[1], baseUrl);
    if (url) links.push(url);
  }
  return [...new Set(links)];
}

async function discoverFromSitemaps() {
  const products = new Set();
  const visited = new Set();
  const queue = [`${BASE}/sitemap.xml`];

  while (queue.length && visited.size < 30) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    let xml;
    try { xml = await fetchText(url, {}, 2); }
    catch { continue; }
    const locs = [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)].map(m => decodeHtml(m[1].trim()));
    for (const loc of locs) {
      if (/\/products\//i.test(loc)) products.add(canonicalizeProductUrl(loc));
      else if (/\.xml(?:\?|$)/i.test(loc) && new URL(loc, BASE).hostname === new URL(BASE).hostname) queue.push(absoluteUrl(loc));
    }
  }
  products.delete('');
  return products;
}

async function discoverFromStorefront() {
  const productUrls = new Set();
  const collectionUrls = new Set();
  const homepage = await fetchText(BASE);
  for (const link of extractLinks(homepage, BASE)) {
    const p = canonicalizeProductUrl(link);
    if (p) productUrls.add(p);
    if (/\/collections\//i.test(new URL(link).pathname) && !/\/products\//i.test(link)) collectionUrls.add(link.split('?')[0]);
  }

  // Crawl each collection's pagination until two consecutive pages add no products.
  for (const collection of [...collectionUrls].slice(0, 80)) {
    let dryPages = 0;
    for (let page = 1; page <= 40 && dryPages < 2; page++) {
      let html;
      try { html = await fetchText(`${collection}${collection.includes('?') ? '&' : '?'}page=${page}`, {}, 2); }
      catch { break; }
      const before = productUrls.size;
      for (const link of extractLinks(html, collection)) {
        const p = canonicalizeProductUrl(link);
        if (p) productUrls.add(p);
      }
      if (productUrls.size === before) dryPages += 1; else dryPages = 0;
    }
  }
  return productUrls;
}

function parseJsonLd(html) {
  const nodes = [];
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const raw = decodeHtml(match[1].trim());
    try {
      const value = JSON.parse(raw);
      if (Array.isArray(value)) nodes.push(...value); else nodes.push(value);
    } catch {}
  }
  const flattened = [];
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(walk);
    flattened.push(value);
    if (value['@graph']) walk(value['@graph']);
  };
  nodes.forEach(walk);
  return flattened;
}

function meta(html, key) {
  const patterns = [
    new RegExp(`<meta\\b[^>]*(?:property|name)=["']${escapeRegExp(key)}["'][^>]*content=["']([^"']*)["'][^>]*>`, 'i'),
    new RegExp(`<meta\\b[^>]*content=["']([^"']*)["'][^>]*(?:property|name)=["']${escapeRegExp(key)}["'][^>]*>`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return decodeHtml(match[1]).trim();
  }
  return '';
}

function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function parseMoney(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/[^0-9.\-]/g, '');
  const number = Number(cleaned);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function extractImages(html, productNode) {
  const images = [];
  const add = value => {
    if (!value) return;
    if (Array.isArray(value)) return value.forEach(add);
    if (typeof value === 'object') return add(value.url || value.contentUrl);
    const url = absoluteUrl(String(value));
    if (/^https?:\/\//.test(url) && !images.includes(url)) images.push(url);
  };
  add(productNode?.image);
  add(meta(html, 'og:image'));
  for (const m of html.matchAll(/<img\b[^>]*(?:src|data-src|data-original)=["']([^"']+)["'][^>]*>/gi)) add(m[1]);
  return images.filter(url => !/logo|icon|payment|shipping|secure/i.test(url)).slice(0, 30);
}

function extractModel(title, htmlText, productNode) {
  const direct = productNode?.mpn || productNode?.model || productNode?.sku;
  if (direct) return String(direct).trim();
  const candidates = `${title} ${htmlText}`.match(/\b[A-Z0-9]{2,}(?:[-_][A-Z0-9]{1,}){1,6}\b/gi) || [];
  const filtered = candidates.filter(x => !/^NT[-_]?\d/i.test(x) && x.length <= 40);
  return filtered.sort((a, b) => b.length - a.length)[0] || '';
}

function extractComparePrice(html, currentPrice) {
  const text = stripTags(html);
  const values = [...text.matchAll(/NT\$\s*([0-9][0-9,]*(?:\.\d+)?)/gi)].map(m => parseMoney(m[1])).filter(Number.isFinite);
  const larger = values.filter(v => currentPrice !== null && v > currentPrice).sort((a, b) => a - b);
  return larger[0] || null;
}

async function parseProduct(url) {
  const html = await fetchText(url);
  const nodes = parseJsonLd(html);
  const productNode = nodes.find(node => {
    const type = node?.['@type'];
    return type === 'Product' || (Array.isArray(type) && type.includes('Product'));
  }) || {};
  const offer = Array.isArray(productNode.offers) ? productNode.offers[0] : (productNode.offers || {});
  const title = decodeHtml(productNode.name || meta(html, 'og:title') || (html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '')).replace(/\s*[–-]\s*小時候彈珠堂\s*$/i, '').trim();
  if (!title) throw new Error('missing title');
  const currentPrice = parseMoney(offer.price ?? meta(html, 'product:price:amount') ?? meta(html, 'og:price:amount'));
  const htmlText = stripTags(html).slice(0, 12000);
  const images = extractImages(html, productNode);
  const brandValue = typeof productNode.brand === 'object' ? productNode.brand?.name : productNode.brand;
  const brand = String(brandValue || '').trim();
  const model = extractModel(title, htmlText, productNode);
  const sku = String(productNode.sku || '').trim();
  const productUrl = canonicalizeProductUrl(productNode.url || meta(html, 'og:url') || url) || canonicalizeProductUrl(url);
  const compareAt = extractComparePrice(html, currentPrice);
  const description = stripTags(productNode.description || meta(html, 'description') || '').slice(0, 800);

  return {
    id: productUrl,
    source: new URL(BASE).hostname,
    title,
    brand,
    model,
    sku,
    price: currentPrice,
    compare_at_price: compareAt,
    currency: String(offer.priceCurrency || meta(html, 'product:price:currency') || 'TWD').toUpperCase(),
    image_url: images[0] || '',
    image_urls: images,
    product_url: productUrl,
    keywords: [brand, model, sku, description].filter(Boolean),
  };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) break;
      try { results[index] = await fn(items[index], index); }
      catch (error) { results[index] = { __error: String(error?.message || error), __url: items[index] }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function pushProducts(products) {
  if (!PUSH_URL || !SYNC_SECRET) throw new Error('缺少 SMART_PRICE_URL 或 SYNC_SECRET');
  const syncId = new Date().toISOString().replace(/[:.]/g, '-');
  const source = new URL(BASE).hostname;
  for (let i = 0; i < products.length; i += 50) {
    const batch = products.slice(i, i + 50);
    const response = await fetch(`${PUSH_URL}/api/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SYNC_SECRET}`, 'user-agent': USER_AGENT },
      body: JSON.stringify({ mode: 'upsert', sync_id: syncId, source, products: batch }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(`同步失敗：${response.status} ${JSON.stringify(data)}`);
    console.log(`Uploaded ${Math.min(i + batch.length, products.length)}/${products.length}`);
  }
  const finalResponse = await fetch(`${PUSH_URL}/api/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SYNC_SECRET}`, 'user-agent': USER_AGENT },
    body: JSON.stringify({ mode: 'finalize', sync_id: syncId, source }),
  });
  const finalData = await finalResponse.json().catch(() => ({}));
  if (!finalResponse.ok || !finalData.ok) throw new Error(`Finalize 失敗：${finalResponse.status} ${JSON.stringify(finalData)}`);
  console.log(`Sync complete. Active products: ${finalData.active_products}`);
}

async function main() {
  console.log(`Source: ${BASE}`);
  let urls = await discoverFromSitemaps();
  console.log(`Sitemap products: ${urls.size}`);
  if (urls.size < 5) {
    const storefront = await discoverFromStorefront();
    storefront.forEach(url => urls.add(url));
    console.log(`After storefront crawl: ${urls.size}`);
  }
  if (!urls.size) throw new Error('找不到任何商品網址');

  const list = [...urls];
  const parsed = await mapLimit(list, MAX_CONCURRENCY, async (url, index) => {
    if (index % 20 === 0) console.log(`Parsing ${index + 1}/${list.length}`);
    return parseProduct(url);
  });
  const errors = parsed.filter(x => x?.__error);
  const products = parsed.filter(x => x && !x.__error && x.title && x.product_url);
  console.log(`Parsed: ${products.length}, failed: ${errors.length}`);
  if (errors.length) console.log('Sample errors:', errors.slice(0, 8));
  if (!products.length) throw new Error('商品解析結果為 0');

  if (SHOULD_WRITE) {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const outDir = path.resolve('data');
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(path.join(outDir, 'products.json'), JSON.stringify(products, null, 2));
    console.log(`Wrote data/products.json (${products.length})`);
  }
  if (SHOULD_PUSH) await pushProducts(products);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
