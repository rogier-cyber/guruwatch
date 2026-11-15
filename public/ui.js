// Tooltips voor alle grafieken: muis (hover) én vinger (tik).
// Elk SVG-element met een <title> krijgt een nette tooltip; de <title> wordt een aria-label.
(function () {
  var tip = null;
  var current = null;
  var lastPointer = 'mouse';

  function ensureTip() {
    if (tip) return tip;
    tip = document.createElement('div');
    tip.className = 'gw-tip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    document.body.appendChild(tip);
    return tip;
  }

  function prepare(root) {
    (root || document).querySelectorAll('svg title').forEach(function (t) {
      var el = t.parentNode;
      if (!el || el.tagName.toLowerCase() === 'svg') return;
      var txt = t.textContent.trim();
      if (!txt) return;
      el.setAttribute('data-tip', txt);
      if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', txt.replace(/\n/g, ', '));
      t.parentNode.removeChild(t);
    });
    // Gewone title-attributen ook als tooltip tonen (werkt dan ook met een tik).
    (root || document).querySelectorAll('[title]:not(input):not(button):not(select):not(textarea):not(iframe)').forEach(function (el) {
      var txt = el.getAttribute('title');
      if (!txt || el.hasAttribute('data-tip')) return;
      el.setAttribute('data-tip', txt);
      if (!el.getAttribute('aria-label') && !el.textContent.trim()) el.setAttribute('aria-label', txt);
      el.removeAttribute('title');
    });
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }

  function place(el) {
    var t = ensureTip();
    var r = el.getBoundingClientRect();
    var tw = t.offsetWidth;
    var th = t.offsetHeight;
    var vw = document.documentElement.clientWidth;
    var x = r.left + r.width / 2 - tw / 2;
    x = Math.max(8, Math.min(vw - tw - 8, x));
    var y = r.top - th - 10;
    if (y < 8) y = r.bottom + 10;
    t.style.left = x + window.scrollX + 'px';
    t.style.top = y + window.scrollY + 'px';
  }

  function show(el) {
    var txt = el.getAttribute('data-tip');
    if (!txt) return;
    var t = ensureTip();
    var lines = txt.split('\n');
    t.innerHTML = '<b>' + esc(lines[0]) + '</b>' + lines.slice(1).map(function (l) { return '<span>' + esc(l) + '</span>'; }).join('');
    t.hidden = false;
    if (current && current !== el) current.classList.remove('tip-on');
    current = el;
    el.classList.add('tip-on');
    place(el);
  }

  function hide() {
    if (tip) tip.hidden = true;
    if (current) current.classList.remove('tip-on');
    current = null;
  }

  function target(e) {
    return e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
  }

  document.addEventListener('pointerdown', function (e) { lastPointer = e.pointerType || 'mouse'; }, true);
  document.addEventListener('mouseover', function (e) {
    if (lastPointer === 'touch') return;
    var el = target(e);
    if (el) show(el);
    else if (current && !(e.target.closest && e.target.closest('.gw-tip'))) hide();
  });
  document.addEventListener('click', function (e) {
    var el = target(e);
    if (!el) { if (current) hide(); return; }
    if (lastPointer !== 'mouse') {
      // Eerste tik toont de tooltip; een tweede tik op een link volgt de link.
      if (current !== el && el.getAttribute('data-tip-touch') !== '0') { e.preventDefault(); show(el); return; }
    }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); });
  window.addEventListener('scroll', function () { if (current && lastPointer === 'mouse') hide(); else if (current) place(current); }, { passive: true });
  window.addEventListener('resize', hide);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { prepare(); });
  else prepare();
  window.gwTips = { prepare: prepare, hide: hide };
})();

// "Meer"-knop onder ingekorte tabellen: toont de verborgen rijen.
document.addEventListener('click', function (e) {
  var b = e.target.closest && e.target.closest('[data-more]');
  if (!b) return;
  var wrap = b.previousElementSibling;
  if (wrap) wrap.querySelectorAll('tr[hidden]').forEach(function (r) { r.hidden = false; });
  b.hidden = true;
});

// Telefoon: actief menu-item in beeld schuiven.
(function () {
  var on = document.querySelector('.nav a.on');
  var nav = on && on.parentElement;
  if (nav && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = on.offsetLeft - (nav.clientWidth - on.offsetWidth) / 2;
})();
