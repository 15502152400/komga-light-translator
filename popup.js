const siteEl = document.getElementById('site');
const toggleEl = document.getElementById('toggle');
const settingsEl = document.getElementById('settings');
const statusEl = document.getElementById('status');

let currentOrigin = null;
let enabled = false;

function setStatus(text, error = false) {
  statusEl.textContent = text || '';
  statusEl.classList.toggle('error', error);
}

async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https?:/.test(tab.url)) {
    siteEl.textContent = '当前页面不是 HTTP/HTTPS 网页';
    return;
  }

  currentOrigin = new URL(tab.url).origin;
  siteEl.textContent = currentOrigin;
  const { enabledOrigins = [] } = await chrome.storage.local.get('enabledOrigins');
  enabled = enabledOrigins.includes(currentOrigin);
  toggleEl.disabled = false;
  toggleEl.textContent = enabled ? '停用此站点' : '启用此站点';
}

toggleEl.addEventListener('click', async () => {
  if (!currentOrigin) return;
  toggleEl.disabled = true;
  setStatus('');
  try {
    if (!enabled) {
      const pattern = `${currentOrigin}/*`;
      const granted = await chrome.permissions.request({ origins: [pattern] });
      if (!granted) throw new Error('未获得当前站点访问权限');
    }
    const type = enabled ? 'DISABLE_SITE' : 'ENABLE_SITE';
    const result = await chrome.runtime.sendMessage({ type, origin: currentOrigin });
    if (!result?.ok) throw new Error(result?.error || '操作失败');
    enabled = !enabled;
    toggleEl.textContent = enabled ? '停用此站点' : '启用此站点';
    setStatus(enabled ? '已启用。刷新当前 Komga 页面即可。' : '已停用。刷新页面后完全卸载。');
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    toggleEl.disabled = false;
  }
});

settingsEl.addEventListener('click', () => chrome.runtime.openOptionsPage());
refresh().catch(error => setStatus(error.message || String(error), true));
