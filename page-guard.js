(() => {
  if (window.__KLT_PAGE_GUARD__) return;
  window.__KLT_PAGE_GUARD__ = true;

  const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);

  function isVisibleLarge(el) {
    const r = el.getBoundingClientRect();
    return r.width >= 200 && r.height >= 200 &&
      r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }

  function pageSignature() {
    const pages = [...document.querySelectorAll('img, canvas')]
      .filter(isVisibleLarge)
      .map(el => {
        if (el.tagName === 'IMG') {
          return `img:${el.currentSrc || el.src || ''}`;
        }
        return `canvas:${el.width}x${el.height}`;
      })
      .sort()
      .slice(0, 4);

    return `${location.href}|${pages.join('|')}`;
  }

  chrome.runtime.sendMessage = function patchedSendMessage(message, ...args) {
    if (message?.type !== 'MODEL_REQUEST') {
      return originalSendMessage(message, ...args);
    }

    const startedOn = pageSignature();
    const result = originalSendMessage(message, ...args);

    if (!result || typeof result.then !== 'function') return result;

    return result.then(response => {
      if (pageSignature() !== startedOn) {
        return {
          ok: false,
          stale: true,
          error: '页面已切换，已丢弃上一页的模型返回结果'
        };
      }
      return response;
    });
  };
})();
