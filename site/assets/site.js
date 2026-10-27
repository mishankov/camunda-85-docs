(() => {
  'use strict';
  const root = new URL(document.currentScript.dataset.root, document.baseURI);
  const dialog = document.querySelector('#search-dialog');
  const input = document.querySelector('#search-input');
  const status = document.querySelector('#search-status');
  const results = document.querySelector('#search-results');
  const trigger = document.querySelector('.search-button');
  const close = document.querySelector('#close-search');
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  document.querySelector('.search-shortcut').textContent = isMac ? '⌘ K' : 'Ctrl K';
  const sectionMenu = document.querySelector('.section-menu');
  if (sectionMenu && matchMedia('(max-width: 760px)').matches) sectionMenu.open = false;
  let loading;
  let composing = false;
  let timer;
  let returnFocus;
  let renderedQuery = null;
  const theme = document.querySelector('#theme-choice');
  const themeChoices = ['system', 'light', 'dark'];
  const themeButtons = [...theme.querySelectorAll('[data-theme-choice]')];
  function updateThemeControl() {
    for (const button of themeButtons) button.setAttribute('aria-pressed', String(button.dataset.themeChoice === window.CamundaTheme.getPreference()));
  }
  function chooseTheme(preference) {
    const button = themeButtons.find(button => button.dataset.themeChoice === preference);
    if (!button || button.disabled || theme.getAttribute('aria-disabled') === 'true' || document.querySelector('dialog[open]')) return;
    window.CamundaTheme.setPreference(preference);
  }
  for (const button of themeButtons) button.addEventListener('click', () => chooseTheme(button.dataset.themeChoice));
  document.addEventListener('themechange', updateThemeControl);
  updateThemeControl();

  function loadIndex() {
    if (window.CAMUNDA_SEARCH) return Promise.resolve(window.CAMUNDA_SEARCH);
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = new URL('assets/search-index.js', root).href;
      script.onload = () => resolve(window.CAMUNDA_SEARCH);
      script.onerror = () => { script.remove(); loading = undefined; reject(new Error('Search index could not be loaded.')); };
      document.head.append(script);
    });
    return loading;
  }

  function occurrences(text, term) {
    const positions = [];
    for (let position = text.indexOf(term); position !== -1; position = text.indexOf(term, position + term.length)) positions.push(position);
    return positions;
  }

  function highlight(element, text, phrase, terms) {
    const normalized = text.toLocaleLowerCase();
    // Prefer whole phrases over overlapping individual words. Every piece stays
    // text, including queries and documentation containing HTML-like characters.
    const words = normalized.includes(phrase) ? [phrase] : terms;
    const ranges = words.flatMap(word => occurrences(normalized, word).map(start => ({ start, end: start + word.length })))
      .sort((a, b) => a.start - b.start || b.end - a.end);
    const merged = [];
    for (const range of ranges) {
      const previous = merged.at(-1);
      if (previous && range.start < previous.end) previous.end = Math.max(previous.end, range.end);
      else merged.push({ ...range });
    }
    let position = 0;
    for (const range of merged) {
      element.append(document.createTextNode(text.slice(position, range.start)));
      const strong = document.createElement('strong');
      strong.textContent = text.slice(range.start, range.end);
      element.append(strong);
      position = range.end;
    }
    element.append(document.createTextNode(text.slice(position)));
  }

  function searchSnippet(text, phrase, terms) {
    const normalized = text.toLocaleLowerCase();
    const length = Math.max(210, phrase.length + 40);
    let anchor = normalized.indexOf(phrase);
    let anchorLength = phrase.length;
    if (anchor === -1) {
      const common = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'to', 'with']);
      const weights = terms.map(term => common.has(term) ? 1 : Math.max(3, term.length));
      let bestScore = -1;
      for (const [index, term] of terms.entries()) {
        for (const position of occurrences(normalized, term)) {
          const start = Math.max(0, position - Math.floor((length - term.length) / 2));
          const context = normalized.slice(start, start + length);
          const score = terms.reduce((score, word, i) => score + (context.includes(word) ? weights[i] * 10 : 0), weights[index]);
          if (score > bestScore) {
            bestScore = score;
            anchor = position;
            anchorLength = term.length;
          }
        }
      }
    }
    const start = Math.max(0, Math.min(text.length - length, anchor - Math.floor((length - anchorLength) / 2)));
    return `${start ? '…' : ''}${text.slice(start, start + length)}${text.length > start + length ? '…' : ''}`;
  }

  async function search() {
    if (composing) return;
    const query = input.value.trim();
    results.replaceChildren();
    renderedQuery = null;
    if (!query) { status.textContent = 'Type to search all archived pages.'; renderedQuery = ''; return; }
    status.textContent = 'Searching…';
    try {
      const pages = await loadIndex();
      if (query !== input.value.trim()) return;
      const phrase = query.toLocaleLowerCase().replace(/\s+/g, ' ');
      const terms = [...new Set(phrase.split(' ').filter(Boolean))];
      const matches = [];
      for (const page of pages) {
        const title = page.title.toLocaleLowerCase();
        const text = page.text.toLocaleLowerCase();
        if (terms.every(term => title.includes(term) || text.includes(term))) {
          const phraseRank = title === phrase ? 3 : title.includes(phrase) ? 2 : text.includes(phrase) ? 1 : 0;
          const score = terms.reduce((score, term) => score + (title.includes(term) ? 10 : 0), 0);
          matches.push({ page, phraseRank, score });
        }
      }
      matches.sort((a, b) => b.phraseRank - a.phraseRank || b.score - a.score || a.page.title.localeCompare(b.page.title));
      status.textContent = matches.length ? `${matches.length} matching pages${matches.length > 50 ? ' · showing the first 50' : ''}. Tab to browse results; Enter to open.` : `No pages match “${query}”. Try a different term.`;
      for (const { page } of matches.slice(0, 50)) {
        const link = document.createElement('a');
        link.className = 'search-result';
        link.href = new URL(page.url, root).href;
        const title = document.createElement('span'); title.className = 'search-result-title';
        highlight(title, page.title, phrase, terms);
        const section = document.createElement('small'); section.textContent = page.section;
        const snippet = document.createElement('p');
        highlight(snippet, searchSnippet(page.text, phrase, terms), phrase, terms);
        link.append(title, section, snippet); results.append(link);
      }
      renderedQuery = query;
    } catch (error) {
      status.textContent = `${error.message} Edit your search to retry, or browse All documentation.`;
    }
  }

  function openSearch() {
    if (trigger.disabled || trigger.getAttribute('aria-disabled') === 'true' || dialog.open) return;
    // Do not displace an unrelated active dialog.
    if (document.querySelector('dialog[open]')) return;
    returnFocus = document.activeElement;
    dialog.showModal();
    input.focus();
    if (input.value.trim() && input.value.trim() !== renderedQuery) search();
  }
  function closeSearch() {
    if (close.disabled || composing || !dialog.open) return;
    clearTimeout(timer);
    dialog.close();
  }
  trigger.addEventListener('click', openSearch);
  close.addEventListener('click', closeSearch);
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeSearch(); });
  dialog.addEventListener('close', () => { if (!dialog.open && returnFocus?.isConnected) returnFocus.focus(); });
  input.addEventListener('compositionstart', () => { composing = true; clearTimeout(timer); });
  input.addEventListener('compositionend', () => { composing = false; search(); });
  input.addEventListener('input', () => { clearTimeout(timer); if (!composing) timer = setTimeout(search, 100); });
  input.addEventListener('keydown', event => {
    if (event.isComposing || composing || event.keyCode === 229 || event.repeat) return;
    if (event.key === 'ArrowDown' && results.firstElementChild) { event.preventDefault(); results.firstElementChild.focus(); }
    if (event.key === 'Enter' && results.firstElementChild) { event.preventDefault(); results.firstElementChild.click(); }
  });
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing || composing || event.keyCode === 229 || event.repeat) return;
    if (event.key === 'Escape' && dialog.open && !close.disabled) {
      event.preventDefault();
      closeSearch();
      return;
    }
    const target = event.target;
    const editing = target instanceof Element && (target.isContentEditable || target.closest('input,textarea,select,[contenteditable="true"],[role="textbox"]'));
    const themeShortcut = event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && (event.code ? event.code === 'KeyD' : event.key.toLowerCase() === 'd');
    if (themeShortcut && !editing && themeButtons.some(button => !button.disabled) && theme.getAttribute('aria-disabled') !== 'true' && !document.querySelector('dialog[open]')) {
      event.preventDefault();
      chooseTheme(themeChoices[(themeChoices.indexOf(window.CamundaTheme.getPreference()) + 1) % themeChoices.length]);
      return;
    }
    // Use the physical K position for non-English layouts, as well as the key.
    const commandK = (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && (event.code === 'KeyK' || event.key.toLowerCase() === 'k');
    const slash = event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey && !editing;
    if ((commandK || slash) && !trigger.disabled && !document.querySelector('dialog[open]')) { event.preventDefault(); openSearch(); }
  });
  function revealAnchor() {
    if (!location.hash) return;
    const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (target instanceof HTMLDetailsElement) target.open = true;
    for (let parent = target?.parentElement; parent; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement) parent.open = true;
    }
    target?.scrollIntoView();
  }
  window.addEventListener('hashchange', revealAnchor);
  revealAnchor();
})();
