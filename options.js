const DEFAULTS = {
  apiMode: 'generic',
  apiUrl: '',
  apiHeaders: '{}',
  model: '',
  targetLanguage: 'zh-CN',
  autoTranslate: true,
  contextPages: 3,
  maxImageSide: 1800,
  jpegQuality: 0.88,
  requestTimeoutSec: 180,
  maxOutputTokens: 2048,
  llamaCppOptimizations: true,
  minImageWidth: 500,
  minImageHeight: 700,
  showOriginal: false
};

const ids = Object.keys(DEFAULTS);
const statusEl = document.getElementById('status');

function setStatus(text, error = false) {
  statusEl.textContent = text || '';
  statusEl.classList.toggle('error', error);
}

function endpointOriginPattern(raw) {
  if (!raw) return null;
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('接口 URL 只支持 http/https');
  return `${url.protocol}//${url.host}/*`;
}

function validateHeaders(raw) {
  if (!raw.trim()) return '{}';
  const parsed = JSON.parse(raw);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('Headers 必须是 JSON 对象');
  }
  return JSON.stringify(parsed, null, 2);
}

async function load() {
  const settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = Boolean(settings[id]);
    else el.value = settings[id];
  }
}

document.getElementById('save').addEventListener('click', async () => {
  setStatus('');
  try {
    const settings = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      settings[id] = el.type === 'checkbox' ? el.checked : el.value;
    }

    settings.contextPages = Math.max(0, Math.min(10, Number(settings.contextPages) || 0));
    settings.maxImageSide = Math.max(800, Math.min(5000, Number(settings.maxImageSide) || 1800));
    settings.jpegQuality = Math.max(0.5, Math.min(1, Number(settings.jpegQuality) || 0.88));
    settings.requestTimeoutSec = Math.max(30, Math.min(900, Number(settings.requestTimeoutSec) || 180));
    settings.maxOutputTokens = Math.max(256, Math.min(8192, Number(settings.maxOutputTokens) || 2048));
    settings.minImageWidth = Math.max(200, Number(settings.minImageWidth) || 500);
    settings.minImageHeight = Math.max(200, Number(settings.minImageHeight) || 700);
    settings.apiHeaders = validateHeaders(settings.apiHeaders);

    const origin = endpointOriginPattern(settings.apiUrl);
    if (origin) {
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) throw new Error('没有获得模型接口地址的访问权限');
    }

    await chrome.storage.sync.set(settings);
    setStatus('已保存。已打开的漫画页会在下一次扫描时读取新设置。');
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
});

document.getElementById('clearCache').addEventListener('click', async () => {
  await chrome.storage.local.remove(['translationCache']);
  setStatus('翻译结果缓存已清空，上下文记忆仍保留。');
});

document.getElementById('clearContext').addEventListener('click', async () => {
  await chrome.storage.local.remove(['contextCache']);
  setStatus('漫画上下文记忆已清空。');
});

load().catch(error => setStatus(error.message || String(error), true));
