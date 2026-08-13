import { json, cleanModel, searchProducts } from '../_lib/common.js';

/**
 * ArrayBuffer → Base64
 */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let binary = '';

  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, i + chunk)
    );
  }

  return btoa(binary);
}

/**
 * 取得 Workers AI 回傳文字
 */
function extractTextResponse(response) {
  if (!response) return '';

  if (typeof response === 'string') {
    return response;
  }

  // Moondream 3.1
  if (typeof response.answer === 'string') {
    return response.answer;
  }

  // 相容其他 Workers AI 格式
  if (typeof response.response === 'string') {
    return response.response;
  }

  if (typeof response.result === 'string') {
    return response.result;
  }

  if (typeof response.output_text === 'string') {
    return response.output_text;
  }

  if (
    response.result &&
    typeof response.result.response === 'string'
  ) {
    return response.result.response;
  }

  return JSON.stringify(response);
}

/**
 * 嘗試解析 AI 回傳 JSON
 */
function parseJsonLoose(text) {
  const cleaned = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  // 標準 JSON
  try {
    return JSON.parse(cleaned);
  } catch {}

  // AI 前後多講話時，只取第一個 {...}
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');

  if (start >= 0 && end > start) {
    try {
      return JSON.parse(
        cleaned.slice(start, end + 1)
      );
    } catch {}
  }

  return null;
}

/**
 * 陣列去除重複與空白
 */
function uniq(values) {
  return [
    ...new Set(
      values
        .map(v => String(v || '').trim())
        .filter(Boolean)
    ),
  ];
}

/**
 * 多條件商品搜尋
 *
 * 舊版：
 * AI 組一整句 query
 * ↓
 * 查一次
 *
 * 新版：
 * 型號
 * SKU
 * 品名
 * 品牌
 * OCR文字
 * AI query
 *
 * 全部分開搜尋，再合併結果。
 */
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
    if (!term) continue;

    try {
      const results = await searchProducts(
        db,
        term,
        analysis,
        8
      );

      for (const item of results) {
        const key =
          item.id ||
          item.product_url;

        if (!key) continue;

        const previous = merged.get(key);

        if (!previous) {
          merged.set(key, {
            ...item,
            _hits: 1,
          });
        } else {
          previous._hits += 1;

          previous.match = Math.max(
            previous.match || 0,
            item.match || 0
          );

          previous.reasons = uniq([
            ...(previous.reasons || []),
            ...(item.reasons || []),
          ]);
        }
      }
    } catch (error) {
      console.log(
        'Search term failed:',
        term,
        error
      );
    }
  }

  return [...merged.values()]
    .sort((a, b) => {
      // 多個 OCR 關鍵字都命中的優先
      if (b._hits !== a._hits) {
        return b._hits - a._hits;
      }

      // 再按照原本相似度
      return (
        (b.match || 0) -
        (a.match || 0)
      );
    })
    .slice(0, 8)
    .map(({ _hits, ...item }) => item);
}

/**
 * POST /api/vision
 */
export const onRequestPost = async (context) => {

  /* ===============================
     檢查 Workers AI
  =============================== */

  if (!context.env.AI) {
    return json(
      {
        ok: false,
        error:
          '尚未綁定 Workers AI（變數名稱需為 AI）',
      },
      503
    );
  }

  /* ===============================
     檢查 D1
  =============================== */

  if (!context.env.DB) {
    return json(
      {
        ok: false,
        error:
          '尚未綁定 D1（變數名稱需為 DB）',
      },
      503
    );
  }

  /* ===============================
     讀取圖片
  =============================== */

  let form;

  try {
    form =
      await context.request.formData();
  } catch {
    return json(
      {
        ok: false,
        error:
          '請使用 multipart/form-data 上傳圖片',
      },
      400
    );
  }

  const image = form.get('image');

  if (!(image instanceof File)) {
    return json(
      {
        ok: false,
        error:
          '找不到 image 圖片欄位',
      },
      400
    );
  }

  /* ===============================
     限制圖片 5MB
  =============================== */

  if (
    image.size >
    5 * 1024 * 1024
  ) {
    return json(
      {
        ok: false,
        error:
          '圖片太大，請控制在 5MB 內',
      },
      413
    );
  }

  try {

    /* ===============================
       圖片 → Base64 Data URI
    =============================== */

    const buffer =
      await image.arrayBuffer();

    const base64 =
      arrayBufferToBase64(buffer);

    const dataUrl =
      `data:${
        image.type || 'image/jpeg'
      };base64,${base64}`;

    /* ===============================
       OCR / 商品辨識 Prompt
    =============================== */

    const question = `
請把這張零售商品照片當成「進貨商品查價 OCR」處理。

你的目的不是描述圖片內容，
而是要從商品包裝、商品本體、標籤、外盒中，
精準找出可以拿去搜尋商品資料庫的文字。

請優先辨識：

1. 品牌
例如：
YAMADA
山田家電
Iwatani
岩谷

2. 完整型號
例如：
YAF-07SD310
CB-GHP-A-set1
TG-NB10C

型號非常重要。

型號中的：
英文
數字
-
_
/
.

都必須盡量原樣保留。

尤其注意：

0 與 O
1 與 I
5 與 S
8 與 B
2 與 Z

不要自行改寫。

3. SKU / 商品編號

4. 商品名稱
例如：
空氣循環扇
循環扇
電風扇
料理爐

5. 包裝上其他有搜尋價值的文字

規則：

- 看得到才寫
- 看不清楚就留空
- 不可以自行杜撰型號
- 中文請保留中文
- 英文品牌保留英文
- visible_text 放 3～12 個真正看得到且有搜尋價值的文字
- 不要把價格當成型號
- 不要把「優惠」「新品」「3檔風量」這種促銷文字誤認成型號
- query 請優先組成：
  型號 + 品牌 + 品名

只輸出 JSON。
不要 Markdown。
不要解釋。
不要加任何其他文字。

JSON 格式：

{
  "brand": "",
  "model": "",
  "sku": "",
  "product_name": "",
  "category": "",
  "visible_text": [],
  "query": ""
}
`.trim();

    /* ===============================
       Workers AI
       Moondream 3.1 OCR
    =============================== */

    const aiResponse =
      await context.env.AI.run(
        '@cf/moondream/moondream3.1-9B-A2B',
        {
          task: 'query',

          image: dataUrl,

          question,

          reasoning: false,

          temperature: 0,

          max_tokens: 900,

          stream: false,
        }
      );

    /* ===============================
       解析 AI 回傳
    =============================== */

    const rawText =
      extractTextResponse(
        aiResponse
      );

    console.log(
      'AI RAW:',
      rawText
    );

    const parsed =
      parseJsonLoose(rawText) || {};

    /* ===============================
       整理商品辨識資料
    =============================== */

    const analysis = {

      brand:
        String(
          parsed.brand || ''
        )
          .trim()
          .slice(0, 100),

      model:
        cleanModel(
          parsed.model || ''
        ),

      sku:
        cleanModel(
          parsed.sku || ''
        ),

      product_name:
        String(
          parsed.product_name || ''
        )
          .trim()
          .slice(0, 180),

      category:
        String(
          parsed.category || ''
        )
          .trim()
          .slice(0, 100),

      visible_text:
        Array.isArray(
          parsed.visible_text
        )
          ? parsed.visible_text
              .map(x =>
                String(x).trim()
              )
              .filter(Boolean)
              .slice(0, 12)
          : [],

      query:
        String(
          parsed.query || ''
        )
          .trim()
          .slice(0, 300),
    };

    /* ===============================
       如果 AI 沒產生 query
       自己組搜尋字
    =============================== */

    const query =
      analysis.query ||
      uniq([
        analysis.model,
        analysis.sku,
        analysis.brand,
        analysis.product_name,
        ...analysis.visible_text,
      ]).join(' ');

    /* ===============================
       多條件搜尋 D1
    =============================== */

    const results =
      await multiSearch(
        context.env.DB,
        analysis
      );

    /* ===============================
       回傳手機
    =============================== */

    return json({
      ok: true,

      engine:
        'moondream3.1',

      analysis,

      query,

      results,
    });

  } catch (error) {

    console.error(
      'VISION ERROR:',
      error
    );

    return json(
      {
        ok: false,

        error:
          String(
            error?.message ||
            error
          ),

        results: [],
      },
      500
    );
  }
};
