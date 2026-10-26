/* HVM INTENT SCORING
   ------------------------------------------------------------------
   Ranks resolved visitors so the cold intent stream goes highest-first.

   TWO SEPARATE QUESTIONS, DELIBERATELY NOT MIXED:

     score()  answers HOW INTERESTED this person is.  0-100, from behaviour.
     gate()   answers WHETHER WE MAY SEND to them.    Boolean, from status.

   They are kept apart because they fail differently. A score is a guess and
   a wrong one costs a wasted send. The gate is a promise and a wrong one
   costs a complaint, and complaints cost the sending domain — which takes
   down the mail to people who DID ask for it. So the gate is evaluated
   independently and always wins: a score of 100 does not open a gate, ever.

   Runs in the Cloudflare worker, in Node, and in a browser. No dependencies.

   INPUT — a stitched visitor profile, assembled by the worker from the
   visit beacons (js/visit.js) keyed on visitorId, plus whatever the worker
   already knows about that address:

     {
       visitorId:  'v_1a2b…',
       firstSeen:  ISO8601,
       lastSeen:   ISO8601,
       visits: [{
         ts, kind:'offer'|'cert'|'other', family, dest,
         dwellMs, scrollPct, reachedPrice, reachedForm, formStarted
       }, …],
       resolved:         {email, name} | null,   // from DataMoon
       suppressed:       bool,                   // unsubscribed or complained
       consentedContact:   bool,   // gave us an address on a form
       touredWithin90Days: bool,   // -> mini-vacation-seeker, warm stream
       attendedSession:    bool,   // -> membership-prospect,  warm stream
       lastSentAt:       ISO8601 | null,
       complaints:       int,
       bounces:          int
     }
*/
// UMD. `globalThis` FIRST, and that is not cosmetic: under ESM the module-level
// `this` is undefined, so the old `self : this` fallback threw
// "Cannot set properties of undefined" the moment anything imported this file
// as a module — which is exactly what the Cloudflare Worker runtime is.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HVMScore = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── Tunables, in one place ────────────────────────────────────────
  // Every number the model depends on lives here so it can be re-weighted
  // from evidence later without going hunting through the logic. Nothing
  // below this block hard-codes a threshold.
  var W = {
    // Component ceilings. These sum to RAW_MAX and are the actual model:
    // depth dominates because the furthest step someone reached is the single
    // strongest signal we have, and everything else is context around it.
    depth: 30, recency: 15, frequency: 12, dwell: 12,
    breadth: 10, focus: 10, money: 8, source: 8,

    tierA: 80, tierB: 60, tierC: 40,      // score floors
    freqCapDays: 14,                       // min gap between cold sends
    bounceOnlyCap: 25,                     // ceiling for a pure bounce profile
    botVisitsPerDay: 40                    // above this, not a person
  };
  var RAW_MAX = W.depth + W.recency + W.frequency + W.dwell +
                W.breadth + W.focus + W.money + W.source;

  var DAY = 86400000;

  function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }
  function ts(v) { var t = Date.parse(v); return isNaN(t) ? 0 : t; }
  function arr(v) { return Object.prototype.toString.call(v) === '[object Array]' ? v : []; }

  // Step on a ladder -> points, first match wins. Written as a table rather
  // than an if-chain so the ordering IS the model and can be read at a glance.
  function ladder(steps, fallback) {
    return function (v) {
      for (var i = 0; i < steps.length; i++) if (v >= steps[i][0]) return steps[i][1];
      return fallback;
    };
  }

  var byRecency   = ladder([[30,0],[14,2],[7,5],[3,9],[1,12]], W.recency);
  var byFrequency = ladder([[3,W.frequency],[2,8],[1,4]], 0);
  var byDwellSec  = ladder([[180,W.dwell],[60,8],[20,4]], 0);
  var byBreadth   = ladder([[5,W.breadth],[3,8],[2,5],[1,2]], 0);
  var byFocus     = ladder([[3,W.focus],[2,5]], 0);
  var byMoney     = ladder([[2,W.money],[1,5]], 0);

  var SOURCE_POINTS = {
    'organic': W.source, 'direct': W.source,
    'referral': 6, 'email': 6,
    'paid-search': 5, 'paid-social': 2
  };

  // ── THE FOUR SEGMENTS, AND THE TWO STREAMS THEY SPLIT INTO ────────
  // Dave named four. They are not four of the same thing: two are read off
  // BEHAVIOUR (what an anonymous visitor did on the site) and two are CRM
  // FACTS (something that already happened between us and a real contact).
  // That difference decides which domain the mail goes out from, so it is
  // modelled here rather than left to whoever writes the send job.
  //
  //   COLD  — no relationship. Resolved from anonymous traffic, never gave us
  //           an address. Goes out from the cold subdomain, tier-gated,
  //           because these are the sends that earn complaints.
  //     presentation-seeker   worked the offer pages: price, form, booking path
  //     certificate-seeker    worked the certificate pages: destinations, terms
  //
  //   WARM  — a real relationship already exists. These people gave us an
  //           address, or sat through a session. They are NOT cold-stream
  //           targets: mailing them from the sacrificial subdomain would put
  //           our best contacts behind our worst reputation, and they convert
  //           far better than cold traffic anyway. Root domain, always.
  //     mini-vacation-seeker  toured inside 90 days; this certificate cannot
  //                           be issued to them and the site already promised
  //                           them a different conversation
  //     membership-prospect   attended a session; the membership pitch is the
  //                           one thing they have actually already heard
  var SEGMENTS = ['presentation-seeker', 'certificate-seeker',
                  'mini-vacation-seeker', 'membership-prospect'];

  // Relationship decides the stream. Never the score — a hot browse score does
  // not make someone a stranger, and a cold one does not cancel a relationship.
  function route(p) {
    return (p.consentedContact || p.attendedSession || p.touredWithin90Days)
      ? 'warm' : 'cold';
  }

  // THE DEPTH LADDER. Ordered hardest-earned first. An offer page is the
  // booking path and a certificate page is the catalogue, so the same gesture
  // is worth more on an offer page — someone who scrolled to the booking form
  // is closer to a seat than someone who read a destination blurb.
  function depthPoints(v) {
    var offer = v.kind === 'offer';
    if (offer && v.formStarted)   return { p: W.depth, why: 'started filling the booking form' };
    if (offer && v.reachedForm)   return { p: 24, why: 'scrolled to the booking form' };
    if (offer && v.reachedPrice)  return { p: 18, why: 'read the price block on an offer page' };
    if (!offer && v.kind === 'cert' && v.reachedPrice)
                                  return { p: 16, why: 'read the certificate price and terms' };
    if (offer)                    return { p: 12, why: 'viewed an offer page' };
    if (v.kind === 'cert')        return { p: 10, why: 'viewed a certificate page' };
    return { p: 3, why: 'viewed the site' };
  }

  function score(profile, nowMs) {
    profile = profile || {};
    var now = num(nowMs) || Date.now();
    var visits = arr(profile.visits);

    var out = {
      visitorId: profile.visitorId || '',
      score: 0, tier: 'D',
      archetype: 'browser', archetypeConfidence: 0,
      components: {}, reasons: [], flags: []
    };
    if (!visits.length) {
      out.reasons.push('no recorded visits');
      return out;
    }

    // ── Roll the visits up ──────────────────────────────────────────
    var deepest = { p: 0, why: '' };
    var dwellSec = 0, days = {}, dests = {}, moneyViews = 0;
    var offerPts = 0, certPts = 0;
    var bouncesOnly = true, lastSeen = ts(profile.lastSeen);
    var i, v, d;

    for (i = 0; i < visits.length; i++) {
      v = visits[i] || {};
      var t = ts(v.ts);
      if (t > lastSeen) lastSeen = t;

      var sec = num(v.dwellMs) / 1000;
      dwellSec += sec;
      if (t) days[new Date(t).toISOString().slice(0, 10)] = 1;
      // BREADTH AND FOCUS KEY ON dest OR family, NOT dest ALONE.
      // Only certificate pages carry a destination, so keying on dest made a
      // fifth of the model (breadth + focus, 20 points) structurally
      // unreachable for a presentation seeker — who has no dest by definition.
      // That put a form-starter who came back three times one point under
      // tier A while a casual destination browser cleared it, which is
      // backwards. Someone who viewed the cruise, condo and all-inclusive
      // offers IS comparing, and someone who hit the cruise offer three times
      // IS focused; both deserve to score as such.
      var key = v.dest || v.family || '';
      if (key) dests[key] = (dests[key] || 0) + 1;
      if (v.reachedPrice) moneyViews++;

      // A visit that lasted seconds and never scrolled is a wrong turn, not
      // interest. One real visit anywhere in the history clears the flag.
      if (sec >= 5 || num(v.scrollPct) >= 15) bouncesOnly = false;

      d = depthPoints(v);
      if (d.p > deepest.p) deepest = d;

      // ARCHETYPE. Which of the two things Dave named is this person doing —
      // shopping the presentation, or shopping the certificates? Accumulated
      // rather than taken from the deepest single visit, because the pattern
      // across a history is what separates them.
      if (v.kind === 'offer') {
        offerPts += 3 + (v.formStarted ? 8 : 0) + (v.reachedForm ? 4 : 0) + (v.reachedPrice ? 2 : 0);
      } else if (v.kind === 'cert') {
        certPts += 3 + (v.reachedPrice ? 3 : 0);
      }
    }

    var distinctDays = 0; for (var k in days) if (days.hasOwnProperty(k)) distinctDays++;
    var distinctDests = 0, maxRepeat = 0;
    for (var dk in dests) if (dests.hasOwnProperty(dk)) {
      distinctDests++;
      if (dests[dk] > maxRepeat) maxRepeat = dests[dk];
    }
    // Breadth counts distinct things looked at; five in a week is shopping.
    // Focus counts returns to ONE of them; three visits to the same page is
    // not shopping any more, it is deciding. Only the archetype half below is
    // certificate-weighted — the score half applies to both kinds of visitor.
    certPts += distinctDests * 2 + (maxRepeat >= 2 ? maxRepeat * 2 : 0);

    var daysAgo = lastSeen ? Math.floor((now - lastSeen) / DAY) : 999;
    var src = String(profile.source || sourceOf(visits) || 'unknown');

    var c = out.components = {
      depth:     deepest.p,
      recency:   byRecency(daysAgo),
      frequency: byFrequency(distinctDays),
      dwell:     byDwellSec(dwellSec),
      breadth:   byBreadth(distinctDests),
      focus:     byFocus(maxRepeat),
      money:     byMoney(moneyViews),
      source:    SOURCE_POINTS.hasOwnProperty(src) ? SOURCE_POINTS[src] : 4
    };

    var raw = 0; for (var ck in c) if (c.hasOwnProperty(ck)) raw += c[ck];
    var pct = Math.round((raw / RAW_MAX) * 100);

    // ── Penalties ───────────────────────────────────────────────────
    var perDay = distinctDays ? visits.length / distinctDays : visits.length;
    if (perDay > W.botVisitsPerDay) {
      out.flags.push('non-human');
      pct = 0;
    } else if (bouncesOnly && pct > W.bounceOnlyCap) {
      out.flags.push('bounce-only');
      out.reasons.push('every visit was short and unscrolled — capped');
      pct = W.bounceOnlyCap;
    }

    out.score = Math.max(0, Math.min(100, pct));
    out.tier = out.score >= W.tierA ? 'A'
             : out.score >= W.tierB ? 'B'
             : out.score >= W.tierC ? 'C' : 'D';

    // ── Segment and stream ──────────────────────────────────────────
    // A CRM fact outranks a behavioural guess. Someone who sat through a
    // session is a membership prospect no matter what they browsed afterwards,
    // and confidence is 1 because it is not an inference.
    out.stream = route(profile);
    var total = offerPts + certPts;
    if (profile.attendedSession) {
      out.archetype = 'membership-prospect';
      out.archetypeConfidence = 1;
    } else if (profile.touredWithin90Days) {
      out.archetype = 'mini-vacation-seeker';
      out.archetypeConfidence = 1;
    } else if (total > 0) {
      out.archetype = offerPts >= certPts ? 'presentation-seeker' : 'certificate-seeker';
      out.archetypeConfidence = Math.round(Math.abs(offerPts - certPts) / total * 100) / 100;
    }
    out.signals = {
      visits: visits.length, distinctDays: distinctDays,
      distinctDestinations: distinctDests, maxRepeatOnOneDestination: maxRepeat,
      dwellSeconds: Math.round(dwellSec), daysSinceLastVisit: daysAgo,
      offerPoints: offerPts, certificatePoints: certPts, source: src
    };

    // ── Why, in words a person can act on ───────────────────────────
    if (deepest.why) out.reasons.push(deepest.why);
    if (distinctDays >= 2) out.reasons.push('came back on ' + distinctDays + ' separate days');
    if (maxRepeat >= 2) out.reasons.push('viewed the same destination ' + maxRepeat + ' times');
    if (distinctDests >= 3) out.reasons.push('compared ' + distinctDests + ' destinations');
    if (moneyViews >= 1) out.reasons.push('read the pricing');
    if (daysAgo <= 1) out.reasons.push('was here today');

    return out;
  }

  function sourceOf(visits) {
    for (var i = 0; i < visits.length; i++) if (visits[i] && visits[i].source) return visits[i].source;
    return '';
  }

  // ── THE GATE ──────────────────────────────────────────────────────
  // Status, not behaviour. Ordered most-serious first so blockedBy names the
  // reason a human would give. Nothing here consults the score, and the score
  // cannot overrule any of it.
  function gate(profile, scored, nowMs) {
    profile = profile || {};
    var now = num(nowMs) || Date.now();
    var stream = (scored && scored.stream) || route(profile);
    var blocked = [];

    // UNIVERSAL. True of any stream, any score, any segment.
    if (scored && scored.flags && scored.flags.indexOf('non-human') !== -1)
      blocked.push('non-human');
    if (profile.suppressed) blocked.push('suppressed');
    if (num(profile.complaints) > 0) blocked.push('prior-complaint');
    if (num(profile.bounces) >= 2) blocked.push('repeat-bounces');
    if (!profile.resolved || !profile.resolved.email) blocked.push('no-resolved-address');

    var last = ts(profile.lastSentAt || profile.lastColdSendAt);
    if (last && (now - last) < W.freqCapDays * DAY)
      blocked.push('frequency-cap-' + W.freqCapDays + 'd');

    // COLD ONLY. The tier floor exists because a cold send to a lukewarm
    // stranger is the send that earns a complaint, and complaints are the
    // whole cost of this programme. A warm contact has already raised their
    // hand, so their browse score decides the CONTENT, never the permission.
    if (stream === 'cold' && scored && scored.tier !== 'A' && scored.tier !== 'B')
      blocked.push('below-sendable-tier');

    return { ok: blocked.length === 0, stream: stream, blockedBy: blocked };
  }

  function evaluate(profile, nowMs) {
    var s = score(profile, nowMs);
    var g = gate(profile, s, nowMs);
    s.gate = g;
    s.sendable = g.ok;
    // The segment picks the template, the stream picks the sending domain, and
    // the score picks the position in the queue. That is the whole job.
    s.template = s.sendable ? s.archetype : '';
    s.sendFrom = s.sendable ? (s.stream === 'warm' ? 'root-domain' : 'cold-subdomain') : '';
    return s;
  }

  // Score a list, drop everything the gate refuses, and hand back the rest
  // highest-first. `limit` is the day's send budget.
  // opts: {now, limit, stream:'cold'|'warm', segment:'presentation-seeker'|…}
  // The two streams go out from different domains on different schedules, so a
  // send job pulls one queue at a time rather than filtering a mixed list and
  // risking a warm contact going out over the sacrificial subdomain.
  function rank(profiles, opts) {
    opts = opts || {};
    var now = num(opts.now) || Date.now();
    var out = [], i, r;
    for (i = 0; i < arr(profiles).length; i++) {
      r = evaluate(profiles[i], now);
      if (!r.sendable) continue;
      if (opts.stream && r.stream !== opts.stream) continue;
      if (opts.segment && r.archetype !== opts.segment) continue;
      out.push(r);
    }
    out.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      // Deterministic tie-break, so two runs over the same data send in the
      // same order and a partial send can be resumed without duplicates.
      return String(a.visitorId) < String(b.visitorId) ? -1 : 1;
    });
    return opts.limit > 0 ? out.slice(0, opts.limit) : out;
  }

  return { score: score, gate: gate, evaluate: evaluate, rank: rank, route: route,
           SEGMENTS: SEGMENTS, weights: W, RAW_MAX: RAW_MAX };
});

