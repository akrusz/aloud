/* Screenshot carousel. Owns the <img> src: which shot (the arrows) crossed with
   which theme (theme.js, which fires 'aloud:theme' whenever it changes).

   Progressive enhancement: the HTML ships one real <img> already pointing at
   the light setup shot, and the arrows/caption stay hidden until this runs, so
   no-JS gets a picture rather than an empty frame. */
(function() {
  var SHOTS = [
    {
      light: 'assets/aloud-screen-light.webp',
      dark: 'assets/aloud-screen-dark.webp',
      caption: 'the session setup screen',
      alt: "aloud's session setup screen"
    },
    {
      light: 'assets/aloud-session-light.webp',
      dark: 'assets/aloud-session-dark.webp',
      caption: 'an exploration session',
      alt: "an exploration session in aloud"
    }
  ];

  var img = document.getElementById('app-screenshot');
  var prev = document.getElementById('shot-prev');
  var next = document.getElementById('shot-next');
  var caption = document.getElementById('shot-caption');
  if (!img || !prev || !next || !caption) return;

  var index = 0;

  function isDark() {
    var attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'dark' || attr === 'light') return attr === 'dark';
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  function render() {
    var shot = SHOTS[index];
    var src = isDark() ? shot.dark : shot.light;
    if (img.getAttribute('src') !== src) img.setAttribute('src', src);
    img.setAttribute('alt', shot.alt);
    caption.textContent = shot.caption;
  }

  function go(step) {
    index = (index + step + SHOTS.length) % SHOTS.length;
    render();
  }

  if (SHOTS.length > 1) {
    prev.hidden = false;
    next.hidden = false;
    prev.addEventListener('click', function() { go(-1); });
    next.addEventListener('click', function() { go(1); });
  }
  caption.hidden = false;

  // Preload the other shot in the current theme, so the first arrow tap swaps
  // instantly instead of flashing an empty frame.
  SHOTS.forEach(function(shot, i) {
    if (i === index) return;
    var pre = new Image();
    pre.src = isDark() ? shot.dark : shot.light;
  });

  document.addEventListener('aloud:theme', render);
  render();
})();
