import { json, cleanModel, searchProducts } from '../_lib/common.js';

const MODEL = '@cf/moondream/moondream3.1-9B-A2B';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
}

function extractTextResponse(response) {
  if (!response) return '';
  if (typeof response === 'string') return response;
  if (typeof response.answer === 'string') return response.answer;
  if (typeof response.response === 'string') return response.response;
  if (typeof response.result === 'string') return response.result;
  if (typeof response.output_text === 'string') return response.output_text;

  if (response.result && typeof response.result.answer === 'string') {
    return response.result.answer;
  }

  if (response.result && typeof response.result.response === 'string') {
    return response.result.response;
  }

  return JSON.stringify(response);
}

function parseJsonLoose(text) {
  const cleaned = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {}

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');

  if (start >= 0 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {}
  }

  return null;
}

function uniq(values) {
  return [
    ...new Set(
      values
        .map(value => String(value || '').trim())
        .filter(Boolean)
    ),
  ];
}

function normalizeVisibleText(value) {
  if (Array.isArray(value)) {
    return uniq(value).slice(0, 12);
  }

  if (typeof value === 'string') {
    return uniq(
      value
        .split(/[\r\n,，、;；|]+/)
        .map(line => line.replace(/^[-*•\d.()\s]+/, '').trim())
    ).slice(0, 12);
  }

  return [];
}

function extractLikelyModel(values) {
  const candidates = [];

  for (const value of values) {
    const text = String(value || '').toUpperCase();
    const matches = text.match(/[A-Z0-9][A-Z0-9._/-]{3,39}/g) || [];

    for (const match of matches) {
      const candidate = match.replace(/^[._/-]+|[._/-]+$/g, '');
      const hasLetter = /[A-Z]/.test(candidate);
      const hasNumber = /\d/.test(candidate);

      if (!hasLetter || !hasNumber) continue;

      let score = candidate.length;
      if (/[-_/]/.test(candidate)) score += 12;
      if (/^[A-Z]{2,6}[-_/]/.test(candidate)) score += 6;

      candidates.push({ candidate, score });
    }
  }

  candidates.sort((left, right) => right.score - left.score);
  return candidates[0]?.candidate || '';
}

function buildAnalysis(parsed) {
  const visibleText = normalizeVisibleText(parsed.visible_text);

  return {
    brand: String(parsed.brand || '').trim().slice(0, 100),
    model: cleanModel(parsed.model || ''),
    sku: cleanModel(parsed.sku || ''),
    product_name: String(parsed.product_name || '').trim().slice(0, 180),
    category: String(parsed.category || '').trim().slice(0, 100),
    visible_text: visibleText,
    query: String(parsed.query || '').trim().slice(0, 300),
  };
}

function hasUsefulAnalysis(analysis) {
  return Boolean(
    analysis.brand ||
    analysis.model ||
    analysis.sku ||
    analysis.product_name ||
    analysis.visible_text.length ||
    analysis.query
  );
}

async function runStructuredRecognition(ai, dataUrl) {
  const question = `
Read the visible text in this retail product image carefully.

Extract only information that is actually visible:
- brand name
- complete model number
- SKU or product code
- product name
- product category
- other useful visible text

Preserve letters, numbers, hyphens, underscores, slashes and periods exactly.
Model numbers such as YAF-07SD310 are especially important.
Do not guess unreadable characters.

Return only valid JSON with exactly this structure:
{
  "brand": "",
  "model": "",
  "sku": "",
  "product_name": "",
  "category": "",
  "visible_text": [],
  "query": ""
}

Use the complete model number as query when it is visible.
`.trim();

  const response = await ai.run(MODEL, {
    task: 'query',
    image: dataUrl,
    question,
    reasoning: true,
    temperature: 0,
    max_tokens: 1200,
    stream: false,
  });

  const rawText = extractTextResponse(response);
  console.log('VISION STRUCTURED RAW:', rawText);

  return {
    rawText,
    parsed: parseJsonLoose(rawText),
  };
}

async function runOcrFallback(ai, dataUrl) {
  const question = `
Transcribe every visible word from this product image exactly as printed.
Pay special attention to brand names and complete model numbers.
Preserve Chinese text, English letters, numbers, hyphens, underscores, slashes and periods.
Return plain text only, with one useful text item per line.
Do not describe the image and do not guess unreadable text.
`.trim();

  const response = await ai.run(MODEL, {
    task: 'query',
    image: dataUrl,
    question,
    reasoning: true,
    temperature: 0,
    max_tokens: 1000,
    stream: false,
  });

  const rawText = extractTextResponse(response);
  console.log('VISION OCR FALLBACK RAW:', rawText);

  const visibleText = normalizeVisibleText(rawText);
  const model = cleanModel(extractLikelyModel(visibleText));

  return {
    brand: '',
    model,
    sku: model,
    product_name: '',
    category: '',
    visible_text: visibleText,
    query: model || visibleText.join(' '),
  };
}

async function multiSearch(db, analysis) {
  const terms = uniq([
    analysis.model,
    analysis.sku,
    analysis.product_name,
    analysis.brand,
    ...(analysis.visible_text || []),
    analysis.query,
  ]).slice(0, 14);

  const merged = new Map();

  for (const term of terms) {
    try {
      const results = await searchProducts(db, term, analysis, 8);

      for (const item of results) {
        const key = item.id || item.product_url;
        if (!key) continue;

        const previous = merged.get(key);

        if (!previous) {
          merged.set(key, {
            ...item,
            _hits: 1,
          });
          continue;
        }

        previous._hits += 1;
        previous.match = Math.max(previous.match || 0, item.match || 0);
        previous.reasons = uniq([
          ...(previous.reasons || []),
          ...(item.reasons || []),
        ]);
      }
    } catch (error) {
      console.log('Search term failed:', term, error);
    }
  }

  return [...merged.values()]
    .sort((left, right) => {
      if (right._hits !== left._hits) return right._hits - left._hits;
      return (right.match || 0) - (left.match || 0);
    })
    .slice(0, 8)
    .map(({ _hits, ...item }) => item);
}

export const onRequestPost = async context => {
  if (!context.env.AI) {
    return json(
      {
        ok: false,
        error: '尚未綁定 Workers AI（變數名稱必須是 AI）',
      },
      503
    );
  }

  if (!context.env.DB) {
    return json(
      {
        ok: false,
        error: '尚未綁定 D1（變數名稱必須是 DB）',
      },
      503
    );
  }

  let form;

  try {
    form = await context.request.formData();
  } catch {
    return json(
      {
        ok: false,
        error: '請使用 multipart/form-data 上傳圖片',
      },
      400
    );
  }

  const image = form.get('image');

  if (!(image instanceof File)) {
    return json(
      {
        ok: false,
        error: '找不到 image 圖片欄位',
      },
      400
    );
  }

  if (!image.type.startsWith('image/')) {
    return json(
      {
        ok: false,
        error: '上傳的檔案不是圖片',
      },
      415
    );
  }

  if (image.size === 0) {
    return json(
      {
        ok: false,
        error: '上傳的圖片是空檔案',
      },
      400
    );
  }

  if (image.size > MAX_IMAGE_BYTES) {
    return json(
      {
        ok: false,
        error: '圖片太大，請控制在 5MB 內',
      },
      413
    );
  }

  try {
    const buffer = await image.arrayBuffer();
    const base64 = arrayBufferToBase64(buffer);
    const contentType = image.type || 'image/jpeg';
    const dataUrl = `data:${contentType};base64,${base64}`;

    const structured = await runStructuredRecognition(context.env.AI, dataUrl);
    let analysis = buildAnalysis(structured.parsed || {});
    let usedFallback = false;

    if (!hasUsefulAnalysis(analysis)) {
      analysis = await runOcrFallback(context.env.AI, dataUrl);
      usedFallback = true;
    }

    if (!hasUsefulAnalysis(analysis)) {
      return json(
        {
          ok: false,
          error: '沒有讀到品牌、型號或商品文字，請靠近文字區域重新拍攝',
          engine: 'moondream3.1',
          used_fallback: usedFallback,
          analysis,
          query: '',
          results: [],
        },
        422
      );
    }

    const query =
      analysis.query ||
      uniq([
        analysis.model,
        analysis.sku,
        analysis.brand,
        analysis.product_name,
        ...analysis.visible_text,
      ]).join(' ');

    const searchAnalysis = {
      ...analysis,
      query,
    };

    const results = await multiSearch(context.env.DB, searchAnalysis);

    return json({
      ok: true,
      engine: 'moondream3.1',
      used_fallback: usedFallback,
      analysis: searchAnalysis,
      query,
      results,
    });
  } catch (error) {
    console.error('VISION ERROR:', error);

    return json(
      {
        ok: false,
        error: String(error?.message || error),
        results: [],
      },
      500
    );
  }
};
