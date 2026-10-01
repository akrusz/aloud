// Clicking the hero mark (orb or wordmark) replays the hello ripple it gave on
// load. The ripple lives on .orb::before/::after (style.css); .replay drops the
// animation for a single style flush, and removing it starts the ripple over.
// Under reduced motion the ripple is animation: none anyway, so this is a no-op.
(function () {
  var mark = document.querySelector('.hero-mark');
  var orb = mark && mark.querySelector('.orb');
  if (!orb) return;
  mark.addEventListener('click', function (e) {
    if (!e.target.closest('.orb, .brand-mark')) return;
    orb.classList.add('replay');
    void orb.offsetWidth;
    orb.classList.remove('replay');
  });
})();
