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
    var logo = el.getAttribute('data-tip-logo');
    var head = '<b>' + esc(lines[0]) + '</b>';
    if (logo) head = '<div class="tip-head"><img src="' + esc(logo) + '" alt="" onerror="this.remove()">' + head + '</div>';
    t.innerHTML = head + lines.slice(1).map(function (l) { return '<span>' + esc(l) + '</span>'; }).join('');
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
  if (!wrap) return;
  var rest = wrap.querySelectorAll('tr[hidden], .more-item[hidden]');
  // data-more="25": telkens 25 extra tonen; leeg: alles in één keer.
  var step = parseInt(b.getAttribute('data-more'), 10) || rest.length;
  for (var i = 0; i < Math.min(step, rest.length); i++) rest[i].hidden = false;
  var left = rest.length - step;
  if (left > 0) { var n = b.querySelector('[data-more-n]'); if (n) n.textContent = left; } else b.hidden = true;
});

// Telefoon: actief menu-item in beeld schuiven.
(function () {
  var on = document.querySelector('.nav a.on');
  var nav = on && on.parentElement;
  if (nav && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = on.offsetLeft - (nav.clientWidth - on.offsetWidth) / 2;
})();

// Brede tabellen die bij de nieuwste kolom moeten beginnen (bv. onderwerpen per call).
document.querySelectorAll('[data-scroll-end]').forEach(function (el) { el.scrollLeft = el.scrollWidth; });

// GuruScore-schuif onder de bollengrafiek op /analisten: Alle, of per 10 punten (0-10 ... 90-100).
(function () {
  document.querySelectorAll('[data-am-filter]').forEach(function (f) {
    var box = f.closest('.an-map') || document;
    var range = f.querySelector('[data-am-range]');
    var all = f.querySelector('[data-am-all]');
    var val = f.querySelector('[data-am-val]');
    var cnt = f.querySelector('[data-am-n]');
    function apply(b) { // b = null (alle) of 0..9
      var lo = b === null ? 0 : b * 10, hi = lo + 10;
      var shown = 0, total = 0;
      box.querySelectorAll('svg.am').forEach(function (svg, k) {
        svg.querySelectorAll('[data-s]').forEach(function (el) {
          var s = Number(el.getAttribute('data-s'));
          var on = b === null || (s >= lo && (s < hi || hi === 100));
          el.style.display = on ? '' : 'none';
          if (k === 0 && el.tagName.toLowerCase() === 'a') { total++; if (on) shown++; }
        });
      });
      range.classList.toggle('off', b === null);
      all.classList.toggle('on', b === null);
      val.textContent = b === null ? 'Alle analisten' : 'Score ' + lo + ' tot ' + hi;
      cnt.textContent = b === null ? total + ' analisten' : shown + ' van ' + total + ' analisten';
    }
    var pick = function () { apply(Number(range.value)); };
    range.addEventListener('input', pick);
    range.addEventListener('change', pick);
    range.addEventListener('pointerup', pick);
    range.addEventListener('keyup', pick);
    all.addEventListener('click', function () { range.value = 0; apply(null); });
    apply(null);
  });
})();

// Sectorendonut op guru-pagina's: hover of tik op een stuk of legendaregel toont de aandelen in die sector.
(function () {
  document.querySelectorAll('[data-secpie]').forEach(function (pie) {
    var card = pie.closest('.card') || document;
    var panels = card.querySelectorAll('.sec-panel');
    var lis = pie.querySelectorAll('li[data-sec]');
    var c = pie.querySelector('[data-pie-c]'), s = pie.querySelector('[data-pie-s]');
    var c0 = c && c.textContent, s0 = s && s.textContent, fs0 = c && c.style.fontSize;
    function show(i) {
      panels.forEach(function (p) { p.hidden = p.getAttribute('data-sec') !== String(i); });
      lis.forEach(function (li) { li.classList.toggle('on', li.getAttribute('data-sec') === String(i)); });
      pie.querySelectorAll('.pie-seg').forEach(function (g) { g.classList.toggle('on', g.getAttribute('data-sec') === String(i)); });
      var li = pie.querySelector('li[data-sec="' + i + '"]');
      if (li && c && s) { c.textContent = li.getAttribute('data-w'); s.textContent = li.getAttribute('data-l'); c.style.fontSize = fs0; }
    }
    pie.addEventListener('mouseover', function (e) { var t = e.target.closest && e.target.closest('[data-sec]'); if (t) show(t.getAttribute('data-sec')); });
    pie.addEventListener('click', function (e) { var t = e.target.closest && e.target.closest('[data-sec]'); if (t) show(t.getAttribute('data-sec')); });
    pie.addEventListener('focusin', function (e) { var t = e.target.closest && e.target.closest('[data-sec]'); if (t) show(t.getAttribute('data-sec')); });
    show(0);
  });
})();
