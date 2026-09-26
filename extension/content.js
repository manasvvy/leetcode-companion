// content.js — LeetCode Companion (dev scaffold)
// Scope: page detection, Run/Submit click detection, result detection,
// Monaco code reading + non-empty check, idle tracking (log only, no
// prompt), and a minimal inert side panel. No storage, no backend, no LLM
// calls in this file — that's intentional, per current task scope.

(function () {
  'use strict';

  // ---- Guard against double-injection (SPA re-runs, extension reload) ----
  if (window.__lcCompanionLoaded) {
    console.log('[LC Companion] already loaded, skipping re-init');
    return;
  }
  window.__lcCompanionLoaded = true;

  const LOG_PREFIX = '[LC Companion]';
  const IDLE_THRESHOLD_MS = 60_000;
  const IDLE_CHECK_INTERVAL_MS = 5_000;
  // Confirmed via live diagnostic (see conversation) — LeetCode marks these
  // with stable data-e2e-locator attributes, independent of its obfuscated
  // CSS-module classes.
  const SUBMIT_SELECTOR = '[data-e2e-locator="console-submit-button"]';
  const RESULT_SELECTOR = '[data-e2e-locator="submission-result"]';
  const RUN_SELECTOR = '[data-e2e-locator="console-run-button"]';

  // Per-"problem session" state. Reset on SPA navigation.
  let state = null;

  function freshState() {
    return {
      lastEditAt: Date.now(),
      idleFired: false,
      lastResult: null,
      lastResultAt: 0,
      observers: [], // MutationObservers to disconnect on nav
      idleIntervalId: null,
    };
  }

  function teardown() {
    if (!state) return;
    // DIAGNOSTIC ONLY — confirms the suspected race: are we disconnecting
    // a result-watching observer that never got to fire?
    if (state.observers.length > 0 && !state.lastResult) {
      console.log(
        `${LOG_PREFIX}[DIAG] teardown(): disconnecting ${state.observers.length} observer(s) with NO result observed yet`
      );
    }
    state.observers.forEach((o) => {
      try {
        o.disconnect();
      } catch (_) {}
    });
    if (state.idleIntervalId) clearInterval(state.idleIntervalId);
    state = null;
  }

  // ---------------------------------------------------------------------
  // 1. Page detection
  // ---------------------------------------------------------------------
  function isProblemPage() {
    return /^https:\/\/leetcode\.com\/problems\//.test(location.href);
  }

  // ---------------------------------------------------------------------
  // 2 & 3. Run/Submit click detection + result detection
  // ---------------------------------------------------------------------
  function findActionFromClick(target) {
    // Submit — CONFIRMED via diagnostic: clicks land on an inner SVG, but
    // the nearest data-e2e-locator element is stable regardless of which
    // inner element was actually clicked.
    if (target.closest && target.closest(SUBMIT_SELECTOR)) return 'submit';
    // Run — CONFIRMED via diagnostic: ariaLabel "Run", data-e2e-locator
    // "console-run-button".
    if (target.closest && target.closest(RUN_SELECTOR)) return 'run';
    return null;
  }

  function onDocumentClick(e) {
    if (!state) return;
    try {
      const action = findActionFromClick(e.target);
      if (!action) return;
      console.log(`${LOG_PREFIX} ${action.toUpperCase()} clicked`);
      checkEditorState(); // was manual-only before; now fires on every click
      watchForResult(action);
    } catch (err) {
      console.warn(`${LOG_PREFIX} click handler error:`, err);
    }
  }

  // After a Run/Submit, watch for the result. CONFIRMED via diagnostic:
  // LeetCode renders it as `<span data-e2e-locator="submission-result">`.
  // That element may already exist (stale from a previous run, just gets
  // its text swapped) or get inserted fresh, so we don't need to guess
  // which mutation shape happens — on any DOM change, just re-check what
  // that element currently says.
  function watchForResult(triggerAction) {
    const deadline = Date.now() + 30_000; // stop watching after 30s

    function reportIfPresent() {
      const el = document.querySelector(RESULT_SELECTOR);
      if (!el) return false;
      const text = (el.textContent || '').trim();
      if (!text) return false;
      const now = Date.now();
      // de-dupe: ignore repeat firing for the same result within 2s
      if (state.lastResult === text && now - state.lastResultAt < 2000) return false;
      state.lastResult = text;
      state.lastResultAt = now;
      console.log(`${LOG_PREFIX} RESULT (${triggerAction}):`, text);
      return true;
    }

    const observer = new MutationObserver(() => {
      if (Date.now() > deadline) {
        observer.disconnect();
        return;
      }
      if (reportIfPresent()) observer.disconnect();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    state.observers.push(observer);
    reportIfPresent(); // in case the element already has the answer
  }

  // ---------------------------------------------------------------------
  // 5. Reading Monaco's current code
  // ---------------------------------------------------------------------
  // Content scripts run in an isolated JS world: they share the page's DOM
  // but NOT its JS globals, so `window.monaco` is invisible here even
  // though it exists on the page. We inject page-bridge.js into the page's
  // own context and talk to it via CustomEvents on `document` (the DOM is
  // shared, so this works across the world boundary). If that fails for
  // any reason (monaco not global, no models, etc.) we fall back to
  // scraping Monaco's own — stable, library-owned — `.view-lines` DOM.
  // Note: the fallback only sees currently-rendered (viewport) lines,
  // since Monaco virtualizes long files.
  function injectPageBridge() {
    if (document.getElementById('lc-companion-bridge')) return;
    const script = document.createElement('script');
    script.id = 'lc-companion-bridge';
    script.src = chrome.runtime.getURL('page-bridge.js');
    script.onload = () => script.remove(); // no need to keep the tag around
    (document.head || document.documentElement).appendChild(script);
  }

  function getCodeViaBridge(timeoutMs = 300) {
    return new Promise((resolve) => {
      let done = false;
      const onResponse = (e) => {
        if (done) return;
        done = true;
        document.removeEventListener('lc-companion:code-response', onResponse);
        resolve(e.detail);
      };
      document.addEventListener('lc-companion:code-response', onResponse);
      document.dispatchEvent(new CustomEvent('lc-companion:request-code'));
      setTimeout(() => {
        if (done) return;
        done = true;
        document.removeEventListener('lc-companion:code-response', onResponse);
        resolve({ ok: false, code: null, error: 'bridge timeout' });
      }, timeoutMs);
    });
  }

  function getCodeViaDomFallback() {
    try {
      const lines = Array.from(
        document.querySelectorAll('.monaco-editor .view-lines .view-line')
      );
      if (lines.length === 0) return null;
      // Monaco absolutely-positions each rendered line via inline `top`;
      // sort by that to reconstruct line order.
      lines.sort(
        (a, b) => parseFloat(a.style.top || '0') - parseFloat(b.style.top || '0')
      );
      return lines.map((l) => l.textContent).join('\n');
    } catch (err) {
      console.warn(`${LOG_PREFIX} DOM fallback failed:`, err);
      return null;
    }
  }

  async function getCurrentCode() {
    const bridgeResult = await getCodeViaBridge();
    if (bridgeResult.ok && typeof bridgeResult.code === 'string') {
      return { code: bridgeResult.code, source: 'monaco-bridge' };
    }
    const fallback = getCodeViaDomFallback();
    return { code: fallback, source: fallback !== null ? 'dom-fallback' : 'none' };
  }

  // ---------------------------------------------------------------------
  // 6. Non-empty check — exposed for manual console testing
  // ---------------------------------------------------------------------
  async function checkEditorState() {
    const { code, source } = await getCurrentCode();
    const nonEmpty = typeof code === 'string' && code.trim().length > 0;
    console.log(
      `${LOG_PREFIX} editor check — source: ${source}, nonEmpty: ${nonEmpty}, length: ${
        code ? code.length : 0
      }`
    );
    return { code, nonEmpty, source };
  }

  // ---------------------------------------------------------------------
  // 7. Idle tracking (detection only — no prompt shown yet)
  // ---------------------------------------------------------------------
  function attachIdleTracking() {
    const markActive = () => {
      if (!state) return;
      state.lastEditAt = Date.now();
      if (state.idleFired) {
        state.idleFired = false;
        console.log(`${LOG_PREFIX} editor active again (idle cleared)`);
      }
    };
    // Monaco's own textarea class ('.inputarea') is library-owned, not
    // LeetCode-specific, so this is a stable hook.
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.target && e.target.classList && e.target.classList.contains('inputarea')) {
          markActive();
        }
      },
      true
    );

    const intervalId = setInterval(() => {
      if (!state || state.idleFired) return;
      if (Date.now() - state.lastEditAt >= IDLE_THRESHOLD_MS) {
        state.idleFired = true;
        console.log(`${LOG_PREFIX} IDLE event (>=60s without edits) — no prompt shown yet`);
      }
    }, IDLE_CHECK_INTERVAL_MS);
    state.idleIntervalId = intervalId;
  }

  // ---------------------------------------------------------------------
  // 8. Minimal side panel
  // ---------------------------------------------------------------------
  function ensurePanel() {
    let panel = document.getElementById('lc-companion-panel');
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = 'lc-companion-panel';
    panel.style.display = 'none';
    panel.innerHTML =
      '<div id="lc-companion-panel-header">🧠 Companion</div>' +
      '<div id="lc-companion-panel-body"></div>';
    document.body.appendChild(panel);
    return panel;
  }

  // Public-ish API for later steps to call. Question bank / LLM calls are
  // NOT implemented here — this just proves the panel can display text.
  window.__lcCompanion = window.__lcCompanion || {};
  window.__lcCompanion.showQuestion = function showQuestion(text) {
    const panel = ensurePanel();
    panel.querySelector('#lc-companion-panel-body').textContent = text;
    panel.style.display = 'block';
  };
  window.__lcCompanion.hide = function hide() {
    const panel = document.getElementById('lc-companion-panel');
    if (panel) panel.style.display = 'none';
  };
  // Exposed for manual console testing right now:
  window.__lcCompanion.debugCheckEditor = checkEditorState;

  // ---------------------------------------------------------------------
  // Init / SPA navigation handling
  // ---------------------------------------------------------------------
  // LeetCode is a client-routed SPA — plain page loads won't fire between
  // problems, so `document_idle` alone isn't enough. We poll location.href
  // (cheapest reliable option without hooking the app's own router) and
  // reinitialize per-problem state on change.
  let lastUrl = null;

  function initForCurrentPage() {
    teardown();
    if (!isProblemPage()) {
      console.log(`${LOG_PREFIX} not a problem page, idling`);
      return;
    }
    lastUrl = location.href;
    state = freshState();
    console.log(`${LOG_PREFIX} initialized for`, location.href);
    injectPageBridge();
    attachIdleTracking();
    ensurePanel();

    // DIAGNOSTIC ONLY — checks whether RESULT_SELECTOR's element/text is
    // actually present on a submission-detail sub-route, independent of
    // whether any observer is currently attached. Tells us whether this is
    // (a) our own observer being torn down before it fires, or (b) a
    // different selector needed for this view. Doesn't change detection.
    if (/\/submissions\//.test(location.href)) {
      [300, 800, 1500, 3000].forEach((delay) => {
        setTimeout(() => {
          const el = document.querySelector(RESULT_SELECTOR);
          console.log(
            `${LOG_PREFIX}[DIAG] +${delay}ms RESULT_SELECTOR check:`,
            el ? JSON.stringify(el.textContent.trim()) : 'not found'
          );
          diagFindWrongAnswerText(delay);
        }, delay);
      });
    }
  }

  // DIAGNOSTIC ONLY — walks TEXT nodes (cheap, no full-DOM element dump)
  // looking for literal "Wrong Answer" text, then reports the containing
  // element plus a few ancestor levels — tag, id, class, and every data-*
  // /aria-* attribute — so we can find a stable hook without guessing.
  function diagCollectAttrs(el) {
    const out = {};
    if (!el || !el.attributes) return out;
    for (const attr of el.attributes) out[attr.name] = attr.value;
    return out;
  }

  function diagDescribeChain(el, levels) {
    const chain = [];
    let cur = el;
    for (let i = 0; i < levels && cur && cur.nodeType === Node.ELEMENT_NODE; i++) {
      chain.push({
        tagName: cur.tagName,
        attrs: diagCollectAttrs(cur),
        textPreview: (cur.textContent || '').trim().slice(0, 60),
      });
      cur = cur.parentElement;
    }
    return chain;
  }

  function diagFindWrongAnswerText(delay) {
    const needle = 'Wrong Answer';
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    let node;
    let matches = 0;
    while ((node = walker.nextNode()) && matches < 3) {
      if (!node.textContent || !node.textContent.includes(needle)) continue;
      const el = node.parentElement;
      const key = el ? el.outerHTML.slice(0, 50) : node.textContent;
      if (seen.has(key)) continue;
      seen.add(key);
      matches++;
      console.log(
        `${LOG_PREFIX}[DIAG] +${delay}ms found "${needle}" — ancestor chain (leaf first):`,
        diagDescribeChain(el, 4)
      );
    }
    if (matches === 0) {
      console.log(`${LOG_PREFIX}[DIAG] +${delay}ms "${needle}" not found anywhere in document.body`);
    }
  }

  function pollForNavigation() {
    if (location.href !== lastUrl) {
      console.log(`${LOG_PREFIX} navigation detected:`, lastUrl, '->', location.href);
      initForCurrentPage();
    }
  }

  // Document-level click delegation is registered ONCE — it survives SPA
  // navigation since `document` itself is never replaced.
  document.addEventListener('click', onDocumentClick, true);

  window.addEventListener('popstate', pollForNavigation);
  setInterval(pollForNavigation, 1000);

  initForCurrentPage();
})();