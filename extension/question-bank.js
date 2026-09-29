// question-bank.js — LeetCode Companion
// Scope: deterministic technical-interview question bank, pattern detection,
// and session-aware question selection.
// Supports: hashmap, two_pointers, binary_search, sliding_window, stack,
// and generic interview-style fallback.
// Triggers: on_run, on_submit, on_wrong.

(function (root) {
  'use strict';

  // ---------------------------------------------------------------------
  // 1. Question Bank
  // Questions sound like real SWE technical rounds (not educational definitions).
  // Each (pattern, trigger) bucket contains multiple questions to avoid immediate
  // repeats during a problem session.
  // ---------------------------------------------------------------------
  const QUESTION_BANK = {
    hashmap: {
      on_run: [
        'Why did you choose a hashmap here instead of sorting or two pointers?',
        'What is your key-value design, and does it guarantee constant-time lookups on average?',
        'How are you handling duplicate keys or collisions in your frequency mapping?',
        'What invariant are you maintaining in the map as you iterate through the input?',
      ],
      on_submit: [
        'Walk me through the worst-case time and space complexity with this hashmap.',
        'Could this problem be solved with O(1) auxiliary space if the input were already sorted?',
        'How does your solution behave if the input contains a very high collision rate or duplicate values?',
        'What are the trade-offs between using a hash table versus an array-based lookup table here?',
      ],
      on_wrong: [
        'What assumption about key uniqueness or default values might have caused this incorrect output?',
        'Did you update the hashmap before or after checking for the complement or existing entry?',
        'Could an edge case like empty input, single elements, or negative keys break your lookup logic?',
        'Are you accidentally overwriting values when duplicate elements appear in the input?',
      ],
    },

    two_pointers: {
      on_run: [
        'What invariant makes your two-pointer approach correct as the pointers move?',
        'Under what condition do you advance each pointer, and can they ever cross unexpectedly?',
        "Why does moving one pointer guarantee you don't miss a potential optimal pair?",
        'Is the input required to be sorted for this two-pointer strategy to remain valid?',
      ],
      on_submit: [
        'Walk me through why this two-pointer traversal is strictly O(N) time.',
        'How would you defend the correctness of your termination condition in a formal proof?',
        'Are there boundary cases where both pointers meet at the same element that need special handling?',
        'Could this approach be extended to three or four pointers, and what would the complexity trade-off be?',
      ],
      on_wrong: [
        'Did an off-by-one error or premature pointer termination cause you to skip the target state?',
        'Which pointer update assumption broke on this failing test case?',
        'Are you handling duplicates properly when advancing your left and right pointers?',
        'Did your loop condition (< vs <=) terminate before evaluating the final valid element pair?',
      ],
    },

    binary_search: {
      on_run: [
        'Why is this binary-search boundary update safe against infinite loops?',
        'What monotonic property or predicate allows you to discard half the search space at each step?',
        'How did you decide between using left < right versus left <= right for your search loop?',
        'How do you prevent integer overflow when calculating the midpoint?',
      ],
      on_submit: [
        'Walk me through why this search space reduction guarantees O(log N) time.',
        'When the loop terminates, what does the position of left or right represent?',
        'How does your binary search handle duplicates when searching for the first or last occurrence?',
        'Could this search space be framed as a binary search on the answer range rather than array indices?',
      ],
      on_wrong: [
        'Did your midpoint calculation or boundary adjustment skip over the target value?',
        'Did you test extreme edge cases: empty array, single element, or target outside the range?',
        'Did the search loop terminate one iteration too early or get stuck in an off-by-one loop?',
        'Is the monotonicity assumption violated by any part of this test input?',
      ],
    },

    sliding_window: {
      on_run: [
        'What exact condition determines when your sliding window needs to shrink from the left?',
        'What window invariant are you maintaining across each expansion and contraction step?',
        'Why does this sliding window approach guarantee finding the optimal substring or subarray?',
        'Are you tracking window state incrementally in O(1) instead of recomputing on each shift?',
      ],
      on_submit: [
        'Explain why your sliding window runs in O(N) amortized time even though there are nested loops.',
        'What is the auxiliary space complexity of tracking characters or frequencies inside the window?',
        'How would your window logic adapt if the input stream were infinite or arrived in chunks?',
        'Can the window ever become invalid (left pointer overtaking right pointer), and how is that handled?',
      ],
      on_wrong: [
        'Did your left-boundary shrink condition fail to restore the valid window property on this input?',
        'Did you update the global result before or after shrinking the window?',
        'How does your window handle an input where no valid window exists at all?',
        'Did your window state get corrupted when removing the outgoing element at the left pointer?',
      ],
    },

    stack: {
      on_run: [
        'Why is a stack the right abstraction here instead of a queue or simple counter?',
        'What invariant does the stack maintain during iteration?',
        'What does each element on the stack represent: the actual value, an index, or both?',
        "How are you ensuring you don't perform an illegal pop on an empty stack?",
      ],
      on_submit: [
        'Walk me through the amortized time complexity per element pushed and popped.',
        'What is the worst-case space complexity if the input is strictly increasing or decreasing?',
        'Could this stack-based solution be implemented with an explicit recursion or vice versa?',
        'How does your solution handle trailing unclosed elements left on the stack at the end of the input?',
      ],
      on_wrong: [
        'Did your stack logic assume all matching pairs would be adjacent or properly ordered?',
        'What assumption about empty-stack behavior or leftover elements failed on this test case?',
        'Did you pop an element when you should have only inspected top, or vice versa?',
        'Did a monotonic invariant break when processing equal or duplicate values?',
      ],
    },

    fallback: {
      on_run: [
        'Walk me through how your current logic processes a minimal edge case.',
        'What is the core state or invariant you are maintaining through each iteration?',
        'Why did you choose this approach over alternative data structures or algorithms?',
        'What assumption about the input format or constraints are you relying on here?',
      ],
      on_submit: [
        'Walk me through the time and space complexity of this solution.',
        'How would your solution perform if the input size scaled by a factor of 1000?',
        'What is the primary bottleneck in your approach, and could it be optimized further?',
        'Are there trade-offs you made between code readability, memory usage, and runtime?',
      ],
      on_wrong: [
        'What assumption in your solution might be wrong for this failing test case?',
        'Did you consider boundary cases such as empty inputs, negative numbers, or duplicates?',
        'Where does the actual output diverge from the expected output when stepping through your logic?',
        'Did an off-by-one condition or unhandled edge case cause this failure?',
      ],
    },
  };

  // ---------------------------------------------------------------------
  // 2. Pattern Detection
  // Detects one of: hashmap, two_pointers, binary_search, sliding_window, stack.
  // Returns null when no pattern is recognized (triggering fallback).
  // ---------------------------------------------------------------------

  const SLUG_PATTERNS = [
    {
      pattern: 'binary_search',
      regex: /(?:binary-search|search-in-rotated|search-a-2d|find-first-and-last|search-insert|peak-index|find-peak|first-bad-version|koko-eating|capacity-to-ship|median-of-two-sorted)/i,
    },
    {
      pattern: 'sliding_window',
      regex: /(?:sliding-window|longest-substring-without-repeating|minimum-window-substring|longest-repeating-character|permutation-in-string|find-all-anagrams|max-consecutive-ones|minimum-size-subarray-sum|subarray-product-less-than-k|fruit-into-baskets)/i,
    },
    {
      pattern: 'two_pointers',
      regex: /(?:two-pointer|3sum|three-sum|two-sum-ii|container-with-most-water|trapping-rain-water|move-zeroes|remove-duplicates-from-sorted|squares-of-a-sorted|reverse-string|valid-palindrome|is-subsequence|sort-colors|linked-list-cycle)/i,
    },
    {
      pattern: 'stack',
      regex: /(?:stack|valid-parentheses|min-stack|daily-temperatures|evaluate-reverse-polish|generate-parentheses|simplify-path|basic-calculator|decode-string|largest-rectangle-in-histogram|online-stock-span|asteroid-collision|remove-k-digits|next-greater)/i,
    },
    {
      pattern: 'hashmap',
      regex: /(?:hash-map|hash-table|two-sum|group-anagrams|top-k-frequent|contains-duplicate|valid-anagram|intersection-of-two-arrays|subarray-sum-equals-k|isomorphic-strings|word-pattern|first-unique-character|ransom-note|design-hashmap)/i,
    },
  ];

  function detectPatternFromCode(code) {
    if (typeof code !== 'string' || !code.trim()) return null;

    // Binary search indicators
    if (
      /(?:\bbinary_search\b|\bbisect\b|\bbisect_left\b|\bbisect_right\b|\blower_bound\b|\bupper_bound\b)/i.test(code) ||
      /\bmid\s*=\s*(?:Math\.floor\()?.*?\(?\s*(?:left|low|l|start)\s*\+\s*(?:right|high|r|end)\s*\)?\s*(?:\/|\>>)\s*2/i.test(code) ||
      /\b(?:low|left|l)\s*\+\s*\(\s*(?:high|right|r)\s*-\s*(?:low|left|l)\s*\)/i.test(code) ||
      (/\bwhile\s*\(\s*(?:left|low|l)\s*<=\s*(?:right|high|r)\s*\)/i.test(code) && /\bmid\b/i.test(code))
    ) {
      return 'binary_search';
    }

    // Sliding window indicators (checked before generic two_pointers)
    if (
      /(?:\bsliding_?window\b)/i.test(code) ||
      /(?:\bwindow\w*\b)/i.test(code) ||
      /(?:\bright\b|\br\b|\bend\b)\s*-\s*(?:\bleft\b|\bl\b|\bstart\b)\s*\+\s*1/i.test(code)
    ) {
      return 'sliding_window';
    }

    // Stack indicators
    if (
      (/\bstack\b/i.test(code) && /\.(?:push|pop)\(/i.test(code)) ||
      /\b(?:Stack|ArrayDeque|Deque)\b/.test(code) ||
      /\bstack\[-1\]|\bstack\[stack\.length\s*-\s*1\]|\bstack\.peek\(\)/i.test(code) ||
      /(?:\bmonotone_stack\b|\bmonotonic_stack\b)/i.test(code)
    ) {
      return 'stack';
    }

    // Two pointers indicators
    if (
      /(?:\btwo_pointers\b|\btwo_pointer\b|\btwoPointers\b|\btwoPointer\b)/i.test(code) ||
      /\bwhile\s*\(\s*(?:left|l)\s*<\s*(?:right|r)\s*\)/i.test(code) ||
      /\bwhile\s+(?:left|l)\s*<\s*(?:right|r)\s*:/i.test(code) ||
      (/(?:\bleft\+\+|\bl\+\+)\b/i.test(code) && /(?:\bright\-\-|\br\-\-)\b/i.test(code)) ||
      (/(?:\bslow\b|\bfast\b)/i.test(code) && /(?:slow\.next|fast\.next)/i.test(code))
    ) {
      return 'two_pointers';
    }

    // Hashmap indicators
    if (
      /\b(?:HashMap|HashSet|unordered_map|unordered_set|defaultdict|Counter)\b/.test(code) ||
      /new\s+(?:Map|Set)\b/.test(code) ||
      /\b(?:map|hash_map|hashMap|seen|freq|count|memo)\.(?:get|set|has|put|containsKey)\b/i.test(code) ||
      /\b(?:freq|counts?|seen|memo|cache)\[/i.test(code)
    ) {
      return 'hashmap';
    }

    return null;
  }

  function detectPatternFromDom(doc) {
    if (!doc) return null;
    try {
      const tagLinks = doc.querySelectorAll ? doc.querySelectorAll('a[href*="/tag/"]') : [];
      for (const a of tagLinks) {
        const href = (a.getAttribute('href') || '').toLowerCase();
        if (href.includes('/tag/binary-search')) return 'binary_search';
        if (href.includes('/tag/sliding-window')) return 'sliding_window';
        if (href.includes('/tag/stack')) return 'stack';
        if (href.includes('/tag/two-pointers')) return 'two_pointers';
        if (href.includes('/tag/hash-table') || href.includes('/tag/hash-map')) return 'hashmap';
      }

      const tagElements = doc.querySelectorAll
        ? doc.querySelectorAll('[class*="topic"], [class*="tag"], [data-keyword]')
        : [];
      for (const el of tagElements) {
        const text = (el.textContent || '').trim().toLowerCase();
        if (text === 'binary search') return 'binary_search';
        if (text === 'sliding window') return 'sliding_window';
        if (text === 'stack') return 'stack';
        if (text === 'two pointers') return 'two_pointers';
        if (text === 'hash table' || text === 'hash map') return 'hashmap';
      }
    } catch (_) {}
    return null;
  }

  function detectPatternFromSlug(slug) {
    if (!slug || typeof slug !== 'string') return null;
    for (const item of SLUG_PATTERNS) {
      if (item.regex.test(slug)) return item.pattern;
    }
    return null;
  }

  function detectPattern({ code, slug, document }) {
    // 1. Detect from editor code if explicit algorithmic patterns are present
    const fromCode = detectPatternFromCode(code);
    if (fromCode) return fromCode;

    // 2. Detect from page DOM topic tags
    const fromDom = detectPatternFromDom(document);
    if (fromDom) return fromDom;

    // 3. Detect from problem slug in URL
    const fromSlug = detectPatternFromSlug(slug);
    if (fromSlug) return fromSlug;

    // Unmatched: returns null to trigger generic interview-style fallback
    return null;
  }

  // ---------------------------------------------------------------------
  // 3. Session and Question Selection
  // Tracks asked questions during a problem session so repeated triggers
  // do not immediately produce the exact same question.
  // ---------------------------------------------------------------------

  function createSession() {
    return {
      askedQuestions: new Set(),
      lastQuestionByBucket: {},
    };
  }

  function selectQuestion({ trigger, pattern, session }) {
    const validPattern = pattern && QUESTION_BANK[pattern] ? pattern : 'fallback';
    const bucket = QUESTION_BANK[validPattern]?.[trigger] || QUESTION_BANK.fallback[trigger];
    if (!bucket || bucket.length === 0) return null;

    const bucketKey = `${validPattern}:${trigger}`;

    if (!session || !session.askedQuestions) {
      const idx = Math.floor(Math.random() * bucket.length);
      return bucket[idx];
    }

    // Filter questions not yet asked in this session
    let candidates = bucket.filter((q) => !session.askedQuestions.has(q));

    // If all questions in this bucket have been asked in this session, reset for this bucket,
    // but avoid immediately repeating the exact preceding question if possible.
    if (candidates.length === 0) {
      const lastAsked = session.lastQuestionByBucket[bucketKey];
      candidates = bucket.filter((q) => q !== lastAsked);
      if (candidates.length === 0) candidates = bucket.slice();
      // Remove recycled candidates from session.askedQuestions
      bucket.forEach((q) => {
        if (q !== lastAsked) {
          session.askedQuestions.delete(q);
        }
      });
    }

    const chosen = candidates[Math.floor(Math.random() * candidates.length)];
    session.askedQuestions.add(chosen);
    session.lastQuestionByBucket[bucketKey] = chosen;
    return chosen;
  }

  // ---------------------------------------------------------------------
  // 4. Exports
  // ---------------------------------------------------------------------
  const QuestionBank = {
    QUESTION_BANK,
    detectPattern,
    detectPatternFromCode,
    detectPatternFromDom,
    detectPatternFromSlug,
    createSession,
    selectQuestion,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = QuestionBank;
  }
  if (typeof root !== 'undefined') {
    root.__lcQuestionBank = QuestionBank;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
