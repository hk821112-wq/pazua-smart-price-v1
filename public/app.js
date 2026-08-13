const $ = (selector) => document.querySelector(selector);
const state = { busy: false, lastObjectUrl: null };

const cameraButton = $('#cameraButton');
const cameraInput = $('#cameraInput');
const galleryButton = $('#galleryButton');
const galleryInput = $('#galleryInput');
const searchInput = $('#searchInput');
const searchButton = $('#searchButton');
const scanPanel = $('#scanPanel');
const previewImage = $('#previewImage');
const scanTitle = $('#scanTitle');
const scanDetail = $('#scanDetail');
const analysisPanel = $('#analysisPanel');
const analysisChips = $('#analysisChips');
const resultsSection = $('#resultsSection');
const resultsList = $('#resultsList');
const resultsTitle = $('#resultsTitle');
const resultCount = $('#resultCount');
const emptyState = $('#emptyState');
const bottomAction = $('#bottomAction');
const nextItemButton = $('#nextItemButton');
const editQueryButton = $('#editQueryButton');
const toastEl = $('#toast');

cameraButton.addEventListener('click', () => cameraInput.click());
galleryButton.addEventListener('click', () => galleryInput.click());
cameraInput.addEventListener('change', onImageSelected);
galleryInput.addEventListener('change', onImageSelected);
searchButton.addEventListener('click', () => manualSearch());
searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') manualSearch();
});
nextItemButton.addEventListener('click', () => {
  resetForNext();
  cameraInput.click();
});
editQueryButton.addEventListener('click', () => {
  searchInput.focus();
  searchInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

init();

async function init() {
  try {
    const response = await fetch('/api/stats', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'status failed');
    $('#systemStatus').classList.add('online');
    $('#productCount').textContent = Number(data.count || 0).toLocaleString('zh-TW');
    $('#lastSync').textContent = data.last_sync ? formatDate(data.last_sync) : '尚未同步';
  } catch {
    $('#productCount').textContent = '0';
    $('#lastSync').textContent = '等待資料庫設定';
  }
}

async function onImageSelected(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file || state.busy) return;

  resetResultsOnly();
  state.busy = true;
  emptyState.classList.add('hidden');
  scanPanel.classList.remove('hidden');
  scanTitle.textContent = '正在處理照片…';
  scanDetail.textContent = '縮小圖片，讓手機上傳更快';

  try {
    const compressed = await compressImage(file, 1600, 0.82);
    if (state.lastObjectUrl) URL.revokeObjectURL(state.lastObjectUrl);
    state.lastObjectUrl = URL.createObjectURL(compressed);
    previewImage.src = state.lastObjectUrl;
    scanTitle.textContent = '正在辨識商品…';
    scanDetail.textContent = '讀取品牌、型號與包裝文字';

    const form = new FormData();
    form.append('image', compressed, 'product.jpg');
    const response = await fetch('/api/vision', { method: 'POST', body: form });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || '辨識失敗');

    renderAnalysis(data.analysis || {});
    renderResults(data.results || [], data.query || '照片辨識');
    scanTitle.textContent = '辨識完成';
    scanDetail.textContent = data.query ? `搜尋：${data.query}` : '已完成資料庫比對';
    setTimeout(() => scanPanel.classList.add('hidden'), 800);
  } catch (error) {
    scanTitle.textContent = '沒有完成辨識';
    scanDetail.textContent = error.message || '請再拍一次';
    toast(error.message || '照片辨識失敗');
    bottomAction.classList.remove('hidden');
  } finally {
    state.busy = false;
  }
}

async function manualSearch() {
  const q = searchInput.value.trim();
  if (!q || state.busy) return;
  state.busy = true;
  emptyState.classList.add('hidden');
  analysisPanel.classList.add('hidden');
  scanPanel.classList.add('hidden');
  resultsSection.classList.remove('hidden');
  resultsList.innerHTML = '<div class="empty-state"><strong>搜尋中…</strong></div>';

  try {
    const response = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=12`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || '搜尋失敗');
    renderResults(data.results || [], q);
  } catch (error) {
    toast(error.message || '搜尋失敗');
    renderResults([], q);
  } finally {
    state.busy = false;
  }
}

function renderAnalysis(analysis) {
  const chips = [];
  if (analysis.brand) chips.push(['品牌', analysis.brand]);
  if (analysis.model) chips.push(['型號', analysis.model]);
  if (analysis.sku && analysis.sku !== analysis.model) chips.push(['SKU', analysis.sku]);
  if (analysis.product_name) chips.push(['品名', analysis.product_name]);
  if (analysis.category) chips.push(['類別', analysis.category]);
  (analysis.visible_text || []).slice(0, 5).forEach(text => chips.push(['文字', text]));
  if (!chips.length) {
    analysisPanel.classList.add('hidden');
    return;
  }
  analysisChips.innerHTML = chips.map(([label, value]) => `<span class="chip"><strong>${escapeHtml(label)}</strong> ${escapeHtml(value)}</span>`).join('');
  analysisPanel.classList.remove('hidden');
}

function renderResults(results, query) {
  resultsSection.classList.remove('hidden');
  resultsTitle.textContent = results.length ? `「${truncate(query, 24)}」` : '沒有找到相符商品';
  resultCount.textContent = results.length ? `${results.length} 個結果` : '';

  if (!results.length) {
    resultsList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">?</div>
        <strong>這次沒有找到</strong>
        <p>請把品牌或型號拍得更清楚，<br>也可以直接輸入包裝上的型號搜尋。</p>
      </div>`;
    bottomAction.classList.remove('hidden');
    return;
  }

  resultsList.innerHTML = results.map((item, index) => productCard(item, index === 0)).join('');
  bottomAction.classList.remove('hidden');
}

function productCard(item, best) {
  const price = money(item.price, item.currency);
  const compare = item.compare_at_price && item.compare_at_price > item.price ? money(item.compare_at_price, item.currency) : '';
  const model = [item.brand, item.model || item.sku].filter(Boolean).join(' · ');
  const matchClass = Number(item.match || 0) >= 70 ? '' : ' low';
  const fallback = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><rect width="100%" height="100%" fill="#eef0f2"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#9ba0aa" font-size="18">NO IMAGE</text></svg>')}`;
  return `
    <article class="product-card ${best ? 'best' : ''}">
      <img class="product-image" src="${escapeAttr(item.image_url || fallback)}" onerror="this.src='${escapeAttr(fallback)}'" alt="${escapeAttr(item.title || '商品圖片')}" loading="lazy" />
      <div class="product-main">
        <div class="match-row"><span class="match-badge${matchClass}">${best ? '最佳結果 · ' : ''}${Number(item.match || 0)}% 匹配</span></div>
        <h4 class="product-title">${escapeHtml(item.title || '')}</h4>
        <div class="model-line">${escapeHtml(model || '未標示型號')}</div>
        <div class="price-row">
          <span class="price">${escapeHtml(price)}</span>
          ${compare ? `<span class="compare-price">${escapeHtml(compare)}</span>` : ''}
        </div>
        ${item.product_url ? `<a class="product-link" href="${escapeAttr(item.product_url)}" target="_blank" rel="noopener">查看商品頁</a>` : ''}
      </div>
    </article>`;
}

function resetResultsOnly() {
  analysisPanel.classList.add('hidden');
  resultsSection.classList.add('hidden');
  bottomAction.classList.add('hidden');
  resultsList.innerHTML = '';
}

function resetForNext() {
  resetResultsOnly();
  scanPanel.classList.add('hidden');
  emptyState.classList.remove('hidden');
  searchInput.value = '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function compressImage(file, maxSide, quality) {
  if (!file.type.startsWith('image/')) throw new Error('請選擇圖片檔');
  const bitmap = await createImageBitmap(file);
  const ratio = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * ratio));
  const height = Math.max(1, Math.round(bitmap.height * ratio));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('圖片壓縮失敗')), 'image/jpeg', quality));
}

function money(value, currency = 'TWD') {
  const number = Number(value);
  if (!Number.isFinite(number)) return '價格未提供';
  return new Intl.NumberFormat('zh-TW', { style: 'currency', currency: currency === 'NTD' ? 'TWD' : currency, maximumFractionDigits: 0 }).format(number);
}

function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

function truncate(text, max) { return text.length > max ? `${text.slice(0, max)}…` : text; }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }
function escapeAttr(value) { return escapeHtml(value); }
function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastEl._timer);
  toastEl._timer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}
