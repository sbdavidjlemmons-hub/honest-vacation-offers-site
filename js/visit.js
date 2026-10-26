/* HVM VISIT BEACON
   ------------------------------------------------------------------
   Feeds js/scoring.js. Without this file the scorer has nothing to score:
   before it, the only thing that ever reached the worker was a submitted
   form, so every visitor who did not fill something in was invisible.

   Sends ONE beacon per page view, at the end of the view, carrying what the
   person actually did: how long they were really looking, how far they got,
   whether they reached the money, whether they touched the form.

   WHAT IT DOES NOT DO. No email address, no name, no phone, nothing typed
   into any field — formStarted is a boolean, never a value. The id is a
   random first-party string in this site's own localStorage; it identifies a
   browser to us and nobody else, it is not bought, sold or shared, and
   clearing site data ends it. Identity resolution happens elsewhere and is
   not this file's business: this file records behaviour only.
*/
(function () {
  'use strict';
  var ENDPOINT = 'https://hvm-lead-intake.lead-intake.workers.dev';
  var P = window.HVM_PAGE || {};                 // {kind, family, dest}
  if (!P.kind) return;

  // ── The visitor id ────────────────────────────────────────────────
  // Wrapped because Safari private mode throws on localStorage. A visit we
  // cannot stitch to a history is still worth more than no visit at all, so
  // a failure here degrades to a one-off rather than dropping the beacon.
  var VKEY = 'hvm_vid', NKEY = 'hvm_visits', FKEY = 'hvm_first';
  var vid = '', visitNo = 1, firstSeen = '';
  try {
    vid = localStorage.getItem(VKEY) || '';
    if (!vid) {
      vid = 'v_' + Date.now().toString(36) + '_' +
            Math.random().toString(36).slice(2, 10);
      localStorage.setItem(VKEY, vid);
    }
    visitNo = (parseInt(localStorage.getItem(NKEY), 10) || 0) + 1;
    localStorage.setItem(NKEY, String(visitNo));
    firstSeen = localStorage.getItem(FKEY) || '';
    if (!firstSeen) { firstSeen = new Date().toISOString(); localStorage.setItem(FKEY, firstSeen); }
  } catch (e) { vid = vid || 'v_anon'; }

  // Published so a DataMoon custom field can carry it back on the resolved
  // record. Without that mapping the worker has behaviour on one side and an
  // address on the other and no way to join them.
  window.HVM_VID = vid;
  try { document.documentElement.setAttribute('data-hvm-vid', vid); } catch (e) {}

  // ── Engaged time, not wall-clock ──────────────────────────────────
  // A tab left open over lunch is not a hundred-point visit. The clock stops
  // whenever the page is hidden, so dwell means time actually looking.
  var engaged = 0, mark = Date.now(), visible = !document.hidden;
  function tick() { if (visible) { engaged += Date.now() - mark; } mark = Date.now(); }
  document.addEventListener('visibilitychange', function () {
    tick(); visible = !document.hidden;
  });

  // ── Depth ─────────────────────────────────────────────────────────
  var maxScroll = 0;
  function scrolled() {
    var h = document.documentElement.scrollHeight - window.innerHeight;
    var pct = h > 0 ? Math.round((window.pageYOffset / h) * 100) : 100;
    if (pct > maxScroll) maxScroll = Math.min(100, pct);
  }
  scrolled();
  window.addEventListener('scroll', scrolled, { passive: true });

  // ── The three gestures that matter ────────────────────────────────
  var reachedPrice = false, reachedForm = false, formStarted = false;

  function watch(sel, hit) {
    var nodes = document.querySelectorAll(sel);
    if (!nodes.length) return;
    if (!window.IntersectionObserver) { return; }
    var io = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) { hit(); io.disconnect(); return; }
      }
    }, { threshold: 0.35 });
    for (var i = 0; i < nodes.length; i++) io.observe(nodes[i]);
  }

  // Two ways a page can show its money, and they need different detectors.
  // On the offer pages the payment schedule is a static block, so scrolling it
  // into view is the signal. On the certificate pages the charges live on the
  // back of a flip card — geometrically on screen the whole time, so an
  // observer there would score everyone who scrolled past as having read the
  // price. Flipping the card is a deliberate act and the better signal anyway.
  watch('[data-hvm="price"]', function () { reachedPrice = true; });
  watch('form', function () { reachedForm = true; });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t && t.getAttribute && t.getAttribute('data-hvm') === 'price-toggle' && t.checked)
      reachedPrice = true;
  }, true);

  // TOUCHED, NOT TYPED. We record that a field was engaged with and never what
  // went into it. An abandoned form is the strongest signal on the site and
  // also the most sensitive moment on it, so the beacon takes the signal and
  // leaves the content alone.
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (!t || !t.form) return;
    if (t.name === 'company_website') return;          // honeypot
    formStarted = true;
  }, true);

  function referrerClass() {
    var q = location.search || '';
    if (/utm_medium=(cpc|ppc|paid)/i.test(q) || /gclid=/i.test(q)) return 'paid-search';
    if (/utm_medium=(paid_social|paidsocial|social_paid)/i.test(q) || /fbclid=/i.test(q)) return 'paid-social';
    if (/utm_medium=email/i.test(q)) return 'email';
    var r = document.referrer || '';
    if (!r) return 'direct';
    try {
      var h = new URL(r).hostname.replace(/^www\./, '');
      if (h === location.hostname.replace(/^www\./, '')) return 'internal';
      if (/(google|bing|duckduckgo|yahoo|ecosia)\./i.test(h)) return 'organic';
      return 'referral';
    } catch (e) { return 'referral'; }
  }

  // ── Send once, at the end ─────────────────────────────────────────
  var sent = false;
  function send() {
    if (sent) return;
    sent = true;
    tick();
    var body = {
      net: 'net1', bucket: 'visit',
      visitorId: vid, visitNo: visitNo, firstSeen: firstSeen,
      ts: new Date().toISOString(),
      kind: P.kind, family: P.family || '', dest: P.dest || '',
      page: location.pathname,
      dwellMs: engaged, scrollPct: maxScroll,
      reachedPrice: reachedPrice, reachedForm: reachedForm, formStarted: formStarted,
      source: referrerClass(),
      attribution: (function () { try { return hvmAttr(); } catch (e) { return {}; } })()
    };
    var payload = JSON.stringify(body);
    // sendBeacon survives the page going away, which a fetch does not — and
    // the end of the view is exactly when the interesting numbers are final.
    try {
      if (navigator.sendBeacon &&
          navigator.sendBeacon(ENDPOINT, new Blob([payload], { type: 'application/json' }))) return;
    } catch (e) {}
    try {
      fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: payload, keepalive: true }).catch(function () {});
    } catch (e) {}
  }

  window.addEventListener('pagehide', send);
  document.addEventListener('visibilitychange', function () { if (document.hidden) send(); });
  // A visitor who reads one page for ten minutes and closes the laptop lid can
  // lose both events. Backstop so a long, engaged visit is never the one we
  // fail to record.
  setTimeout(send, 120000);
})();

