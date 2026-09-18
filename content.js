(() => {
  if (window.__KLT_LOADED__) return;
  window.__KLT_LOADED__ = true;

  const DEFAULTS = {
    apiMode: 'generic',
    apiUrl: '',
    apiHeaders: '{}',
    model: '',
    targetLanguage: 'zh-CN',
    autoTranslate: true,
    contextPages: 3,
    maxImageSide: 2400,
    minImageWidth: 500,
    minImageHeight: 700,
    showOriginal: false
  };

  const CONTEXT_VERSION = 1;
  const CACHE_LIMIT = 120;
  const CONTEXT_PAGE_LIMIT = 30;

  let settings = { ...DEFAULTS };
  let root;
  let toolbar;
  let statusEl;
  let showTranslations = true;
  let autoTranslate = true;
  let scanTimer = null;
  let queueRunning = false;
  const pending = [];
  const stateByElement = new WeakMap();
  const activeStates = new Set();
  let translationCache = {};
  let contextCache = {};

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text || '';
  }

  async function loadSettings() {
    settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
    autoTranslate = Boolean(settings.autoTranslate);
    const local = await chrome.storage.local.get({ translationCache: {}, contextCache: {} });
    translationCache = local.translationCache || {};
    contextCache = local.contextCache || {};
    updateToolbar();
  }

  function createUi() {
    root = document.createElement('div');
    root.id = 'klt-root';
    document.documentElement.appendChild(root);

    toolbar = document.createElement('div');
    toolbar.id = 'klt-toolbar';

    const autoBtn = document.createElement('button');
    autoBtn.id = 'klt-auto';
    autoBtn.title = '自动翻译';
    autoBtn.addEventListener('click', () => {
      autoTranslate = !autoTranslate;
      updateToolbar();
      if (autoTranslate) scheduleScan(0);
    });

    const visibleBtn = document.createElement('button');
    visibleBtn.id = 'klt-visible';
    visibleBtn.title = '显示/隐藏译文';
    visibleBtn.addEventListener('click', () => {
      showTranslations = !showTranslations;
      root.style.display = showTranslations ? 'block' : 'none';
      updateToolbar();
    });

    const nowBtn = document.createElement('button');
    nowBtn.textContent = '翻当前';
    nowBtn.title = '立即翻译当前可见漫画页';
    nowBtn.addEventListener('click', () => scan(true));

    statusEl = document.createElement('span');
    statusEl.id = 'klt-status';

    toolbar.append(autoBtn, visibleBtn, nowBtn, statusEl);
    document.documentElement.appendChild(toolbar);
  }

  function updateToolbar() {
    if (!toolbar) return;
    const autoBtn = toolbar.querySelector('#klt-auto');
    const visibleBtn = toolbar.querySelector('#klt-visible');
    autoBtn.textContent = autoTranslate ? '自动✓' : '自动';
    autoBtn.classList.toggle('klt-active', autoTranslate);
    visibleBtn.textContent = showTranslations ? '译✓' : '译';
    visibleBtn.classList.toggle('klt-active', showTranslations);
  }

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }

  function isCandidate(el) {
    const r = el.getBoundingClientRect();
    if (r.width < Number(settings.minImageWidth) || r.height < Number(settings.minImageHeight)) return false;
    if (!isVisible(el)) return false;
    if (el.tagName === 'IMG') {
      const src = el.currentSrc || el.src || '';
      if (!src || src.startsWith('data:image/svg')) return false;
    }
    return true;
  }

  function candidates() {
    return [...document.querySelectorAll('img, canvas')]
      .filter(isCandidate)
      .sort((a, b) => visibleArea(b) - visibleArea(a));
  }

  function visibleArea(el) {
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) *
      Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
  }

  function scheduleScan(delay = 250) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => scan(false), delay);
  }

  function sourceKey(el) {
    if (el.tagName === 'IMG') return el.currentSrc || el.src || '';
    return `canvas:${el.width}x${el.height}`;
  }

  function parsePageRef(el) {
    const src = el.tagName === 'IMG' ? (el.currentSrc || el.src || '') : '';
    const decoded = safeDecode(src);
    const apiMatch = decoded.match(/\/api\/v1\/books\/([^/?#]+)\/pages\/(\d+)/i);
    if (apiMatch) {
      const bookId = apiMatch[1];
      return {
        scope: `${location.origin}|book:${bookId}`,
        bookId,
        pageNumber: Number(apiMatch[2]),
        sourceUrl: src
      };
    }

    const pathMatch = location.pathname.match(/\/(?:read|reader|book|books)\/([^/?#]+)/i);
    const fallbackBook = pathMatch?.[1] || null;
    return {
      scope: fallbackBook ? `${location.origin}|book:${fallbackBook}` : `${location.origin}|path:${location.pathname}`,
      bookId: fallbackBook,
      pageNumber: null,
      sourceUrl: src
    };
  }

  function safeDecode(value) {
    try { return decodeURIComponent(value); } catch (_) { return value; }
  }

  async function scan(force) {
    if (!force && !autoTranslate) return;
    const list = candidates().slice(0, 2);
    for (const el of list) {
      let state = stateByElement.get(el);
      const key = sourceKey(el);
      if (state && state.sourceKey !== key) {
        clearRendered(state);
        state.done = false;
        state.queued = false;
        state.processing = false;
        state.blocks = [];
        state.hash = null;
        state.sourceKey = key;
        state.pageRef = parsePageRef(el);
      }
      if (!state || (!state.done && !state.queued && !state.processing)) enqueue(el);
    }
  }

  function enqueue(el) {
    let state = stateByElement.get(el);
    if (!state) {
      state = {
        el,
        sourceKey: sourceKey(el),
        pageRef: parsePageRef(el),
        queued: false,
        processing: false,
        done: false,
        blocks: [],
        hash: null
      };
      stateByElement.set(el, state);
      activeStates.add(state);
    }
    if (state.queued || state.processing || state.done) return;
    state.queued = true;
    pending.push(state);
    runQueue();
  }

  async function runQueue() {
    if (queueRunning) return;
    queueRunning = true;
    try {
      while (pending.length) {
        const state = pending.shift();
        state.queued = false;
        if (!document.contains(state.el) || !isCandidate(state.el)) continue;
        state.processing = true;
        try {
          await processPage(state);
          state.done = true;
        } catch (error) {
          console.warn('[KLT]', error);
          setStatus(`错误: ${error.message || error}`);
          state.errorAt = Date.now();
        } finally {
          state.processing = false;
        }
      }
    } finally {
      queueRunning = false;
      if (!pending.length && statusEl?.textContent?.startsWith('处理')) setStatus('就绪');
    }
  }

  async function elementToBlob(el) {
    if (el.tagName === 'CANVAS') {
      return await new Promise((resolve, reject) => {
        try {
          el.toBlob(blob => blob ? resolve(blob) : reject(new Error('无法读取 canvas')), 'image/jpeg', 0.92);
        } catch (error) { reject(error); }
      });
    }

    const src = el.currentSrc || el.src;
    const response = await fetch(src, { credentials: 'include', cache: 'force-cache' });
    if (!response.ok) throw new Error(`漫画图片读取失败: HTTP ${response.status}`);
    return await response.blob();
  }

  async function prepareImage(blob, maxSide) {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const out = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (!out) throw new Error('图片压缩失败');
    return { blob: out, width, height };
  }

  async function blobToBase64(blob) {
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  async function hashBlob(blob) {
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return [...new Uint8Array(digest)].slice(0, 16).map(x => x.toString(16).padStart(2, '0')).join('');
  }

  async function sendModel(body) {
    const result = await chrome.runtime.sendMessage({
      type: 'MODEL_REQUEST',
      url: settings.apiUrl,
      headers: settings.apiHeaders,
      body
    });
    if (!result?.ok) throw new Error(result?.error || '扩展后台请求失败');
    return result.value;
  }

  function getContext(scope) {
    const raw = contextCache[scope];
    if (raw?.version === CONTEXT_VERSION) return raw;
    return {
      version: CONTEXT_VERSION,
      rollingSummary: '',
      translationMemory: { characters: {}, terms: {}, speakerStyles: {} },
      pages: [],
      updatedAt: 0
    };
  }

  function buildContext(scope, currentPageNumber) {
    const ctx = getContext(scope);
    let pages = [...(ctx.pages || [])];
    if (Number.isFinite(currentPageNumber)) {
      const previous = pages.filter(p => Number.isFinite(p.pageNumber) && p.pageNumber < currentPageNumber);
      if (previous.length) pages = previous.sort((a, b) => b.pageNumber - a.pageNumber);
      else pages = pages.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    } else {
      pages.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    }

    const recentPages = pages.slice(0, Number(settings.contextPages || 0)).reverse().map(p => ({
      pageNumber: p.pageNumber ?? null,
      source: p.source || '',
      translation: p.translation || '',
      summary: p.summary || ''
    }));

    return {
      rollingSummary: ctx.rollingSummary || '',
      recentPages,
      translationMemory: ctx.translationMemory || { characters: {}, terms: {}, speakerStyles: {} }
    };
  }

  function genericRequest({ imageBase64, prepared, state, context }) {
    return {
      model: settings.model || undefined,
      targetLanguage: settings.targetLanguage,
      image: {
        mimeType: prepared.blob.type || 'image/jpeg',
        dataBase64: imageBase64,
        width: prepared.width,
        height: prepared.height
      },
      page: {
        url: location.href,
        sourceUrl: state.pageRef.sourceUrl || '',
        bookId: state.pageRef.bookId,
        pageNumber: state.pageRef.pageNumber,
        width: prepared.width,
        height: prepared.height
      },
      context
    };
  }

  function openAiRequest({ imageBase64, prepared, state, context }) {
    const schemaInstruction = [
      `Translate this manga page into ${settings.targetLanguage}.`,
      'Read the image yourself. Return JSON only, with no markdown fences.',
      'Use normalized coordinates from 0 to 1 relative to the image.',
      'Required top-level format:',
      '{"blocks":[{"id":"b1","source":"original","translation":"translated","x":0,"y":0,"width":0,"height":0}],"pageSummary":"short summary","contextUpdate":{"rollingSummary":"updated compact story summary","characters":{},"terms":{},"speakerStyles":{}}}',
      'Every visible dialogue/caption that should be translated must have one block. Keep names, terms, pronouns and tone consistent with the supplied context.',
      'rollingSummary must stay compact and should replace, not append blindly to, the prior rolling summary.'
    ].join('\n');

    const contextText = JSON.stringify({
      targetLanguage: settings.targetLanguage,
      page: {
        bookId: state.pageRef.bookId,
        pageNumber: state.pageRef.pageNumber
      },
      context
    });

    return {
      model: settings.model || undefined,
      messages: [
        { role: 'system', content: schemaInstruction },
        {
          role: 'user',
          content: [
            { type: 'text', text: `Context:\n${contextText}` },
            {
              type: 'image_url',
              image_url: { url: `data:${prepared.blob.type || 'image/jpeg'};base64,${imageBase64}` }
            }
          ]
        }
      ],
      temperature: 0.2
    };
  }

  function extractJsonText(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) throw new Error('模型返回为空');
    try { return JSON.parse(trimmed); } catch (_) {}
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) return JSON.parse(fence[1]);
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first >= 0 && last > first) return JSON.parse(trimmed.slice(first, last + 1));
    throw new Error('无法从模型返回中解析 JSON');
  }

  function normalizeResponse(data) {
    if (settings.apiMode === 'openai-chat') {
      const content = data?.choices?.[0]?.message?.content;
      if (Array.isArray(content)) {
        const text = content.map(x => typeof x === 'string' ? x : (x?.text || '')).join('\n');
        return extractJsonText(text);
      }
      return extractJsonText(content);
    }
    return data;
  }

  function normalizeResultBlock(block, index) {
    const bbox = block?.bbox;
    let x = Number(block?.x ?? block?.left ?? bbox?.x ?? bbox?.[0] ?? 0);
    let y = Number(block?.y ?? block?.top ?? bbox?.y ?? bbox?.[1] ?? 0);
    let width = Number(block?.width ?? block?.w ?? bbox?.width ?? bbox?.[2] ?? 0);
    let height = Number(block?.height ?? block?.h ?? bbox?.height ?? bbox?.[3] ?? 0);
    const allNormalized = Math.max(Math.abs(x), Math.abs(y), Math.abs(width), Math.abs(height)) <= 1.5;

    if (!allNormalized) {
      const iw = Number(block?.imageWidth || 1);
      const ih = Number(block?.imageHeight || 1);
      x /= iw;
      y /= ih;
      width /= iw;
      height /= ih;
    }

    return {
      id: String(block?.id ?? `b${index + 1}`),
      text: String(block?.source ?? block?.text ?? block?.original ?? '').trim(),
      translation: String(block?.translation ?? block?.translated ?? block?.target ?? '').trim(),
      x: clamp01(x),
      y: clamp01(y),
      width: clamp01(width),
      height: clamp01(height)
    };
  }

  function clamp01(n) {
    return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
  }

  async function processPage(state) {
    if (!settings.apiUrl) {
      setStatus('请先配置模型接口 URL');
      return;
    }

    setStatus('处理当前页…');
    const original = await elementToBlob(state.el);
    const prepared = await prepareImage(original, Number(settings.maxImageSide));
    const hash = await hashBlob(prepared.blob);
    state.hash = hash;
    state.pageRef = parsePageRef(state.el);

    const cacheKey = [location.origin, state.pageRef.bookId || '', state.pageRef.pageNumber ?? '', hash, settings.apiMode, settings.apiUrl, settings.model, settings.targetLanguage].join('|');
    const cached = translationCache[cacheKey];
    if (cached?.blocks?.length) {
      state.blocks = cached.blocks;
      renderState(state);
      await rememberContext(state.pageRef.scope, state.pageRef.pageNumber, cached.blocks, cached.pageSummary || '', cached.contextUpdate || {});
      setStatus('缓存命中');
      return;
    }

    const imageBase64 = await blobToBase64(prepared.blob);
    const context = buildContext(state.pageRef.scope, state.pageRef.pageNumber);
    const body = settings.apiMode === 'openai-chat'
      ? openAiRequest({ imageBase64, prepared, state, context })
      : genericRequest({ imageBase64, prepared, state, context });

    const raw = await sendModel(body);
    const result = normalizeResponse(raw) || {};
    const rawBlocks = Array.isArray(result) ? result : (result.blocks || result.translations || result.results || []);
    const blocks = rawBlocks.map(normalizeResultBlock).filter(b => b.translation && b.width > 0 && b.height > 0);

    if (!blocks.length) {
      setStatus('模型未返回可定位译文');
      state.done = true;
      return;
    }

    const pageSummary = String(result.pageSummary || result.contextSummary || result.summary || '').trim();
    const contextUpdate = result.contextUpdate && typeof result.contextUpdate === 'object' ? result.contextUpdate : {};
    state.blocks = blocks;
    renderState(state);

    translationCache[cacheKey] = { blocks, pageSummary, contextUpdate, savedAt: Date.now() };
    trimTranslationCache();
    await chrome.storage.local.set({ translationCache });
    await rememberContext(state.pageRef.scope, state.pageRef.pageNumber, blocks, pageSummary, contextUpdate);
    setStatus('已翻译');
  }

  async function rememberContext(scope, pageNumber, blocks, pageSummary, contextUpdate) {
    const ctx = getContext(scope);
    const source = blocks.map(b => b.text).filter(Boolean).join('\n');
    const translation = blocks.map(b => b.translation).filter(Boolean).join('\n');
    if (!source && !translation) return;

    const pageRecord = {
      pageNumber: Number.isFinite(pageNumber) ? pageNumber : null,
      source,
      translation,
      summary: pageSummary || '',
      savedAt: Date.now()
    };

    const sameIndex = ctx.pages.findIndex(p =>
      Number.isFinite(pageRecord.pageNumber) && p.pageNumber === pageRecord.pageNumber
    );
    if (sameIndex >= 0) ctx.pages[sameIndex] = pageRecord;
    else {
      const duplicate = ctx.pages.findIndex(p => p.source === source && p.translation === translation);
      if (duplicate >= 0) ctx.pages[duplicate] = pageRecord;
      else ctx.pages.push(pageRecord);
    }

    ctx.pages.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    ctx.pages = ctx.pages.slice(0, CONTEXT_PAGE_LIMIT);

    const rolling = contextUpdate.rollingSummary ?? contextUpdate.chapterSummary ?? contextUpdate.summary;
    if (typeof rolling === 'string' && rolling.trim()) ctx.rollingSummary = rolling.trim();
    mergeMemory(ctx.translationMemory, contextUpdate);
    ctx.updatedAt = Date.now();
    contextCache[scope] = ctx;
    trimContextCache();
    await chrome.storage.local.set({ contextCache });
  }

  function mergeMemory(memory, update) {
    memory.characters = { ...(memory.characters || {}), ...objectOrEmpty(update.characters), ...objectOrEmpty(update.newCharacters) };
    memory.terms = { ...(memory.terms || {}), ...objectOrEmpty(update.terms), ...objectOrEmpty(update.newTerms) };
    memory.speakerStyles = { ...(memory.speakerStyles || {}), ...objectOrEmpty(update.speakerStyles) };
  }

  function objectOrEmpty(value) {
    return value && !Array.isArray(value) && typeof value === 'object' ? value : {};
  }

  function trimTranslationCache() {
    const entries = Object.entries(translationCache);
    if (entries.length <= CACHE_LIMIT) return;
    entries.sort((a, b) => (b[1]?.savedAt || 0) - (a[1]?.savedAt || 0));
    translationCache = Object.fromEntries(entries.slice(0, CACHE_LIMIT));
  }

  function trimContextCache() {
    const entries = Object.entries(contextCache);
    if (entries.length <= 50) return;
    entries.sort((a, b) => (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0));
    contextCache = Object.fromEntries(entries.slice(0, 50));
  }

  function clearRendered(state) {
    state.nodes?.forEach(node => node.remove());
    state.nodes = [];
  }

  function renderState(state) {
    clearRendered(state);
    state.nodes = state.blocks.map(block => {
      const node = document.createElement('div');
      node.className = 'klt-block';
      node.dataset.kltId = block.id;

      const translated = document.createElement('div');
      translated.className = 'klt-translation';
      translated.textContent = block.translation || block.text;
      node.appendChild(translated);

      if (settings.showOriginal && block.text) {
        const original = document.createElement('div');
        original.className = 'klt-original';
        original.textContent = block.text;
        translated.appendChild(original);
      }

      root.appendChild(node);
      return node;
    });
    positionState(state);
  }

  function positionState(state) {
    if (!state.nodes?.length || !document.contains(state.el)) return;
    const rect = state.el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    state.nodes.forEach((node, i) => {
      const b = state.blocks[i];
      const left = rect.left + b.x * rect.width;
      const top = rect.top + b.y * rect.height;
      const width = Math.max(18, b.width * rect.width);
      const height = Math.max(18, b.height * rect.height);
      node.style.left = `${left}px`;
      node.style.top = `${top}px`;
      node.style.width = `${width}px`;
      node.style.height = `${height}px`;
      const font = Math.max(10, Math.min(26, height * 0.26));
      node.style.fontSize = `${font}px`;
      node.style.display = (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) ? 'none' : 'flex';
    });
  }

  function positionAll() {
    for (const state of [...activeStates]) {
      if (!document.contains(state.el)) {
        clearRendered(state);
        activeStates.delete(state);
        continue;
      }
      positionState(state);
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') loadSettings().then(() => scheduleScan(0));
  });

  const observer = new MutationObserver(() => scheduleScan(180));
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'style', 'class']
  });
  addEventListener('scroll', () => { positionAll(); scheduleScan(160); }, { passive: true, capture: true });
  addEventListener('resize', positionAll, { passive: true });

  createUi();
  loadSettings().then(() => scheduleScan(100)).catch(error => setStatus(error.message || String(error)));
})();
