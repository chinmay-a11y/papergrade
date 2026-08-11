// Shared frontend helpers (vanilla, zero-build).
const qs = new URLSearchParams(location.search);
const WID = qs.get('w') || '';
const SID = qs.get('s') || '';

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = res.status;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v != null) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(kid));
  return n;
}

function toast(msg) {
  const t = el('div', { class: 'toast' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}

function confClass(c) { return c >= 0.85 ? 'conf-hi' : c >= 0.7 ? 'conf-mid' : 'conf-lo'; }

// Renders the standard top bar with nav + mode pill. active = page key.
function topbar(active, mock) {
  const link = (key, label, href) =>
    el('a', { href: href + (WID ? `?w=${WID}` : ''), class: active === key ? 'active' : '' }, label);
  const modePill = mock == null ? '' :
    el('span', { class: 'pill ' + (mock ? 'mock' : 'live') }, mock ? 'MOCK mode' : 'LIVE · Sarvam');
  return el('div', { class: 'topbar' },
    el('div', { class: 'brand' }, el('span', { class: 'dot' }), 'PaperGrade'),
    el('div', { class: 'nav' },
      link('setup', 'Setup', '/'),
      link('capture', 'Capture', '/capture.html'),
      link('review', 'Review', '/review.html'),
      link('dashboard', 'Dashboard', '/dashboard.html'),
      modePill,
    ),
  );
}
function mountTopbar(active) {
  const holder = document.getElementById('topbar');
  api('/api/health').then(h => holder.replaceWith(topbar(active, h.mock)))
    .catch(() => holder.replaceWith(topbar(active, null)));
}

function fmt(n) { return (Math.round(n * 100) / 100).toString(); }

// Light (Stripe-theme) app nav used by capture / review / dashboard.
function appbar(active, mock) {
  const link = (key, label, href) =>
    el('a', { href: href + (WID ? `?w=${WID}` : ''), class: 'appnav-link' + (active === key ? ' on' : '') }, label);
  const pill = mock == null ? '' :
    el('span', { class: 'pill-tag', style: mock ? '' : 'background:#e7f7ee;color:#1a7f46' }, mock ? 'MOCK mode' : 'LIVE · Sarvam');
  return el('div', { class: 'appbar' },
    el('div', { class: 'appbar-in' },
      el('a', { class: 'brand', href: '/landing.html' }, el('span', { class: 'dot' }), 'PaperGrade'),
      el('div', { class: 'nav-links' },
        link('capture', 'Capture', '/capture.html'),
        link('review', 'Review', '/review.html'),
        link('dashboard', 'Dashboard', '/dashboard.html'),
        pill,
      ),
    ),
  );
}
function mountAppbar(active) {
  const holder = document.getElementById('topbar');
  if (!holder) return;
  api('/api/health').then(h => holder.replaceWith(appbar(active, h.mock)))
    .catch(() => holder.replaceWith(appbar(active, null)));
}
