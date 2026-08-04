// Cards land slightly crooked and straighten out over ~0.4s the first
// time they scroll into view (the `settle` keyframes in style.css, driven by
// each element's --tilt). At rest everything is square; the wonk is only an
// entrance. Elements opt in with the .settle class.
(function () {
  var els = document.querySelectorAll('.settle');
  if (!('IntersectionObserver' in window)) return;
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      e.target.classList.add('settle-in');
      io.unobserve(e.target);
    });
  }, { threshold: 0.15 });
  els.forEach(function (el) { io.observe(el); });
})();
