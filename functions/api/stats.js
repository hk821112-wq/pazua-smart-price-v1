import { json } from '../_lib/common.js';

export const onRequestGet = async (context) => {
  try {
    const [countRow, syncRow] = await Promise.all([
      context.env.DB.prepare('SELECT COUNT(*) AS count FROM products WHERE active = 1').first(),
      context.env.DB.prepare("SELECT value, updated_at FROM sync_meta WHERE key = 'last_successful_sync'").first(),
    ]);
    return json({
      ok: true,
      count: Number(countRow?.count || 0),
      last_sync: syncRow?.value || null,
      last_sync_recorded_at: syncRow?.updated_at || null,
    });
  } catch (error) {
    return json({ ok: false, count: 0, last_sync: null, error: String(error?.message || error) }, 500);
  }
};
