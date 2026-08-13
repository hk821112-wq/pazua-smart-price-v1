import { json } from '../_lib/common.js';

export const onRequestGet = async (context) => {
  try {
    const row = await context.env.DB.prepare('SELECT COUNT(*) AS count FROM products WHERE active = 1').first();
    return json({ ok: true, products: Number(row?.count || 0), ai: Boolean(context.env.AI) });
  } catch (error) {
    return json({ ok: false, error: String(error?.message || error) }, 500);
  }
};
