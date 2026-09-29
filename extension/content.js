// content.js — LeetCode Companion
// Scope: page detection, Run/Submit click detection, result detection,
// Monaco code reading + non-empty check, idle tracking, pattern detection,
// question selection, and polished floating Companion Overlay UI.

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
  const SUBMIT_SELECTOR = '[data-e2e-locator="console-submit-button"]';
  const RESULT_SELECTOR = '[data-e2e-locator="submission-result"]';
  const RUN_SELECTOR = '[data-e2e-locator="console-run-button"]';
  const NON_ACCEPTED_VERDICTS = [
    'Wrong Answer',
    'Time Limit Exceeded',
    'Runtime Error',
    'Memory Limit Exceeded',
    'Output Limit Exceeded',
    'Compile Error',
  ];

  const TRIGGER_LABELS = {
    on_run: 'Technical Round',
    on_submit: '30-sec Defense',
    on_wrong: 'Debug This',
  };

  // Global UI Overlay State
  const uiState = {
    mode: 'pro', // 'pro' | 'genz'
    isMinimized: false,
    isClosed: false,
    currentQuestion: null, // Professional question string
    currentTrigger: null,  // 'on_run' | 'on_submit' | 'on_wrong'
    currentPattern: null,  // e.g. 'hashmap'
    showingHint: false,
  };

  function getQuestionBank() {
    if (typeof window !== 'undefined' && window.__lcQuestionBank) {
      return window.__lcQuestionBank;
    }
    if (typeof globalThis !== 'undefined' && globalThis.__lcQuestionBank) {
      return globalThis.__lcQuestionBank;
    }
    return null;
  }

  // Per-"problem session" state. Reset on SPA navigation.
  let state = null;

  function freshState() {
    const qb = getQuestionBank();
    return {
      lastEditAt: Date.now(),
      idleFired: false,
      lastResult: null,
      lastResultAt: 0,
      observers: [], // MutationObservers to disconnect on nav
      idleIntervalId: null,
      questionSession: qb && qb.createSession ? qb.createSession() : null,
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
    if (target.closest && target.closest(SUBMIT_SELECTOR)) return 'submit';
    if (target.closest && target.closest(RUN_SELECTOR)) return 'run';
    return null;
  }

  function onDocumentClick(e) {
    if (!state) return;
    try {
      const action = findActionFromClick(e.target);
      if (!action) return;
      console.log(`${LOG_PREFIX} ${action.toUpperCase()} clicked`);
      checkEditorState();
      handleQuestionTrigger(action === 'run' ? 'on_run' : 'on_submit');
      watchForResult(action);
    } catch (err) {
      console.warn(`${LOG_PREFIX} click handler error:`, err);
    }
  }

  async function handleQuestionTrigger(trigger) {
    if (!state) return;
    const session = state.questionSession;
    try {
      const { code } = await getCurrentCode();
      const slug = getProblemSlug(location.href);
      const qb = getQuestionBank();
      if (!qb) return;
      const pattern = qb.detectPattern({ code, slug, document });
      const question = qb.selectQuestion({
        trigger,
        pattern,
        session,
      });
      if (question) {
        console.log(
          `${LOG_PREFIX} question (${trigger}, ${pattern || 'fallback'}): ${question}`
        );
        uiState.currentQuestion = question;
        uiState.currentTrigger = trigger;
        uiState.currentPattern = pattern || 'fallback';
        uiState.showingHint = false;
        uiState.isClosed = false;
        uiState.isMinimized = false;
        renderOverlay();
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} error selecting question:`, err);
    }
  }

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

  function watchForResult(triggerAction) {
    const deadline = Date.now() + 30_000;

    function reportIfPresent() {
      const successEl = document.querySelector(RESULT_SELECTOR);
      const text = successEl ? (successEl.textContent || '').trim() : findRedVerdictElement();
      if (!text) return false;
      const now = Date.now();
      if (state.lastResult === text && now - state.lastResultAt < 2000) return false;
      state.lastResult = text;
      state.lastResultAt = now;
      console.log(`${LOG_PREFIX} RESULT (${triggerAction}):`, text);
      if (text.startsWith('Wrong Answer')) {
        handleQuestionTrigger('on_wrong');
      }
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
    reportIfPresent();
  }

  // ---------------------------------------------------------------------
  // 5. Reading Monaco's current code
  // ---------------------------------------------------------------------
  function injectPageBridge() {
    if (document.getElementById('lc-companion-bridge')) return;
    const script = document.createElement('script');
    script.id = 'lc-companion-bridge';
    script.src = chrome.runtime.getURL('page-bridge.js');
    script.onload = () => script.remove();
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
  // 6. Non-empty check
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
  // 7. Idle tracking
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
  // 8. Companion Overlay UI Rendering
  // ---------------------------------------------------------------------
  function ensureOverlayElements() {
    let panel = document.getElementById('lc-companion-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'lc-companion-panel';
      panel.className = 'lc-companion-panel lc-companion-hidden';
      document.body.appendChild(panel);
    }

    let badge = document.getElementById('lc-companion-minimized-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'lc-companion-minimized-badge';
      badge.className = 'lc-companion-minimized-badge lc-companion-hidden';
      badge.setAttribute('tabindex', '0');
      badge.setAttribute('aria-label', 'Reopen LeetCode Companion');
      badge.innerHTML =
        '<span class="lc-companion-badge-icon">✦</span>' +
        '<span>LC Companion</span>' +
        '<span class="lc-companion-badge-dot"></span>';

      const onBadgeClick = () => {
        uiState.isMinimized = false;
        renderOverlay();
      };
      badge.addEventListener('click', onBadgeClick);
      badge.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onBadgeClick();
        }
      });
      document.body.appendChild(badge);
    }

    return { panel, badge };
  }

  function renderOverlay() {
    const { panel, badge } = ensureOverlayElements();

    if (uiState.isClosed || !uiState.currentQuestion) {
      panel.classList.add('lc-companion-hidden');
      badge.classList.add('lc-companion-hidden');
      panel.style.display = 'none';
      badge.style.display = 'none';
      return;
    }

    if (uiState.isMinimized) {
      panel.classList.add('lc-companion-hidden');
      panel.style.display = 'none';
      badge.classList.remove('lc-companion-hidden');
      badge.style.display = 'flex';
      return;
    }

    // Expanded view
    badge.classList.add('lc-companion-hidden');
    badge.style.display = 'none';
    panel.classList.remove('lc-companion-hidden');
    panel.style.display = 'block';

    const qb = getQuestionBank();
    const isGenZ = uiState.mode === 'genz';
    const displayText = isGenZ && qb && qb.getGenZQuestion
      ? qb.getGenZQuestion(uiState.currentQuestion)
      : uiState.currentQuestion;

    const triggerLabel = TRIGGER_LABELS[uiState.currentTrigger] || 'Technical Question';
    const patternTag = (uiState.currentPattern || 'general').replace('_', ' ');

    panel.innerHTML = `
      <div class="lc-companion-header">
        <div class="lc-companion-title">
          <span class="lc-companion-title-icon">✦</span>
          <span>LC Companion</span>
        </div>
        <div class="lc-companion-header-right">
          <div class="lc-companion-mode-toggle" role="group" aria-label="Tone mode toggle">
            <button type="button" class="lc-companion-toggle-btn ${!isGenZ ? 'lc-companion-toggle-btn-active' : ''}" data-mode="pro" aria-label="Professional tone mode">PRO</button>
            <button type="button" class="lc-companion-toggle-btn ${isGenZ ? 'lc-companion-toggle-btn-active' : ''}" data-mode="genz" aria-label="Gen Z tone mode">GEN Z</button>
          </div>
          <button type="button" class="lc-companion-control-btn lc-companion-btn-minimize" aria-label="Minimize Companion" title="Minimize">−</button>
          <button type="button" class="lc-companion-control-btn lc-companion-btn-close" aria-label="Close Companion" title="Close">×</button>
        </div>
      </div>
      <div class="lc-companion-body">
        <div class="lc-companion-badges">
          <span class="lc-companion-badge">${escapeHtml(triggerLabel)}</span>
          <span class="lc-companion-pattern-tag">${escapeHtml(patternTag)}</span>
        </div>
        <p class="lc-companion-question-text">${escapeHtml(displayText)}</p>
        ${
          uiState.showingHint
            ? `<div class="lc-companion-hint-box">💡 Hint: Take a step back and trace your variable invariants step by step!</div>`
            : ''
        }
        <div class="lc-companion-actions">
          <button type="button" class="lc-companion-btn lc-companion-btn-secondary lc-companion-action-hint">${uiState.showingHint ? 'Hide Hint' : "I don't know"}</button>
          <button type="button" class="lc-companion-btn lc-companion-btn-primary lc-companion-action-gotit">Got it</button>
        </div>
      </div>
    `;

    // Bind event listeners inside panel
    const toggleBtns = panel.querySelectorAll('.lc-companion-toggle-btn');
    toggleBtns.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const mode = e.currentTarget.getAttribute('data-mode');
        if (mode && uiState.mode !== mode) {
          uiState.mode = mode;
          renderOverlay();
        }
      });
    });

    const minimizeBtn = panel.querySelector('.lc-companion-btn-minimize');
    if (minimizeBtn) {
      minimizeBtn.addEventListener('click', () => {
        uiState.isMinimized = true;
        renderOverlay();
      });
    }

    const closeBtn = panel.querySelector('.lc-companion-btn-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        uiState.isClosed = true;
        renderOverlay();
      });
    }

    const hintBtn = panel.querySelector('.lc-companion-action-hint');
    if (hintBtn) {
      hintBtn.addEventListener('click', () => {
        uiState.showingHint = !uiState.showingHint;
        renderOverlay();
      });
    }

    const gotItBtn = panel.querySelector('.lc-companion-action-gotit');
    if (gotItBtn) {
      gotItBtn.addEventListener('click', () => {
        uiState.isMinimized = true;
        renderOverlay();
      });
    }
  }

  function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Public API
  window.__lcCompanion = window.__lcCompanion || {};
  window.__lcCompanion.showQuestion = function showQuestion(text) {
    uiState.currentQuestion = text;
    uiState.currentTrigger = uiState.currentTrigger || 'on_run';
    uiState.currentPattern = uiState.currentPattern || 'fallback';
    uiState.showingHint = false;
    uiState.isClosed = false;
    uiState.isMinimized = false;
    renderOverlay();
  };
  window.__lcCompanion.hide = function hide() {
    uiState.isClosed = true;
    renderOverlay();
  };
  window.__lcCompanion.setMode = function setMode(mode) {
    if (mode === 'pro' || mode === 'genz') {
      uiState.mode = mode;
      renderOverlay();
    }
  };
  window.__lcCompanion.toggleMinimize = function toggleMinimize() {
    uiState.isMinimized = !uiState.isMinimized;
    renderOverlay();
  };
  window.__lcCompanion.debugCheckEditor = checkEditorState;
  window.__lcCompanion.triggerQuestion = handleQuestionTrigger;
  window.__lcCompanion.selectQuestion = function (trigger, pattern) {
    const qb = getQuestionBank();
    if (!qb) return null;
    return qb.selectQuestion({
      trigger,
      pattern,
      session: state ? state.questionSession : null,
    });
  };
  window.__lcCompanion.detectPattern = function (codeOverride) {
    const qb = getQuestionBank();
    if (!qb) return null;
    return qb.detectPattern({
      code: codeOverride !== undefined ? codeOverride : null,
      slug: getProblemSlug(location.href),
      document,
    });
  };

  // ---------------------------------------------------------------------
  // Init / SPA Navigation
  // ---------------------------------------------------------------------
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
      uiState.currentQuestion = null;
      renderOverlay();
      return;
    }
    lastUrl = location.href;
    lastSlug = getProblemSlug(location.href);
    state = freshState();

    // Reset question state on NEW problem page navigation
    uiState.currentQuestion = null;
    uiState.showingHint = false;
    uiState.isClosed = false;
    uiState.isMinimized = false;

    console.log(`${LOG_PREFIX} initialized for`, location.href);
    injectPageBridge();
    attachIdleTracking();
    renderOverlay();
  }

  function pollForNavigation() {
    if (location.href === lastUrl) return;
    const newSlug = getProblemSlug(location.href);
    if (newSlug && newSlug === lastSlug) {
      console.log(`${LOG_PREFIX} same-problem navigation (no reinit):`, lastUrl, '->', location.href);
      lastUrl = location.href;
      return;
    }
    console.log(`${LOG_PREFIX} navigation detected:`, lastUrl, '->', location.href);
    initForCurrentPage();
  }

  document.addEventListener('click', onDocumentClick, true);
  window.addEventListener('popstate', pollForNavigation);
  setInterval(pollForNavigation, 1000);

  initForCurrentPage();
})();
