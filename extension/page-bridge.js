// page-bridge.js
// Runs in the PAGE's own JS context (injected via <script src>), not the
// content script's isolated world. This is the only way to reach
// `window.monaco`, since content scripts share the DOM with the page but
// not its JS globals. Communicates back to content.js purely via
// CustomEvents on `document`, which both worlds can see.
(function () {
  const REQUEST_EVENT = 'lc-companion:request-code';
  const RESPONSE_EVENT = 'lc-companion:code-response';

  document.addEventListener(REQUEST_EVENT, () => {
    const payload = { ok: false, code: null, error: null };
    try {
      if (window.monaco && window.monaco.editor) {
        const models = window.monaco.editor.getModels();
        if (models && models.length > 0) {
          // LeetCode may keep more than one model alive (e.g. across
          // language switches). Heuristic: the active/real one is usually
          // the longest, since stale models tend to be boilerplate-sized.
          const model = models.reduce((a, b) =>
            b.getValueLength() > a.getValueLength() ? b : a
          );
          payload.code = model.getValue();
          payload.ok = true;
        } else {
          payload.error = 'monaco.editor.getModels() returned no models';
        }
      } else {
        payload.error = 'window.monaco not found in page context';
      }
    } catch (err) {
      payload.error = String(err && err.message ? err.message : err);
    }
    document.dispatchEvent(new CustomEvent(RESPONSE_EVENT, { detail: payload }));
  });
})();
