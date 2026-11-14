// Suggesties onder de zoekbalk: aandelen (logo, ticker, naam), analisten en guru's.
(function () {
  var input = document.querySelector('.search input[name=q]');
  var list = document.getElementById('sx-list');
  if (!input || !list) return;
  var form = input.form;
  var items = [];
  var active = -1;
  var timer = null;
  var seq = 0;
  var cache = {};

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // Markeer het getypte stuk in een tekst.
  function mark(text, term) {
    var t = String(text || '');
    var i = t.toLowerCase().indexOf(term.toLowerCase());
    if (!term || i < 0) return esc(t);
    return esc(t.slice(0, i)) + '<mark>' + esc(t.slice(i, i + term.length)) + '</mark>' + esc(t.slice(i + term.length));
  }
  function initials(n) {
    return String(n || '?').split(/\s+/).filter(Boolean).map(function (w) { return w.charAt(0); }).join('').slice(0, 2).toUpperCase();
  }
  function logo(sym) {
    var s = String(sym || '');
    return '<span class="lg" aria-hidden="true">' + esc(s.replace(/[^A-Z0-9]/gi, '').charAt(0) || '?') +
      '<img src="https://eodhd.com/img/logos/US/' + encodeURIComponent(s.toUpperCase()) + '.png" alt="" onload="this.className=\'ok\'" onerror="this.remove()"></span>';
  }

  function open(on) {
    list.hidden = !on;
    input.setAttribute('aria-expanded', on ? 'true' : 'false');
    document.documentElement.classList.toggle('sx-open', on);
  }

  function render(data, term) {
    items = [];
    var html = '';
    function group(title, rows) {
      if (!rows.length) return;
      html += '<div class="sx-h">' + title + '</div>';
      rows.forEach(function (r) {
        var i = items.length;
        items.push(r.href);
        html += '<a class="sx-i" role="option" id="sx-' + i + '" data-i="' + i + '" href="' + esc(r.href) + '">' + r.icon +
          '<span class="sx-t"><b>' + r.main + '</b><em>' + r.sub + '</em></span>' + (r.tag ? '<i class="sx-tag">' + esc(r.tag) + '</i>' : '') + '</a>';
      });
    }
    group('Aandelen', data.stocks.map(function (s) {
      return { href: '/aandeel/' + encodeURIComponent(s.symbol), icon: logo(s.symbol), main: mark(s.symbol, term), sub: mark(s.name, term), tag: s.ex && !/^(NASDAQ|NYSE|AMEX)$/i.test(s.ex) ? s.ex : '' };
    }));
    group("Guru's", data.gurus.map(function (g) {
      return { href: '/guru/' + encodeURIComponent(g.slug), icon: '<span class="sx-av sx-gu">' + esc(initials(g.name)) + '</span>', main: mark(g.name, term), sub: mark(g.fund, term), tag: 'Guru' };
    }));
    group('Analisten', data.analysts.map(function (a) {
      return { href: '/analist/' + encodeURIComponent(a.slug), icon: '<span class="sx-av">' + esc(initials(a.name)) + '</span>', main: mark(a.name, term), sub: mark(a.firm, term), tag: 'Analist' };
    }));
    if (!items.length) html = '<div class="sx-empty">Geen resultaten voor “' + esc(term) + '”</div>';
    html += '<button type="submit" class="sx-all">Alle resultaten voor “' + esc(term) + '” <span>↵</span></button>';
    list.innerHTML = html;
    active = -1;
    open(true);
  }

  function setActive(i) {
    var els = list.querySelectorAll('.sx-i');
    if (!els.length) return;
    active = (i + els.length) % els.length;
    els.forEach(function (el, k) { el.classList.toggle('on', k === active); el.setAttribute('aria-selected', k === active ? 'true' : 'false'); });
    input.setAttribute('aria-activedescendant', 'sx-' + active);
    els[active].scrollIntoView({ block: 'nearest' });
  }

  function fetchSuggest() {
    var term = input.value.trim();
    if (!term) { open(false); return; }
    if (cache[term]) { render(cache[term], term); return; }
    var my = ++seq;
    fetch('/zoek/suggesties?q=' + encodeURIComponent(term), { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || my !== seq) return;
        cache[term] = data;
        if (input.value.trim() === term) render(data, term);
      })
      .catch(function () {});
  }

  input.addEventListener('input', function () {
    clearTimeout(timer);
    timer = setTimeout(fetchSuggest, 140);
  });
  input.addEventListener('focus', function () { if (input.value.trim() && list.innerHTML) open(true); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden) fetchSuggest(); else setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'Escape') { open(false); }
    else if (e.key === 'Enter') {
      if (active >= 0 && items[active]) { e.preventDefault(); location.href = items[active]; return; }
      // Precies een ticker getypt? Dan meteen naar het aandeel.
      var data = cache[input.value.trim()];
      var up = input.value.trim().toUpperCase();
      if (data && data.stocks[0] && data.stocks[0].symbol.toUpperCase() === up) { e.preventDefault(); location.href = '/aandeel/' + encodeURIComponent(data.stocks[0].symbol); }
    }
  });
  list.addEventListener('mousemove', function (e) {
    var a = e.target.closest('.sx-i');
    if (a && +a.dataset.i !== active) setActive(+a.dataset.i);
  });
  // Blur pas na de klik op een suggestie verwerken.
  list.addEventListener('mousedown', function (e) { e.preventDefault(); });
  input.addEventListener('blur', function () { setTimeout(function () { open(false); }, 120); });
  document.addEventListener('click', function (e) { if (!form.contains(e.target)) open(false); });
})();
