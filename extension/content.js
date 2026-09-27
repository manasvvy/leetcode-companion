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
  // Confirmed via live diagnostic: non-Accepted verdicts do NOT get the
  // data-e2e-locator="submission-result" treatment — LeetCode renders them
  // as a red-colored <h3> heading instead (see findRedVerdictElement below).
  const NON_ACCEPTED_VERDICTS = [
    'Wrong Answer',
    'Time Limit Exceeded',
    'Runtime Error',
    'Memory Limit Exceeded',
    'Output Limit Exceeded',
    'Compile Error',
  ];

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

  // Non-Accepted verdicts (Wrong Answer, TLE, etc.) render as a red <h3>
  // heading instead of the data-e2e-locator span — confirmed via live
  // diagnostic. Matching on tag + a semantic color class (rather than the
  // full Tailwind class string, which is brittle across theme/build
  // changes) plus requiring the text to start with a known verdict keeps
  // this narrow enough not to match an unrelated heading elsewhere.
  function findRedVerdictElement() {
    const headings = document.querySelectorAll('h3');
    for (const h of headings) {
      if (typeof h.className !== 'string' || !h.className.includes('text-red')) continue;
      const text = (h.textContent || '').trim();
      const verdict = NON_ACCEPTED_VERDICTS.find((v) => text.startsWith(v));
      if (verdict) return verdict;
    }
    return null;
  }

  // After a Run/Submit, watch for the result. Two independent DOM shapes
  // are checked, confirmed via live diagnostic: Accepted uses
  // `<span data-e2e-locator="submission-result">`, while every other
  // verdict uses a red `<h3>` heading with no such locator at all — an
  // asymmetry in LeetCode's own markup, not something fixable with one
  // selector. Either element may already exist (stale from a previous run)
  // or get inserted fresh, so on any DOM change we just re-check both.
  function watchForResult(triggerAction) {
    const deadline = Date.now() + 30_000; // stop watching after 30s

    function reportIfPresent() {
      const successEl = document.querySelector(RESULT_SELECTOR);
      const text = successEl ? (successEl.textContent || '').trim() : findRedVerdictElement();
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
  // (cheapest reliable option without hooking the app's own router).
  //
  // CONFIRMED via live diagnostic: submitting navigates the URL from
  // /problems/<slug>/ to /problems/<slug>/submissions/<id>/ — a sub-route
  // of the SAME problem, not a new one. Comparing full href (as before)
  // treated that as "new page" and tore down the in-flight result
  // observer before it could fire, which is exactly why Wrong Answer
  // (whose heavier render loses the race against our 1s poll) was being
  // missed while faster-rendering Accepted sometimes wasn't. Comparing the
  // problem *slug* instead means we only reinit when the problem actually
  // changes, letting the result observer/idle timer survive that nav.
  let lastUrl = null;
  let lastSlug = null;

  function getProblemSlug(url) {
    const m = /^https:\/\/leetcode\.com\/problems\/([^/]+)/.exec(url);
    return m ? m[1] : null;
  }

  function initForCurrentPage() {
    teardown();
    if (!isProblemPage()) {
      console.log(`${LOG_PREFIX} not a problem page, idling`);
      lastSlug = null;
      return;
    }
    lastUrl = location.href;
    lastSlug = getProblemSlug(location.href);
    state = freshState();
    console.log(`${LOG_PREFIX} initialized for`, location.href);
    injectPageBridge();
    attachIdleTracking();
    ensurePanel();
  }

  function pollForNavigation() {
    if (location.href === lastUrl) return;
    const newSlug = getProblemSlug(location.href);
    if (newSlug && newSlug === lastSlug) {
      // Same problem, just an SPA sub-route change (e.g. into/out of a
      // /submissions/<id>/ detail view) — don't tear down active result
      // watchers or the idle timer over this, just track the new URL.
      console.log(`${LOG_PREFIX} same-problem navigation (no reinit):`, lastUrl, '->', location.href);
      lastUrl = location.href;
      return;
    }
    console.log(`${LOG_PREFIX} navigation detected:`, lastUrl, '->', location.href);
    initForCurrentPage();
  }

  // Document-level click delegation is registered ONCE — it survives SPA
  // navigation since `document` itself is never replaced.
  document.addEventListener('click', onDocumentClick, true);

  window.addEventListener('popstate', pollForNavigation);
  setInterval(pollForNavigation, 1000);

  initForCurrentPage();
})();