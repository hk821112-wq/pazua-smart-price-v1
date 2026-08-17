import test from 'node:test';
import assert from 'node:assert/strict';

import { modelSearchVariants, searchProducts } from '../functions/_lib/common.js';

test('removes a short alphabetic color suffix after the numeric model', () => {
  assert.deepEqual(modelSearchVariants('KPB-2652BR'), ['KPB-2652BR', 'KPB-2652']);
  assert.deepEqual(modelSearchVariants('KPB-2652'), ['KPB-2652']);
  assert.deepEqual(modelSearchVariants('YAF-07SD310'), ['YAF-07SD310']);
});

test('searches both the scanned SKU and its color-neutral model', async () => {
  let capturedBinds = [];
  const db = {
    prepare() {
      return {
        bind(...values) {
          capturedBinds = values;
          return this;
        },
        async all() {
          return {
            results: [{
              id: 'product-1',
              title: 'Kinyo AC迷你萬用充',
              brand: 'Kinyo',
              model: 'copy_to_clipboard',
              sku: null,
              price: 0,
              compare_at_price: 730,
              currency: 'TWD',
              image_url: '',
              image_urls_json: '[]',
              product_url: 'https://example.com/product-1',
              search_text: 'kinyo ac迷你萬用充 kpb-2652',
              updated_at: '2026-08-18',
            }],
          };
        },
      };
    },
  };

  const results = await searchProducts(
    db,
    'KPB-2652BR',
    { model: 'KPB-2652BR', sku: 'KPB-2652BR' },
    8,
  );

  assert.ok(capturedBinds.includes('%kpb-2652br%'));
  assert.ok(capturedBinds.includes('%kpb-2652%'));
  assert.equal(results[0]?.title, 'Kinyo AC迷你萬用充');
  assert.ok(results[0]?.reasons.includes('忽略顏色碼後型號相符'));
});
