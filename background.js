const CONTENT_SCRIPT_ID_PREFIX = 'komga-light-translator-';
const MODEL_REQUEST_TIMEOUT_MS = 60000;

function scriptIdForOrigin(origin) {
  const bytes = new TextEncoder().encode(origin);
  let hash = 2166136261;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return CONTENT_SCRIPT_ID_PREFIX + (hash >>> 0).toString(16);
}

function matchPatternForOrigin(origin) {
  const url = new URL(origin);
  return `${url.protocol}//${url.host}/*`;
}

async function ensureSiteEnabled(origin) {
  const match = matchPatternForOrigin(origin);
  const granted = await chrome.permissions.contains({ origins: [match] });
  if (!granted) throw new Error('未获得站点访问权限');

  const id = scriptIdForOrigin(origin);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  if (!existing.length) {
    await chrome.scripting.registerContentScripts([{
      id,
      matches: [match],
      js: ['content.js'],
      css: ['content.css'],
      runAt: 'document_idle',
      persistAcrossSessions: true
    }]);
  }

  const { enabledOrigins = [] } = await chrome.storage.local.get('enabledOrigins');
  if (!enabledOrigins.includes(origin)) {
    enabledOrigins.push(origin);
    await chrome.storage.local.set({ enabledOrigins });
  }
  return true;
}

async function disableSite(origin) {
  const id = scriptIdForOrigin(origin);
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [id] });
  } catch (_) {}

  const { enabledOrigins = [] } = await chrome.storage.local.get('enabledOrigins');
  await chrome.storage.local.set({ enabledOrigins: enabledOrigins.filter(x => x !== origin) });
  return true;
}

function headersFromSetting(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('Headers 必须是 JSON 对象');
    }
    return parsed;
  } catch (error) {
    throw new Error(`Headers JSON 无效: ${error.message}`);
  }
}

function endpointLabel(endpoint) {
  return `${endpoint.origin}${endpoint.pathname}`;
}

function formatNetworkError(error, endpoint) {
  if (error?.name === 'AbortError') {
    return `模型接口连接或响应超时（${Math.round(MODEL_REQUEST_TIMEOUT_MS / 1000)} 秒）：${endpointLabel(endpoint)}`;
  }

  const causeCode = error?.cause?.code ? `，底层代码 ${error.cause.code}` : '';
  const browserMessage = error?.message && error.message !== 'Failed to fetch'
    ? `；浏览器错误：${error.message}`
    : '';

  return [
    `无法连接模型接口：${endpointLabel(endpoint)}${causeCode}${browserMessage}`,
    '请检查接口 URL、模型服务是否启动、端口/反向代理是否可访问，以及 HTTPS 证书是否已被 Edge 信任。',
    '如果接口使用自签名证书，请先在 Edge 中直接打开该接口域名并处理证书警告。'
  ].join(' ');
}

async function proxyJsonRequest(url, headers, body) {
  if (!url) throw new Error('模型接口 URL 未配置');
  const endpoint = new URL(url);
  if (!['http:', 'https:'].includes(endpoint.protocol)) {
    throw new Error('模型接口 URL 只支持 http/https');
  }

  const originPattern = `${endpoint.protocol}//${endpoint.host}/*`;
  const hasPermission = await chrome.permissions.contains({ origins: [originPattern] });
  if (!hasPermission) {
    throw new Error(`没有访问接口 ${endpoint.origin} 的权限，请在扩展设置中重新保存并授权`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_REQUEST_TIMEOUT_MS);
  let response;

  try {
    response = await fetch(endpoint.href, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headersFromSetting(headers)
      },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: controller.signal
    });
  } catch (error) {
    throw new Error(formatNetworkError(error, endpoint));
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_) {
    throw new Error(`接口返回的不是 JSON（HTTP ${response.status}）: ${text.slice(0, 240)}`);
  }

  if (!response.ok) {
    const detail = data?.error?.message || data?.message || text || response.statusText;
    throw new Error(`HTTP ${response.status}: ${detail}`);
  }
  return data;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'ENABLE_SITE':
        return { ok: true, value: await ensureSiteEnabled(message.origin) };
      case 'DISABLE_SITE':
        return { ok: true, value: await disableSite(message.origin) };
      case 'MODEL_REQUEST':
        return { ok: true, value: await proxyJsonRequest(message.url, message.headers, message.body) };
      case 'PING':
        return { ok: true };
      default:
        return { ok: false, error: '未知消息' };
    }
  })().then(sendResponse).catch(error => {
    sendResponse({ ok: false, error: error?.message || String(error) });
  });
  return true;
});
