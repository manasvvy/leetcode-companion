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
    answerText: '',            // PR #4: user's submitted answer text
    hasSubmittedAnswer: false, // PR #4: whether the user has submitted an answer
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
        // PR #4: clear previous answer state on new question
        uiState.answerText = '';
        uiState.hasSubmittedAnswer = false;
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

  // Pattern-specific, trigger-aware, mode-aware hint table.
  // Keys: pattern → trigger → 'pro' | 'genz'
  const HINTS = {
    hashmap: {
      on_run: {
        pro:  'Think about what the key and value each represent. Before writing a lookup, ask whether you need to store frequency, index, or a complement — and whether the map should be populated before or during the pass.',
        genz: "Before you freestyle the map, lock in what the key and value actually mean. Are you storing frequency, index, or a complement? And does the map need to be populated before you check, or at the same time?",
      },
      on_submit: {
        pro:  'HashMap insertion and lookup are O(1) average but O(N) worst-case under pathological hashing. Confirm your space is O(N) and that no hash-collision input breaks your bounds.',
        genz: "HashMap ops are O(1) on average but can go O(N) if the input is crafted to hammer collisions. Make sure you know your space complexity and that a bad hash input won't cook your solution.",
      },
      on_wrong: {
        pro:  'Check the order of operations: are you reading from the map before writing, or vice versa? Also verify edge cases — empty input, all duplicates, or keys with value zero.',
        genz: "Check the order: are you reading the map before you write to it, or the other way around? Also double-check edge cases like empty input, all-duplicate elements, or a key whose value is literally 0 — that one fumbles a lot of solutions.",
      },
    },

    two_pointers: {
      on_run: {
        pro:  'State the invariant your two pointers maintain before touching the code. If that invariant is broken at any step, the pointer-movement rule is wrong.',
        genz: "Before you move any pointer, write out the invariant you're maintaining. If that rule ever breaks while you trace through, your pointer-movement logic is cooked.",
      },
      on_submit: {
        pro:  'Verify the termination condition carefully. Off-by-one between < and <= is the most common source of skipped or double-counted elements in two-pointer solutions.',
        genz: "Double-check your loop termination — < vs <= is where most two-pointer solutions fumble. One wrong comparison and you either skip the last pair or process it twice.",
      },
      on_wrong: {
        pro:  'Trace the failing test case manually. Identify exactly which pointer move caused the skip or overlap, then trace why your condition chose that move.',
        genz: "Manually trace through the failing case. Find the exact pointer move where things went sideways and ask yourself why your condition picked that move — that's where the bug lives.",
      },
    },

    binary_search: {
      on_run: {
        pro:  'Identify the monotonic predicate first: what property is true for the left half and false for the right (or vice versa)? Your mid assignment and boundary update must consistently shrink the search space toward that boundary.',
        genz: "Find the monotonic predicate first — what's true on one side and false on the other? Your mid calc and boundary update both need to consistently shrink toward that split, or the search is gonna get cooked.",
      },
      on_submit: {
        pro:  'Confirm mid is computed as left + (right - left) // 2 to avoid overflow, and that the loop terminates: every iteration must strictly reduce the search interval.',
        genz: "Make sure mid is computed as left + (right - left) // 2 so you don't overflow on big inputs. Also confirm every iteration actually shrinks the interval — if it ever stays the same size, you've got an infinite loop on the way.",
      },
      on_wrong: {
        pro:  'Binary search bugs almost always live in the boundary update (mid+1 vs mid) or the loop condition (< vs <=). Write out what left and right represent at termination and verify the update rules preserve that meaning.',
        genz: "Binary search bugs live in two places almost every time: the boundary update (mid+1 vs mid) and the loop condition (< vs <=). Write out what left and right mean when the loop ends and trace whether your updates actually keep that meaning.",
      },
    },

    sliding_window: {
      on_run: {
        pro:  'Define the window invariant explicitly: what property must always hold for the window to be valid? Expansion adds an element; contraction restores validity. Make sure both operations update your window state in O(1).',
        genz: "Write out the window invariant before coding — what rule must always hold for the window to be valid? Expanding adds an element, contracting restores validity. Both operations need to update your state in O(1) or you're just doing brute force with extra steps.",
      },
      on_submit: {
        pro:  'Confirm the result is updated at the right point in the loop — before or after shrinking matters. Also verify the left pointer never overtakes the right.',
        genz: "Check where you record the best result — before or after shrinking the window? That order is huge. Also make sure left never goes past right or your window logic will start returning garbage.",
      },
      on_wrong: {
        pro:  'Trace the exact point where the window state diverges from the expected state. Common causes: incorrect shrink condition, updating the result at the wrong time, or corrupting window state when removing the leftmost element.',
        genz: "Trace exactly where the window state stops matching what it should be. The usual suspects: wrong shrink condition, recording the result at the wrong moment, or corrupting state when you boot the left element out.",
      },
    },

    stack: {
      on_run: {
        pro:  'State what invariant the stack maintains at every step. Common monotonic-stack invariants: strictly increasing or decreasing from bottom to top. Verify that each push and pop preserves this invariant.',
        genz: "Write out the stack invariant before you code anything. Monotonic stacks are usually strictly increasing or decreasing bottom-to-top. Every push and pop has to preserve that rule or the whole thing fumbles.",
      },
      on_submit: {
        pro:  'Each element is pushed at most once and popped at most once, giving O(N) amortized time. Confirm the worst-case space: a strictly monotone input leaves N elements on the stack simultaneously.',
        genz: "Every element gets pushed once and popped once max, so the total time is O(N) amortized — lock that in. Also check worst-case space: if the input is strictly sorted in one direction, you could have N elements stacked at the same time.",
      },
      on_wrong: {
        pro:  'Check whether you are using the stack value, index, or both — and whether you are popping when you should only peek, or missing a pop entirely. Also verify what happens to elements still on the stack when the loop ends.',
        genz: "Check whether you stored the value, the index, or both on the stack — and whether you're popping when you should just be peeking, or forgetting to pop at all. Also check what happens to leftover elements when the loop ends; they usually need processing.",
      },
    },

    fallback: {
      on_run: {
        pro:  'Identify the core invariant your algorithm maintains through each iteration. Trace through a minimal example by hand and confirm the invariant holds at every step before and after each operation.',
        genz: "Figure out what invariant your loop is keeping alive on every iteration. Trace a tiny example by hand and check that the rule holds before and after every step — if it breaks anywhere, that's your bug.",
      },
      on_submit: {
        pro:  'Characterize the time and space complexity precisely. Is there a tighter bound available? Identify the bottleneck operation and whether it can be eliminated or amortized.',
        genz: "Lock in your time and space complexity — not just \"O(N)\" vibes, but the actual analysis. Find the slowest operation and ask whether it can be removed, batched, or amortized.",
      },
      on_wrong: {
        pro:  'Isolate the failing test case to the smallest possible input that still reproduces the error. Step through your algorithm on that input and identify the first moment the actual output diverges from the expected output.',
        genz: "Shrink the failing test case down to the smallest input that still breaks. Then trace your code on that input step by step and find the exact moment your output goes sideways — that's where the bug is hiding.",
      },
    },
  };

  function getHint(pattern, trigger, mode) {
    const p = (pattern && HINTS[pattern]) ? pattern : 'fallback';
    const t = (trigger && HINTS[p][trigger]) ? trigger : 'on_run';
    const m = mode === 'genz' ? 'genz' : 'pro';
    return HINTS[p][t][m] || HINTS.fallback.on_run.pro;
  }

  // PR #4: deterministic acknowledgment text — never claims correctness
  const ACKNOWLEDGMENT = {
    pro: [
      'Answer recorded. You can now defend why that approach guarantees correctness.',
      'Answer recorded. Be ready to walk through the edge cases that stress-test this reasoning.',
      'Answer recorded. Make sure you can justify the time and space complexity behind it.',
    ],
    genz: [
      "Okay, answer locked in. Now make sure you can actually defend why that keeps the solution from getting cooked.",
      "Answer locked in, no cap. Be ready to back it up with edge cases or it's gonna fumble.",
      "Got it noted. Now make sure you can explain the complexity too or it'll be an L.",
    ],
  };

  function getAcknowledgment(mode) {
    const pool = mode === 'genz' ? ACKNOWLEDGMENT.genz : ACKNOWLEDGMENT.pro;
    // Deterministic per session: pick based on question text length mod pool size
    const idx = (uiState.currentQuestion || '').length % pool.length;
    return pool[idx];
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

    // PR #4: build the body content depending on answer submission state
    let answerAreaHtml;
    if (uiState.hasSubmittedAnswer) {
      // Submitted state: show the user's answer and acknowledgment
      const ackText = getAcknowledgment(uiState.mode);
      answerAreaHtml = `
        <div class="lc-companion-answer-submitted">
          <div class="lc-companion-answer-label">Your answer</div>
          <div class="lc-companion-answer-display">${escapeHtml(uiState.answerText)}</div>
          <div class="lc-companion-ack-box">${escapeHtml(ackText)}</div>
        </div>
      `;
    } else {
      // Input state: textarea + Submit Answer button
      answerAreaHtml = `
        <form class="lc-companion-answer-form" autocomplete="off">
          <label class="lc-companion-answer-label" for="lc-companion-answer-input">Your answer</label>
          <textarea
            id="lc-companion-answer-input"
            class="lc-companion-answer-textarea"
            placeholder="Type your answer here…"
            rows="3"
            aria-label="Type your answer"
          >${escapeHtml(uiState.answerText)}</textarea>
          <div class="lc-companion-actions">
            <button type="button" class="lc-companion-btn lc-companion-btn-secondary lc-companion-action-hint">${uiState.showingHint ? 'Hide Hint' : "I don't know"}</button>
            <button type="submit" class="lc-companion-btn lc-companion-btn-primary lc-companion-action-submit">Submit Answer</button>
          </div>
        </form>
      `;
    }

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
            ? `<div class="lc-companion-hint-box">💡 ${escapeHtml(getHint(uiState.currentPattern, uiState.currentTrigger, uiState.mode))}</div>`
            : ''
        }
        ${answerAreaHtml}
        ${
          uiState.hasSubmittedAnswer
            ? `<div class="lc-companion-actions lc-companion-actions-submitted">
                <button type="button" class="lc-companion-btn lc-companion-btn-secondary lc-companion-action-hint">${uiState.showingHint ? 'Hide Hint' : "I don't know"}</button>
                <button type="button" class="lc-companion-btn lc-companion-btn-secondary lc-companion-action-tryagain">Try Again</button>
                <button type="button" class="lc-companion-btn lc-companion-btn-primary lc-companion-action-gotit">Got it</button>
              </div>`
            : ''
        }
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

    // "I don't know" / "Hide Hint" button — present in both input and submitted states
    const hintBtn = panel.querySelector('.lc-companion-action-hint');
    if (hintBtn) {
      hintBtn.addEventListener('click', () => {
        uiState.showingHint = !uiState.showingHint;
        renderOverlay();
      });
    }

    // PR #4: Submit Answer (form submit or button click)
    const answerForm = panel.querySelector('.lc-companion-answer-form');
    if (answerForm) {
      const submitAnswer = (e) => {
        e.preventDefault();
        const textarea = panel.querySelector('.lc-companion-answer-textarea');
        const text = textarea ? textarea.value.trim() : '';
        if (!text) {
          // Focus the textarea so the user knows something is expected
          if (textarea) textarea.focus();
          return;
        }
        uiState.answerText = text;
        uiState.hasSubmittedAnswer = true;
        renderOverlay();
      };
      answerForm.addEventListener('submit', submitAnswer);
      const submitBtn = panel.querySelector('.lc-companion-action-submit');
      if (submitBtn) submitBtn.addEventListener('click', submitAnswer);
    }

    // PR #4: Try Again — return to input state, preserve text so user can edit
    const tryAgainBtn = panel.querySelector('.lc-companion-action-tryagain');
    if (tryAgainBtn) {
      tryAgainBtn.addEventListener('click', () => {
        uiState.hasSubmittedAnswer = false;
        // answerText is preserved so the textarea is pre-filled for editing
        renderOverlay();
        // Focus textarea after re-render
        const ta = panel.querySelector('.lc-companion-answer-textarea');
        if (ta) {
          ta.focus();
          // Move cursor to end
          ta.selectionStart = ta.selectionEnd = ta.value.length;
        }
      });
    }

    // Got it (submitted state only) → minimize
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
    // PR #4: clear answer state on new question
    uiState.answerText = '';
    uiState.hasSubmittedAnswer = false;
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
    // PR #4: clear answer state on new problem
    uiState.answerText = '';
    uiState.hasSubmittedAnswer = false;

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
