'use strict';

// Kleine bouwstenen voor tabellen en lijsten, zodat ze overal hetzelfde ogen.
const fmt = require('./format');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const { logoUrl: logoSrc } = require('./logos');

// Logo met de eerste letter als terugval (als het plaatje ontbreekt, blijft de letter staan).
function logo(symbol, { size = 'sm' } = {}) {
  const s = String(symbol || '');
  return `<span class="lg lg-${size}" aria-hidden="true">${esc(s.replace(/[^A-Z0-9]/gi, '').charAt(0) || '?')}<img src="${logoSrc(s)}" alt="" loading="lazy" onload="this.className='ok'" onerror="this.remove()"></span>`;
}

/**
 * Aandeel als cel: logo, ticker en daaronder de bedrijfsnaam (afgekapt als die te lang is).
 * opts.href: false voor geen link; opts.extra: extra HTML achter de ticker (bv. een ster).
 */
function stock(symbol, name, opts = {}) {
  const s = String(symbol || '');
  const n = name ? fmt.company(name) : '';
  const tag = opts.href === false ? 'span' : 'a';
  const href = opts.href === false ? '' : ` href="${esc(opts.href || '/aandeel/' + encodeURIComponent(s))}"`;
  const tip = [n ? `${name} (${s})` : '', opts.tip || ''].filter(Boolean).join('\n');
  return `<${tag} class="sc${n ? '' : ' sc-1'}"${href}${tip ? ` data-tip="${esc(tip)}"${opts.tip ? '' : ' data-tip-touch="0"'}` : ''}>${logo(s)}<span class="sc-t"><b>${esc(s)}${opts.extra || ''}</b>${n ? `<em>${esc(n)}</em>` : ''}</span></${tag}>`;
}

// Persoon met daaronder de bank of functie, beide afgekapt.
function who(name, sub, href, tip) {
  const n = name ? fmt.person(name) : '';
  const dt = tip ? ` data-tip="${esc(tip)}"` : '';
  const main = n ? (href ? `<a href="${esc(href)}"${dt}>${esc(n)}</a>` : `<span${dt}>${esc(n)}</span>`) : '';
  if (!main) return `<span class="who"><span class="who-n">${esc(sub || '–')}</span></span>`;
  return `<span class="who"><span class="who-n">${main}</span>${sub ? `<span class="who-s">${esc(sub)}</span>` : ''}</span>`;
}

module.exports = { esc, logo, stock, who };
