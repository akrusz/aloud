// The promo film is click-to-load. The page carries a poster and a plain link
// to the video; pressing play swaps in YouTube's player, so nothing is fetched
// from YouTube (and no cookie is set) for a visitor who never plays it. Without
// JS the link just opens the video.
// The player refuses to start without a Referer ("error 153"), hence the
// referrer policy, and why this can't be tested from a file:// page.
(function () {
  var film = document.getElementById('film');
  var link = film && film.querySelector('.film-play');
  if (!link) return;
  link.addEventListener('click', function (e) {
    // A modified click is asking for a new tab: let the link do that.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    var player = document.createElement('iframe');
    player.src = 'https://www.youtube-nocookie.com/embed/' +
      encodeURIComponent(film.dataset.video) + '?autoplay=1&rel=0&playsinline=1';
    player.title = 'aloud promo video';
    player.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    player.referrerPolicy = 'strict-origin-when-cross-origin';
    film.textContent = '';
    film.appendChild(player);
    player.focus();
  });
})();
