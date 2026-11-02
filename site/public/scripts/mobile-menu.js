/**
 * IMK mobile navigation + sticky CTA.
 *
 * Served as a static file from /scripts/mobile-menu.js on purpose: the site's
 * Content-Security-Policy is `script-src 'self' ...` with no 'unsafe-inline',
 * so any INLINE <script> is blocked by the browser on the deployed site. That
 * is why the old inline implementations "did nothing" on a real phone while
 * working in local preview (which sends no CSP header). An external file
 * under 'self' is allowed.
 */
(function () {
  'use strict';

  var btn = document.getElementById('burger-btn');
  var menu = document.getElementById('mobile-menu');

  if (btn && menu) {
    var panel = menu.querySelector('.mobile-menu__panel');
    var closeEls = menu.querySelectorAll('[data-menu-close]');
    var lastFocused = null;

    var isOpen = function () {
      return menu.classList.contains('open');
    };

    var onKeydown = function (e) {
      if (e.key === 'Escape' || e.key === 'Esc') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== 'Tab' || !panel) return;
      var focusable = panel.querySelectorAll('a[href], button:not([disabled])');
      if (!focusable.length) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    var open = function () {
      if (isOpen()) return;
      lastFocused = document.activeElement;
      menu.removeAttribute('inert');
      menu.classList.add('open');
      document.body.classList.add('menu-open');
      btn.setAttribute('aria-expanded', 'true');
      btn.setAttribute('aria-label', 'Close menu');
      var closeBtn = menu.querySelector('.mobile-menu__close');
      if (closeBtn) closeBtn.focus();
      document.addEventListener('keydown', onKeydown);
    };

    var close = function () {
      if (!isOpen()) return;
      menu.classList.remove('open');
      menu.setAttribute('inert', '');
      document.body.classList.remove('menu-open');
      btn.setAttribute('aria-expanded', 'false');
      btn.setAttribute('aria-label', 'Open menu');
      document.removeEventListener('keydown', onKeydown);
      // On a real phone tap the burger is often not the focused element (iOS
      // Safari does not focus buttons on tap), so fall back to it explicitly
      // instead of leaving focus on <body>.
      var target = lastFocused && lastFocused !== document.body ? lastFocused : btn;
      if (target && typeof target.focus === 'function') target.focus();
    };

    btn.addEventListener('click', function (e) {
      e.preventDefault();
      if (isOpen()) close();
      else open();
    });

    for (var i = 0; i < closeEls.length; i++) {
      closeEls[i].addEventListener('click', close);
    }

    var links = menu.querySelectorAll('a[href]');
    for (var j = 0; j < links.length; j++) {
      links[j].addEventListener('click', close);
    }

    // Never leave the drawer open when the viewport grows past the breakpoint.
    window.addEventListener('resize', function () {
      if (window.innerWidth >= 900) close();
    });
    window.addEventListener('orientationchange', function () {
      if (window.innerWidth >= 900) close();
    });
  }

  // Mobile sticky CTA: reveal after the hero is scrolled past. This used to be
  // a separate inline Astro script, which the deployed CSP also blocked.
  var sticky = document.querySelector('[data-sticky-cta]');
  if (sticky) {
    var onScroll = function () {
      sticky.classList.toggle('open', window.scrollY > 320);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }
})();
