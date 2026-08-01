/* Site theme toggle. Default follows the OS via light-dark() in CSS; clicking
   forces a choice (data-theme on <html>) and remembers it for 4 hours. The
   pre-paint bootstrap that applies a saved choice lives inline in <head>. */
(function() {
  var TTL = 4 * 60 * 60 * 1000;
  var STORAGE_KEY = 'aloud-site-theme';
  var btn = document.getElementById('theme-toggle');
  if (!btn) return;

  var SUN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
  var MOON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

  function osPrefersDark() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  // The theme actually showing right now: explicit override if set, else OS.
  function effectiveTheme() {
    var attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'dark' || attr === 'light') return attr;
    return osPrefersDark() ? 'dark' : 'light';
  }

  // Show the icon for the theme you'd switch TO (sun while dark, moon while light).
  function updateIcon() {
    btn.innerHTML = effectiveTheme() === 'dark' ? SUN : MOON;
  }

  function sync() {
    updateIcon();
    // The screenshot carousel (js/shots.js) picks its own theme variant off
    // this; it owns the <img> src, since which shot is showing is its business.
    document.dispatchEvent(new CustomEvent('aloud:theme'));
  }

  sync();

  btn.addEventListener('click', function() {
    var next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ value: next, ts: Date.now() }));
    } catch (e) {}
    sync();
  });

  // If there's no fresh override, keep tracking the OS preference live.
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function() {
      var hasOverride = false;
      try {
        var raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          var saved = JSON.parse(raw);
          hasOverride = saved && saved.ts && (Date.now() - saved.ts < TTL);
        }
      } catch (e) {}
      if (!hasOverride) {
        document.documentElement.removeAttribute('data-theme');
        sync();
      }
    });
  }
})();
