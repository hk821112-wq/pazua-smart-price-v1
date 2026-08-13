import { json, cleanModel, searchProducts } from '../_lib/common.js';

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function extractTextResponse(response) {
  if (!response) return '';
  if (typeof response === 'string') return response;
  if (typeof response.response === 'string') return response.response;
  if (typeof response.result === 'string') return response.result;
  if (typeof response.output_text === 'string') return response.output_text;
  if (response.result && typeof response.result.response === 'string') return response.result.response;
  return JSON.stringify(response);
}

function parseJsonLoose(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch {}
  }
  return null;
}

export const onRequestPost = async (context) => {
  if (!context.env.AI) return json({ ok: false, error: '尚未綁定 Workers AI（變數名稱需為 AI）' }, 503);

  let form;
  try {
    form = await context.request.formData();
  } catch {
    return json({ ok: false, error: '請使用 multipart/form-data 上傳圖片' }, 400);
  }

  const image = form.get('image');
  if (!(image instanceof File)) return json({ ok: false, error: '找不到 image 圖片欄位' }, 400);
  if (image.size > 5 * 1024 * 1024) return json({ ok: false, error: '圖片太大，請控制在 5MB 內' }, 413);

  try {
    const buffer = await image.arrayBuffer();
    const dataUrl = `data:${image.type || 'image/jpeg'};base64,${arrayBufferToBase64(buffer)}`;
    const prompt = `你正在辨識台灣零售商品的實拍照片。你的任務不是描述畫面，而是找出最適合拿去查商品資料庫的識別資訊。\n\n規則：\n1. 優先讀取包裝上的品牌、完整型號、SKU、品名。型號中的英文、數字、連字號必須原樣保留。\n2. 看不清楚就留空，不可自行杜撰。\n3. visible_text 只放你真的看得到、且有助於辨識商品的文字，最多 12 個。\n4. query 組合成適合搜尋商品資料庫的一行字，優先順序：型號 > 品牌 > 品名 > 類別。\n5. 只輸出 JSON，不要 Markdown。\n\nJSON 格式：\n{"brand":"","model":"","sku":"","product_name":"","category":"","visible_text":[],"query":""}`;

    const aiResponse = await context.env.AI.run('@cf/meta/llama-4-scout-17b-16e-instruct', {
      messages: [
        { role: 'system', content: 'You extract exact retail product identifiers from images and return strict JSON.' },
        { role: 'user', content: prompt },
      ],
      image: dataUrl,
      max_tokens: 420,
      temperature: 0.1,
    });

    const rawText = extractTextResponse(aiResponse);
    const parsed = parseJsonLoose(rawText) || {};
    const analysis = {
      brand: String(parsed.brand || '').trim().slice(0, 100),
      model: cleanModel(parsed.model || ''),
      sku: cleanModel(parsed.sku || ''),
      product_name: String(parsed.product_name || '').trim().slice(0, 180),
      category: String(parsed.category || '').trim().slice(0, 100),
      visible_text: Array.isArray(parsed.visible_text) ? parsed.visible_text.map(x => String(x).trim()).filter(Boolean).slice(0, 12) : [],
      query: String(parsed.query || '').trim().slice(0, 300),
    };

    const query = analysis.query || [analysis.model, analysis.sku, analysis.brand, analysis.product_name, ...analysis.visible_text]
      .filter(Boolean).join(' ');
    const results = await searchProducts(context.env.DB, query, analysis, 8);

    return json({ ok: true, analysis, query, results });
  } catch (error) {
    return json({ ok: false, error: String(error?.message || error), results: [] }, 500);
  }
};
