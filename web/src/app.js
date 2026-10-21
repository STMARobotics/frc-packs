import { api, explain } from "./api";

/* The game UI. Everything that matters (what's in a pack, serial numbers, timers, pity) comes from the server
   through `api`; this file only shows it. RECIPE is the pack recipe (data/packs/<id>.json), the same file the
   server rolls from. */
export function start(RECIPE) {
  var PACK_ID = RECIPE.id;
  var TOTAL = 0, CLAIM_MS = 5 * 60 * 60 * 1000, SHELF_N = 10;
  var $ = function (s) { return document.querySelector(s); };
  var RM = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  /* Mouse users click and drag; touch users tap and swipe. */
  var MOUSE = !!(window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches);
  var TAP = MOUSE ? "Click" : "Tap", SWIPE = MOUSE ? "Drag" : "Swipe";

  /* ---------- data ---------- */
  /* Teams arrive ranked and tiered by tools/build_packs.py: Mythic is the season's top 50 who came to Houston;
     everyone else is ranked by EPA at Champs and split into Legendary, Rare, Uncommon and Common. */
  var TEAMS = RECIPE.teams.slice(), BY_NUM = {};
  TEAMS.forEach(function (t) { BY_NUM[t.num] = t; });
  TOTAL = TEAMS.length;
  function tierOf(num) { return BY_NUM[num] && BY_NUM[num].tier; }
  var ORDER = ["mythic", "legendary", "rare", "uncommon", "common"];
  var TIERS = {
    common: { label: "Common", color: "#aab8c4", parts: 10, pow: 4, gems: "◆" },
    uncommon: { label: "Uncommon", color: "#7fe0d2", parts: 26, pow: 6, gems: "◆◆" },
    rare: { label: "Rare", color: "#ffc850", parts: 60, pow: 8, gems: "◆◆◆" },
    legendary: { label: "Legendary", color: "#b478ff", parts: 140, pow: 11, gems: "◆◆◆◆" },
    mythic: { label: "Mythic", color: "#3cffdc", parts: 260, pow: 13, gems: "★" }
  };
  var POOL = {}; ORDER.forEach(function (t) { POOL[t] = []; });
  TEAMS.forEach(function (t) { POOL[t.tier].push(t); });
  /* Division sets: own every team from one Houston division for a bonus pack. */
  var DIVS = [], DIV_TEAMS = {};
  TEAMS.forEach(function (t) { if (!DIV_TEAMS[t.div]) { DIV_TEAMS[t.div] = []; DIVS.push(t.div); } DIV_TEAMS[t.div].push(t); });
  DIVS.sort();

  /* ---------- odds (shown on the pack; the server does the rolling) ---------- */
  var ODDS = RECIPE.odds, SOFT = ODDS.soft, HARD = ODDS.hard, LEG_EVERY = ODDS.legEvery;
  function pct(x) { return +((x || 0) * 100).toFixed(2) + "%"; }
  /* Picking your team is off for now: anyone could claim to be 254 and get a guaranteed top card in their first pack.
     It can come back once a team is verified through an account. The code stays so turning this on restores it. */
  var TEAM_PICK = false;
  function myTeam() { return TEAM_PICK ? S.team : 0; }

  /* ---------- state ---------- */
  /* S mirrors the server: sealed packs, the free-pack timer, pity, the collection and the pack being revealed.
     Only display preferences (sound, the wheel setting, which cards are marked new) are kept in this browser. */
  var PREFS = "frcpacks.prefs";
  var S = { packs: 0, nextClaimAt: Date.now(), inv: {}, pending: null, opened: 0, demo: false, devTools: false, pity: { m: 0, l: 0 }, boosted: 0, mythic: 0, openMythic: false, parts: 0, boostCost: 250, scrapParts: {}, sets: {}, team: 0, teamAsked: true, muted: false, wheel: true, unseen: {} };
  try {
    var prefs = JSON.parse(localStorage.getItem(PREFS) || "{}");
    if (prefs && typeof prefs === "object") {
      S.muted = prefs.muted === true; S.wheel = prefs.wheel2 === true; 
      if (prefs.unseen && typeof prefs.unseen === "object" && !Array.isArray(prefs.unseen)) S.unseen = prefs.unseen;
    }
  } catch (e) {}
  function save() { try { localStorage.setItem(PREFS, JSON.stringify({ muted: S.muted, wheel2: S.wheel, unseen: S.unseen })); } catch (e) {} }
  /* Server times are converted to this device's clock on every response, so a wrong device clock can't change a timer. */
  /* The donation link is off for now: set DONATIONS to true (and the link in the admin panel) to show it. */
  var DONATIONS = false;
  var ME = ""; // this account's username
  var stamp = 0; // bumped by everything that changes the account, so a sync started earlier can't undo it
  function applyState(st, fromSync) {
    if (!fromSync) stamp++;
    if (st.notice && !noticeShown) { noticeShown = true; var note = st.notice; setTimeout(function () { showNotice(note); }, 600); }
    if (st.account && st.account.username) ME = st.account.username;
    S.account = st.account || null;
    var skew = st.now - Date.now(); CLAIM_MS = st.claimMs; BANK = st.bank; PER = st.claimPacks || 1;
    var p = st.packs.filter(function (x) { return x.id === PACK_ID; })[0] || { sealed: 0, boosted: 0, opened: 0, pity: { m: 0, l: 0 } };
    S.mythic = p.mythic || 0; S.packs = p.sealed; S.boosted = (p.boosted || 0) - S.mythic; S.opened = p.opened; S.pity = p.pity; S.nextClaimAt = st.nextClaimAt - skew;
    S.account = st.account || S.account; S.level = st.level || null; S.parts = st.parts || 0; S.boostCost = st.boostCost || 250; S.scrapParts = st.scrapParts || {};
    if (st.missions) { S.missions = st.missions; S.streak = st.streak; dailyDirty = true; }
    S.favorites = st.favorites || S.favorites || []; if (st.wishlist) { S.wishlist = st.wishlist; S.showcase = st.showcase || []; }
    /* The donation link only shows when the admin set one (always https, checked by the server). */
    var don = DONATIONS && st.donateUrl && /^https:\/\//.test(st.donateUrl) ? st.donateUrl : "";
    $("#donateLine").hidden = !don; if (don) { $("#donateBtn").href = don; }
    S.demo = st.demo; S.devTools = st.devTools;
  }
  function applyCollection(col) {
    S.inv = {}; col.cards.forEach(function (c) { if (BY_NUM[c.num]) S.inv[c.num] = c.serials.map(String); });
    S.sets = {}; col.sets.forEach(function (d) { S.sets[d] = 1; });
    hidePending(); // the server lists cards still to be dealt; they join the binder as they're dealt
  }
  /* Robot photos are fetched and decoded as soon as a pack's cards are known. Face-down cards sit in a flipped 3D layer, and
     phones (iOS especially) can skip loading images there until it's too late, which left some cards without a picture. */
  var photoCache = {};
  function preloadPhotos(nums) { nums.forEach(function (n) { if (photoCache[n] || !BY_NUM[n] || !BY_NUM[n].photo) return; var im = new Image(); im.decoding = "async"; im.src = "/photos/" + n + ".webp"; photoCache[n] = im; im._ready = im.decode ? im.decode().catch(function () {}) : Promise.resolve(); }); }
  /* Resolves once these robots' photos are downloaded and decoded (or after `ms`, whichever is first), so the cards
     can be drawn without the phone stalling to decode five photos in the same frame as the tear. */
  function photosReady(nums, ms) {
    preloadPhotos(nums);
    var all = Promise.all(nums.map(function (n) { return photoCache[n] && photoCache[n]._ready || Promise.resolve(); }));
    return Promise.race([all, new Promise(function (r) { setTimeout(r, ms); })]);
  }
  function pendingFrom(o) {
    if (!o || o.pack !== PACK_ID || o.cards.length !== 5 || !o.cards.every(function (c) { return BY_NUM[c.num] && TIERS[c.tier]; })) return null;
    preloadPhotos(o.cards.map(function (c) { return c.num; }));
    return { id: o.id, revealed: o.revealed, sets: o.sets, cards: o.cards.map(function (c) { return { num: c.num, tier: c.tier, serial: String(c.serial), isNew: c.isNew, copy: c.copy, inGame: c.inGame, test: !!c.test }; }) };
  }
  function offline(e) { say(e && e.status === 0 ? "Can't reach the server. Check your connection." : e && e.status === 401 ? "You've been signed out. Reload to sign in again." : explain(e), 3600); }
  /* Another tab or device may have opened packs. Refresh whenever this tab is between packs. */
  function sync(force) {
    if (!force && state !== "select" && state !== "summary" && state !== "home") return;
    var at = stamp;
    Promise.all([api.state(), api.collection(PACK_ID)]).then(function (r) {
      if (at !== stamp || (state !== "select" && state !== "summary" && state !== "home")) return;
      applyState(r[0], true); applyCollection(r[1]);
      paintStatus(); paintToggles(); paintTabDot(); if (!vBinder.hidden) paintBinder(); if (state === "select" || state === "home") paintSelectHud();
    }, function () {});
    loadTrades();
  }
  document.addEventListener("visibilitychange", function () { if (!document.hidden) sync(); });
  addEventListener("focus", function () { sync(); });

  /* ---------- sound ---------- */
  var ac = null;
  function actx() { if (!ac) { try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { ac = false; } } if (ac && ac.state === "suspended") ac.resume(); return ac; }
  function blip(f, d, type, v, when) {
    if (S.muted) return; var a = actx(); if (!a) return;
    var t = a.currentTime + (when || 0), o = a.createOscillator(), g = a.createGain();
    o.type = type || "sine"; o.frequency.setValueAtTime(f, t);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v || .1, t + .01); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + d + .02);
  }
  function noise(d, v, lo) {
    if (S.muted) return; var a = actx(); if (!a) return;
    var n = Math.floor(a.sampleRate * d), buf = a.createBuffer(1, n, a.sampleRate), data = buf.getChannelData(0);
    for (var i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
    var s = a.createBufferSource(); s.buffer = buf;
    var bp = a.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = lo; bp.Q.value = .7;
    var g = a.createGain(); g.gain.value = v; s.connect(bp); bp.connect(g); g.connect(a.destination); s.start();
  }
  function chord(freqs, step, type, v) { freqs.forEach(function (f, i) { blip(f, .5, type, v, i * step); }); }
  /* Chrome refuses (and logs an error) if the page vibrates before the first tap, e.g. a wheel tick after a reload. */
  function buzz(ms) { try { if (!S.muted && navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) navigator.vibrate(ms); } catch (e) {} }
  var sfx = {
    tick: function () { blip(900, .03, "square", .02); },
    pick: function () { blip(520, .08, "triangle", .08); blip(780, .1, "triangle", .06, .06); },
    rip: function (best) {
      noise(.4, .5, 2400); blip(180, .15, "sawtooth", .05);
      if (best === "legendary" || best === "mythic") { chord([392, 523, 659], .06, "triangle", .07); buzz([30, 30, 60, 30, 90]); }
      else if (best === "rare") { blip(523, .2, "triangle", .06, .05); buzz([20, 30, 50]); }
      else buzz([20, 30, 40]);
    },
    tease: function (tier) { if (tier === "rare") { blip(1318, .12, "sine", .03); buzz(12); } else { blip(1318, .14, "sine", .04); blip(1760, .14, "sine", .03, .09); buzz([15, 40, 15]); } },
    promote: function () { [523, 659, 784, 1046, 1318].forEach(function (f, i) { blip(f, .18, "triangle", .06, i * .05); }); buzz([20, 20, 20, 20, 60]); },
    /* Two heartbeats while the room goes dark before a Mythic flips. */
    heartbeat: function () {
      if (S.muted) return; var a = actx(); if (!a) return;
      [0, .26, .78, 1.04].forEach(function (d, i) {
        var t = a.currentTime + d, o = a.createOscillator(), g = a.createGain();
        o.type = "sine"; o.frequency.setValueAtTime(i % 2 ? 58 : 66, t); o.frequency.exponentialRampToValueAtTime(38, t + .18);
        g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(i % 2 ? .22 : .3, t + .02); g.gain.exponentialRampToValueAtTime(.0001, t + .22);
        o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + .25);
      });
      buzz([45, 160, 35, 340, 45, 160, 35]);
    },
    /* The Mythic itself: a bright rising arpeggio over a low swell, then sparkles. */
    mythic: function () {
      chord([523, 659, 784, 988, 1046, 1318, 1568, 1976], .06, "triangle", .055);
      blip(131, 1.8, "sine", .1); blip(196, 1.6, "sine", .06, .05);
      [2637, 3136, 2349, 3520, 2794].forEach(function (f, i) { blip(f, .09, "sine", .025, .55 + i * .11); });
      buzz([60, 40, 60, 40, 220]);
    },
    riser: function () { if (S.muted) return; var a = actx(); if (!a) return; var t = a.currentTime, o = a.createOscillator(), g = a.createGain(); o.type = "sine"; o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(880, t + .45); g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(.12, t + .4); g.gain.exponentialRampToValueAtTime(.0001, t + .5); o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + .55); buzz([10, 30, 10, 30, 10, 30]); },
    mine: function () { chord([659, 784, 988, 1318], .07, "triangle", .08); buzz([40, 40, 80]); },
    whoosh: function () { noise(.18, .18, 900); },
    claim: function () { chord([392, 523, 659], .08, "triangle", .09); },
    flip: function (tier) {
      if (tier === "common") blip(440, .09, "triangle", .08);
      else if (tier === "uncommon") chord([523, 659], .07, "triangle", .08);
      else if (tier === "rare") { chord([523, 659, 784], .07, "triangle", .1); buzz(30); }
      else if (tier === "legendary") { chord([392, 523, 659, 784, 988], .08, "square", .06); noise(.6, .25, 3000); buzz([30, 40, 60]); }
      else { chord([261, 392, 523, 659, 784, 1046, 1318], .09, "square", .06); blip(65, 1.2, "sine", .3); noise(1.1, .3, 1800); buzz([40, 60, 40, 60, 120]); }
    }
  };

  /* ---------- particles ---------- */
  var cv = $("#fx"), cx = cv.getContext("2d"), parts = [], raf = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
  function size() { cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; }
  size(); addEventListener("resize", size);
  var PALETTE = ["#ff3d9a", "#ffe14a", "#38ffd2", "#4d7bff", "#c04dff", "#ffffff"];
  function burst(x, y, n, color, pow, rainbow) {
    if (RM) n = Math.min(n, 12); else if (document.body.classList.contains("perf")) n = Math.ceil(n * .3);
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2, s = (.3 + Math.random()) * pow;
      parts.push({ x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - pow * .35, life: 1, dec: .008 + Math.random() * .014, sz: 3 + Math.random() * 6, c: rainbow ? PALETTE[i % PALETTE.length] : color, rot: Math.random() * 6, vr: (Math.random() - .5) * .4 });
    }
    if (!raf) raf = requestAnimationFrame(tick);
  }
  function tick() {
    cx.setTransform(dpr, 0, 0, dpr, 0, 0); cx.clearRect(0, 0, innerWidth, innerHeight);
    for (var i = parts.length - 1; i >= 0; i--) {
      var p = parts[i]; p.x += p.vx; p.y += p.vy; p.vy += .22; p.vx *= .985; p.life -= p.dec; p.rot += p.vr;
      if (p.life <= 0) { parts.splice(i, 1); continue; }
      cx.save(); cx.globalAlpha = Math.max(p.life, 0); cx.translate(p.x, p.y); cx.rotate(p.rot); cx.fillStyle = p.c; cx.fillRect(-p.sz / 2, -p.sz / 3, p.sz, p.sz * .66); cx.restore();
    }
    raf = parts.length ? requestAnimationFrame(tick) : 0;
    if (!raf) cx.clearRect(0, 0, innerWidth, innerHeight);
  }
  var stage = $("#stage"), flashEl = $("#flash"), banner = $("#banner");
  function shake(big) { if (RM) return; var c = big ? "shake-big" : "shake"; stage.classList.remove("shake", "shake-big"); void stage.offsetWidth; stage.classList.add(c); setTimeout(function () { stage.classList.remove(c); }, big ? 850 : 550); }
  function ripFx(r, color, rainbow, big) {
    if (RM) return;
    var fx = document.createElement("div"); fx.className = "ripfx" + (rainbow ? " rainbow" : "");
    fx.style.cssText = "left:" + r.left + "px;top:" + (r.top + r.height * .13 - r.width / 2) + "px;width:" + r.width + "px;height:" + r.width + "px;--c:" + color;
    fx.innerHTML = (big ? '<i class="rays"></i>' : "") + '<i class="ring"></i><i class="slash"></i>';
    document.body.appendChild(fx); setTimeout(function () { fx.remove(); }, 1000);
  }
  function flash() { if (RM) return; flashEl.classList.remove("go"); void flashEl.offsetWidth; flashEl.classList.add("go"); }
  function say(msg, ms) { banner.textContent = msg; banner.classList.add("show"); clearTimeout(say.t); say.t = setTimeout(function () { banner.classList.remove("show"); }, ms || 3200); }

  /* ---------- art ---------- */
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  var GEAR = (function () {
    var d = "", n = 12, R = 46, r = 38;
    for (var i = 0; i < n; i++) {
      var a0 = i / n * Math.PI * 2, a1 = a0 + Math.PI / n * .55, a2 = a0 + Math.PI / n, a3 = a0 + Math.PI / n * 1.55;
      [[r, a0], [R, a1], [R, a2], [r, a3]].forEach(function (p, j) { d += (i === 0 && j === 0 ? "M" : "L") + (50 + p[0] * Math.cos(p[1])).toFixed(1) + " " + (50 + p[0] * Math.sin(p[1])).toFixed(1); });
    }
    return d + "Z";
  })();
  var BACK_SVG = '<svg viewBox="0 0 100 100" aria-hidden="true"><path d="' + GEAR + '" fill="#e9f6f4"/><circle cx="50" cy="50" r="31" fill="#0a2f45"/><circle cx="50" cy="50" r="31" fill="none" stroke="#27d3c3" stroke-width="2"/>' +
    '<text x="50" y="47" text-anchor="middle" font-family="Lilita One, Arial Rounded MT Bold, sans-serif" font-size="15" fill="#f5fbfa">FRC</text><text x="50" y="62" text-anchor="middle" font-family="Lilita One, Arial Rounded MT Bold, sans-serif" font-size="12" fill="#27d3c3">PACKS</text></svg>';

  /* A side-view FRC robot: swerve chassis, bumpers with the team number, and one of four mechanisms. */
  function robotSVG(num) {
    var hue = (num * 137) % 360, v = num % 4, red = num % 2 === 0;
    var bumper = red ? "#d8343f" : "#2f6fd6", bumperDk = red ? "#9c1f29" : "#1d4a99";
    var accent = "hsl(" + hue + " 70% 55%)", accentDk = "hsl(" + hue + " 60% 32%)", metal = "#c9d3da", K = "#0b161b";
    var s = "";
    if (v === 0) { // elevator + claw
      s += '<rect x="58" y="22" width="8" height="72" fill="' + metal + '" stroke="' + K + '" stroke-width="2"/><rect x="76" y="22" width="8" height="72" fill="' + metal + '" stroke="' + K + '" stroke-width="2"/>' +
        '<rect x="54" y="34" width="34" height="14" rx="2" fill="' + accent + '" stroke="' + K + '" stroke-width="2"/><path d="M88 36 L104 30 L106 36 L92 42 Z M88 46 L104 52 L106 46 L92 42 Z" fill="' + accentDk + '" stroke="' + K + '" stroke-width="2" stroke-linejoin="round"/>' +
        '<circle cx="110" cy="41" r="7" fill="#ffb238" stroke="' + K + '" stroke-width="2"/>';
    } else if (v === 1) { // pivot arm + roller intake
      s += '<path d="M54 86 L60 80 L118 30 L126 38 L66 90 Z" fill="' + accent + '" stroke="' + K + '" stroke-width="2" stroke-linejoin="round"/><circle cx="60" cy="86" r="7" fill="' + metal + '" stroke="' + K + '" stroke-width="2"/>' +
        '<circle cx="124" cy="32" r="9" fill="' + accentDk + '" stroke="' + K + '" stroke-width="2"/><circle cx="124" cy="32" r="3" fill="' + metal + '"/>';
    } else if (v === 2) { // shooter turret + game piece in flight
      s += '<rect x="44" y="52" width="40" height="34" rx="3" fill="' + accent + '" stroke="' + K + '" stroke-width="2"/><path d="M58 52 L96 26 L104 36 L70 60 Z" fill="' + accentDk + '" stroke="' + K + '" stroke-width="2" stroke-linejoin="round"/>' +
        '<circle cx="64" cy="69" r="7" fill="' + metal + '" stroke="' + K + '" stroke-width="2"/><circle cx="118" cy="20" r="7" fill="#ffb238" stroke="' + K + '" stroke-width="2"/><path d="M104 28 L96 33 M108 34 L100 38" stroke="#fff" stroke-width="2" stroke-linecap="round" opacity=".7"/>';
    } else { // climber hooks + front intake
      s += '<rect x="40" y="16" width="7" height="76" fill="' + metal + '" stroke="' + K + '" stroke-width="2"/><rect x="92" y="16" width="7" height="76" fill="' + metal + '" stroke="' + K + '" stroke-width="2"/>' +
        '<path d="M40 16 Q36 8 44 8 L50 12 M92 16 Q88 8 96 8 L102 12" fill="none" stroke="' + K + '" stroke-width="3" stroke-linecap="round"/><rect x="46" y="50" width="46" height="10" rx="2" fill="' + accent + '" stroke="' + K + '" stroke-width="2"/>' +
        '<path d="M140 78 L156 66 L160 72 L146 86 Z" fill="' + accentDk + '" stroke="' + K + '" stroke-width="2" stroke-linejoin="round"/>';
    }
    // chassis and electronics, swerve modules, bumpers with the number
    s += '<rect x="30" y="80" width="118" height="14" rx="2" fill="#3c4a52" stroke="' + K + '" stroke-width="2"/><rect x="100" y="64" width="34" height="16" rx="2" fill="#2a363c" stroke="' + K + '" stroke-width="2"/><circle cx="108" cy="72" r="2.5" fill="#5cff8a"/><circle cx="116" cy="72" r="2.5" fill="#ffb238"/>';
    s += '<rect x="34" y="104" width="16" height="16" rx="3" fill="#20292e" stroke="' + K + '" stroke-width="2"/><rect x="128" y="104" width="16" height="16" rx="3" fill="#20292e" stroke="' + K + '" stroke-width="2"/>';
    s += '<rect x="20" y="92" width="140" height="20" rx="7" fill="' + bumper + '" stroke="' + K + '" stroke-width="2.5"/><rect x="20" y="106" width="140" height="6" rx="3" fill="' + bumperDk + '"/>' +
      '<text x="90" y="107.5" text-anchor="middle" font-family="Lilita One, Arial Rounded MT Bold, sans-serif" font-size="15" fill="#fff" letter-spacing="1">' + num + '</text>';
    return s;
  }
  function artSVG(num, tier) {
    var full = tier === "legendary" || tier === "mythic", photo = BY_NUM[num] && BY_NUM[num].photo, s = '<svg viewBox="0 0 200 ' + (full ? 280 : 130) + '" preserveAspectRatio="xMidYMid slice" aria-hidden="true">';
    if (full) {
      var c = tier === "mythic" ? "#5cffe9" : "#d7b8ff", rays = "";
      for (var i = 0; i < 12; i++) { var a = i / 12 * Math.PI * 2; rays += '<path d="M100 110 L' + (100 + 260 * Math.cos(a)).toFixed(0) + ' ' + (110 + 260 * Math.sin(a)).toFixed(0) + ' L' + (100 + 260 * Math.cos(a + .18)).toFixed(0) + ' ' + (110 + 260 * Math.sin(a + .18)).toFixed(0) + 'Z" fill="' + c + '"/>'; }
      s += '<g opacity=".3">' + rays + '</g>';
      s += '<text x="100" y="128" text-anchor="middle" font-family="Lilita One, Arial Rounded MT Bold, sans-serif" font-size="78" fill="#fff" opacity=".1">' + num + '</text>';
      s += '<ellipse cx="100" cy="196" rx="118" ry="20" fill="rgba(0,0,0,.4)"/>';
      if (!photo) s += '<g transform="translate(-12 46) scale(1.24)">' + robotSVG(num) + '</g>';
    } else if (photo) {
      return photoHTML(num);
    } else {
      s += '<path d="M0 98 L200 98 L200 130 L0 130 Z" fill="rgba(0,0,0,.14)"/><path d="M0 104 L200 104 M0 116 L200 116" stroke="rgba(255,255,255,.35)" stroke-width="1.5"/>';
      s += '<g transform="translate(14 2) scale(.92)">' + robotSVG(num) + '</g>';
    }
    s += "</svg>";
    return s; // a Legendary or Mythic photo goes in its own frame under the header (see cardEl)
  }
  /* The whole team photo: they're all 4:3, like the window it sits in, so nothing is cropped. A blurred copy behind
     fills any gap. */
  function photoHTML(num) {
    var src = '/photos/' + num + '.webp';
    return '<span class="phw"><img class="ph-bg" alt="" draggable="false" decoding="async" src="' + src + '"><img class="ph" alt="" draggable="false" decoding="async" data-num="' + num + '" src="' + src + '"></span>';
  }
  /* Centers each photo on where its robot is (data/photos/focus.json, made by tools/photo_focus.py): the photo fills its
     window, and the part that gets cropped is the part least likely to be the robot. */
  var FOCUS = {};
  fetch("/photos/focus.json").then(function (r) { return r.ok ? r.json() : {}; }).then(function (f) { FOCUS = f || {}; document.querySelectorAll(".card img.ph[data-num]").forEach(centerPhoto); }).catch(function () {});
  function centerPhoto(img) {
    var f = FOCUS[img.dataset.num], w = img.naturalWidth, h = img.naturalHeight, box = img.parentElement.getBoundingClientRect();
    if (!f || !w || !box.width) return;
    var scale = Math.max(box.width / w, box.height / h), visW = box.width / (w * scale), visH = box.height / (h * scale);
    var pos = function (c, vis) { return vis >= 1 ? 50 : Math.min(100, Math.max(0, (c - vis / 2) / (1 - vis) * 100)); };
    img.style.objectPosition = pos(f[0], visW) + "% " + pos(f[1], visH) + "%";
  }
  document.addEventListener("load", function (e) { if (e.target.matches && e.target.matches(".card img.ph[data-num]")) centerPhoto(e.target); }, true);
  function nameScale(n) { var l = n.length; return l <= 20 ? 1 : l <= 25 ? .86 : l <= 30 ? .74 : .64; } // the name has its own line
  function btNameScale(n) { var l = n.length; return l <= 12 ? 1 : l <= 15 ? .85 : l <= 19 ? .7 : l <= 24 ? .58 : .5; } // shares its line with the ring
  /* Rarity star scale: one star per step up, in the tier's accent; the steps not reached are dimmed. */
  var STARS = { common: 1, uncommon: 2, rare: 3, legendary: 4, mythic: 5 };
  function starScale(tier) { var s = ""; for (var i = 0; i < 5; i++) s += i < STARS[tier] ? "★" : "<i>★</i>"; return s; }
  function attachTilt(slot) {
    var tilt = slot.querySelector(".tilt"), inner = slot.querySelector(".inner");
    slot.addEventListener("pointermove", function (e) {
      /* Hover tilt is for a mouse over cards in the lists. In the big card view you grab the card instead (below), and in the
         pack stack the swipe is the job. */
      if (slot.classList.contains("drag") || slot.closest("#modal") || (e.pointerType && e.pointerType !== "mouse")) return;
      var r = slot.getBoundingClientRect(), px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
      tilt.classList.remove("rest"); slot.classList.add("live");
      tilt.style.setProperty("--ry", ((px - .5) * 26) + "deg"); tilt.style.setProperty("--rx", ((.5 - py) * 22) + "deg");
      slot.style.setProperty("--sx", ((.5 - px) * r.width * .08).toFixed(1)); slot.style.setProperty("--sy", ((.5 - py) * r.height * .06).toFixed(1));
      inner.style.setProperty("--mx", (px * 100).toFixed(1)); inner.style.setProperty("--my", (py * 100).toFixed(1));
    });
    function leave() { slot.classList.remove("live"); slot.style.setProperty("--sx", 0); slot.style.setProperty("--sy", 0); tilt.classList.add("rest"); tilt.style.setProperty("--ry", "0deg"); tilt.style.setProperty("--rx", "0deg"); inner.style.setProperty("--mx", 50); inner.style.setProperty("--my", 50); }
    /* Grab and drag, in the big card view: the card turns the way your finger moves, eases off near the limit, and springs
       back when you let go. It only reacts to a drag that starts on the card. */
    var G = { held: false, rawX: 0, rawY: 0, rx: 0, ry: 0, vx: 0, vy: 0, lx: 0, ly: 0, lt: 0, id: null, raf: 0 }, MAXA = 20, GAIN = .3;
    function soft(v) { return MAXA * Math.tanh(v / MAXA); }
    function paintGrab() {
      var cx = Math.max(0, Math.min(100, 50 + G.ry / MAXA * 50)), cy = Math.max(0, Math.min(100, 50 - G.rx / MAXA * 50));
      tilt.style.setProperty("--ry", G.ry.toFixed(2) + "deg"); tilt.style.setProperty("--rx", G.rx.toFixed(2) + "deg");
      inner.style.setProperty("--mx", cx.toFixed(1)); inner.style.setProperty("--my", cy.toFixed(1));
    }
    function springBack() {
      cancelAnimationFrame(G.raf); var last = performance.now();
      (function step(t) {
        var dt = Math.min(.032, (t - last) / 1000); last = t;
        G.vx += (-170 * G.rx - 15 * G.vx) * dt; G.vy += (-170 * G.ry - 15 * G.vy) * dt; G.rx += G.vx * dt; G.ry += G.vy * dt; G.rawX = G.rx; G.rawY = G.ry; paintGrab();
        if (Math.abs(G.rx) + Math.abs(G.ry) + Math.abs(G.vx) + Math.abs(G.vy) > .06) G.raf = requestAnimationFrame(step);
        else { G.rx = G.ry = G.vx = G.vy = G.rawX = G.rawY = 0; tilt.classList.remove("grab"); leave(); }
      })(last);
    }
    slot.addEventListener("pointerdown", function (e) {
      if (!slot.closest("#modal") || (e.pointerType === "mouse" && e.button)) return;
      G.held = true; G.id = e.pointerId; G.lx = e.clientX; G.ly = e.clientY; G.lt = performance.now(); G.vx = G.vy = 0; cancelAnimationFrame(G.raf);
      tilt.classList.remove("rest"); tilt.classList.add("grab"); slot.classList.add("live");
      try { slot.setPointerCapture(e.pointerId); } catch (er) {}
    });
    slot.addEventListener("pointermove", function (e) {
      if (!G.held || e.pointerId !== G.id) return;
      var now = performance.now(), dx = e.clientX - G.lx, dy = e.clientY - G.ly; G.lx = e.clientX; G.ly = e.clientY;
      G.rawY += dx * GAIN; G.rawX -= dy * GAIN;
      var nry = soft(G.rawY), nrx = soft(G.rawX), dtm = Math.max(8, now - G.lt) / 1000; G.lt = now;
      G.vy = (nry - G.ry) / dtm; G.vx = (nrx - G.rx) / dtm; G.ry = nry; G.rx = nrx; paintGrab();
    });
    function letGo(e) { if (!G.held || (e && e.pointerId !== G.id)) return; G.held = false; springBack(); }
    slot.addEventListener("pointerup", letGo); slot.addEventListener("pointercancel", letGo); slot.addEventListener("lostpointercapture", letGo);
    var gentle = function () { if (!slot.closest("#modal")) leave(); };
    slot.addEventListener("pointerleave", gentle); slot.addEventListener("pointercancel", gentle); slot.addEventListener("pointerup", function (e) { if (e.pointerType && e.pointerType !== "mouse") gentle(); });
    slot.addEventListener("lostpointercapture", function (e) { if (e.pointerType && e.pointerType !== "mouse") gentle(); });
    slot.addEventListener("touchend", gentle); slot.addEventListener("touchcancel", gentle);
  }
  var EDGES = [-2, -1, 1, 2].map(function (z) { return '<i class="edge" style="--z:' + z + '"></i>'; }).join("") + '<i class="edge e0" style="--z:0"></i>';
  /* c = { num, tier, serial, isNew, copy } */
  function cardEl(c, opts) {
    opts = opts || {}; var t = BY_NUM[c.num], T = TIERS[c.tier];
    var slot = document.createElement("div");
    slot.className = "slot" + (opts.faceUp ? " flipped" : "") + (opts.button ? " btn" : "") + (opts.alive ? " alive" : "") + (opts.locked ? " locked" : "");
    slot.style.setProperty("--tc", T.color);
    if (myTeam() && c.num === myTeam()) slot.classList.add("mine");
    if (opts.button) { slot.setAttribute("role", "button"); slot.tabIndex = 0; }
    slot.setAttribute("aria-label", t.name + ", team " + t.num + ", " + T.label);
    // The battler card layout for every tier (design/battler/): the team's ring and name, the robot photo over a strip with
    // the number, division and location, and season; then the battler stats (AUTO / TELE / END, RP1-3, unique effect), or
    // the champs box for a team without them yet; the star scale and serial sit on the bottom of the frame.
    var epa = t.epa == null ? "–" : Math.round(t.epa * 10) / 10, snCls = (+c.serial > 0 && +c.serial <= 10 ? " low" : "") + (+c.serial === c.num ? " match" : "");
    var pic = t.photo ? photoHTML(t.num) : '<svg class="ph-fallback" viewBox="0 0 200 200" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><g transform="translate(6 38) scale(1.04)">' + robotSVG(t.num) + '</g></svg>';
    var bt = t.bt, stats = bt ?
      '<div class="statrow"><div class="stat"><small>AUTO</small><b>' + bt.auto + '</b></div><div class="stat"><small>TELE</small><b>' + bt.tele + '</b></div><div class="stat"><small>END</small><b>' + bt.end + '</b></div></div>' +
      '<div class="rprow">' + bt.rp.map(function (p, i) { return '<div class="rp"><i>RP' + (i + 1) + '</i><b>' + p + '%</b></div>'; }).join("") + '</div>' +
      '<div class="effect"><small>UNIQUE EFFECT</small>' + (bt.effect ? '<p>' + esc(bt.effect) + '</p>' : '<p class="tbd">Effect coming soon</p>') + '</div>' :
      '<div class="statrow"><div class="stat"><small>EPA</small><b>' + epa + '</b></div><div class="stat"><small>RECORD</small><b>' + esc(t.wl) + '</b></div><div class="stat"><small>RANK</small><b>#' + t.rank + '</b></div></div>' +
      '<div class="effect"><small>BATTLER STATS</small><p class="tbd">Coming soon</p></div>';
    slot.innerHTML =
      '<div class="shade"></div><div class="float"><div class="tilt rest"><div class="flip card" data-tier="' + c.tier + '">' + EDGES +
      '<div class="face back">' + BACK_SVG + '</div>' +
      '<div class="face front btf"><div class="inner v2 bt b2' + (bt ? '' : ' nobt') + '" style="--nl:' + btNameScale(t.name) + '">' +
      '<div class="head"><span class="avatar none">' + t.num + '</span><span class="tname">' + esc(t.name) + '</span></div>' +
      '<div class="fwrap"><div class="fphoto">' + pic + '</div>' +
        '<div class="idbar"><span class="num">#' + t.num + '</span><span class="loc">' + esc(t.div) + (t.loc ? ' · ' + esc(t.loc) : '') + '</span><span class="yr">2026</span></div></div>' +
      stats +
      '<div class="foil"></div><div class="spark"></div><div class="glare"></div></div>' +
      '<div class="ftb"><span class="rar" aria-label="' + STARS[c.tier] + ' of 5 stars">' + starScale(c.tier) + '</span><span class="sn' + snCls + '">No. ' + esc(c.serial || "------") + '</span></div>' +
      '</div></div></div></div></div>';
    if (opts.ribbon) { var r = document.createElement("div"); r.className = "ribbon" + (c.isNew ? "" : " dupe"); r.textContent = c.test ? "TEST" : c.isNew ? "NEW" : "COPY #" + c.copy; r.hidden = true; slot.appendChild(r); slot._ribbon = r; }
    if (opts.count > 1) { var b = document.createElement("div"); b.className = "count-badge"; b.textContent = "×" + opts.count; slot.appendChild(b); }
    attachTilt(slot);
    return slot;
  }

  /* ---------- packs ---------- */
  var TROPHY = '<svg viewBox="0 0 180 130" aria-hidden="true"><g stroke="#3a2600" stroke-width="2.5" stroke-linejoin="round">' +
    '<path d="M62 26 Q40 26 42 44 Q44 60 64 62 M118 26 Q140 26 138 44 Q136 60 116 62" fill="none" stroke-width="8"/>' +
    '<path d="M62 18 H118 V44 Q118 78 90 84 Q62 78 62 44 Z" fill="#ffd34d"/>' +
    '<rect x="82" y="84" width="16" height="14" fill="#e9b52f"/><rect x="66" y="98" width="48" height="14" rx="3" fill="#ffd34d"/><rect x="58" y="112" width="64" height="10" rx="3" fill="#e9b52f"/></g>' +
    '<path d="M62 26 Q40 26 42 44 Q44 60 64 62 M118 26 Q140 26 138 44 Q136 60 116 62" fill="none" stroke="#ffd34d" stroke-width="3"/>' +
    '<path d="M70 26 Q72 56 86 70" stroke="#fff" stroke-width="4" fill="none" stroke-linecap="round" opacity=".55"/>' +
    '<text x="90" y="56" text-anchor="middle" font-family="Lilita One, Arial Rounded MT Bold, sans-serif" font-size="20" fill="#3a2600">2026</text></svg>';
  var PACK_HUE = 222;
  /* Pack system: every pack (set) the binder tracks. Only the 2026 Championship pack exists so far;
     future packs add an entry here with their own team list and inventory. */
  var PACKS = [{ id: PACK_ID, name: RECIPE.name, where: RECIPE.where, teams: TEAMS }], curPack = PACKS[0];
  function packHTML(back) {
    var bo = S.openKind && !S.testMode && ODDS.boosted, OD = bo ? ODDS.boosted : ODDS, mult = bo ? ODDS.boosted.mythicMult : 1;
    var front = '<div class="pk-face pk-front"><div class="pk-top"></div><div class="pk-body"><div class="pk-cover">' +
      '<div class="pk-set">2026 Championship</div><div class="pk-logo">FRC<br>PACKS</div>' +
      '<div class="pk-hero"><div class="burst"></div>' + TROPHY + '</div>' +
      '<div class="pk-feat">Houston · 8 divisions</div></div></div></div>';
    var b = !back ? "" : '<div class="pk-face pk-back"><div class="pk-body"></div><div class="pk-info"><h3>2026 Championship</h3>' +
      '<div class="odds"><span>Common</span><b>' + pct(OD.slots.common) + '</b><span>Uncommon</span><b>' + pct(OD.slots.uncommon) + '</b><span>Rare</span><b>' + pct(OD.slots.rare) + '</b><span>Legendary</span><b>' + pct(OD.slots.legendary) + '</b><span>Mythic</span><b>1 in ' + Math.round(1 / ((S.demo ? ODDS.demoMythic : ODDS.mythicBase) * mult)) + (S.demo ? "*" : "") + '</b></div>' +
      '<small>Last card is Rare or better.' + (S.demo ? " *Demo luck is on." : "") + '</small></div></div>';
    var edges = [-3, -2, -1, 0, 1, 2, 3].map(function (z) { return '<i class="pk-edge" style="--z:' + z + '"></i>'; }).join("");
    return '<div class="pk" style="--h:' + PACK_HUE + '">' + edges + front + b + '</div>';
  }

  /* ---------- status bar, timer, claim ---------- */
  var packCount = $("#packCount"), timerEl = $("#timer"), claimBtn = $("#claim");
  function fmt(ms) { var s = Math.max(0, Math.ceil(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return h + ":" + String(m).padStart(2, "0") + ":" + String(x).padStart(2, "0"); }
  /* The admin sets the timer, how many packs each one gives (PER) and how many missed timers wait (BANK), so missing
     one overnight doesn't cost packs. */
  var BANK = 2, PER = 1;
  function banked(now) { return now < S.nextClaimAt ? 0 : Math.min(BANK, 1 + Math.floor((now - S.nextClaimAt) / CLAIM_MS)); }
  function packsWord(n) { return n === 1 ? "pack" : "packs"; }
  /* ---------- daily missions and the streak ---------- */
  var dailyDirty = true, dailyOpen = false;
  try { dailyOpen = localStorage.getItem("frcpacks.daily") === "1"; } catch (e) {}
  function paintDaily() {
    dailyDirty = false;
    var ms = S.missions || [], st = S.streak || { days: 0, today: false, alive: false, every: 7 };
    var done = ms.filter(function (m) { return m.claimed; }).length, ready = ms.filter(function (m) { return !m.claimed && m.progress >= m.goal; }).length;
    var flame = $("#streakFlame"); flame.classList.toggle("lit", st.today && st.days > 0); flame.classList.toggle("warm", !st.today && st.days > 0);
    var toGift = st.every - (st.days % st.every || (st.today ? st.every : 0));
    $("#streakTxt").textContent = st.days ? st.days + "-day streak" : "Start a streak";
    $("#dailySum").textContent = (ready ? ready + " to collect · " : "") + done + " of " + ms.length + " missions done" + (st.days && !st.today ? " · open a pack today to keep your streak" : "");
    $("#dailyDots").innerHTML = ms.map(function (m) { return '<i class="' + (m.claimed ? "done" : m.progress >= m.goal ? "ready" : "") + '"></i>'; }).join("");
    $("#dailyToggle").setAttribute("aria-expanded", String(dailyOpen)); $("#dailyBody").hidden = !dailyOpen;
    var chip = $("#streakChip"); if (chip) chip.innerHTML = "🔥 " + (st.days || 0) + (ready ? '<i class="rdot" aria-label="Mission ready"></i>' : "");
    var meB = $("#meBtn"); if (meB && ME) meB.innerHTML = avatar(ME);
    var list = $("#dailyList"); list.innerHTML = "";
    ms.forEach(function (m) {
      var el = document.createElement("div"), full = m.progress >= m.goal;
      el.className = "mission" + (m.claimed ? " claimed" : full ? " ready" : "");
      el.innerHTML = '<b>' + esc(m.label) + '</b><span class="mbar"><i style="width:' + (m.progress / m.goal * 100) + '%"></i></span>';
      var act = document.createElement(full && !m.claimed ? "button" : "span"); act.className = "act";
      if (m.claimed) act.innerHTML = '<span class="reward">✓ +' + m.reward + '</span>';
      else if (full) { act.type = "button"; act.className = "act cta small"; act.textContent = "Collect +" + m.reward; act.onclick = function () { collect(m, act); }; }
      else act.innerHTML = '<span class="reward">' + m.progress + "/" + m.goal + ' · +' + m.reward + '</span>';
      el.appendChild(act); list.appendChild(el);
    });
    var into = st.days % st.every || (st.days ? st.every : 0), week = "";
    for (var i = 1; i <= st.every; i++) week += '<i class="' + (i <= into ? "on" : i === st.every ? "gift" : "") + '"></i>';
    $("#streakNote").innerHTML = '<span class="streak-week" aria-hidden="true">' + week + '</span>' +
      (st.today ? "You've opened a pack today. " : st.days ? "Open a pack today to keep your streak. " : "Open a pack each day to build a streak. ") +
      (toGift === st.every && st.today ? "Boosted pack earned! Next one in " + st.every + " days." : "A boosted pack every " + st.every + " days in a row" + (st.days ? " · " + toGift + " to go." : ".")) +
      " Missions reset at midnight; parts go toward boosted packs in the binder.";
  }
  /* Top bar: streak (opens missions), the timer or Claim, and your profile. The old status card and the gear fold in here. */
  (function () {
    var tools = document.querySelector(".top .tools"), gearB = $("#gear"); if (!tools || !gearB) return;
    var sc = document.createElement("button"); sc.type = "button"; sc.className = "tchip"; sc.id = "streakChip"; sc.setAttribute("aria-label", "Streak and missions");
    var me = document.createElement("button"); me.type = "button"; me.id = "meBtn"; me.className = "mebtn"; me.setAttribute("aria-label", "Your profile");
    tools.insertBefore(sc, gearB); tools.insertBefore($("#timer"), gearB); tools.insertBefore($("#claim"), gearB); tools.insertBefore(me, gearB);
    gearB.classList.add("gear-hidden");
    sc.onclick = function (e) { e.stopPropagation(); var on = !document.body.classList.contains("daily-pop"); document.body.classList.toggle("daily-pop", on); if (on) { dailyOpen = true; paintDaily(); } };
    document.addEventListener("click", function (e) { if (document.body.classList.contains("daily-pop") && !e.target.closest("#daily") && !e.target.closest("#streakChip")) document.body.classList.remove("daily-pop"); });
    me.onclick = function () { openProfile(ME); };
  })();
  $("#dailyToggle").onclick = function () { dailyOpen = !dailyOpen; try { localStorage.setItem("frcpacks.daily", dailyOpen ? "1" : "0"); } catch (e) {} paintDaily(); };
  function collect(m, btn) {
    btn.disabled = true; actx();
    api.claimMission(m.id).then(function (st) {
      var r = btn.getBoundingClientRect(); applyState(st); paintDaily(); paintStatus(); sfx.claim();
      burst(r.left + r.width / 2, r.top + r.height / 2, 26, "#ffd34d", 6);
      say("+" + m.reward + " parts", 1800);
    }, function (e) { btn.disabled = false; offline(e); });
  }
  function paintStatus() {
    if (dailyDirty) paintDaily();
    var now = Date.now(); if (S.nextClaimAt > now + CLAIM_MS) S.nextClaimAt = now + CLAIM_MS;
    setText(packCount, S.packs);
    var n = banked(now), ready = n * PER, next = PER === 1 ? "another" : PER + " more";
    if (claimBtn.hidden !== !n) claimBtn.hidden = !n; setText(claimBtn, ready === 1 ? "Claim pack" : "Claim " + ready + " packs");
    /* The ring around the pack fills as the next pack gets closer. */
    var left = S.nextClaimAt + (n ? n * CLAIM_MS : 0) - now, full = n >= BANK;
    collectionEl.style.setProperty("--mp", (full ? 100 : Math.max(0, Math.min(100, (1 - left / CLAIM_MS) * 100))).toFixed(2) + "%");
    collectionEl.classList.toggle("ready", n > 0);
    var capT = n ? (ready === 1 ? "Pack ready" : ready + " packs ready") : "Next pack " + fmt(S.nextClaimAt - now);
    if (collectionEl.getAttribute("data-cap") !== capT) collectionEl.setAttribute("data-cap", capT);
    if (n >= BANK) setHTML(timerEl, "<b>Ready</b>");
    else if (n) setHTML(timerEl, "<b>" + fmt(S.nextClaimAt + n * CLAIM_MS - now) + "</b>");
    else setHTML(timerEl, "<b>" + fmt(S.nextClaimAt - now) + "</b>");
    paintMeter();
  }
  function paintMeter() {
    var n = S.pity.m, el = $("#meter");
    var w = (Math.min(n, HARD) / HARD * 100) + "%", bar = $("#meterBar"); if (bar.style.width !== w) bar.style.width = w;
    setText($("#meterTxt"), n + " / " + HARD);
    var mb = $("#mythicBar"); if (mb) { mb.querySelector("i").style.width = (Math.min(n, HARD) / HARD * 100) + "%"; setText(mb.querySelector("em"), n + " / " + HARD); mb.classList.toggle("hot", n >= SOFT); }
    var pc = $("#partsChip"); if (pc) setText(pc, "⚙ " + S.parts);
    if (el.classList.contains("hot") !== (n >= SOFT)) el.classList.toggle("hot", n >= SOFT);
    var tip = "Packs since your last Mythic. Odds climb after " + SOFT + " and one is guaranteed by pack " + HARD + "."; if (el.title !== tip) el.title = tip;
  }
  setInterval(function () { paintStatus(); if (state === "select" || state === "home") paintSelectHud(); }, 1000);
  var claiming = false;
  claimBtn.addEventListener("click", function () {
    if (claiming || !banked(Date.now())) return; actx(); claiming = true;
    api.claim().then(function (st) {
      applyState(st); paintStatus(); sfx.claim();
      var r = claimBtn.getBoundingClientRect(); burst(r.left + r.width / 2, r.top + r.height / 2, 18, "#27d3c3", 5);
      if (state === "select" || state === "home") paintSelectHud();
    }, function (e) { if (e && e.code === "not_ready") sync(); else offline(e); }).then(function () { claiming = false; });
  });

  /* ---------- open flow: select -> inspect -> cut -> stack -> summary ---------- */
  var hint = $("#hint"), sub = $("#sub"), ringwrap = $("#ringwrap"), ringEl = $("#ring"), homeView = $("#homeView"), collectionEl = $("#collection");
  var selectView = $("#selectView"), inspectView = $("#inspectView"), inspectEl = $("#inspect"), stackView = $("#stackView"), stackEl = $("#stack"), counterEl = $("#counter");
  var summaryEl = $("#summary"), inspectBtns = $("#inspectBtns"), sumBtns = $("#sumBtns"), againBtn = $("#again"), skipBtn = $("#skipBtn");
  var state = "home", chosen = -1, deck = [], idx = 0;
  /* The status bar ticks every second. Writing the same text again still makes the browser redo styles, so these
     only touch the page when something actually changed. */
  function setText(el, v) { v = String(v); if (el.textContent !== v) el.textContent = v; }
  function setHTML(el, v) { if (el._html !== v) { el._html = v; el.innerHTML = v; } }
  function setHud(h, s) { setText(hint, h); setText(sub, s); }
  function showOnly(which) {
    homeView.hidden = which !== "home"; selectView.hidden = which !== "select"; inspectView.hidden = which !== "inspect"; inspectBtns.hidden = which !== "inspect";
    stackView.hidden = which !== "stack"; counterEl.hidden = which !== "stack"; summaryEl.hidden = which !== "summary"; sumBtns.hidden = which !== "summary";
    document.body.classList.toggle("focus", which === "inspect");
    document.body.classList.toggle("playing", which === "inspect" || which === "stack");
    document.body.classList.remove("cutting"); skipBtn.hidden = which !== "stack";
    setTimeout(coach, 0);
  }
  /* ---------- first-run tips ---------- */
  /* A new player gets one short tip per step of their first pack, pointing at what to do. Skippable, shown once. */
  var TOUR = "frcpacks.tour", tourOn = false, coachEl = $("#coach"), coachAt = null;
  try { tourOn = localStorage.getItem(TOUR) !== "done"; } catch (e) {}
  var TIPS = {
    home: [function () { return collectionEl.querySelector(".ptype"); }, "Here's your first pack. " + TAP + " it to start opening."],
    select: [function () { return ringwrap; }, SWIPE + " to spin the wheel, then " + TAP.toLowerCase() + " the pack in front to take it."],
    inspect: [function () { return inspectEl; }, SWIPE + " across the top of the pack to tear it open. The glow tells you how good it is."],
    stack: [function () { return stackEl; }, TAP + " a shiny card to flip it. " + TAP + " or swipe to deal the next one."],
    summary: [function () { return tabBinder; }, "Every card lands in your Binder. Come back daily for free packs, missions and your streak!"]
  };
  var ORDER_TIPS = ["home", "select", "inspect", "stack", "summary"];
  function endTour() { tourOn = false; coachEl.hidden = true; try { localStorage.setItem(TOUR, "done"); } catch (e) {} setTimeout(function () { if (typeof betaWelcome === "function") betaWelcome(); }, 1200); }
  $("#coachSkip").onclick = endTour;
  function coach() {
    coachEl.hidden = true; return; // no tutorial tips: the app should speak for itself
    if (!tourOn) return;
    if (S.opened > 1 || (S.opened > 0 && state !== "summary" && state !== "stack" && state !== "dealing")) return endTour(); // not their first pack
    var tip = TIPS[state === "dealing" ? "stack" : state];
    if (!tip || !vOpen || vOpen.hidden || !modal.hidden) { coachEl.hidden = true; return; }
    var at = tip[0](); if (!at) { coachEl.hidden = true; return; }
    $("#coachTxt").textContent = tip[1];
    $("#coachStep").textContent = "Tip " + (ORDER_TIPS.indexOf(state === "dealing" ? "stack" : state) + 1) + " of " + ORDER_TIPS.length;
    coachAt = at; coachEl.hidden = false; placeCoach();
    if (state === "summary") setTimeout(function () { if (state === "summary") endTour(); }, 9000);
  }
  function placeCoach() {
    if (coachEl.hidden || !coachAt) return;
    var r = coachAt.getBoundingClientRect(), w = coachEl.offsetWidth, h = coachEl.offsetHeight;
    var below = r.bottom + h + 16 < innerHeight || r.top - h - 16 < 0;
    var x = Math.max(16, Math.min(innerWidth - w - 16, r.left + r.width / 2 - w / 2));
    var y = below ? Math.min(r.bottom + 12, innerHeight - h - 8) : r.top - h - 12;
    if (state === "inspect" || state === "stack" || state === "dealing" || state === "flipping") { y = Math.max(8, r.top - h - 12); below = false; } // keep the card clear
    coachEl.style.left = x + "px"; coachEl.style.top = Math.max(8, y) + "px";
    coachEl.classList.toggle("below", below); coachEl.classList.toggle("above", !below);
    coachEl.style.setProperty("--ax", Math.max(18, Math.min(w - 18, r.left + r.width / 2 - x)) + "px");
  }
  addEventListener("resize", placeCoach); addEventListener("scroll", placeCoach, true);
  /* Pack inventory: standard and boosted packs are separate stacks; S.openKind is the one being opened (true =
     boosted). */
  S.openKind = false;
  function kindCount(k) { return k ? S.boosted : Math.max(0, S.packs - S.boosted - S.mythic); }
  /* The admin's test pack: unlimited, rolled like a real one, and nothing about it is saved (no pack used, no serial
     number, nothing in the binder). S.testMode says that's the stack being opened. */
  S.testMode = false;
  function isAdmin() { return !!(S.account && S.account.admin); }
  function have() { return S.testMode ? 999 : S.openMythic ? S.mythic : kindCount(S.openKind); }
  function packsLeftHud(title, more) {
    if (S.packs > 0 || S.testMode) setHud(title, more);
    else { var left = S.nextClaimAt - Date.now(); setHud("Out of packs", left <= 0 ? "Claim your pack above" : fmt(left)); }
  }
  function paintSelectHud() {
    if (state === "home") packsLeftHud("Your packs", (S.packs === 1 ? "1 pack" : S.packs + " packs") + " to open · " + (S.boosted || S.mythic ? "pick a stack" : "tap to open"));
    else packsLeftHud(S.testMode ? "Choose a test pack" : S.openMythic ? "Choose a Mythic pack" : S.openKind ? "Choose a boosted pack" : "Choose a pack", SWIPE + " to spin · " + TAP.toLowerCase() + " one to take it");
    ringwrap.classList.toggle("out", have() < 1);
    ringwrap.classList.toggle("boosted", S.openKind && !S.testMode);
    ringwrap.classList.toggle("test", S.testMode);
    if (state === "home" && (homeKinds().length !== $("#kindRow").children.length || (homeKinds().length > 1 && homeKinds().indexOf(homeKind) < 0))) return paintHome();
    Array.prototype.forEach.call(collectionEl.querySelectorAll(".ptype"), function (tile) { paintTile(tile, PACKS[0]); });
    var kr = $("#kindRow"); if (kr && state === "home") homeKinds().forEach(function (k, i) { var c = kr.children[i]; if (!c) return; var n = k === "test" ? "∞" : kindCount(k === true); var em = c.querySelector("em"); if (em && em.textContent !== String(n)) em.textContent = n; c.classList.toggle("empty", k !== "test" && !n); });
    var inv = $("#packInv");
    if (inv) setHTML(inv, '<span><b>' + kindCount(false) + '</b> standard</span>' + (S.boosted ? '<span class="gold"><b>' + S.boosted + '</b> boosted</span>' : '') + (S.mythic ? '<span class="gold"><b>' + S.mythic + '</b> mythic</span>' : '') +
      '<span><b>' + S.parts + '</b> parts</span><span><b>' + Math.max(0, S.boostCost - S.parts) + '</b> to next boosted</span>');
  }
  /* ---------- home: your pack collection ---------- */
  function paintTile(b, pk) {
    if (b._test) { setText(b.querySelector(".cnt"), "∞"); setText(b.querySelector(".pt-sub"), "Admin · saves nothing"); b.setAttribute("aria-label", "Test " + pk.name + " pack, unlimited, nothing is saved"); return; }
    var boosted = b._boosted, n = b._mythic ? S.mythic : kindCount(boosted);
    if (b.classList.contains("empty") !== (n < 1)) b.classList.toggle("empty", n < 1); setText(b.querySelector(".cnt"), "×" + n);
    setText(b.querySelector(".pt-sub"), n ? (b._mythic ? "3 Mythics inside" : boosted ? "Better odds" : "Tap to open") : "None left");
    var al = (b._mythic ? "Mythic " : boosted ? "Boosted " : "") + pk.name + " pack, " + n + " to open"; if (b.getAttribute("aria-label") !== al) b.setAttribute("aria-label", al);
  }
  /* Home: one hero pack inside the Mythic-meter ring, and a row of every pack type you own under it. */
  var homeKind = null;
  function homeKinds() {
    var k = [false]; if (S.boosted > 0) k.push(true); if (S.mythic > 0) k.push("mythic"); if (isAdmin()) k.push("test"); return k;
  }
  function kindName(kind) { return kind === "mythic" ? "Mythic" : kind === "test" ? "Test" : kind === true ? "Boosted" : "Standard"; }
  function paintHome() {
    state = "home"; showOnly("home");
    var kinds = homeKinds();
    if (kinds.indexOf(homeKind) < 0) homeKind = kindCount(false) < 1 ? (S.boosted > 0 ? true : S.mythic > 0 ? "mythic" : false) : false;
    collectionEl.innerHTML = "";
    var kind = homeKind, pk = PACKS[0], test = kind === "test", boosted = kind === true, myth = kind === "mythic";
    var b = document.createElement("button"); b.type = "button"; b.className = "ptype" + (boosted || myth ? " boosted" : "") + (myth ? " mythic" : "") + (test ? " test" : ""); b.setAttribute("role", "listitem"); b._boosted = boosted || myth; b._mythic = myth; b._test = test;
    b.innerHTML = '<span class="cnt"></span>' + packHTML(false) + '<span class="pt-name">' + (test ? "Test " : myth ? "Mythic " : boosted ? "Boosted " : "") + esc(pk.name) + '</span><span class="pt-sub"></span>';
    paintTile(b, pk);
    b.addEventListener("click", function () { S.testMode = test; S.openKind = boosted || myth; S.openMythic = myth; openRing(b); });
    b.addEventListener("pointermove", function (e) {
      var r = b.getBoundingClientRect(), px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
      b.style.setProperty("--gx", ((px - .5) * 2).toFixed(3)); b.style.setProperty("--gy", ((py - .5) * 2).toFixed(3));
    });
    b.addEventListener("pointerleave", function () { b.style.removeProperty("--gx"); b.style.removeProperty("--gy"); });
    collectionEl.appendChild(b); collectionEl.classList.add("one");
    var row = $("#kindRow"); row.innerHTML = "";
    kinds.forEach(function (k) {
      var t = k === "test", g = k === true, m = k === "mythic", n = t ? "∞" : m ? S.mythic : kindCount(g);
      var c = document.createElement("button"); c.type = "button"; c.className = "kind" + (k === kind ? " on" : "") + (g || m ? " gold" : "") + (t ? " test" : "") + (t || n ? "" : " empty");
      c.setAttribute("role", "option"); c.setAttribute("aria-selected", String(k === kind)); c.setAttribute("aria-label", kindName(k) + " packs, " + n);
      c.innerHTML = '<i></i><em>' + n + '</em><span>' + kindName(k) + '</span>';
      c.onclick = function () { homeKind = k; S.testMode = t; S.openKind = g || m; S.openMythic = m; sfx.tick(); paintHome(); };
      row.appendChild(c);
    });
    row.hidden = kinds.length < 2;
    paintMeter(); paintSelectHud(); paintStatus();
  }
  function openRing(tile) {
    if (state !== "home") return; actx();
    if (have() < 1) { shake(false); say(S.packs ? "None of those left. Pick the other stack." : claimBtn.hidden ? "Out of packs. Next one in " + fmt(S.nextClaimAt - Date.now()) : "Claim your pack first", 2400); return; }
    sfx.pick();
    /* Straight to the pack in your hand; the wheel of 10 is a setting. */
    if (S.wheel === true) paintSelect(true); else { paintSelect(false); choose(Math.floor(SHELF_N / 2)); }
  }
  /* ---------- the wheel of 10 packs ---------- */
  var ringA = 0, ringFront = -1, ringRaf = 0, ringDragged = false;
  /* Runs every frame while the wheel turns, so it writes plain properties on as few elements as it can. A custom
     property set on the wheel or a pack is inherited by everything inside it, and restyling all ten packs each frame
     is what made spinning stutter on phones. */
  function setRing(a) {
    ringA = a; ringEl.style.transform = "translateZ(calc(var(--R) * -1)) rotateX(-7deg) rotateY(" + a + "deg)";
    var front = ((Math.round(-a / 36) % SHELF_N) + SHELF_N) % SHELF_N;
    Array.prototype.forEach.call(ringEl.children, function (el, i) {
      var th = (i * 36 + a) * Math.PI / 180, sheen = (100 + Math.sin(th) * 110).toFixed(1) + "%";
      el.style.opacity = (1 - (1 - Math.cos(th)) / 2 * .6).toFixed(3);
      if (!el._lit) el._lit = el.querySelectorAll(".pk-front .pk-top, .pk-front .pk-body");
      for (var j = 0; j < el._lit.length; j++) el._lit[j].style.backgroundPositionX = sheen + ", 0, 0";
      if (i === front !== el.classList.contains("front")) { el.classList.toggle("front", i === front); el.setAttribute("aria-selected", String(i === front)); }
    });
    if (front !== ringFront) { if (ringFront !== -1) { sfx.tick(); buzz(4); } ringFront = front; }
  }
  function spinTo(target, ms, done) {
    cancelAnimationFrame(ringRaf);
    if (RM || !ms) { setRing(target); if (done) done(); return; }
    var from = ringA, t0 = performance.now();
    (function step(now) {
      var t = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - t, 3);
      setRing(from + (target - from) * e);
      if (t < 1) ringRaf = requestAnimationFrame(step); else if (done) done();
    })(t0);
  }
  function snap() { spinTo(Math.round(ringA / 36) * 36, 380); }
  function paintSelect(spinIn, toIdx) {
    state = "select"; showOnly("select");
    if (!ringEl.children.length) {
      for (var i = 0; i < SHELF_N; i++) (function (i) {
        var b = document.createElement("button"); b.type = "button"; b.className = "pick"; b.setAttribute("role", "option"); b.tabIndex = -1;
        b.style.setProperty("--i", i);
        b.setAttribute("aria-label", "2026 Championship pack " + (i + 1) + " of " + SHELF_N);
        b.innerHTML = packHTML(false);
        b.addEventListener("click", function () { if (ringDragged) return; choose(i); });
        ringEl.appendChild(b);
      })(i);
    }
    var target = -36 * (toIdx == null ? Math.floor(SHELF_N / 2) : toIdx);
    ringFront = -1;
    /* Packs shuffle around the wheel on the way in, then settle with one in front. */
    if (spinIn && !RM) { setRing(target + 540); spinTo(target, 1100); } else setRing(target);
    paintSelectHud(); paintStatus();
  }
  var rg = null;
  ringwrap.addEventListener("pointerdown", function (e) {
    if (state !== "select") return; cancelAnimationFrame(ringRaf); ringDragged = false;
    rg = { x: e.clientX, a: ringA, t: performance.now(), v: 0, lx: e.clientX, id: e.pointerId, cap: false };
  });
  ringwrap.addEventListener("pointermove", function (e) {
    if (!rg) return; var dx = e.clientX - rg.x;
    if (!rg.cap && Math.abs(dx) > 6) { rg.cap = true; ringDragged = true; ringwrap.classList.add("drag"); try { ringwrap.setPointerCapture(rg.id); } catch (er) {} }
    if (!rg.cap) return;
    var now = performance.now(), dt = Math.max(1, now - rg.t); rg.v = (e.clientX - rg.lx) * .32 / dt; rg.lx = e.clientX; rg.t = now;
    setRing(rg.a + dx * .32);
  });
  function ringUp() {
    if (!rg) return; var was = rg; rg = null; ringwrap.classList.remove("drag");
    if (!was.cap) return;
    setTimeout(function () { ringDragged = false; }, 0);
    /* Let it coast with the flick's speed, then click into place on the nearest pack. */
    var v = Math.max(-2.5, Math.min(2.5, was.v)); if (RM) return snap();
    var last = performance.now();
    (function coast(now) {
      var dt = now - last; last = now; v *= Math.pow(.94, dt / 16); setRing(ringA + v * dt);
      if (Math.abs(v) > .05) ringRaf = requestAnimationFrame(coast); else snap();
    })(last);
  }
  ringwrap.addEventListener("pointerup", ringUp); ringwrap.addEventListener("pointercancel", ringUp);
  ringwrap.addEventListener("keydown", function (e) {
    if (state !== "select") return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); spinTo(Math.round(ringA / 36) * 36 + (e.key === "ArrowLeft" ? -36 : 36), 260); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(ringFront < 0 ? Math.floor(SHELF_N / 2) : ringFront); }
  });
  $("#ringBack").addEventListener("click", function () { if (state === "select") { cancelAnimationFrame(ringRaf); paintHome(); } });

  var rotY = 0, rotX = 0, g = null;
  function choose(i) {
    if (state !== "select") return; actx();
    if (have() < 1) { shake(false); say(S.packs ? "None of those left." : claimBtn.hidden ? "Out of packs. Next one in " + fmt(S.nextClaimAt - Date.now()) : "Claim your pack first", 2400); return; }
    chosen = i; state = "inspect"; sfx.pick();
    inspectEl.className = "inspect" + (S.openKind && !S.testMode ? " boosted" : ""); rotY = 0; rotX = 0;
    /* The pack's contents are fixed as soon as you pick it up (and stay fixed if you put it back), so the glow while you swipe tells the truth. */
    promoted = false; nextBest = "common"; openReq = null; inspectEl.style.setProperty("--tp", 0);
    holdPack();
    cancelAnimationFrame(ringRaf);
    var fromR = ringEl.children[i] && ringEl.children[i].getBoundingClientRect();
    inspectEl.innerHTML = '<div class="tell"></div><div class="lift"><div class="rot" id="rot">' + packHTML(true) + '</div></div><div class="cuthint"><span>' + SWIPE + ' to open</span></div><div class="cutline" id="cutline"></div>';
    showOnly("inspect");
    if (fromR && fromR.width) flyFrom(inspectEl.querySelector(".lift"), fromR, 460);
    setHud(SWIPE + " across the top to open", "Drag the pack to turn it over");
    try { $("#openBtn").focus({ preventScroll: true }); } catch (e) {}
  }
  /* FLIP helper: animate el from where `from` (a rect) was to where it sits now. */
  function flyFrom(el, from, ms, delay, mid) {
    if (RM || !el.animate) return null;
    var to = el.getBoundingClientRect(); if (!to.width) return null;
    el.style.animation = "none";
    var dx = (from.left + from.width / 2) - (to.left + to.width / 2), dy = (from.top + from.height / 2) - (to.top + to.height / 2), sc = from.width / to.width;
    var frames = [{ transform: "translate(" + dx + "px," + dy + "px) scale(" + sc + ")" }];
    if (mid) frames.push(mid(dx, dy, sc));
    frames.push({ transform: "none" });
    return el.animate(frames, { duration: ms, delay: delay || 0, easing: "cubic-bezier(.22,.9,.28,1)", fill: "backwards" });
  }
  var promoted = false, nextBest = "common", openReq = null, holdN = 0;
  /* Picking up a pack asks the server to decide its cards (they stay fixed if you put it back). Only the best
     rarity comes back, so the glow while you swipe tells the truth without revealing the cards. */
  var testHand = null;
  function holdPack() {
    var n = ++holdN;
    inspectEl.style.setProperty("--tell", TIERS.common.color);
    if (S.testMode) { // a throwaway pack: rolled now, kept only in this page, gone when opened
      testHand = null;
      api.admin.testPack(PACK_ID, false).then(function (r) {
        if (n !== holdN || state !== "inspect") return;
        testHand = r.cards; var best = r.cards[r.cards.length - 1].tier;
        nextBest = best; inspectEl.style.setProperty("--tell", TIERS[best === "mythic" ? "legendary" : best].color);
      }, offline);
      return;
    }
    api.hand(PACK_ID, S.openKind, S.openMythic).then(function (r) {
      if (n !== holdN || state !== "inspect") return;
      nextBest = r.best; inspectEl.style.setProperty("--tell", TIERS[r.best === "mythic" ? "legendary" : r.best].color);
      inspectEl.classList.toggle("boosted", !!r.boosted);
    }, function (e) { if (n === holdN && state === "inspect" && e && e.code === "no_packs") { paintHome(); say("Out of packs", 2000); sync(true); } });
  }
  /* Like opening a loot pack: the light leaking out of the tear gets brighter the further you swipe, in the best card's color. A Mythic starts gold and flips to rainbow past halfway. */
  function glow(t) {
    inspectEl.style.setProperty("--tp", t.toFixed(3));
    if (nextBest === "mythic" && t > .55 && !promoted) { promoted = true; inspectEl.classList.add("rainbow"); sfx.promote(); }
  }
  function facingFront() { var d = ((rotY % 360) + 360) % 360; return Math.min(d, 360 - d) < 35; }
  function setRot(live) {
    var r = $("#rot"); if (!r) return;
    r.classList.toggle("live", !!live); r.style.setProperty("--ry", rotY + "deg"); r.style.setProperty("--rx", rotX + "deg");
    r.classList.remove("idle"); r.style.setProperty("--sheen", (100 - Math.sin(rotY * Math.PI / 180) * 90).toFixed(1) + "%");
    var away = !facingFront(); inspectEl.classList.toggle("away", away);
    if (!live && state === "inspect") setHud(away ? "Pack odds" : SWIPE + " across the top to open", away ? "Turn it back over to open it" : "Drag the pack to turn it over");
  }
  inspectEl.addEventListener("pointerdown", function (e) {
    if (state !== "inspect") return;
    var r = inspectEl.getBoundingClientRect(), y = (e.clientY - r.top) / r.height;
    g = { x: e.clientX, y: e.clientY, ry: rotY, cut: facingFront() && y < .26, w: r.width, left: r.left, moved: false };
    try { inspectEl.setPointerCapture(e.pointerId); } catch (er) {}
  });
  inspectEl.addEventListener("pointermove", function (e) {
    if (!g || state !== "inspect") return;
    var dx = e.clientX - g.x, dy = e.clientY - g.y; if (Math.abs(dx) + Math.abs(dy) > 6) g.moved = true;
    if (g.cut) {
      var p = Math.max(0, Math.min(1, (e.clientX - g.left) / g.w)), from = Math.max(0, Math.min(1, (g.x - g.left) / g.w));
      var line = $("#cutline"); line.style.left = (Math.min(from, p) * 100) + "%"; line.style.width = (Math.abs(p - from) * 100) + "%";
      inspectEl.classList.add("swiping"); glow(Math.min(1, Math.abs(p - from) / .6));
      if (Math.abs(p - from) > .45) startOpen(); // ask the server early so the cards are ready when the tear finishes
      if (Math.abs(p - from) > .6) { g = null; cut(); }
    } else { rotY = g.ry + dx * .7; rotX = Math.max(-18, Math.min(18, -dy * .15)); setRot(true); }
  });
  function endGesture() {
    if (!g) return; var was = g; g = null;
    if (was.cut) { inspectEl.classList.remove("swiping"); var line = $("#cutline"); if (line) line.style.width = "0"; if (!promoted) glow(0); return; }
    if (!was.moved) rotY += 180; // a tap turns the pack over
    rotY = Math.round(rotY / 180) * 180; rotX = 0; setRot(false);
    sfx.whoosh();
  }
  inspectEl.addEventListener("pointerup", endGesture); inspectEl.addEventListener("pointercancel", endGesture);
  function back() {
    if (state !== "inspect") return;
    if (openReq) { cut(); return; } // already torn far enough to open; finish it
    if (S.wheel !== true) { paintHome(); return; }
    paintSelect(false, chosen);
    try { ringwrap.focus({ preventScroll: true }); } catch (e) {}
  }
  $("#turnBtn").addEventListener("click", function () { if (state !== "inspect") return; rotY += 180; setRot(false); sfx.whoosh(); });
  $("#openBtn").addEventListener("click", function () { if (state !== "inspect") return; var turned = !facingFront(); rotY = Math.round(rotY / 360) * 360; setRot(false); if (turned) setTimeout(cut, 350); else cut(); });
  $("#backBtn").addEventListener("click", back);

  /* Opens the pack on the server, once, even if the swipe and the button both ask. */
  function startOpen() {
    if (!openReq) {
      if (S.testMode) {
        var cards = testHand || [];
        openReq = cards.length === 5 ? Promise.resolve({
          opening: { id: 0, pack: PACK_ID, revealed: 0, sets: [], cards: cards.map(function (c) { return { num: c.num, tier: c.tier, serial: "TEST", isNew: false, copy: 0, inGame: 0, test: true }; }) },
          state: null, streakReward: false }) : Promise.reject(new Error("test pack not ready"));
        testHand = null;
      } else openReq = api.open(PACK_ID, S.openKind, S.openMythic);
      openReq.catch(function () {});
    }
    return openReq;
  }
  function cut() {
    if (state !== "inspect") return; state = "cutting";
    startOpen().then(function (res) {
      openReq = null;
      var o = res.opening;
      o.sets.forEach(function (d) { S.sets[d] = 1; });
      var was = S.streak || { days: 0, today: false };
      if (res.state) applyState(res.state); save();
      S.pending = pendingFrom(o);
      if (res.streakReward) setTimeout(function () { sfx.promote(); say(S.streak.days + "-day streak! A boosted pack is yours", 4000); }, 2600);
      else if (!was.today && S.streak && S.streak.today && S.streak.days > 1) setTimeout(function () { say(S.streak.days + "-day streak! Keep it going tomorrow", 3000); }, 2600);
      if (!S.pending) return lostPack(); // a card this page doesn't know (an older tab after an update)
      photosReady(S.pending.cards.map(function (c) { return c.num; }), 450).then(function () { if (state === "cutting") ripOpen(); });
    }, function (e) {
      openReq = null;
      if (e && e.code === "no_packs") { paintHome(); say("Out of packs", 2000); sync(true); return; }
      /* The server may have opened it and only the answer got lost: pick that pack up instead of opening another. */
      api.state().then(function (st) {
        var p = pendingFrom(st.pending);
        if (state === "cutting" && p) { applyState(st); S.pending = p; ripOpen(p.revealed); return; }
        retry();
      }, retry);
      function retry() {
        if (state !== "cutting") return;
        state = "inspect"; inspectEl.classList.remove("swiping"); glow(0);
        var line = $("#cutline"); if (line) line.style.width = "0";
        offline(e);
      }
    });
  }
  /* Something about the opened pack doesn't fit this page: reload to show it properly. */
  function lostPack() { state = "home"; say("Your pack opened. Reloading to show it…", 2400); setTimeout(function () { location.reload(); }, 1200); }
  /* A card joins the binder when it's dealt, so switching to the binder mid-reveal doesn't spoil what's coming. */
  function stash(c) {
    if (c._in || c.test) return; c._in = 1;
    var have = S.inv[c.num] || (S.inv[c.num] = []); if (have.indexOf(String(c.serial)) < 0) have.push(String(c.serial));
    if (c.isNew) S.unseen[c.num] = 1;
  }
  /* After loading the collection mid-reveal: cards not dealt yet come out of the binder until they are. */
  function hidePending() {
    if (!S.pending) return;
    S.pending.cards.forEach(function (c, i) {
      if (i < (S.pending.revealed || 0)) { c._in = 1; return; }
      var have = S.inv[c.num]; if (!have) return;
      var at = have.indexOf(String(c.serial)); if (at >= 0) have.splice(at, 1);
      if (!have.length) delete S.inv[c.num];
    });
  }
  function ripOpen(from) {
    /* The tear glows in the color of the best card inside. A Mythic shows gold first, then turns rainbow. */
    var best = S.pending.cards[4].tier, big = best === "legendary" || best === "mythic", promo = best === "mythic";
    paintStatus(); sfx.rip(best); shake(false); document.body.classList.add("cutting");
    nextBest = best; glow(1); inspectEl.classList.add("told");
    var r = inspectEl.getBoundingClientRect(); burst(r.left + r.width / 2, r.top + r.height * .12, big ? 60 : 40, promo ? null : TIERS[best].color, 7, promo);
    ripFx(r, promo ? "#ffd34d" : TIERS[best].color, promo, big);
    setHud("", "");
    if (from) hidePending();
    buildStack(from || 0, r);
  }
  /* fromPack = the torn pack's rect: the real cards rise out of it, fanned, and settle into the stack while the empty pack drops away. */
  function buildStack(from, fromPack) {
    deck = S.pending.cards; idx = from; stackEl.innerHTML = ""; summaryEl.innerHTML = "";
    for (var i = deck.length - 1; i >= from; i--) {
      var c = deck[i], hidden = c.tier !== "common" && c.tier !== "uncommon";
      var el = cardEl(c, { faceUp: !hidden, ribbon: true });
      if (hidden) el.classList.add("tease");
      if (c.tier === "mythic") { el.style.setProperty("--tc", TIERS.legendary.color); el._promo = true; }
      el._c = c; el._hidden = hidden;
      stackEl.appendChild(el);
    }
    showOnly("stack");
    stackEl.classList.remove("rise"); void stackEl.offsetWidth;
    paintCounter(); sfx.whoosh();
    var flight = fromPack && !RM && dealFromPack(fromPack, function () { if (state !== "dealing") return; state = "stack"; armTop(); });
    if (flight) state = "dealing";
    else { stackEl.classList.add("rise"); state = "stack"; armTop(); }
    try { stackEl.focus({ preventScroll: true }); } catch (e) {}
  }
  /* Calls done when the cards have landed. Returns false when there's nothing to animate. */
  function dealFromPack(pr, done) {
    /* The empty pack: a copy of the torn pack, drawn on top so the cards come up out of its open top. */
    var gp = document.createElement("div"); gp.className = "ghostpack inspect told" + (inspectEl.classList.contains("boosted") ? " boosted" : ""); gp.setAttribute("aria-hidden", "true");
    gp.style.cssText = "left:" + pr.left + "px;top:" + pr.top + "px;width:" + pr.width + "px;min-width:0;--tp:1;--tell:" + inspectEl.style.getPropertyValue("--tell");
    gp.innerHTML = '<div class="lift" style="animation:none"><div class="rot">' + packHTML(false) + '</div></div>';
    document.body.appendChild(gp);
    /* Start inside the pack (same width as the pack, sunk below its top), rise above it, then glide down into place. */
    var start = { left: pr.left + pr.width * .08, top: pr.top + pr.height * .2, width: pr.width * .84, height: pr.width * .84 * 1.4 };
    var all = stackEl.children, n = all.length;
    for (var i = 0; i < n; i++) all[i].style.setProperty("--k", n - 1 - i);
    stackEl.classList.add("fan");
    var anim = flyFrom(stackEl, start, 720, 0, function (dx, dy, sc) { return { offset: .42, transform: "translate(" + (dx * .5) + "px," + (dy - pr.height * .42) + "px) scale(" + ((sc + 1) / 2) + ")" }; });
    if (!anim) { gp.remove(); stackEl.classList.remove("fan"); return false; }
    /* The first frame with five new cards on screen takes the browser a while to draw (100ms+ on a laptop). The
       animation's clock would keep running through it and the cards would skip the rise out of the pack, so they
       wait, hidden inside the pack, until frames are coming smoothly again, then go. */
    anim.pause();
    var last = performance.now(), t0 = last, slow = false;
    requestAnimationFrame(function wait(now) {
      var smooth = now - last < 30; last = now; if (!smooth) slow = true;
      if (now - t0 < 600 && !(smooth && (slow || now - t0 > 150))) return requestAnimationFrame(wait);
      gp.classList.add("drop"); anim.play();
      setTimeout(function () { stackEl.classList.remove("fan"); }, 380);
      setTimeout(function () { gp.remove(); }, 900);
      setTimeout(done, 720);
    });
    return true;
  }
  function paintCounter() { counterEl.innerHTML = deck.map(function (c, i) { return '<i class="' + (i < idx ? "done" : i === idx ? "now" : "") + '"></i>'; }).join(""); }
  function topEl() { var c = stackEl.children; for (var i = c.length - 1; i >= 0; i--) if (!c[i].classList.contains("gone")) return c[i]; return null; }
  function armTop() {
    var el = topEl(); if (!el) return;
    /* Cards still flying off don't count, or the new top card keeps a leftover offset and angle. */
    var all = Array.prototype.filter.call(stackEl.children, function (c) { return !c.classList.contains("gone"); });
    for (var i = 0; i < all.length; i++) { all[i].style.setProperty("--k", all.length - 1 - i); all[i].classList.toggle("top", all[i] === el); }
    var c = el._c;
    if (el._hidden) {
      el.classList.add("peek");
      setHud("Something shiny…", TAP + " to flip it");
      if (!el._teased) { el._teased = true; sfx.tease(c.tier); }
      if (el._promo) setTimeout(function () { if (!el._promo || !el._hidden || el !== topEl()) return; promoteCard(el); setHud("Something very shiny…", TAP + " to flip it"); }, RM ? 0 : 900);
    }
    else { showRibbon(el); setHud(c.isNew ? "New card" : TIERS[c.tier].label, NEXT); if (isMine(c)) celebrateMine(el); }
  }
  function promoteCard(el) { el._promo = false; el.style.setProperty("--tc", TIERS.mythic.color); sfx.promote(); var r = el.getBoundingClientRect(); burst(r.left + r.width / 2, r.top + r.height / 2, 40, null, 7, true); }
  function isMine(c) { return myTeam() && c.num === myTeam(); }
  function celebrateMine(el) {
    if (el._cheered) return; el._cheered = true; sfx.mine();
    var r = el.getBoundingClientRect(); burst(r.left + r.width / 2, r.top + r.height / 2, 50, "#ffd34d", 8);
    say("Your team! " + BY_NUM[el._c.num].name + " (" + el._c.num + ")", 3000);
  }
  var NEXT = MOUSE ? "Click or press → for the next card" : "Swipe or tap for the next card";
  function showRibbon(el) { if (el._ribbon) el._ribbon.hidden = false; }
  function reveal(el) {
    if (el._c.tier !== "mythic" || RM) return doReveal(el);
    /* A Mythic gets a moment of its own: the room goes dark, the card shakes and leaks rainbow light, two heartbeats,
       then it flips. A tap skips ahead. */
    state = "flipping"; if (el._promo) promoteCard(el);
    document.body.classList.add("mythic-dark"); el.classList.add("charging"); sfx.heartbeat();
    setHud("…", "");
    el._skip = function () {
      if (el._charged) return; el._charged = true; el._skip = null; el.classList.remove("charging");
      if (state === "flipping") doReveal(el);
    };
    setTimeout(function () { if (el._skip) sfx.riser(); }, 1000);
    setTimeout(function () { if (el._skip) el._skip(); }, 1500);
  }
  function doReveal(el) {
    var c = el._c, T = TIERS[c.tier], t = BY_NUM[c.num];
    el._promo = false; el.style.setProperty("--tc", T.color);
    el._hidden = false; el.classList.add("flipped"); el.classList.remove("tease"); sfx.flip(c.tier); state = "flipping";
    setTimeout(function () {
      if (state === "summary") return; // skipped ahead
      showRibbon(el);
      var r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
      if (c.tier === "rare") { burst(x, y, T.parts, T.color, T.pow); shake(false); }
      else if (c.tier === "legendary") { burst(x, y, T.parts, T.color, T.pow); burst(x, y, 60, null, 9, true); shake(true); flash(); takeover("rgba(190,140,255,.16)"); say("LEGENDARY · " + t.name + " (" + t.num + ")", 3000); }
      else if (c.tier === "mythic") mythicMoment(el, c, t, x, y);
      setHud(T.label + (c.isNew ? " · new" : ""), NEXT);
      if (isMine(c)) setTimeout(function () { celebrateMine(el); }, c.tier === "mythic" || c.tier === "legendary" ? 1600 : 200);
    }, 380);
    setTimeout(function () { if (state === "flipping") state = "stack"; }, RM ? 400 : 850);
  }
  /* The flip of a Mythic: white flash, rainbow shockwaves, MYTHIC stamped in gold over the card, star bursts, and a
     rainbow aura that stays until you move on. The serial number says how many were ever pulled before it. */
  function ordinal(n) { var s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
  function mythicMoment(el, c, t, x, y) {
    document.body.classList.remove("mythic-dark"); document.body.classList.add("mythic-aura");
    takeover("rgba(255,225,120,.2)"); flash(); shake(true); sfx.mythic();
    (document.body.classList.contains("perf") ? [0] : [0, 180, 420]).forEach(function (d, i) {
      setTimeout(function () { var r = document.createElement("i"); r.className = "mring" + (i === 1 ? " gold" : ""); r.style.left = x + "px"; r.style.top = y + "px"; document.body.appendChild(r); setTimeout(function () { r.remove(); }, 1300); }, d);
    });
    var title = document.createElement("div"); title.className = "mtitle"; title.setAttribute("aria-hidden", "true"); title.style.setProperty("--ty", (y - el.getBoundingClientRect().height * .12) + "px");
    title.innerHTML = "MYTHIC".split("").map(function (ch, i) { return '<span style="--i:' + i + '">' + ch + '</span>'; }).join("");
    document.body.appendChild(title); setTimeout(function () { title.remove(); }, 2900);
    /* The team's name and number arrive under the title, with shockwaves rolling across the whole screen and a buzz on phones. */
    var nameEl = document.createElement("div"); nameEl.className = "mname"; nameEl.setAttribute("aria-hidden", "true");
    nameEl.style.setProperty("--ny", (y + el.getBoundingClientRect().height * .46) + "px");
    nameEl.innerHTML = '<b>' + esc(t.name) + '</b><span>Team ' + t.num + '</span>';
    document.body.appendChild(nameEl); setTimeout(function () { nameEl.remove(); }, 3400);
    (document.body.classList.contains("perf") ? [0] : [0, 350, 800]).forEach(function (d) { setTimeout(function () { var w = document.createElement("i"); w.className = "mshock"; w.style.left = x + "px"; w.style.top = y + "px"; document.body.appendChild(w); setTimeout(function () { w.remove(); }, 1500); }, d); });
    try { if (navigator.vibrate) navigator.vibrate([60, 40, 120, 60, 260]); } catch (e) {}
    burst(x, y, 90, null, 15, true);
    setTimeout(function () { burst(x - 70, y - 50, 50, "#ffd34d", 11); burst(x + 70, y - 50, 50, "#ffd34d", 11); }, 300);
    setTimeout(function () { burst(x, y - 90, 90, null, 13, true); }, 750);
    setTimeout(function () { burst(x, y, 40, "#fff6c2", 9); }, 1250);
    var n = c.inGame;
    say("MYTHIC · " + t.name + " (" + t.num + ") · " + (c.test ? "a test pull, nothing saved" : n === 1 ? "the only one in the game" : n > 1 ? "one of only " + n + " in the game" : "No. " + c.serial), 6000);
  }
  function endMythic() { document.body.classList.remove("mythic-dark", "mythic-aura"); }
  function takeover(ray) { document.documentElement.style.setProperty("--ray", ray); document.body.classList.add("takeover"); }
  function fling(el, dir) {
    if (state !== "stack" || el !== topEl()) return;
    state = "flinging"; sfx.whoosh();
    el.classList.remove("drag"); el.classList.add("gone");
    el.style.transform = "translate(" + (dir * 130) + "vw, -10vh) rotate(" + (dir * 30) + "deg)";
    document.body.classList.remove("takeover"); endMythic();
    stash(deck[idx]); save();
    idx++; S.pending.revealed = idx; if (S.pending.id) api.progress(S.pending.id, idx).catch(function () {}); paintCounter();
    // The next card is live straight away, so cards can be thrown one after another.
    if (idx < deck.length) { state = "stack"; armTop(); }
    setTimeout(function () {
      el.remove();
      if (idx >= deck.length) summary(); else if (state === "stack") armTop();
    }, RM ? 60 : 380);
  }
  function tapTop() {
    var el = topEl(); if (!el) return;
    if (state === "flipping" && el._skip) return el._skip(); // tap through a Mythic's build-up
    if (state !== "stack") return;
    if (el._hidden) reveal(el); else fling(el, 1);
  }
  var sg = null;
  stackEl.tabIndex = 0; stackEl.setAttribute("role", "button"); stackEl.setAttribute("aria-label", "Card stack. Enter flips or deals the next card.");
  stackEl.addEventListener("pointerdown", function (e) {
    var el = topEl(); if (!el || state !== "stack") return; actx();
    sg = { x: e.clientX, y: e.clientY, el: el, moved: false };
    try { stackEl.setPointerCapture(e.pointerId); } catch (er) {}
  });
  stackEl.addEventListener("pointermove", function (e) {
    if (!sg || state !== "stack") return;
    var dx = e.clientX - sg.x, dy = e.clientY - sg.y;
    if (!sg.moved && Math.abs(dx) + Math.abs(dy) < 8) return;
    sg.moved = true;
    if (sg.el._hidden) dx *= .25; // face-down cards resist; tap to flip them
    sg.el.classList.add("drag"); sg.el.style.transform = "translate(" + dx + "px," + (dy * .3) + "px) rotate(" + (dx * .06) + "deg)";
  });
  stackEl.addEventListener("pointerup", function (e) {
    if (!sg) return; var s = sg; sg = null;
    if (!s.moved) { tapTop(); return; }
    var dx = e.clientX - s.x;
    if (!s.el._hidden && Math.abs(dx) > 70) fling(s.el, dx > 0 ? 1 : -1);
    else { s.el.classList.remove("drag"); s.el.style.transform = ""; if (s.el._hidden) say(TAP + " to flip it", 1400); }
  });
  stackEl.addEventListener("pointercancel", function () { if (sg) { sg.el.classList.remove("drag"); sg.el.style.transform = ""; sg = null; } });
  stackEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); tapTop(); }
    else if (e.key === "ArrowRight" || e.key === "ArrowLeft") { var el = topEl(); if (el && !el._hidden) fling(el, e.key === "ArrowRight" ? 1 : -1); }
  });

  function nearSet() {
    var best = null;
    DIVS.forEach(function (d) {
      if (S.sets[d]) return;
      var miss = DIV_TEAMS[d].filter(function (t) { return !(S.inv[t.num] && S.inv[t.num].length); }).length;
      if (miss > 0 && miss <= 3 && (!best || miss < best.miss)) best = { d: d, miss: miss };
    });
    return best;
  }
  function summary(skipped) {
    var sets = (S.pending && S.pending.sets) || [], fromR = !stackView.hidden && stackEl.getBoundingClientRect();
    deck.forEach(stash); save();
    state = "summary"; if (S.pending && S.pending.id) api.progress(S.pending.id, 5).catch(function () {}); S.pending = null; document.body.classList.remove("takeover"); endMythic();
    summaryEl.innerHTML = "";
    deck.forEach(function (c, i) {
      var el = cardEl(c, { faceUp: true, button: true, ribbon: true }); el.style.setProperty("--n", i); showRibbon(el);
      if (i === deck.length - 1 && c.tier !== "common" && c.tier !== "uncommon") el.classList.add("best");
      var look = function () { cardNav = deck.filter(function (x) { return !x.test; }).map(function (x) { return x.num; }); if (c.test) { cardNav = null; viewCard(c.num, { serial: "TEST", from: "A test card: not saved anywhere." }); } else inspect(BY_NUM[c.num]); };
      el.addEventListener("click", look);
      el.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); look(); } });
      summaryEl.appendChild(el);
    });
    showOnly("summary");
    if (fromR && fromR.width && !RM) { summaryEl.classList.add("flow"); Array.prototype.forEach.call(summaryEl.children, function (el, i) { flyFrom(el, fromR, 560, i * 70); }); }
    else summaryEl.classList.remove("flow");
    var best = deck[deck.length - 1], bt = BY_NUM[best.num], news = deck.filter(function (c) { return c.isNew; }).length;
    var have = Object.keys(S.inv).filter(function (k) { return BY_NUM[k] && S.inv[k].length; }).length;
    var near = nearSet();
    setHud(best.tier === "mythic" ? bt.name + ". Mythic." : "Best pull: " + bt.name, (news ? news + " new · " : "No new teams · ") + have + " of " + TEAMS.length + " collected" + (near ? " · " + near.miss + " away from the " + near.d + " set" : ""));
    paintTabDot(); paintStatus();
    if (sets.length) setTimeout(function () { if (state !== "summary") return; sfx.claim(); say((sets.length > 1 ? sets.slice(0, -1).join(", ") + " and " + sets[sets.length - 1] : sets[0]) + " set complete! +" + sets.length + (sets.length === 1 ? " pack" : " packs"), 4200); }, skipped ? 1800 : 400);
    if (skipped) {
      /* Skipping still gets the big moment for the best hidden card. */
      sfx.flip(skipped.tier);
      setTimeout(function () {
        var el = summaryEl.lastElementChild; if (!el || state !== "summary") return;
        var r = el.getBoundingClientRect(), T = TIERS[skipped.tier];
        burst(r.left + r.width / 2, r.top + r.height / 2, T.parts, T.color, T.pow, skipped.tier === "mythic");
        if (skipped.tier === "legendary" || skipped.tier === "mythic") { flash(); shake(true); say(T.label.toUpperCase() + " · " + BY_NUM[skipped.num].name + " (" + skipped.num + ")", 3000); }
      }, RM ? 0 : 520);
    }
    againBtn.textContent = (S.testMode || S.packs > 0) ? "Open another pack" : "Back to the packs";
    try { againBtn.focus({ preventScroll: true }); } catch (e) {}
  }
  /* With packs left, go straight to a fresh pack in hand; "Pick another" there goes back to the wheel. */
  againBtn.addEventListener("click", function () {
    if (state !== "summary") return;
    if (!have()) { if (S.openMythic) { S.openMythic = false; S.openKind = kindCount(true) > 0; } else S.openKind = !S.openKind; } // that stack ran out: carry on with the other one
    if (!S.testMode && S.packs < 1) return paintHome();
    if (have() > 0 && S.wheel === true) { sfx.pick(); paintSelect(true); }
    else if (have() > 0) { paintSelect(false); choose(Math.floor(SHELF_N / 2)); } else paintHome();
  });
  function revealAll() {
    if (state !== "stack" && state !== "flipping") return;
    var last = stackEl.firstElementChild, unflipped = last && last._hidden ? last._c : null; // the pack's best card sits at the bottom
    idx = deck.length; S.pending.revealed = idx;
    summary(unflipped);
  }
  skipBtn.addEventListener("click", revealAll);
  $("#toBinder").addEventListener("click", function () { paintHome(); });

  /* ---------- binder ---------- */
  var gridEl = $("#grid"), tiersEl = $("#tiers"), moreBtn = $("#more"), missingBtn = $("#missingBtn"), filter = "all", shown = 48, showMissing = false;
  var searchEl = $("#binderSearch");
  /* Search looks through every team in the pack, owned or not, so you can see what you're missing. */
  searchEl.addEventListener("input", function () { shown = 48; paintBinder(); });
  function matches(t, q) { return String(t.num).indexOf(q) === 0 || t.name.toLowerCase().indexOf(q) >= 0 || (t.loc || "").toLowerCase().indexOf(q) >= 0; }
  missingBtn.addEventListener("click", function () { showMissing = !showMissing; shown = 48; paintBinder(); });
  function ownedList() {
    var out = [];
    Object.keys(S.inv).forEach(function (k) { var t = BY_NUM[k]; if (t && S.inv[k].length) out.push(t); });
    out.sort(function (a, b) { return (b.num === myTeam()) - (a.num === myTeam()) || ORDER.indexOf(a.tier) - ORDER.indexOf(b.tier) || a.rank - b.rank; });
    return out;
  }
  function paintBinder() {
    var owned = ownedList(), counts = {}; ORDER.forEach(function (t) { counts[t] = 0; });
    owned.forEach(function (t) { counts[t.tier]++; });
    var copies = 0; owned.forEach(function (t) { copies += S.inv[t.num].length; });
    $("#binderSum").textContent = owned.length + " of " + TEAMS.length + " teams · " + copies + " cards";
    $("#binderTitle").textContent = "Cards";
    paintPacks(owned, counts); paintWorkshop(); paintV2Binder(owned, counts);
    tiersEl.innerHTML = "";
    var all = document.createElement("button"); all.type = "button"; all.className = "chip" + (filter === "all" ? " on" : ""); all.setAttribute("aria-pressed", String(filter === "all"));
    all.innerHTML = '<b>All</b><em>' + owned.length + '</em><span class="bar"><i style="width:' + (TEAMS.length ? owned.length / TEAMS.length * 100 : 0) + '%"></i></span>';
    all.onclick = function () { filter = "all"; shown = 48; paintBinder(); }; tiersEl.appendChild(all);
    ORDER.forEach(function (t) {
      var b = document.createElement("button"); b.type = "button"; b.className = "chip" + (filter === t ? " on" : ""); b.setAttribute("aria-pressed", String(filter === t));
      b.style.setProperty("--tc", TIERS[t].color);
      b.innerHTML = '<b style="color:' + TIERS[t].color + '">' + TIERS[t].label + '</b><em>' + counts[t] + '/' + POOL[t].length + '</em><span class="bar"><i style="width:' + (POOL[t].length ? counts[t] / POOL[t].length * 100 : 0) + '%"></i></span>';
      b.onclick = function () { filter = t; shown = 48; paintBinder(); }; tiersEl.appendChild(b);
    });
    var divsEl = $("#divs"); divsEl.innerHTML = "";
    DIVS.forEach(function (d) {
      var have = DIV_TEAMS[d].filter(function (t) { return S.inv[t.num] && S.inv[t.num].length; }).length, key = "div:" + d;
      var b = document.createElement("button"); b.type = "button"; b.className = "chip" + (filter === key ? " on" : "") + (S.sets[d] ? " done" : ""); b.setAttribute("aria-pressed", String(filter === key));
      b.innerHTML = '<b>' + esc(d) + '</b><em>' + have + '/' + DIV_TEAMS[d].length + '</em><span class="bar"><i style="width:' + (have / DIV_TEAMS[d].length * 100) + '%"></i></span>';
      b.title = S.sets[d] ? "Set complete" : "Collect every team in " + d + " for a bonus pack";
      b.onclick = function () { filter = key; shown = 48; paintBinder(); }; divsEl.appendChild(b);
    });
    var isDiv = filter.indexOf("div:") === 0, dname = filter.slice(4);
    missingBtn.hidden = filter === "all" && !document.body.classList.contains("v2"); missingBtn.setAttribute("aria-pressed", String(showMissing)); missingBtn.classList.toggle("on", showMissing);
    var q = searchEl.value.trim().toLowerCase();
    var everyone = (filter === "all" ? TEAMS : isDiv ? DIV_TEAMS[dname] : POOL[filter]).slice().sort(function (a, b) { return ORDER.indexOf(a.tier) - ORDER.indexOf(b.tier) || a.rank - b.rank; });
    var have = function (t) { return S.inv[t.num] && S.inv[t.num].length ? 1 : 0; };
    var list = q ? everyone.filter(function (t) { return matches(t, q); }).sort(function (a, b) { return have(b) - have(a); }) // yours first
      : showMissing ? everyone
      : owned.filter(function (t) { return filter === "all" || (isDiv ? t.div === dname : t.tier === filter); });
    gridEl.innerHTML = "";
    if (!list.length) {
      var e = document.createElement("div"); e.className = "empty-binder"; e.style.gridColumn = "1 / -1";
      e.innerHTML = q ? "<b>No team matches</b>Try a team number like 254, or part of a name." : owned.length ? "<b>None of these yet</b>Keep opening packs." : "<b>Your binder is empty</b>Open a pack and every robot you pull lands here.";
      gridEl.appendChild(e);
    }
    list.slice(0, shown).forEach(function (t) {
      var serials = S.inv[t.num] || [];
      if (!serials.length) {
        /* A card you don't own is blurred: you can see its rarity and who it is, not the card itself. */
        var gh = cardEl({ num: t.num, tier: t.tier }, { faceUp: true }); gh.classList.add("ghost");
        var tag = document.createElement("div"); tag.className = "ghost-tag"; tag.innerHTML = "<b>" + t.num + "</b>" + esc(t.name) + "<small>Not yet</small>";
        gh.appendChild(tag); gh.setAttribute("aria-label", t.name + ", team " + t.num + ", " + TIERS[t.tier].label + ", not owned yet" + (wished(t.num) ? ", on your wishlist" : ""));
        gh.setAttribute("role", "button"); gh.tabIndex = 0;
        if (wished(t.num)) { var wl = document.createElement("span"); wl.className = "tr-want mine"; wl.textContent = "♥ Wishlist"; gh.appendChild(wl); }
        gh.addEventListener("click", function () { cardNav = list.slice(0, shown).map(function (x) { return x.num; }); viewCard(t.num, { locked: true }); });
        gh.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); viewCard(t.num, { locked: true }); } });
        gridEl.appendChild(gh); return;
      }
      var el = cardEl({ num: t.num, tier: t.tier, serial: serials[0], isNew: true }, { faceUp: true, button: true, count: serials.length, ribbon: !!S.unseen[t.num] });
      if (S.unseen[t.num]) showRibbon(el);
      if (isFav(t.num)) { var hb = document.createElement("div"); hb.className = "fav-badge"; hb.textContent = "\u2665"; hb.setAttribute("aria-label", "Kept"); el.appendChild(hb); }
      el.addEventListener("click", function () { cardNav = list.slice(0, shown).map(function (x) { return x.num; }); inspect(t); });
      el.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); inspect(t); } });
      gridEl.appendChild(el);
    });
    moreBtn.hidden = list.length <= shown;
  }
  moreBtn.addEventListener("click", function () { shown += 48; paintBinder(); });

  /* ---------- workshop: scrap extra copies for parts, craft boosted packs ---------- */
  /* Which rarities the scrap button takes. Common to Rare by default; Legendary and Mythic only when you pick them.
     Remembered on this device. */
  var scrapPick = { common: true, uncommon: true, rare: true, legendary: false, mythic: false }, scrapArmed = 0;
  try { var sp = JSON.parse(localStorage.getItem("frcpacks.scrap") || "null"); if (sp && typeof sp === "object") ORDER.forEach(function (t) { if (typeof sp[t] === "boolean") scrapPick[t] = sp[t]; }); } catch (e) {}
  /* Extra Legendary copies can be scrapped (off by default in the bulk button); Mythic copies never are. */
  scrapPick.mythic = false;
  var NOSCRAP = { mythic: 1 };
  var craftBtn = $("#craftBtn"), scrapBtn = $("#scrapBtn"), craftMythicBtn = $("#craftMythicBtn"), MYTHIC_COST = 10000;
  /* A small (i) that shows its text on tap or hover, for explanations that used to sit on the page. */
  function infoTip(text) {
    var w = document.createElement("span"); w.className = "tipwrap";
    w.innerHTML = '<button type="button" class="info" aria-label="More info">i</button><span class="tippop" role="tooltip"></span>';
    w.querySelector(".tippop").textContent = text;
    w.querySelector(".info").onclick = function (e) { e.stopPropagation(); w.classList.toggle("show"); };
    return w;
  }
  addEventListener("click", function () { Array.prototype.forEach.call(document.querySelectorAll(".tipwrap.show"), function (x) { x.classList.remove("show"); }); });
  (function () { var n = document.querySelector(".ws-note:not(.ws-held):not(.ws-other)"); if (n) { var t = infoTip(n.textContent); n.remove(); document.querySelector(".ws-parts").appendChild(t); } })();
  /* Copies the server won't scrap yet: cards from the pack being revealed, and cards in open trade offers. Keyed
     "team:serial". */
  function isFav(n) { return (S.favorites || []).indexOf(+n) >= 0; }
  /* "Keep": a favorite is never scrapped, however many copies you hold. */
  function keepButton(num) {
    var b = document.createElement("button"); b.type = "button"; b.className = "cta ghost keepb";
    var paint = function () { b.textContent = isFav(num) ? "\u2665 Kept" : "\u2661 Keep"; b.setAttribute("aria-pressed", String(isFav(num))); b.classList.toggle("on", isFav(num)); };
    paint();
    b.onclick = function () {
      b.disabled = true;
      api.setFavorite(PACK_ID, num, !isFav(num)).then(function (l) { S.favorites = l; b.disabled = false; paint(); sfx.tick(); say(isFav(num) ? "Kept. It will never be scrapped." : "No longer kept.", 1800); paintWorkshop(); }, function (e) { b.disabled = false; offline(e); });
    };
    return b;
  }
  function heldCopies() {
    var held = {};
    if (S.pending) S.pending.cards.forEach(function (c) { held[c.num + ":" + c.serial] = 1; });
    TR.outgoing.concat(TR.incoming).forEach(function (t) { t.youGive.forEach(function (c) { held[c.num + ":" + c.serial] = 1; }); });
    return held;
  }
  /* Extra copies by tier that scrapping will take now, the same way the server counts them: of the copies that
     aren't held back, all but one. `held` counts the extras that have to wait. */
  function extras() {
    var out = { held: 0 }, h = heldCopies(); ORDER.forEach(function (t) { out[t] = 0; });
    Object.keys(S.inv).forEach(function (k) {
      var t = BY_NUM[k], all = S.inv[k].length; if (!t || all < 2 || isFav(k)) return;
      var free = S.inv[k].filter(function (s) { return !h[k + ":" + s]; }).length, now = Math.max(0, free - 1);
      out[t.tier] += now; if (scrapPick[t.tier]) out.held += all - 1 - now;
    });
    return out;
  }
  function paintWorkshop() {
    var ex = extras(), n = 0, gain = 0, cost = S.boostCost;
    $("#partsN").textContent = S.parts;
    $("#partsBar").style.width = Math.min(100, S.parts / cost * 100) + "%";
    $("#partsTxt").textContent = S.parts >= cost ? Math.floor(S.parts / cost) + " boosted pack" + (S.parts >= cost * 2 ? "s" : "") + " ready to craft" : (cost - S.parts) + " more for a boosted pack";
    craftBtn.disabled = S.parts < cost; craftBtn.textContent = "Craft boosted pack · " + cost;
    craftMythicBtn.disabled = S.parts < MYTHIC_COST; craftMythicBtn.textContent = "Mythic pack · " + MYTHIC_COST.toLocaleString() + " (3 Mythics)";
    var row = $("#scrapTiers"); row.innerHTML = "";
    ORDER.slice().reverse().filter(function (t) { return !NOSCRAP[t]; }).forEach(function (t) {
      var b = document.createElement("button"); b.type = "button"; b.className = "chip" + (scrapPick[t] ? " on" : "");
      b.setAttribute("aria-pressed", String(!!scrapPick[t])); b.style.setProperty("--tc", TIERS[t].color);
      b.innerHTML = '<b style="color:' + TIERS[t].color + '">' + TIERS[t].label + '</b> <em>' + ex[t] + '</em>';
      b.title = "+" + (S.scrapParts[t] || 0) + " parts each";
      b.onclick = function () { scrapPick[t] = !scrapPick[t]; scrapArmed = 0; try { localStorage.setItem("frcpacks.scrap", JSON.stringify(scrapPick)); } catch (e) {} paintWorkshop(); };
      row.appendChild(b);
      if (scrapPick[t]) { n += ex[t]; gain += ex[t] * (S.scrapParts[t] || 0); }
    });
    /* Extras in rarities that aren't picked: say so, so they don't look forgotten. */
    var skipped = ORDER.filter(function (t) { return !scrapPick[t] && !NOSCRAP[t] && ex[t]; });
    var other = $("#scrapOther"), more = skipped.reduce(function (a, t) { return a + ex[t]; }, 0);
    other.hidden = !more;
    other.textContent = more + (more === 1 ? " more extra copy" : " more extra copies") + " in " + skipped.map(function (t) { return TIERS[t].label; }).join(" and ") + ". Tap " + (skipped.length === 1 ? "it" : "them") + " above to include " + (more === 1 ? "it" : "them") + ".";
    scrapBtn.disabled = !n;
    var note = $("#scrapHeld"); note.hidden = !ex.held;
    note.textContent = ex.held + (ex.held === 1 ? " extra copy waits" : " extra copies wait") + " until you finish the pack you're opening or the trade offer it's in.";
    scrapBtn.textContent = !n ? "No extras to scrap" : scrapArmed ? "Tap again to scrap " + n : "Scrap " + n + (n === 1 ? " extra" : " extras") + " · +" + gain + " parts";
    scrapBtn.classList.toggle("armed", !!scrapArmed);
  }
  function scrapped(r) {
    applyState(r.state); applyCollection(r.collection);
    Object.keys(S.unseen).forEach(function (k) { if (!S.inv[k]) delete S.unseen[k]; }); save();
    sfx.whoosh(); paintStatus(); if (!vBinder.hidden) paintBinder(); paintTabDot();
    if (r.scrapped) say("Scrapped " + r.scrapped + (r.scrapped === 1 ? " copy" : " copies") + " · +" + r.gained + " parts" + (r.held ? " · " + r.held + " held back" : ""), 3000);
  }
  scrapBtn.addEventListener("click", function () {
    var tiers = ORDER.filter(function (t) { return scrapPick[t]; }); if (!tiers.length) return;
    if (!scrapArmed) { scrapArmed = 1; paintWorkshop(); setTimeout(function () { if (scrapArmed) { scrapArmed = 0; paintWorkshop(); } }, 3500); return; }
    scrapArmed = 0; scrapBtn.disabled = true;
    api.scrapExtras(PACK_ID, tiers).then(scrapped, offline).then(paintWorkshop);
  });
  craftBtn.addEventListener("click", function () {
    if (S.parts < S.boostCost) return; actx(); craftBtn.disabled = true;
    api.craft().then(function (st) {
      applyState(st); paintStatus(); paintWorkshop(); sfx.promote();
      var r = craftBtn.getBoundingClientRect(); burst(r.left + r.width / 2, r.top + r.height / 2, 40, "#ffd34d", 7);
      say("Boosted pack crafted. It waits in its own gold stack on the Open tab.", 2800);
      if (state === "home" || state === "select") paintSelectHud();
    }, function (e) { offline(e); paintWorkshop(); });
  });
  craftMythicBtn.addEventListener("click", function () {
    if (S.parts < MYTHIC_COST) return; actx(); craftMythicBtn.disabled = true;
    api.craftMythic().then(function (st) {
      applyState(st); paintStatus(); paintWorkshop(); sfx.promote();
      var r = craftMythicBtn.getBoundingClientRect(); burst(r.left + r.width / 2, r.top + r.height / 2, 60, "#3cffdc", 8);
      say("Mythic pack crafted. Open it from its own stack on the Open tab.", 3200);
      if (state === "home" || state === "select") paintSelectHud();
    }, function (e) { offline(e); paintWorkshop(); });
  });
  function paintPacks(owned, counts) {
    var row = $("#packRow"); row.innerHTML = "";
    PACKS.forEach(function (pk) {
      var have = owned.length, total = pk.teams.length, pct = total ? Math.floor(have / total * 100) : 0;
      var b = document.createElement("button"); b.type = "button"; b.className = "ptile" + (pk === curPack ? " on" : ""); b.setAttribute("aria-pressed", String(pk === curPack));
      b.setAttribute("aria-label", pk.name + " pack, " + have + " of " + total + " teams collected");
      b.innerHTML = '<div class="pmini" aria-hidden="true">' + packHTML(false) + '</div><div class="pinfo">' +
        '<div class="pname"><b>' + esc(pk.name) + '</b><span class="pct"><em>' + pct + '%</em> · ' + have + ' of ' + total + '</span></div>' +
        '<div class="pbar"><i style="width:' + (have / total * 100) + '%"></i></div>' +
        '<div class="ptiers">' + ORDER.map(function (t) { return '<span style="color:' + TIERS[t].color + '">' + TIERS[t].label + ' <i>' + counts[t] + '/' + POOL[t].length + '</i></span>'; }).join("") + '</div></div>';
      b.onclick = function () { curPack = pk; filter = "all"; shown = 48; paintBinder(); };
      row.appendChild(b);
    });
  }

  var modal = $("#modal"), modalIn = $("#modalIn"), lastFocus = null;
  /* The modal is a stack of screens. Opening a card from a profile puts it on top, and Back returns to the profile.
     Each level is also a browser history entry, so the phone's back button or back swipe steps back one screen
     instead of leaving the app. A screen is a function that fills modalIn and returns what to focus. */
  var mstack = [], afterClose = null;
  function present(render, replace) {
    if (modal.hidden) { mstack = []; lastFocus = document.activeElement; }
    var push = !replace || !mstack.length;
    if (push) { mstack.push(render); try { history.pushState({ modal: mstack.length }, ""); } catch (e) {} }
    else mstack[mstack.length - 1] = render;
    paintModal(push && mstack.length > 1 ? "push" : replace ? "" : "in");
  }
  function paintModal(dir) {
    modalIn.innerHTML = ""; modal.classList.remove("facts-on");
    var focus = mstack[mstack.length - 1]();
    modal.hidden = false; document.body.classList.add("modal-open");
    modal.classList.toggle("card-view", !!modalIn.querySelector(".slot") && !modalIn.querySelector(".profile"));
    if (dir !== "") { modal.scrollTop = 0; modalIn.scrollTop = 0; } // a profile scrolled down must not leave the next card shifted up
    modalIn.classList.remove("m-push", "m-pop", "m-in");
    if (dir) { void modalIn.offsetWidth; modalIn.classList.add("m-" + dir); }
    if (focus && focus.focus) focus.focus({ preventScroll: true });
  }
  function closeButton() {
    var b = document.createElement("button"); b.type = "button"; b.className = "cta";
    var deeper = mstack.length > 1; b.textContent = deeper ? "‹ Back" : "Close"; b.onclick = closeModal;
    if (deeper) b.setAttribute("aria-label", "Back to the previous screen");
    return b;
  }
  /* One screen back (Back, Escape, the B button, the phone's back gesture). */
  function closeModal() {
    if (!mstack.length) return hideModal();
    if (history.state && history.state.modal === mstack.length) history.back(); else popModal(mstack.length - 1);
  }
  /* Every screen at once (tapping outside, or leaving for another tab); `then` runs once it is closed. */
  function closeAll(then) {
    var n = mstack.length;
    if (!n) { hideModal(); if (then) then(); return; }
    if (history.state && history.state.modal === n) { afterClose = then || null; history.go(-n); }
    else { mstack = []; hideModal(); if (then) then(); }
  }
  function popModal(depth) {
    if (depth >= mstack.length) return;
    mstack.length = Math.max(0, depth);
    if (mstack.length) return paintModal("pop");
    hideModal(); var f = afterClose; afterClose = null; if (f) f();
  }
  /* Tap the dark area around a card or profile to close it, like Close. */
  modal.addEventListener("click", function (e) { if (e.target === modal || e.target === modalIn) closeModal(); });
  /* While a card or profile is open the page behind must not scroll (it moved the pinned buttons on some phones). */
  document.addEventListener("touchmove", function (e) { if (!modal.hidden && !e.target.closest(".modal-in")) e.preventDefault(); }, { passive: false });
  function hideModal() {
    mstack = []; cardNav = null; modal.classList.remove("card-view", "facts-on"); modal.hidden = true; document.body.classList.remove("modal-open"); modalIn.innerHTML = "";
    if (lastFocus && lastFocus.focus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
  }
  /* The phone's back button and back swipe step back through the app the way the on-screen buttons do (card ->
     profile, pack in hand -> the wheel -> your packs, another tab -> Open) and only leave the app from the Open
     tab's home. A spare history entry (the guard) is kept whenever there is somewhere to go back to. */
  function deepNav() { return !settings.hidden || vOpen.hidden || state === "select" || state === "inspect" || state === "summary"; }
  function guardNav() {
    var hs = history.state;
    if (!mstack.length && deepNav() && !(hs && (hs.guard || hs.modal))) try { history.pushState({ guard: 1 }, ""); } catch (e) {}
  }
  function navBack() {
    if (!settings.hidden) { gear.click(); return; }
    if (vOpen.hidden) { show("open"); return; }
    if (state === "inspect") back();
    else if (state === "select") { cancelAnimationFrame(ringRaf); paintHome(); }
    else if (state === "summary") paintHome();
  }
  // The entry the app loaded on is marked, so an entry with no state is one a link or a notification just opened.
  try { if (!history.state || history.state.modal) history.replaceState({ base: 1 }, ""); } catch (e) {}
  addEventListener("popstate", function (e) {
    var hs = e.state;
    if (mstack.length) { popModal(hs && hs.modal || 0); if (!mstack.length && !(hs && hs.guard)) guardNav(); return; }
    if (!hs) { // a #tab link: go there, not back
      try { history.replaceState({ base: 1 }, ""); } catch (er) {}
      var h = (location.hash || "").replace("#", "");
      if (h === "open" || h === "binder" || h === "trade" || h === "social") show(h);
      return guardNav();
    }
    if (hs.guard) return;
    navBack(); guardNav();
  });
  /* Any tap that takes you somewhere deeper leaves a way back. Clicks count as a user action, which browsers need
     before they let a history entry catch the back button. */
  addEventListener("click", function () { setTimeout(guardNav, 0); });
  function paintTabDot() {
    var dot = $("#tabDot"), n = Object.keys(S.unseen || {}).length;
    dot.hidden = !n; dot.textContent = n > 99 ? "99+" : n;
    tabBinder.setAttribute("aria-label", n ? "Binder, " + n + " new" : "Binder");
  }
  function inspect(t, replace) { present(function () { return inspectScreen(t); }, replace); }
  function inspectScreen(t) {
    var serials = S.inv[t.num] || []; modalIn.dataset.num = t.num;
    modalIn.appendChild(cardEl({ num: t.num, tier: t.tier, serial: serials[0] }, { faceUp: true, alive: !!serials.length, locked: !serials.length }));
    var bdg2 = serials.length && serialBadges(t.num, serials); if (bdg2) modalIn.appendChild(bdg2);
    var info = document.createElement("div"); info.className = "serials";
    info.innerHTML = serials.length ? "<b>" + serials.length + (serials.length === 1 ? " copy" : " copies") + "</b> owned<br>Serials: " + serials.map(function (s) { return "No. " + esc(s); }).join(" · ") : "Not in your collection yet";
    modalIn.appendChild(info);
    // The same team facts the card view shows everywhere else.
    var fx = document.createElement("div"); fx.className = "serials card-facts";
    fx.innerHTML = "<dl><dt>Team</dt><dd>" + t.num + " · " + esc(t.name) + "</dd><dt>Division</dt><dd>" + esc(t.div) + "</dd>" + (t.loc ? "<dt>From</dt><dd>" + esc(t.loc) + "</dd>" : "") +
      "<dt>EPA</dt><dd>" + (t.epa == null ? "–" : Math.round(t.epa)) + " · #" + t.rank + " at Champs</dd><dt>Record</dt><dd>" + esc(t.wl) + "</dd></dl>" + battlerFacts(t);
    modalIn.appendChild(fx);
    var extra = [];
    var hc = heldCopies(), free = serials.filter(function (x) { return !hc[t.num + ":" + x]; }).length;
    if (serials.length > 1 && free < 2 && !NOSCRAP[t.tier]) {
      var wait = document.createElement("p"); wait.className = "ws-note ws-held";
      wait.textContent = "Your extra copies are in the pack you're opening or a trade offer, so they can't be scrapped yet.";
      extra.push(wait);
    }
    if (free > 1 && !NOSCRAP[t.tier]) {
      var each = S.scrapParts[t.tier] || 0, more = free - 1, srow = document.createElement("div"); srow.className = "cta-row";
      var one = document.createElement("button"); one.type = "button"; one.className = "chip"; one.textContent = "Scrap 1 extra · +" + each + " parts";
      one.onclick = function () { scrapOne(t, 1, one); }; srow.appendChild(one);
      if (more > 1) { var all = document.createElement("button"); all.type = "button"; all.className = "chip"; all.textContent = "Scrap all " + more + " extras · +" + each * more; all.onclick = function () { scrapOne(t, more, all); }; srow.appendChild(all); }
      extra.push(srow);
    }
    var close = cardChrome(t.num, !!serials.length, serials.length ? { label: "Offer it in a trade", run: function () { closeAll(function () { offerFromBinder(t.num); }); } } : null, extra);
    cardPos();
    return close;
  }
  /* The first copy (the lowest serial you got first) is always kept. */
  function scrapOne(t, count, btn) {
    if (!btn._armed && (t.tier === "legendary" || t.tier === "mythic")) { btn._armed = true; btn.textContent = "Tap again to scrap"; return; }
    btn.disabled = true;
    api.scrap(PACK_ID, t.num, count).then(function (r) { scrapped(r); inspect(t, true); }, function (e) { btn.disabled = false; offline(e); });
  }
  /* A card up close from the trading post: the full card (tilt it), its team stats, and whose copy it is. */
  /* Swiping through cards: the list the card was opened from (the collection grid, or the pack you just opened). */
  var cardNav = null;
  function navTo(num) { var own = (S.inv[num] || []).length; if (own) inspect(BY_NUM[num], true); else viewCard(num, { locked: true }, true); }
  function cardStep(d) {
    return; // swiping between cards was removed
    if (!cardNav || modal.hidden || !modal.classList.contains("card-view") || mstack.length > 1) return;
    var cur = +modalIn.dataset.num, i = cardNav.indexOf(cur); if (i < 0) return;
    var n = cardNav[i + d]; if (n == null) { buzz(8); return; }
    sfx.tick(); navTo(n);
  }
  function cardPos() {
    return;
    if (!cardNav || cardNav.length < 2) return; var i = cardNav.indexOf(+modalIn.dataset.num); if (i < 0) return;
    var p = document.createElement("div"); p.className = "card-pos"; p.textContent = (i + 1) + " of " + cardNav.length;
    modalIn.insertBefore(p, modalIn.firstChild);
  }
  /* The controls every card view shares, so the card looks and behaves the same wherever it was opened from (binder,
     profile, trade, pack): Close (or Back) top right, Pin and Keep, or Add to wishlist, top left, and the main action
     plus Details anchored along the bottom. `extra` are any other bottom controls (scrap, notes). Returns Close. */
  function cardChrome(num, owned, action, extra) {
    var icon = function (b, kind) {
      b.classList.add("cv-ic", "cv-" + kind);
      b.setAttribute("aria-label", b.getAttribute("aria-label") || b.textContent.replace(/^[^A-Za-z]+/, "").replace(/^On your profile$/, "Pin to profile").replace(/^Kept$/, "Keep"));
      return b;
    };
    var top = document.createElement("div"); top.className = "cv-top";
    var left = document.createElement("div"); left.className = "cv-left";
    left.appendChild(icon(owned ? pinButton(num) : wishButton(num), owned ? "star" : "heart"));
    if (owned) left.appendChild(icon(keepButton(num), "heart"));
    var close = closeButton(); icon(close, mstack.length > 1 ? "back" : "x");
    top.appendChild(left); top.appendChild(close);
    modalIn.insertBefore(top, modalIn.firstChild);
    var bottom = document.createElement("div"); bottom.className = "cv-bottom";
    var row = document.createElement("div"); row.className = "cta-row";
    if (action) {
      var go = document.createElement("button"); go.type = "button"; go.className = "cta wide"; go.textContent = action.label;
      go.onclick = action.run; row.appendChild(go);
    }
    row.appendChild(detailsButton());
    bottom.appendChild(row);
    (extra || []).forEach(function (x) { bottom.appendChild(x); });
    modalIn.appendChild(bottom);
    return close;
  }
  function detailsButton() {
    var b = document.createElement("button"); b.type = "button"; b.className = "cta ghost dtl"; b.textContent = "Details";
    b.onclick = function () { var on = modal.classList.toggle("facts-on"); b.textContent = on ? "Card" : "Details"; };
    return b;
  }
  function viewCard(num, o, replace) { present(function () { return cardScreen(num, o || {}); }, replace); }
  /* The 1v1 battler stats in the card's facts (t.bt, from tools/battler_stats.py): points in each phase, the three RP
     chances, and the unique effect. Teams without stats yet show nothing. */
  function battlerFacts(t) {
    var bt = t.bt; if (!bt) return "";
    return '<div class="bt-facts" style="--bt:' + TIERS[t.tier].color + '"><h4>Battler</h4><div class="bt-stats">' +
      [["AUTO", bt.auto], ["TELE", bt.tele], ["END", bt.end]].map(function (s) { return '<div><small>' + s[0] + '</small><b>' + s[1] + '</b></div>'; }).join("") + '</div>' +
      '<div class="bt-rp">' + bt.rp.map(function (p, i) { return '<div><small>RP' + (i + 1) + '</small><b>' + p + '%</b></div>'; }).join("") + '</div>' +
      '<div class="bt-effect"><small>Unique effect</small>' + (bt.effect ? '<p>' + esc(bt.effect) + '</p>' : '<p class="tbd">Effect coming soon</p>') + '</div></div>';
  }
  /* Serial numbers worth bragging about: No. 1, any of the first ten, and a serial that matches the team number. */
  function serialBadges(num, serials) {
    var b = [];
    if (serials.some(function (x) { return +x === 1; })) b.push('<span class="bdg g">First print</span>');
    else if (serials.some(function (x) { return +x > 0 && +x <= 10; })) b.push('<span class="bdg g">Low serial</span>');
    if (serials.some(function (x) { return +x === num; })) b.push('<span class="bdg t">Team match</span>');
    if (serials.length > 1) b.push('<span class="bdg p">' + serials.length + ' copies</span>');
    if (!b.length) return null;
    var d = document.createElement("div"); d.className = "badges"; d.innerHTML = b.join(""); return d;
  }
  function cardScreen(num, o) {
    modalIn.dataset.num = num; var t = BY_NUM[num], T = TIERS[t.tier], mine = (S.inv[num] || []).length;
    modalIn.appendChild(cardEl({ num: num, tier: t.tier, serial: o.serial || "" }, { faceUp: true, alive: !o.locked, locked: !!o.locked }));
    var bdg = !o.locked && o.serial && serialBadges(num, [o.serial]); if (bdg) modalIn.appendChild(bdg);
    var facts = document.createElement("div"); facts.className = "serials card-facts";
    facts.innerHTML = '<dl>' +
      '<dt>Team</dt><dd>' + num + ' · ' + esc(t.name) + '</dd>' +
      '<dt>Rarity</dt><dd style="color:' + T.color + '">' + T.label + '</dd>' +
      '<dt>Division</dt><dd>' + esc(t.div) + '</dd>' +
      (t.loc ? '<dt>From</dt><dd>' + esc(t.loc) + '</dd>' : '') +
      '<dt>EPA</dt><dd>' + (t.epa == null ? "–" : Math.round(t.epa)) + ' · #' + t.rank + ' at Champs</dd>' +
      '<dt>Record</dt><dd>' + esc(t.wl) + '</dd>' +
      (o.serial ? '<dt>Serial</dt><dd>No. ' + esc(o.serial) + '</dd>' : '') +
      '</dl>' + battlerFacts(t) + '<p>' + (o.from ? o.from + " " : "") + (mine ? "You own " + (mine === 1 ? "1 copy" : mine + " copies") + "." : "You don't have this one yet.") + '</p>';
    modalIn.appendChild(facts);
    var close = cardChrome(num, !!mine, o.action && { label: o.action.label, run: function () { closeAll(o.action.run); } });
    cardPos();
    return close;
  }
  /* ---------- wishlist, showcase and profiles ---------- */
  function wished(n) { return (S.wishlist || []).indexOf(n) >= 0; }
  function wishButton(num) {
    var b = document.createElement("button"); b.type = "button"; b.className = "cta ghost";
    var paint = function () { b.textContent = wished(num) ? "♥ On your wishlist" : "♡ Add to wishlist"; b.setAttribute("aria-pressed", String(wished(num))); };
    paint();
    b.onclick = function () {
      b.disabled = true;
      api.setWish(PACK_ID, num, !wished(num)).then(function (list) {
        S.wishlist = list; b.disabled = false; paint(); sfx.tick();
        if (!vBinder.hidden) paintBinder(); if (!vTrade.hidden) paintGrid();
      }, function (e) { b.disabled = false; offline(e); });
    };
    return b;
  }
  function pinButton(num) {
    var b = document.createElement("button"); b.type = "button"; b.className = "cta ghost";
    var pinned = function () { return (S.showcase || []).indexOf(num) >= 0; };
    var paint = function () { b.textContent = pinned() ? "★ On your profile" : "☆ Pin to profile"; b.setAttribute("aria-pressed", String(pinned())); };
    paint();
    b.onclick = function () {
      var list = (S.showcase || []).filter(function (n) { return n !== num; });
      if (!pinned()) { if (list.length >= 3) return say("Your profile shows 3 cards. Unpin one first (open it and tap On your profile).", 3200); list.push(num); }
      b.disabled = true;
      api.setShowcase(PACK_ID, list).then(function (l) { S.showcase = l; b.disabled = false; paint(); sfx.tick(); }, function (e) { b.disabled = false; offline(e); });
    };
    return b;
  }
  /* A player's profile: who they are, how far their collection is, their showcase, rarest pulls and wishlist. */
  function openProfile(name) {
    if (!name) return;
    api.profile(name, PACK_ID).then(function (p) { present(function () { return profileScreen(p); }); }, offline);
  }
  function profileScreen(p) {
      var pct = p.total ? Math.round(p.teams / p.total * 100) : 0, joined = new Date(p.joined).toLocaleDateString(undefined, { month: "short", year: "numeric" });
      var cards = function (list, empty, max) {
        var html = list.slice(0, max).filter(function (c) { return BY_NUM[c.num || c]; }).map(function (c) {
          var n = c.num || c; return '<button type="button" class="tr-view" data-num="' + n + '"' + (c.serial ? ' data-serial="' + c.serial + '"' : '') + '>' + miniCard(n, c.serial ? { serial: c.serial } : {}) + '</button>';
        }).join("");
        return html || empty;
      };
      var slots = ""; for (var i = p.showcase.length; i < 3; i++) slots += p.me ? '<button type="button" class="pf-empty pf-pin">Pin a card from your binder</button>' : '<div class="pf-empty">Empty</div>';
      modalIn.innerHTML = '<div class="profile">' +
        '<div class="pf-head">' + avatar(p.username) + '<div><h2>' + esc(p.username) + badgeHTML(p.badge) + '</h2><p>Joined ' + joined + (p.streak ? ' · ' + p.streak + '-day streak' : '') + '</p></div></div>' +
        '<div class="pf-stats"><div><b>' + pct + '%</b><small>collected</small></div><div><b>' + p.teams + '</b><small>teams</small></div><div><b>' + p.sets + '</b><small>sets</small></div><div><b>' + p.trades + '</b><small>trades</small></div></div>' +
        (p.me || p.showcase.length ? '<section class="pf-sec"><h3>Showcase' + (p.me && p.showcase.length > 1 ? ' <small>Drag to reorder</small>' : '') + '</h3><div class="pf-row pf-show">' + cards(p.showcase, "", 3) + (p.me ? slots : "") + '</div></section>' : '') +
        (p.me ? '<section class="pf-sec"><h3>Rarest pulls</h3><div class="pf-row">' + cards(p.rarest, '<p class="hint">No cards yet.</p>', 3) + '</div></section>' : '') +
        (p.me || p.wishlist.length ? '<section class="pf-sec"><h3>Wishlist' + (p.wishlist.length ? " · " + p.wishlist.length : "") + '</h3>' + (p.wishlist.length ? '<div class="pf-row wide pf-wish">' + cards(p.wishlist, "", 12) + '</div>' : '<p class="hint">' + (p.me ? "Tap a card you don't have in the binder to add it." : "Nothing yet.") + '</p>') + '</section>' : '') +
        '</div>';
      var row = document.createElement("div"); row.className = "cta-row";
      var close = closeButton(); row.appendChild(close);
      if (p.me) { var sb = document.createElement("button"); sb.type = "button"; sb.className = "cta ghost"; sb.textContent = "Settings"; sb.onclick = function () { closeAll(function () { $("#gear").click(); }); }; row.appendChild(sb); }
      if (!p.me && REPORTS) {
        var rep = document.createElement("button"); rep.type = "button"; rep.className = "textbtn pf-report"; rep.textContent = "Report " + p.username;
        rep.onclick = function () { reportForm(p.username); };
        modalIn.querySelector(".profile").appendChild(rep);
      }
      if (!p.me) {
        var spSec = document.createElement("section"); spSec.className = "pf-sec sp-host"; spSec.hidden = true;
        modalIn.querySelector(".profile").insertBefore(spSec, modalIn.querySelector(".profile .pf-sec"));
        api.playerSpecials(p.username).then(function (l) { specialRow(l, spSec); }, function () {});
        var tr = document.createElement("button"); tr.type = "button"; tr.className = "cta"; tr.textContent = "Trade";
        tr.onclick = function () { closeAll(function () { tradeFor(p.username); }); };
        row.appendChild(tr);
        /* Their whole collection, loaded when asked for. */
        var all = document.createElement("section"); all.className = "pf-sec";
        all.innerHTML = '<h3 class="pf-all">Collection</h3><div class="pf-grid"></div>';
        modalIn.querySelector(".profile").appendChild(all);
        (function () {
          var btn = all.querySelector(".pf-all");
          api.playerCollection(p.username, PACK_ID).then(function (col) {
            var list = col.cards.filter(function (c) { return BY_NUM[c.num]; }).sort(function (a, b) { var A = BY_NUM[a.num], B = BY_NUM[b.num]; return ORDER.indexOf(A.tier) - ORDER.indexOf(B.tier) || A.rank - B.rank; });
            btn.textContent = "Collection · " + list.length + " of " + TEAMS.length;
            var g = all.querySelector(".pf-grid");
            g.innerHTML = list.map(function (c) { return '<button type="button" class="tr-view" data-num="' + c.num + '">' + miniCard(c.num, { count: c.serials.length }) + '</button>'; }).join("");
            Array.prototype.forEach.call(g.querySelectorAll(".tr-view"), function (x) {
              var n = +x.dataset.num;
              x.onclick = function () { viewCard(n, { from: esc(p.username) + "'s card.", action: { label: "Ask " + p.username + " for it", run: function () { tradeFor(p.username, n); } } }); };
            });
          }, function (e) { offline(e); });
        })();
      }
      modalIn.appendChild(row);
      Array.prototype.forEach.call(modalIn.querySelectorAll(".tr-view"), function (b) {
        var n = +b.dataset.num, theirs = !p.me && !b.closest(".pf-wish");
        b.onclick = function () {
          viewCard(n, { serial: b.dataset.serial, from: p.me ? (b.closest(".pf-wish") ? "On your wishlist." : "Your card.") : esc(p.username) + (theirs ? "'s card." : " wants this one."),
            action: theirs ? { label: "Ask " + p.username + " for it", run: function () { tradeFor(p.username, n); } } :
              !p.me && (S.inv[n] || []).length ? { label: "Offer it to " + p.username, run: function () { tradeFor(p.username, 0, n); } } : null });
        };
      });
      Array.prototype.forEach.call(modalIn.querySelectorAll(".pf-pin"), function (b) { b.onclick = function () { closeAll(function () { show("binder"); }); }; });
      if (p.me) showcaseDrag(p);
      return close;
  }
  $("#myProfile").onclick = function () { openProfile(ME); };
  /* Your showcase: drag a pinned card onto another to swap their places. */
  function showcaseDrag(p) {
    var cells = Array.prototype.slice.call(modalIn.querySelectorAll(".pf-show .tr-view"));
    if (cells.length < 2) return;
    cells.forEach(function (b, i) {
      draggable(b, { targets: function () { return cells.filter(function (c) { return c !== b; }); }, drop: function (t) {
        if (!t) return;
        var j = cells.indexOf(t), list = p.showcase.slice(), moved = list[i]; list[i] = list[j]; list[j] = moved;
        var nums = list.map(function (c) { return c.num || c; });
        api.setShowcase(PACK_ID, nums).then(function (l) { S.showcase = l; p.showcase = list; sfx.tick(); present(function () { return profileScreen(p); }, true); }, offline);
      } });
    });
  }
  /* From your binder to the trading post, with that card on your side of the table. */
  function offerFromBinder(n) {
    show("trade"); setPane("new");
    if (trGive.indexOf(n) < 0 && trGive.length < MAXT) { trGive.push(n); trFresh["give" + n] = 1; }
    trSide = "mine"; paintTable(); paintGrid();
    if (!theirName) { say("It's on the table. Now pick who to trade with.", 2600); try { trWho.focus(); } catch (e) {} }
  }
  /* Straight to the trading post with a player, with a card of theirs you want (or one of yours) on the table. */
  var pendingWant = 0, pendingGive = 0;
  function tradeFor(name, want, give) {
    show("trade"); setPane("new"); pendingWant = want || 0; pendingGive = give || 0;
    trWho.value = name; $("#trSugg").innerHTML = ""; loadTheirs(true);
    try { $("#trPaneNew").scrollIntoView({ block: "start", behavior: RM ? "auto" : "smooth" }); } catch (e) {}
  }
  /* Reporting a player goes to the admin, who can rename or turn off the account. Off for now: set REPORTS to true to
     show the Report link on profiles (the server and the admin panel's Reports list are ready). */
  var REPORTS = false;
  function reportForm(name) { present(function () { return reportScreen(name); }); }
  function reportScreen(name) {
    var reasons = [["username", "Offensive username"], ["cheating", "Cheating or abuse"], ["harassment", "Harassment"], ["other", "Something else"]];
    modalIn.innerHTML = '<form class="profile report" novalidate><div class="pf-sec"><h3>Report ' + esc(name) + '</h3>' +
      '<div class="report-reasons" role="radiogroup">' + reasons.map(function (r, i) { return '<label><input type="radio" name="reason" value="' + r[0] + '"' + (i ? '' : ' checked') + '> ' + r[1] + '</label>'; }).join("") + '</div>' +
      '<textarea class="input" name="details" maxlength="500" rows="3" placeholder="What happened? (optional)"></textarea>' +
      '<p class="hint">Only the admin sees reports. They can rename or turn off the account.</p></div>' +
      '<div class="cta-row"><button type="submit" class="cta">Send report</button><button type="button" class="cta ghost" id="repCancel">Cancel</button></div></form>';
    var f = modalIn.querySelector("form");
    $("#repCancel").onclick = closeModal;
    f.onsubmit = function (e) {
      e.preventDefault();
      var btn = f.querySelector("button[type=submit]"); btn.disabled = true;
      api.report(name, f.reason.value, f.details.value).then(function () { closeAll(function () { say("Thanks. The admin will take a look.", 3000); }); }, function (er) { btn.disabled = false; offline(er); });
    };
    return f.querySelector("input");
  }
  /* ---------- feedback and the beta welcome ---------- */
  var FB_KINDS = [["bug", "Bug"], ["idea", "Idea"], ["other", "Other"]], FB_STATUS = { open: "Open", planned: "Planned", done: "Done", wontfix: "Won't do" };
  /* Where you were and on what, sent with the feedback so a bug can be found: the page, the app version, the screen and the browser. */
  function fbContext() {
    var cur = document.querySelector('script[type="module"][src*="/assets/"]'), v = cur ? (cur.getAttribute("src").match(/\/(?:main|index)-([\w-]+)\./) || [])[1] : "dev";
    return [location.hash || "home", "v " + (v || "?"), innerWidth + "x" + innerHeight, navigator.userAgent.replace(/\s+/g, " ")].join(" | ").slice(0, 290);
  }
  function feedbackForm() { present(feedbackScreen); }
  function feedbackScreen() {
    modalIn.innerHTML = '<form class="profile feedback" novalidate><div class="pf-sec"><h3>Send feedback</h3>' +
      '<div class="fb-kinds" role="radiogroup" aria-label="What kind of feedback">' + FB_KINDS.map(function (k, i) { return '<label><input type="radio" name="kind" value="' + k[0] + '"' + (i ? '' : ' checked') + '> ' + k[1] + '</label>'; }).join("") + '</div>' +
      '<input class="input" type="text" name="title" maxlength="80" placeholder="In a few words (a bug, or what you wish it did)" aria-label="Title" autocomplete="off">' +
      '<textarea class="input" name="details" maxlength="1500" placeholder="Tell us more. For a bug: what you did, what you expected, and what happened instead."></textarea>' +
      '<span class="fb-count" id="fbCount">0 / 1500</span>' +
      '<p class="hint">We also send the page you are on, the app version and your device, so we can find the problem. Nothing else.</p>' +
      '<div class="msg" id="fbMsg" role="status" hidden></div></div>' +
      '<div class="cta-row"><button type="submit" class="cta">Send</button><button type="button" class="cta ghost" id="fbCancel">Cancel</button></div>' +
      '<div class="pf-sec"><h3>Your feedback</h3><div class="fb-mine" id="fbMine"><p class="hint">Loading...</p></div></div></form>';
    var f = modalIn.querySelector("form"), msg = $("#fbMsg");
    f.details.oninput = function () { $("#fbCount").textContent = f.details.value.length + " / 1500"; };
    $("#fbCancel").onclick = closeModal;
    function paintMine(list) {
      var box = $("#fbMine"); if (!box) return;
      if (!list.length) { box.innerHTML = '<p class="hint">Nothing yet. Thank you for helping!</p>'; return; }
      box.innerHTML = list.map(function (x) {
        return '<div class="fb-item"><div class="row"><b>' + esc(x.title) + '</b><span class="fb-st ' + x.status + '">' + (FB_STATUS[x.status] || x.status) + '</span></div>' +
          (x.note ? '<small>' + esc(x.note) + '</small>' : '') + '</div>';
      }).join("");
    }
    function loadMine() { api.myFeedback().then(paintMine, function () { var b = $("#fbMine"); if (b) b.innerHTML = '<p class="hint">Could not load your feedback.</p>'; }); }
    loadMine();
    f.onsubmit = function (e) {
      e.preventDefault();
      var title = f.title.value.trim(); msg.hidden = true;
      if (title.length < 3) { msg.textContent = "Add a short title."; msg.hidden = false; return; }
      var btn = f.querySelector("button[type=submit]"); btn.disabled = true;
      api.sendFeedback(f.kind.value, title, f.details.value, fbContext()).then(function () {
        say("Thanks! We read everything.", 3000); f.title.value = ""; f.details.value = ""; $("#fbCount").textContent = "0 / 1500"; btn.disabled = false; loadMine();
      }, function (er) { btn.disabled = false; msg.textContent = explain(er); msg.hidden = false; });
    };
    return f.title;
  }
  $("#feedbackBtn").onclick = function () { feedbackForm(); };
  /* Players who are past the first-pack tips get the welcome the first time they open the app (once). */
  if (!tourOn) setTimeout(function () { betaWelcome(); }, 3000);
  /* Shown once to a new player after the first-pack tips: what the beta is and how to tell us what's broken. */
  var BETA_KEY = "frcpacks.beta";
  /* A one-time note from the game (for example, "Mythics have changed"), shown once and then marked read. */
  var noticeShown; // set by applyState, which can run before this line
  function showNotice(text) {
    present(function () {
      modalIn.innerHTML = '<div class="profile fb-welcome"><div class="pf-sec"><h3>A note from FRC Packs</h3><p id="noticeText"></p></div>' +
        '<div class="cta-row"><button type="button" class="cta" id="noticeOk">Got it</button></div></div>';
      $("#noticeText").textContent = text;
      $("#noticeOk").onclick = closeModal;
      return $("#noticeOk");
    });
    api.noticeSeen().catch(function () {});
  }
  function betaWelcome() {
    try { if (localStorage.getItem(BETA_KEY)) return; } catch (e) {}
    try { localStorage.setItem(BETA_KEY, "1"); } catch (e) {}
    present(function () {
      modalIn.innerHTML = '<div class="profile fb-welcome"><div class="pf-sec"><h3>You are a beta tester</h3>' +
        '<p>FRC Packs is still being built, and you are one of the first people playing. Thank you!</p>' +
        '<ul><li>Things will break. Tell us when they do.</li><li>Have an idea? Tell us that too.</li><li>Your cards stay safe, but the game may get a reset before launch.</li></ul>' +
        '<p>Find <b>Send feedback</b> in Settings any time.</p></div>' +
        '<div class="cta-row"><button type="button" class="cta" id="betaFb">Send feedback</button><button type="button" class="cta ghost" id="betaOk">Got it</button></div></div>';
      $("#betaOk").onclick = closeModal;
      $("#betaFb").onclick = function () { closeAll(feedbackForm); };
      return $("#betaOk");
    });
  }
  modal.addEventListener("click", function (e) { if (e.target === modal) closeAll(); });
  addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (modal.hidden && vOpen.hidden) return; // the Open screen is behind another tab
    if (!modal.hidden) closeModal(); else if (state === "inspect") back(); else if (state === "select") paintHome();
  });

  /* ---------- drag and drop ---------- */
  /* Pointer-based, so it works with a mouse and on a phone. A mouse drags once it moves a few pixels; a finger holds
     still for a moment first, so a quick swipe still scrolls the page. Tapping still works everywhere you can drag.
     o = { targets: () => elements you can drop on, drop: (element dropped on, or null) => ... } */
  var drag = null, dragEnded = 0;
  function draggable(el, o) {
    el.classList.add("can-drag");
    el.addEventListener("dragstart", function (e) { e.preventDefault(); }); // no native image dragging (it would take over the gesture)
    el.addEventListener("pointerdown", function (e) {
      if (e.button || drag) return;
      var d = drag = { el: el, o: o, x: e.clientX, y: e.clientY, id: e.pointerId, touch: e.pointerType !== "mouse", live: false };
      if (d.touch) d.timer = setTimeout(function () { dragStart(d); }, 260);
    });
  }
  function dragStart(d) {
    if (drag !== d || d.live) return;
    d.live = true; buzz(12); sfx.pick();
    var r = d.el.getBoundingClientRect(), g = d.el.cloneNode(true);
    g.className = "drag-ghost"; g.removeAttribute("id"); g.style.width = r.width + "px"; g.style.height = r.height + "px";
    d.dx = d.x - r.left; d.dy = d.y - r.top; d.ghost = g; document.body.appendChild(g);
    d.el.classList.add("dragging"); document.body.classList.add("is-dragging");
    d.targets = d.o.targets().filter(Boolean); d.targets.forEach(function (t) { t.classList.add("drop-ok"); });
    dragMove(d, d.x, d.y);
  }
  function dragMove(d, x, y) {
    d.lx = x; d.ly = y;
    d.ghost.style.transform = "translate(" + (x - d.dx) + "px," + (y - d.dy) + "px) rotate(-3deg) scale(1.06)";
    d.over = null;
    d.targets.forEach(function (t) {
      var r = t.getBoundingClientRect(), on = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      t.classList.toggle("drop-over", on); if (on) d.over = t;
    });
    // Near the top or bottom of the screen, scroll so a far-away target can be reached.
    var edge = 60, v = y < edge ? -12 : y > innerHeight - edge ? 12 : 0;
    var box = modal.hidden ? null : modal;
    if (v) (box || window).scrollBy(0, v);
  }
  function dragEnd(e, cancel) {
    var d = drag; if (!d || (e && e.pointerId !== d.id)) return;
    clearTimeout(d.timer); drag = null;
    if (!d.live) return;
    dragEnded = Date.now();
    d.ghost.remove(); d.el.classList.remove("dragging"); document.body.classList.remove("is-dragging");
    d.targets.forEach(function (t) { t.classList.remove("drop-ok", "drop-over"); });
    if (!cancel) d.o.drop(d.over, d.lx, d.ly);
  }
  addEventListener("pointermove", function (e) {
    var d = drag; if (!d || e.pointerId !== d.id) return;
    if (!d.live) {
      if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) < 8) return;
      if (d.touch) { clearTimeout(d.timer); drag = null; return; } // a swipe: let the page scroll
      dragStart(d);
    }
    e.preventDefault(); dragMove(d, e.clientX, e.clientY);
  }, { passive: false });
  addEventListener("pointerup", function (e) { dragEnd(e); });
  addEventListener("pointercancel", function (e) { dragEnd(e, true); });
  addEventListener("touchmove", function (e) { if (drag && drag.live) e.preventDefault(); }, { passive: false });
  addEventListener("contextmenu", function (e) { if (drag) e.preventDefault(); });
  // The click that ends a drag isn't a tap.
  addEventListener("click", function (e) { if (Date.now() - dragEnded < 350) { e.stopPropagation(); e.preventDefault(); } }, true);

  /* ---------- tabs and settings ---------- */
  var tabOpen = $("#tabOpen"), tabBinder = $("#tabBinder"), tabTrade = $("#tabTrade"), tabSocial = $("#tabSocial"), vOpen = $("#viewOpen"), vBinder = $("#viewBinder"), vTrade = $("#viewTrade"), vSocial = $("#viewSocial");
  function show(which) {
    var b = which === "binder", tr = which === "trade", so = which === "social", open = !b && !tr && !so;
    banner.classList.remove("show"); if (!modal.hidden) hideModal();
    vOpen.hidden = !open; vBinder.hidden = !b; vTrade.hidden = !tr; vSocial.hidden = !so;
    tabOpen.setAttribute("aria-selected", String(open)); tabBinder.setAttribute("aria-selected", String(b)); tabTrade.setAttribute("aria-selected", String(tr)); tabSocial.setAttribute("aria-selected", String(so));
    $("#status").hidden = !open; $("#daily").hidden = !open; paintTeamPick(!open); document.body.classList.toggle("focus", open && state === "inspect");
    setTimeout(coach, 0);
    if (b) { paintBinder(); loadSpecials(); loadTrades().then(function () { if (!vBinder.hidden) paintWorkshop(); }); }
    if (tr) { enterTrade(); paintTrades(); loadTrades(); loadSocial(); loadSpecials(); }
    // Paint what we already have at once (it may have been loaded from another tab), then check for news.
    if (so) { if (SOCIAL) { paintSocial(); paintActivity(); } loadSocial(); }
    try { history.replaceState(history.state, "", "#" + (b ? "binder" : tr ? "trade" : so ? "social" : "open")); } catch (e) {}
    if (!b && vBinder._was) { S.unseen = {}; save(); } // new marks last one binder visit
    vBinder._was = b; paintTabDot();
  }
  /* Notifications and home-screen shortcuts open a tab by its #hash. */
  addEventListener("hashchange", function () { var h = (location.hash || "").replace("#", ""); if (h === "open" || h === "binder" || h === "trade" || h === "social") show(h); });
  tabOpen.onclick = function () { show("open"); }; tabBinder.onclick = function () { show("binder"); }; tabTrade.onclick = function () { show("trade"); }; tabSocial.onclick = function () { show("social"); };
  var gear = $("#gear"), settings = $("#settings");
  gear.onclick = function () { var open = settings.hidden; settings.hidden = !open; gear.setAttribute("aria-expanded", String(open)); document.body.classList.toggle("settings-open", open); if (open) { paintAccount(); settings.scrollTop = 0; } };
  $("#setBack").onclick = function () { gear.click(); };
  /* The account card at the top of Settings: who you are, and where you change your name. */
  function paintAccount() {
    var a = (S.account || {}), box = $("#setAv"); if (!box) return;
    box.innerHTML = avatar(a.username || ME || "?", "big");
    $("#setName").textContent = a.firstName || a.username || ME || "";
    $("#setTag").innerHTML = badgeHTML(a.badge);
    $("#setUser").textContent = a.username ? "@" + a.username : "";
    var nf = $("#nameIn"); if (nf && document.activeElement !== nf) nf.value = a.firstName || "";
    var uf = $("#userIn"); if (uf && document.activeElement !== uf) uf.value = a.username || "";
    var wait = a.renameAt && a.renameAt > Date.now(), btn = $("#userBtn");
    if (btn) { btn.disabled = !!wait; btn.textContent = wait ? "Next change " + new Date(a.renameAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "Change username"; }
  }
  function setMsg(t, bad) { var m = $("#setMsg"); m.hidden = !t; m.textContent = t || ""; m.classList.toggle("bad", !!bad); }
  $("#nameForm").addEventListener("submit", function (e) {
    e.preventDefault(); var v = $("#nameIn").value.trim(); if (!v) return setMsg("Enter your first name.", true);
    api.changeFirstName(v).then(function (st) { applyState(st); paintAccount(); setMsg("Saved.", false); }, function (er) { setMsg(explain(er), true); });
  });
  $("#userForm").addEventListener("submit", function (e) {
    e.preventDefault(); var f = e.target, nu = f.username.value.trim(), pw = f.password.value;
    if (!nu || !pw) return setMsg("Enter the new username and your current password.", true);
    if (nu === ME) return setMsg("That's already your username.", true);
    api.changeUsername(nu, pw).then(function (st) { f.password.value = ""; ME = st.account.username; applyState(st); paintAccount(); paintSocialAfterRename(); setMsg("Username changed to " + st.account.username + ".", false); }, function (er) { setMsg(explain(er), true); });
  });
  function paintSocialAfterRename() { SOCIAL = null; var mb = $("#meBtn"); if (mb) mb.innerHTML = avatar(ME); }
  /* Latest-version check: compares the script this page loaded with the one the site is serving now. */
  var verBtn = $("#verBtn"), verTxt = $("#verTxt");
  function checkVersion() {
    var cur = document.querySelector('script[type="module"][src*="/assets/"]'); verBtn.disabled = true; verTxt.textContent = "Checking...";
    fetch("/?v=" + Date.now(), { cache: "no-store" }).then(function (r) { return r.text(); }).then(function (h) {
      var m = h.match(/\/assets\/main-[^"']+\.js/), have = cur && cur.getAttribute("src");
      verBtn.disabled = false;
      if (!m || !have || have.indexOf(m[0]) >= 0) { verTxt.textContent = "You have the latest version."; verBtn.textContent = "Check"; verBtn.dataset.update = ""; }
      else { verTxt.textContent = "A newer version is ready."; verBtn.textContent = "Update"; verBtn.dataset.update = "1"; }
    }, function () { verBtn.disabled = false; verTxt.textContent = "Couldn't check. Try again."; });
  }
  verBtn.onclick = function () { if (verBtn.dataset.update) location.reload(); else checkVersion(); };
  var muteBtn = $("#mute"), demoBtn = $("#demoLuck"), wheelBtn = $("#wheelAgain");
  wheelBtn.onclick = function () { S.wheel = S.wheel !== true; save(); paintToggles(); };
  function paintToggles() { paintV2(); muteBtn.textContent = S.muted ? "Off" : "On"; muteBtn.setAttribute("aria-pressed", String(!S.muted)); demoBtn.textContent = S.demo ? "On" : "Off"; demoBtn.setAttribute("aria-pressed", String(S.demo)); wheelBtn.textContent = S.wheel === true ? "On" : "Off"; wheelBtn.setAttribute("aria-pressed", String(S.wheel === true));
    ["#demoLuck", "#demoPack", "#reset"].forEach(function (id) { $(id).closest(".line").hidden = !S.devTools; });
  }
  /* New layout, for testing: the admin can switch it on in Settings. It only changes how the Collection page is arranged. */
  var V2 = "frcpacks.v2", v2On = false;
  try { v2On = localStorage.getItem(V2) === "1"; } catch (e) {}
  function paintV2() { document.body.classList.add("v2"); var l = $("#v2Line"); if (l) l.hidden = true; }
  $("#v2Btn").onclick = function () { v2On = !v2On; try { localStorage.setItem(V2, v2On ? "1" : "0"); } catch (e) {} paintV2(); };
  (function () {
    var head = document.querySelector("#viewBinder .binder-head"), search = $("#binderSearch"); if (!head || !search) return;
    var top = document.createElement("div"); top.className = "v2-top";
    top.innerHTML = '<div class="v2-prog"><div class="v2-pn"><b id="v2PackName"></b><span id="v2PackSum"></span></div><div class="v2-bar2"><i id="v2PackBar"></i></div></div><div class="lvl" id="lvlCard"></div>' +
      '<div class="seg v2-seg" role="tablist" aria-label="Collection pages"><button type="button" role="tab" id="v2Cards" aria-selected="true">Cards</button><button type="button" role="tab" id="v2Work" aria-selected="false">Workshop</button></div>';
    head.insertBefore(top, head.firstChild);
    var sel = document.createElement("div"); sel.className = "v2-sel";
    sel.innerHTML = '<select class="v2s" id="v2Rar" aria-label="Rarity"></select><select class="v2s" id="v2Set" aria-label="Set"></select>';
    head.insertBefore(sel, search.nextSibling);
    var view = $("#viewBinder");
    function page(ws) { view.classList.toggle("ws-open", ws); $("#v2Cards").setAttribute("aria-selected", String(!ws)); $("#v2Work").setAttribute("aria-selected", String(ws)); }
    $("#v2Cards").onclick = function () { page(false); }; $("#v2Work").onclick = function () { page(true); };
    $("#v2Rar").onchange = function () { filter = this.value; shown = 48; paintBinder(); };
    $("#v2Set").onchange = function () { filter = this.value; shown = 48; paintBinder(); };
  })();
  /* The new layout's header and dropdowns follow the same filter state as the chips. */
  /* Collector level: a short track around your level, and a button when levels are waiting to pay out. */
  function paintLevel() {
    var box = $("#lvlCard"), L = S.level; if (!box) return; if (!L) { box.hidden = true; return; } box.hidden = false;
    var waiting = L.level - L.claimed, next = (L.level + 1) * L.per, nodes = "";
    for (var i = Math.max(1, L.level - 1); i <= Math.max(1, L.level - 1) + 4; i++) {
      var cls = i <= L.claimed ? "d" : i <= L.level ? "r" : i === L.level + 1 ? "n" : "";
      nodes += (nodes ? '<span class="ln' + (i <= L.level ? " d" : "") + '"></span>' : "") + '<span class="nd ' + cls + '" title="Level ' + i + ' at ' + (i * L.per) + ' teams">' + (cls === "d" ? "\u2713" : i) + '</span>';
    }
    box.innerHTML = '<div class="lv-top"><b>Collector level ' + L.level + '</b><span>' + (waiting > 0 ? waiting * L.reward + " parts waiting" : (next - L.teams) + " teams to level " + (L.level + 1)) + '</span></div><div class="track">' + nodes + '</div>' +
      (waiting > 0 ? '<button type="button" class="cta small" id="lvlClaim">Collect +' + waiting * L.reward + ' parts</button>' : '');
    var b = $("#lvlClaim"); if (b) b.onclick = function () { b.disabled = true; api.claimLevel().then(function (st) { applyState(st); sfx.claim(); var r = b.getBoundingClientRect(); burst(r.left + r.width / 2, r.top + r.height / 2, 30, "#ffd34d", 6); paintLevel(); paintWorkshop(); }, function (e) { b.disabled = false; offline(e); }); };
  }
  function paintV2Binder(owned, counts) {
    paintLevel();
    if (!$("#v2Rar")) return;
    $("#v2PackName").textContent = PACKS[0].name; $("#v2PackSum").textContent = owned.length + " of " + TEAMS.length;
    $("#v2PackBar").style.width = (TEAMS.length ? owned.length / TEAMS.length * 100 : 0) + "%";
    var rar = $("#v2Rar"), set = $("#v2Set"), isDiv = filter.indexOf("div:") === 0;
    rar.innerHTML = '<option value="all">All rarities</option>' + ORDER.map(function (t) { return '<option value="' + t + '">' + TIERS[t].label + ' ' + counts[t] + '/' + POOL[t].length + '</option>'; }).join("");
    rar.value = isDiv ? "all" : filter;
    set.innerHTML = '<option value="all">All sets</option>' + DIVS.map(function (d) {
      var have = DIV_TEAMS[d].filter(function (t) { return S.inv[t.num] && S.inv[t.num].length; }).length;
      return '<option value="div:' + esc(d) + '">' + esc(d) + ' ' + have + '/' + DIV_TEAMS[d].length + (S.sets[d] ? " ✓" : "") + '</option>';
    }).join("");
    set.value = isDiv ? filter : "all";
  }
  muteBtn.onclick = function () { S.muted = !S.muted; save(); paintToggles(); blip(660, .08, "triangle", .08); };
  function devDone(st) { applyState(st); paintToggles(); paintStatus(); if (state === "select" || state === "home") paintSelectHud(); }
  demoBtn.onclick = function () { api.dev.demo(!S.demo).then(devDone, offline); };
  $("#demoPack").onclick = function () { api.dev.pack(PACK_ID).then(devDone, offline); };
  $("#skipTimer").onclick = function () { api.dev.skipTimer().then(devDone, offline); };
  /* ---------- my team ---------- */
  var teamPick = $("#teamPick"), teamInput = $("#teamInput"), teamMsg = $("#teamMsg");
  function paintTeamPick(inBinder) {
    if (inBinder === undefined) inBinder = !vBinder.hidden;
    teamPick.hidden = !TEAM_PICK || S.teamAsked || inBinder;
    $("#changeTeam").closest(".line").hidden = !TEAM_PICK;
    var t = S.team && BY_NUM[S.team];
    $("#myTeamTxt").textContent = !S.team ? "Not picked yet." : "Team " + S.team + (t ? " · " + t.name : " · not in the 2026 Championship pack");
  }
  $("#teamForm").addEventListener("submit", function (e) {
    e.preventDefault(); var n = parseInt(teamInput.value, 10);
    if (!(n > 0 && n < 100000)) { teamMsg.hidden = false; teamMsg.textContent = "Enter your team number, like 254."; return; }
    S.team = n; S.teamAsked = true; save(); teamMsg.hidden = true; paintTeamPick(); actx(); sfx.mine();
    var t = BY_NUM[n];
    say(t ? "Team " + n + ", " + t.name + ", is your team" + (S.opened === 0 ? ". It's in your first pack." : ".") : "Saved team " + n + ". It wasn't at Champs 2026, so it isn't in this pack.", 4200);
    if (state === "select" || state === "home") paintSelectHud(); if (!vBinder.hidden) paintBinder();
  });
  $("#teamSkip").onclick = function () { S.teamAsked = true; save(); teamMsg.hidden = true; paintTeamPick(); };
  $("#changeTeam").onclick = function () {
    S.teamAsked = false; save(); settings.hidden = true; gear.setAttribute("aria-expanded", "false"); show("open");
    teamInput.value = S.team || ""; try { teamInput.focus(); } catch (e) {}
  };
  var resetBtn = $("#reset"), armed = 0;
  resetBtn.onclick = function () {
    if (!armed) { armed = 1; resetBtn.textContent = "Tap again to delete"; setTimeout(function () { armed = 0; resetBtn.textContent = "Reset collection"; }, 3500); return; }
    armed = 0; resetBtn.textContent = "Reset collection";
    api.dev.reset().then(function (st) {
      applyState(st); S.inv = {}; S.sets = {}; S.unseen = {}; S.pending = null; save(); paintToggles(); paintTabDot(); paintTeamPick();
      document.body.classList.remove("takeover"); endMythic(); paintHome(); if (!vBinder.hidden) paintBinder();
    }, offline);
  };
  paintToggles();

  /* ---------- trading ---------- */
  /* The trading post: pick a player, lay up to 5 of your cards and up to 5 of theirs on the table, and send the
     offer. One copy of each team changes hands, serial number and all; the server picks the newest copy, so you keep
     your earliest serial longest. Offers for you, sent offers and history each have a tab. */
  var TR = { incoming: [], outgoing: [], recent: [] }, MAXT = 5;
  var trWho = $("#trWho"), trSend = $("#trSend"), trPickQ = $("#trPickQ"), trGrid = $("#trGrid");
  var trSerials = { give: {}, get: {} }, theirSer = {};
  var trGive = [], trGet = [], theirInv = null, theirName = "", whoTimer = 0, theirsReq = 0;
  var trPane = "new", trSide = "mine", trTier = "all", trFresh = {};
  /* Repaints only when something changed, so opening the tab doesn't draw (and animate) the same offers twice. */
  var trSig = "";
  function loadTrades() {
    return api.trades().then(function (t) {
      var sig = JSON.stringify(t), changed = sig !== trSig; trSig = sig; TR = t; paintTradeDot();
      if (changed && !vTrade.hidden) paintTrades();
    }, function () {});
  }
  function paintTradeDot() {
    var n = TR.incoming.length, dot = $("#tradeDot"), inN = $("#trInN");
    dot.hidden = inN.hidden = !n; dot.textContent = inN.textContent = n;
    tabTrade.setAttribute("aria-label", n ? "Trade, " + n + " offers for you" : "Trade");
  }
  function initials(name) { return esc((name || "?").replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?"); }
  function avatar(name, cls) {
    var h = 0; for (var i = 0; i < (name || "").length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
    return '<span class="av ' + (cls || "") + '" style="--ah:' + h + '" aria-hidden="true">' + initials(name) + '</span>';
  }
  function ago(ms) {
    var s = Math.max(0, (Date.now() - ms) / 1000);
    return s < 60 ? "just now" : s < 3600 ? Math.floor(s / 60) + "m ago" : s < 86400 ? Math.floor(s / 3600) + "h ago" : Math.floor(s / 86400) + "d ago";
  }
  /* A small card: the team's photo (or its colors), number, name and rarity, framed in its tier. */
  function miniCard(num, opts) {
    opts = opts || {}; var t = BY_NUM[num], T = TIERS[t.tier];
    var art = t.photo ? '<img src="/photos/' + num + '.webp" alt="" loading="lazy" decoding="async" draggable="false">' : '<span class="mc-gear" aria-hidden="true">' + num + '</span>';
    var foot = opts.serial ? "No. " + esc(opts.serial) : opts.count > 1 ? "×" + opts.count : T.label;
    return '<span class="mc card" data-tier="' + t.tier + '" style="--tc:' + T.color + '"><span class="mc-in">' +
      '<span class="mc-art">' + art + '</span><span class="mc-num">' + num + '</span><span class="mc-name">' + esc(t.name) + '</span>' +
      '<span class="mc-foot"><i>' + T.gems + '</i>' + foot + '</span></span></span>';
  }
  /* Parts a card would scrap for: a rough sense of what each side of a trade is worth. */
  function worth(nums) { return nums.reduce(function (a, n) { return a + (S.scrapParts[BY_NUM[n].tier] || 0); }, 0); }
  /* Packs and parts on the table. A sealed pack counts as 50 parts when weighing a trade. */
  var PACK_WORTH = 50, trGoods = { givePacks: 0, wantPacks: 0, giveBoosted: 0, wantBoosted: 0, giveParts: 0, wantParts: 0 }, theirGoods = null, trKind = "cards", trSpec = { give: [], want: [] }, theirSpecials = [];
  function goodsChips(packs, parts, boosted, specials) {
    return (packs ? '<span class="tr-chip pack"><i aria-hidden="true"></i>' + packs + (packs === 1 ? " pack" : " packs") + '</span>' : "") +
      (boosted ? '<span class="tr-chip pack gold"><i aria-hidden="true"></i>' + boosted + ' boosted</span>' : "") +
      (specials || []).map(function (sp) { return '<span class="tr-chip beta">Beta No. ' + pad3(sp.serial) + '</span>'; }).join("") +
      (parts ? '<span class="tr-chip parts"><i aria-hidden="true"></i>' + parts + ' parts</span>' : "");
  }
  /* On the table: what you've added, as chips. Tap them to change it in the Packs & parts picker. */
  function goodsMax(side) {
    return side === "give" ? { packs: kindCount(false), boosted: S.boosted, parts: S.parts } : theirGoods ? { packs: theirGoods.packs, boosted: theirGoods.boosted || 0, parts: theirGoods.parts } : null;
  }
  function goodsControls(box, side) {
    var mine = side === "give", m = goodsMax(side), k = mine ? ["givePacks", "giveBoosted", "giveParts"] : ["wantPacks", "wantBoosted", "wantParts"];
    if (m) { trGoods[k[0]] = Math.min(trGoods[k[0]], m.packs, 50); trGoods[k[1]] = Math.min(trGoods[k[1]], m.boosted, 50); trGoods[k[2]] = Math.min(trGoods[k[2]], m.parts, 100000); }
    var spList = (mine ? SPECIALS : theirSpecials).filter(function (x) { return trSpec[mine ? "give" : "want"].indexOf(x.id) >= 0; });
    var chips = m ? goodsChips(trGoods[k[0]], trGoods[k[2]], trGoods[k[1]], spList) : "";
    box.innerHTML = m ? '<button type="button" class="goods-sum">' + (chips || '<span class="gs-add">+ Packs &amp; parts</span>') + '</button>' : "";
    var b = box.querySelector("button"); if (b) b.onclick = function () { openSheet(mine ? "mine" : "theirs", "goods"); };
  }
  /* The picker: standard packs, boosted packs and parts, each with a counter, for one side of the trade. */
  function paintGoodsPicker() {
    var mine = trSide === "mine", side = mine ? "give" : "want", m = goodsMax(side);
    trGrid.innerHTML = "";
    if (!m) { trGrid.innerHTML = '<div class="tr-empty"><b>Whose packs?</b>Pick a player first.</div>'; return; }
    var wrap = document.createElement("div"); wrap.className = "gp";
    [["packs", "Standard pack", ""], ["boosted", "Boosted pack", " gold"]].forEach(function (r) {
      var key = side + r[0].charAt(0).toUpperCase() + r[0].slice(1), max = Math.min(m[r[0]], 50), n = trGoods[key];
      var row = document.createElement("div"); row.className = "gp-row" + (n ? " on" : "");
      row.innerHTML = '<span class="gp-art' + r[2] + '"></span><span class="gp-t"><b>' + r[1] + '</b><small>' + m[r[0]] + (mine ? " in your stack" : " they have") + '</small></span>' +
        '<span class="step"><button type="button" data-d="-1" aria-label="One fewer">−</button><b>' + n + '</b><button type="button" data-d="1" aria-label="One more">+</button></span>';
      Array.prototype.forEach.call(row.querySelectorAll("button"), function (b) {
        b.disabled = (+b.dataset.d < 0 && !n) || (+b.dataset.d > 0 && n >= max);
        b.onclick = function () { trGoods[key] = Math.max(0, Math.min(max, n + +b.dataset.d)); sfx.tick(); paintTable(); paintGrid(); };
      });
      wrap.appendChild(row);
    });
    var pk = side + "Parts", prow = document.createElement("div"); prow.className = "gp-row" + (trGoods[pk] ? " on" : "");
    prow.innerHTML = '<span class="gp-art parts"></span><span class="gp-t"><b>Parts</b><small>' + m.parts + (mine ? " available" : " they have") + '</small></span><input class="input" type="number" inputmode="numeric" min="0" max="' + m.parts + '" step="10" value="' + (trGoods[pk] || "") + '" placeholder="0" aria-label="Parts">';
    prow.querySelector("input").onchange = function () { trGoods[pk] = Math.max(0, Math.min(m.parts, 100000, Math.floor(+this.value || 0))); paintTable(); paintGrid(); };
    wrap.appendChild(prow);
    trGrid.appendChild(wrap);
  }
  function setPane(p) {
    trPane = p;
    [["new", "#trTabNew", "#trPaneNew"], ["in", "#trTabIn", "#trPaneIn"], ["out", "#trTabOut", "#trPaneOut"], ["past", "#trTabPast", "#trPanePast"]].forEach(function (x) {
      $(x[1]).setAttribute("aria-selected", String(x[0] === p)); $(x[2]).hidden = x[0] !== p;
    });
  }
  $("#trTabNew").onclick = function () { setPane("new"); }; $("#trTabIn").onclick = function () { setPane("in"); };
  $("#trTabOut").onclick = function () { setPane("out"); }; $("#trTabPast").onclick = function () { setPane("past"); };
  function offerCard(t, kind) {
    var el = document.createElement("article"); el.className = "tr-offer " + kind + (t.status !== "open" ? " " + t.status : "");
    var when = kind === "past" && t.decidedAt ? t.decidedAt : t.createdAt;
    var who = kind === "in" ? "<b>" + esc(t.with) + "</b> wants to trade" : kind === "out" ? "Waiting on <b>" + esc(t.with) + "</b>" : "With <b>" + esc(t.with) + "</b>";
    var side = function (label, cards, whose) {
      return '<div class="tr-o-side"><small>' + label + '</small><div class="tr-o-cards">' + cards.map(function (c) {
        return BY_NUM[c.num] ? '<button type="button" class="tr-view" data-num="' + c.num + '" data-serial="' + esc(c.serial) + '" data-whose="' + whose + '" aria-label="See ' + esc(BY_NUM[c.num].name) + '">' + miniCard(c.num, { serial: c.serial }) + '</button>' : "";
      }).join("") + '</div>' + (whose === "you" ? goodsChips(t.youGivePacks, t.youGiveParts, t.youGiveBoosted, t.youGiveSpecials) : goodsChips(t.youGetPacks, t.youGetParts, t.youGetBoosted, t.youGetSpecials)) + '</div>';
    };
    el.innerHTML = '<header><button type="button" class="who-btn" data-who="' + esc(t.with) + '" aria-label="See ' + esc(t.with) + '\'s profile">' + avatar(t.with) + '</button><p>' + who + '<small>' + ago(when) + '</small></p>' + (kind === "past" ? '<span class="pill ' + t.status + '">' + t.status + '</span>' : "") + '</header>' +
      '<div class="tr-o-body">' + side("You give", t.youGive, "you") + '<span class="tr-o-arrow" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 9h13l-4-4M20 15H7l4 4"/></svg></span>' + side("You get", t.youGet, t.with) + '</div>' +
      '<p class="tr-tip">Tap a card to see it up close.</p>';
    el.querySelector(".who-btn").onclick = function () { openProfile(t.with); };
    Array.prototype.forEach.call(el.querySelectorAll(".tr-view"), function (b) {
      b.onclick = function () { viewCard(+b.dataset.num, { serial: b.dataset.serial, from: b.dataset.whose === "you" ? "You'd give this copy." : esc(b.dataset.whose) + " would give this copy." }); };
    });
    var row = document.createElement("div"); row.className = "tr-o-act";
    function act(label, cls, run) {
      var b = document.createElement("button"); b.type = "button"; b.className = cls; b.textContent = label;
      b.onclick = function () { b.disabled = true; run(b).then(null, function (e) { b.disabled = false; offline(e); loadTrades(); }); };
      row.appendChild(b);
    }
    if (kind === "in") {
      act("Accept trade", "cta small", function (b) {
        return api.acceptTrade(t.id).then(function (r) {
          var at = b.getBoundingClientRect();
          applyState(r.state); applyCollection(r.collection); TR = r.trades;
          t.youGet.forEach(function (c) { S.unseen[c.num] = 1; }); save(); loadSpecials();
          sfx.promote(); burst(at.left + at.width / 2, at.top + at.height / 2, 70, null, 9, true);
          paintStatus(); paintTabDot(); paintTradeDot(); paintTrades();
          say("Trade done with " + t.with + "!" + (t.youGet.length ? " " + t.youGet.length + (t.youGet.length === 1 ? " card is" : " cards are") + " in your binder" : "") +
            (t.youGetPacks ? " +" + t.youGetPacks + (t.youGetPacks === 1 ? " pack" : " packs") : "") + (t.youGetParts ? " +" + t.youGetParts + " parts" : "") +
            (r.sets.length ? " · " + r.sets.join(", ") + " set complete! +" + r.sets.length + (r.sets.length === 1 ? " pack" : " packs") : ""), 3800);
        });
      });
      act("Decline", "chip", function () { return api.declineTrade(t.id).then(function (x) { TR = x; paintTradeDot(); paintTrades(); }); });
    } else if (kind === "out") {
      act("Cancel offer", "chip", function () { return api.cancelTrade(t.id).then(function (x) { TR = x; paintTrades(); }); });
    }
    if (row.children.length) el.appendChild(row);
    return el;
  }
  function paintTrades() {
    function fill(id, list, kind, empty) {
      var box = $(id); box.innerHTML = "";
      if (!list.length) box.innerHTML = '<div class="tr-empty"><b>' + empty[0] + '</b>' + empty[1] + '</div>';
      list.forEach(function (t) { box.appendChild(offerCard(t, kind)); });
    }
    fill("#trIncoming", TR.incoming, "in", ["No offers right now", "When someone wants to trade with you, it shows up here."]);
    fill("#trOutgoing", TR.outgoing, "out", ["Nothing sent", "Offers you send wait here until they answer."]);
    paintHistory();
    paintTable(); paintGrid();
  }
  /* Trade history: totals at the top, a filter, and trades grouped by day, newest first. */
  var thFilter = "all";
  var TH_STATUS = { accepted: ["Completed", "✓"], declined: ["Declined", "✕"], cancelled: ["Cancelled", "↺"], failed: ["Called off", "!"] };
  function dayLabel(ms) {
    var d = new Date(ms), today = new Date(); today.setHours(0, 0, 0, 0);
    var diff = Math.round((today - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5);
    return diff === 0 ? "Today" : diff === 1 ? "Yesterday" : diff < 7 ? d.toLocaleDateString(undefined, { weekday: "long" }) : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
  }
  function paintHistory() {
    var all = TR.recent, done = all.filter(function (t) { return t.status === "accepted"; });
    var sum = function (k) { return done.reduce(function (a, t) { return a + (t[k] || (Array.isArray(t[k]) ? 0 : 0)); }, 0); };
    var got = done.reduce(function (a, t) { return a + t.youGet.length; }, 0), gave = done.reduce(function (a, t) { return a + t.youGive.length; }, 0);
    var packs = sum("youGetPacks") - sum("youGivePacks"), parts = sum("youGetParts") - sum("youGiveParts");
    var partners = {}; done.forEach(function (t) { partners[t.with] = 1; });
    var sign = function (n) { return (n > 0 ? "+" : "") + n; };
    $("#thStats").innerHTML = '<div><b>' + done.length + '</b><small>trades done</small></div><div><b>' + got + '<em>/' + gave + '</em></b><small>cards in / out</small></div>' +
      '<div><b>' + sign(packs) + '</b><small>packs</small></div><div><b>' + sign(parts) + '</b><small>parts</small></div><div><b>' + Object.keys(partners).length + '</b><small>partners</small></div>';
    var counts = { all: all.length }; all.forEach(function (t) { counts[t.status] = (counts[t.status] || 0) + 1; });
    var f = $("#thFilter"); f.innerHTML = "";
    ["all", "accepted", "declined", "cancelled", "failed"].forEach(function (k) {
      if (k !== "all" && !counts[k]) return;
      var b = document.createElement("button"); b.type = "button"; b.className = "chip" + (thFilter === k ? " on" : ""); b.setAttribute("aria-pressed", String(thFilter === k));
      b.innerHTML = (k === "all" ? "All" : TH_STATUS[k][0]) + ' <em>' + (counts[k] || 0) + '</em>';
      b.onclick = function () { thFilter = k; paintHistory(); }; f.appendChild(b);
    });
    if (thFilter !== "all" && !counts[thFilter]) thFilter = "all";
    var list = $("#trRecent"); list.innerHTML = "";
    var shown = all.filter(function (t) { return thFilter === "all" || t.status === thFilter; });
    if (!shown.length) { list.innerHTML = '<div class="tr-empty"><b>No trades yet</b>Finished, declined and cancelled trades show up here.</div>'; return; }
    var last = "";
    shown.forEach(function (t) {
      var when = t.decidedAt || t.createdAt, day = dayLabel(when);
      if (day !== last) { var h = document.createElement("h4"); h.className = "th-day"; h.textContent = day; list.appendChild(h); last = day; }
      var st = TH_STATUS[t.status] || [t.status, "·"], el = document.createElement("article"); el.className = "th-item " + t.status;
      var row = function (label, cards, packs, parts, whose, boosted, specials) {
        if (!cards.length && !packs && !parts && !boosted && !(specials || []).length) return "";
        return '<div class="th-row"><small>' + label + '</small><div class="th-cards">' + cards.map(function (c) {
          return BY_NUM[c.num] ? '<button type="button" class="tr-view th-card" data-num="' + c.num + '" data-serial="' + esc(c.serial) + '" data-whose="' + whose + '" aria-label="See ' + esc(BY_NUM[c.num].name) + '">' + miniCard(c.num, { serial: c.serial }) + '</button>' : "";
        }).join("") + goodsChips(packs, parts, boosted, specials) + '</div></div>';
      };
      var verb = t.status === "accepted" ? ["Got", "Gave"] : ["Would have got", "Would have given"];
      el.innerHTML = '<header><span class="th-icon" aria-hidden="true">' + st[1] + '</span><button type="button" class="who-btn" aria-label="See ' + esc(t.with) + '\'s profile">' + avatar(t.with) + '<b>' + esc(t.with) + '</b></button>' +
        '<span class="pill ' + t.status + '">' + st[0] + '</span><time>' + new Date(when).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) + '</time></header>' +
        row(verb[0], t.youGet, t.youGetPacks, t.youGetParts, t.with, t.youGetBoosted, t.youGetSpecials) + row(verb[1], t.youGive, t.youGivePacks, t.youGiveParts, "you", t.youGiveBoosted, t.youGiveSpecials) +
        (t.status === "failed" ? '<p class="th-note">Someone no longer had a card, pack or parts in it, so it was called off.</p>' : '');
      el.querySelector(".who-btn").onclick = function () { openProfile(t.with); };
      Array.prototype.forEach.call(el.querySelectorAll(".tr-view"), function (b) {
        b.onclick = function () { viewCard(+b.dataset.num, { serial: b.dataset.serial, from: b.dataset.whose === "you" ? "Your copy in this trade." : esc(b.dataset.whose) + "'s copy in this trade." }); };
      });
      list.appendChild(el);
    });
  }
  /* The table: your side, their side, and how even it looks. */
  /* Which exact copy (serial number) each card on the table is: the one you picked, or 0 for "any". */
  function ownSerials(n) { return (S.inv[n] || []).map(Number); }
  function serialOf(side, nums, i) {
    var n = nums[i], k = nums.slice(0, i).filter(function (x) { return x === n; }).length, arr = trSerials[side][n], v = arr && arr[k] ? +arr[k] : 0;
    var valid = side === "give" ? ownSerials(n) : (theirSer[n] || []).map(Number);
    return v && valid.indexOf(v) >= 0 ? v : 0;
  }
  function serialsFor(side, nums) { return nums.map(function (n, i) { return serialOf(side, nums, i); }); }
  /* Choose which copies of a card go on the table. */
  function openCopies(side, n) {
    var box = $("#trCopies"), mine = side === "give", all = mine ? ownSerials(n) : (theirSer[n] || []).map(Number);
    var held = mine ? heldCopies() : {}, chosen = (trSerials[side][n] || []).filter(function (x) { return x && all.indexOf(+x) >= 0; }).map(Number);
    var t = BY_NUM[n];
    box.innerHTML = '<div class="tc-h"><b>' + esc(t.name) + ' <small>' + n + '</small></b><button type="button" class="linkbtn" id="tcDone">Done</button></div><p class="tc-s">Pick the copies to ' + (mine ? "give" : "ask for") + '. Low serials are worth more.</p><div class="tc-chips"></div>';
    var chips = box.querySelector(".tc-chips");
    all.slice().sort(function (a, b) { return a - b; }).forEach(function (sn) {
      var b = document.createElement("button"); b.type = "button"; b.className = "tc-chip" + (chosen.indexOf(sn) >= 0 ? " on" : "") + (sn <= 10 ? " low" : "") + (sn === n ? " match" : "");
      b.textContent = "No. " + sn; if (held[n + ":" + sn]) { b.disabled = true; b.title = "In a pack or another offer"; }
      b.onclick = function () {
        var arr = mine ? trGive : trGet, i = chosen.indexOf(sn), others = arr.filter(function (x) { return x !== n; }).length;
        if (i >= 0) chosen.splice(i, 1); else { if (others + chosen.length >= MAXT) return say("Up to " + MAXT + " cards on each side.", 1800); chosen.push(sn); }
        chosen.sort(function (a, c) { return a - c; });
        for (var k = arr.length - 1; k >= 0; k--) if (arr[k] === n) arr.splice(k, 1);
        chosen.forEach(function () { arr.push(n); }); trSerials[side][n] = chosen.slice(); trFresh[(mine ? "give" : "get") + n] = 1;
        b.classList.toggle("on", i < 0); sfx.tick(); paintTable(); paintCopiesLabel();
      };
      chips.appendChild(b);
    });
    function paintCopiesLabel() { /* the grid behind updates when this closes */ }
    $("#tcDone").onclick = function () { box.hidden = true; paintTable(); paintGrid(); };
    box.hidden = false;
  }
  function slots(box, nums, side) {
    box.innerHTML = "";
    for (var i = 0; i < MAXT; i++) {
      var n = nums[i], s = document.createElement("button"); s.type = "button";
      if (n) {
        var sv = serialOf(side, nums, i);
        s.className = "tr-slot full" + (trFresh[side + n] ? " pop" : ""); s.innerHTML = miniCard(n, sv ? { serial: sv } : {}) + '<span class="tr-x" aria-hidden="true">×</span>';
        s.setAttribute("aria-label", "Remove " + BY_NUM[n].name + (sv ? ", No. " + sv : ""));
        s.onclick = (function (n, i) { return function () {
          var arr = side === "give" ? trGive : trGet, k = arr.slice(0, i).filter(function (x) { return x === n; }).length, sa = trSerials[side][n];
          if (sa && sa.length) sa.splice(k, 1);
          arr.splice(i, 1); sfx.tick(); paintTable(); paintGrid(); }; })(n, i);
        // Drag a card off the table to take it back.
        draggable(s, { targets: function () { return [$("#trBrowse")]; }, drop: (function (s, sideEl) { return function (t, x, y) { var r = sideEl.getBoundingClientRect(); if (t || x < r.left || x > r.right || y < r.top || y > r.bottom) s.onclick(); }; })(s, box.closest(".tr-side")) });
      } else {
        s.className = "tr-slot"; s.innerHTML = '<span class="tr-plus" aria-hidden="true">+</span>';
        s.setAttribute("aria-label", side === "give" ? "Add one of your cards" : "Add one of their cards");
        s.onclick = function () { openSheet(side === "give" ? "mine" : "theirs", "cards"); };
      }
      box.appendChild(s);
    }
    trFresh = {};
  }
  var theirWish = [];
  /* What lines up: cards they have that you want, and cards you have that they want. */
  function paintMatch() {
    var el = $("#trMatch"), mine = myInv();
    if (!theirName || !theirInv) { el.hidden = true; return; }
    var iWant = (S.wishlist || []).filter(function (n) { return theirInv[n]; }).length, theyWant = theirWish.filter(function (n) { return mine[n]; }).length;
    el.hidden = !iWant && !theyWant;
    el.textContent = [iWant ? theirName + " has " + iWant + " from your wishlist" : "", theyWant ? "you have " + theyWant + " they want" : ""].filter(Boolean).join(" · ") + ". They're marked below.";
  }
  $("#trThemBtn").onclick = function () { if (theirName) openProfile(theirName); };
  function paintTable() {
    var mine = myInv(), seen = {}; trGive = trGive.filter(function (n) { seen[n] = (seen[n] || 0) + 1; return seen[n] <= (mine[n] || 0); });
    slots($("#trGiveSlots"), trGive, "give"); slots($("#trGetSlots"), trGet, "get");
    $("#trGiveN").textContent = trGive.length + " / " + MAXT; $("#trGetN").textContent = trGet.length + " / " + MAXT;
    $("#avThem").outerHTML = avatar(theirName || "?", "them" + (theirName ? "" : " empty")).replace('class="av', 'id="avThem" class="av');
    $("#trThemName").textContent = theirName || "Pick a player";
    $("#trPaneNew").classList.toggle("picking", !theirName);
    goodsControls($("#trGiveGoods"), "give"); goodsControls($("#trGetGoods"), "get");
    var g = worth(trGive) + trSpec.give.length * 800 + trGoods.givePacks * PACK_WORTH + trGoods.giveBoosted * S.boostCost + trGoods.giveParts, w = worth(trGet) + trSpec.want.length * 800 + trGoods.wantPacks * PACK_WORTH + trGoods.wantBoosted * S.boostCost + trGoods.wantParts;
    var total = g + w, bar = $("#trFairBar"), txt = $("#trFairTxt");
    var lean = total ? (w - g) / total : 0; // -1: you give it all, +1: you get it all
    bar.style.setProperty("--lean", lean.toFixed(3)); bar.parentNode.hidden = !total;
    txt.textContent = !total ? "" : Math.abs(lean) < .2 ? "Looks even" : lean > 0 ? (lean > .6 ? "A big ask" : "You get more") : (lean < -.6 ? "Very generous" : "You give more");
    var giving = trGive.length || trSpec.give.length || trGoods.givePacks || trGoods.giveBoosted || trGoods.giveParts, getting = trGet.length || trSpec.want.length || trGoods.wantPacks || trGoods.wantBoosted || trGoods.wantParts;
    var ready = theirName && giving && getting;
    trSend.disabled = !ready; paintMatch();
    $("#trSummary").textContent = !theirName ? "Start by picking who to trade with." : !giving && !getting ? "Put cards, packs or parts on the table." :
      !giving ? "Add something you're giving." : !getting ? "Add something you want from " + theirName + "." : "Ready to send to " + theirName + ".";
  }
  function myInv() { var m = {}; Object.keys(S.inv).forEach(function (k) { if (S.inv[k].length) m[k] = S.inv[k].length; }); return m; }
  /* The card shelf under the table: your cards or theirs, searchable, by rarity. Tap to put one on the table. */
  function paintGrid() {
    var mineSide = trSide === "mine", inv = mineSide ? myInv() : theirInv, picked = mineSide ? trGive : trGet, q = trPickQ.value.trim().toLowerCase();
    $("#trPickMine").setAttribute("aria-selected", String(mineSide)); $("#trPickTheirs").setAttribute("aria-selected", String(!mineSide));
    $("#trPickMine").textContent = trKind === "goods" ? "Your packs" : "Your cards";
    $("#trPickTheirs").textContent = theirName ? theirName + (trKind === "goods" ? "'s packs" : "'s cards") : (trKind === "goods" ? "Their packs" : "Their cards");
    $("#trSheetT").textContent = trSide === "mine" ? "Your stuff" : (theirName || "Their") + "'s stuff";
    $("#trKindCards").setAttribute("aria-selected", String(trKind === "cards")); $("#trKindGoods").setAttribute("aria-selected", String(trKind === "goods"));
    $("#trBrowse").classList.toggle("goods-mode", trKind === "goods");
    if (trKind === "goods") { $("#trTierF").innerHTML = ""; paintGoodsPicker(); return; }
    var tf = $("#trTierF"); tf.innerHTML = "";
    ["all"].concat(ORDER).forEach(function (t) {
      var b = document.createElement("button"); b.type = "button"; b.className = "chip" + (trTier === t ? " on" : ""); b.setAttribute("aria-pressed", String(trTier === t));
      b.textContent = t === "all" ? "All" : TIERS[t].label; if (t !== "all") b.style.color = TIERS[t].color;
      b.onclick = function () { trTier = t; paintGrid(); }; tf.appendChild(b);
    });
    trGrid.innerHTML = "";
    if (!inv) { trGrid.innerHTML = '<div class="tr-empty"><b>Whose cards?</b>Type a player\'s username above to see what they have.</div>'; return; }
    var list = Object.keys(inv).map(Number).filter(function (n) { return BY_NUM[n] && inv[n] > 0 && (trTier === "all" || BY_NUM[n].tier === trTier) && (!q || matches(BY_NUM[n], q)); })
      .sort(function (a, b) { var A = BY_NUM[a], B = BY_NUM[b]; return ORDER.indexOf(A.tier) - ORDER.indexOf(B.tier) || A.rank - B.rank; });
    if (!list.length) { trGrid.innerHTML = '<div class="tr-empty"><b>' + (q || trTier !== "all" ? "No cards match" : mineSide ? "Your binder is empty" : "No cards yet") + '</b>' + (q || trTier !== "all" ? "Try another search or rarity." : mineSide ? "Open some packs first." : "They haven't opened any packs.") + '</div>'; return; }
    var specs = mineSide ? SPECIALS : theirSpecials;
    if (specs.length) {
      var sr = document.createElement("div"); sr.className = "tr-spec"; sr.innerHTML = '<h3 class="sp-h">Special editions</h3>';
      var srow = document.createElement("div"); srow.className = "sp-row";
      specs.forEach(function (sp) {
        var list2 = trSpec[mineSide ? "give" : "want"], on2 = list2.indexOf(sp.id) >= 0;
        var b = document.createElement("button"); b.type = "button"; b.className = "sp-thumb" + (on2 ? " on" : ""); b.appendChild(specialCardEl(sp));
        b.setAttribute("aria-pressed", String(on2));
        b.onclick = function () { var i = list2.indexOf(sp.id); if (i >= 0) list2.splice(i, 1); else if (list2.length < MAXT) list2.push(sp.id); sfx.pick(); paintTable(); paintGrid(); };
        srow.appendChild(b);
      });
      sr.appendChild(srow); trGrid.appendChild(sr);
    }
    list.slice(0, 80).forEach(function (n) {
      var cnt = picked.filter(function (x) { return x === n; }).length, on = cnt > 0, cell = document.createElement("div"), b = document.createElement("button");
      cell.className = "tr-cell";
      b.type = "button"; b.className = "tr-pick" + (on ? " on" : ""); b.setAttribute("aria-pressed", String(on));
      b.setAttribute("aria-label", BY_NUM[n].name + ", team " + n + ", " + TIERS[BY_NUM[n].tier].label + (inv[n] > 1 ? ", " + inv[n] + " copies" : "") + (mineSide && inv[n] === 1 ? ", your only copy" : ""));
      b.innerHTML = miniCard(n, { count: inv[n] }) + (cnt ? '<span class="tr-on-n">' + (inv[n] > 1 ? cnt + " of " + inv[n] : "On table") + '</span>' : "") + (mineSide && inv[n] === 1 ? '<span class="tr-only">Only copy</span>' : "") +
        (mineSide && theirWish.indexOf(n) >= 0 ? '<span class="tr-want">They want</span>' : !mineSide && wished(n) ? '<span class="tr-want mine">♥ Your list</span>' : "");
      /* Each tap puts one more copy on the table; once every copy is there, the next tap takes them all back. */
      b.onclick = function () {
        if (inv[n] > 1) { openCopies(mineSide ? "give" : "get", n); return; }
        var have = picked.filter(function (x) { return x === n; }).length;
        if (have >= inv[n]) { for (var k = picked.length - 1; k >= 0; k--) if (picked[k] === n) picked.splice(k, 1); sfx.tick(); }
        else if (picked.length >= MAXT) return say("Up to " + MAXT + " cards on each side.", 1800);
        else { picked.push(n); trFresh[(mineSide ? "give" : "get") + n] = 1; sfx.pick(); }
        paintTable(); paintGrid();
      };
      // Or drag it onto the table.
      draggable(b, { targets: function () { return [$(".tr-side." + (mineSide ? "mine" : "theirs"))]; }, drop: function (t) { if (t && picked.filter(function (x) { return x === n; }).length < inv[n]) b.onclick(); } });
      var info = document.createElement("button"); info.type = "button"; info.className = "tr-info"; info.textContent = "i";
      info.setAttribute("aria-label", "See " + BY_NUM[n].name + " up close");
      info.onclick = function () { viewCard(n, { action: { label: on ? "Take it off the table" : "Put it on the table", run: function () { b.onclick(); } }, from: mineSide ? "You have " + (inv[n] === 1 ? "1 copy" : inv[n] + " copies") + "." : esc(theirName) + " has " + (inv[n] === 1 ? "1 copy" : inv[n] + " copies") + "." }); };
      cell.appendChild(b); cell.appendChild(info); trGrid.appendChild(cell);
    });
    if (list.length > 80) { var more = document.createElement("p"); more.className = "tr-more"; more.textContent = "Showing 80 of " + list.length + ". Search to find the rest."; trGrid.appendChild(more); }
  }
  /* The picker is a sheet that slides up over the offer. */
  function openSheet(side, kind) { trSide = side; if (kind) trKind = kind; $("#trBrowse").classList.add("open"); document.body.classList.add("tr-sheet"); paintGrid(); refreshShelves(); }
  /* While trading, both shelves stay current: a card may have been traded or scrapped since they were loaded. Cards
     that left are taken off the table with a note, instead of the offer failing later. */
  var shelfSig = { mine: "", theirs: "" };
  function refreshShelves() {
    if (vTrade.hidden || document.hidden) return;
    api.collection(PACK_ID).then(function (c) {
      var sig = JSON.stringify(c); if (sig === shelfSig.mine) return; shelfSig.mine = sig; // nothing changed: leave the grid alone
      applyCollection(c);
      var keep = trGive.filter(function (n) { return (S.inv[n] || []).length; });
      if (keep.length !== trGive.length) { trGive = keep; say("A card you put on the table isn't in your binder any more, so it came off.", 3200); }
      paintTable(); paintGrid();
    }, function () {});
    if (!theirName) return;
    var name = theirName;
    api.playerCollection(name, PACK_ID).then(function (col) {
      var sig = name + JSON.stringify(col);
      if (theirName !== name || sig === shelfSig.theirs) return; shelfSig.theirs = sig;
      theirInv = {}; theirSer = {};
      col.cards.forEach(function (c) { if (BY_NUM[c.num]) { theirInv[c.num] = c.serials.length; theirSer[c.num] = c.serials.slice(); } });
      var keep = trGet.filter(function (n) { return theirInv[n]; });
      if (keep.length !== trGet.length) { trGet = keep; say(name + " doesn't have one of those cards any more, so it came off the table.", 3200); }
      paintTable(); paintGrid();
    }, function () {});
  }
  setInterval(refreshShelves, 15000);
  function closeSheet() { $("#trBrowse").classList.remove("open"); document.body.classList.remove("tr-sheet"); }
  Array.prototype.forEach.call(document.querySelectorAll(".tr-add"), function (b) { b.onclick = function () { openSheet(b.dataset.side, "cards"); }; });
  $("#trSheetX").onclick = closeSheet; $("#trScrim").onclick = closeSheet;
  /* Swipe down to close a sheet or full-screen panel on a touch screen. The drag starts from the top of the panel, or
     from anywhere once its list is scrolled to the top, and it follows the finger; past about 110px (or a quick flick)
     it closes, otherwise it springs back. Controls that have their own drag (cards you tilt, the showcase order,
     sliders, text fields) are left alone. */
  function swipeToClose(panel, scroller, topZone, close) {
    var y0 = 0, t0 = 0, dy = 0, live = false, armed = false;
    var own = ".slot, input, select, textarea, .pf-show, .tr-slot, [draggable=true]";
    panel.addEventListener("touchstart", function (e) {
      armed = false; live = false; dy = 0;
      if (e.touches.length !== 1 || e.target.closest(own)) return;
      var y = e.touches[0].clientY;
      var atTop = !scroller() || scroller().scrollTop <= 0;
      armed = atTop || y - panel.getBoundingClientRect().top < topZone;
      y0 = y; t0 = Date.now();
    }, { passive: true });
    panel.addEventListener("touchmove", function (e) {
      if (!armed) return;
      dy = e.touches[0].clientY - y0;
      if (!live) {
        if (dy < 10) { if (dy < -10) armed = false; return; }
        live = true; panel.style.transition = "none";
      }
      e.preventDefault();
      panel.style.transform = "translateY(" + Math.max(0, dy) + "px)";
    }, { passive: false });
    function end() {
      if (!live) return;
      live = false; armed = false;
      var quick = dy > 40 && Date.now() - t0 < 250;
      panel.style.transition = "transform .2s ease-out";
      if (dy > 110 || quick) { close(); setTimeout(function () { panel.style.transition = ""; panel.style.transform = ""; }, 300); }
      else { panel.style.transform = ""; setTimeout(function () { panel.style.transition = ""; }, 220); }
    }
    panel.addEventListener("touchend", end);
    panel.addEventListener("touchcancel", end);
  }
  swipeToClose($("#trBrowse"), function () { return $("#trGrid"); }, 120, closeSheet);
  swipeToClose($("#modalIn"), function () { return $("#modalIn"); }, 90, function () { closeModal(); });
  addEventListener("keydown", function (e) { if (e.key === "Escape" && $("#trBrowse").classList.contains("open")) closeSheet(); });
  $("#trKindCards").onclick = function () { trKind = "cards"; paintGrid(); };
  $("#trKindGoods").onclick = function () { trKind = "goods"; paintGrid(); };
  $("#trPickMine").onclick = function () { trSide = "mine"; paintGrid(); };
  $("#trPickTheirs").onclick = function () { trSide = "theirs"; paintGrid(); if (!theirName) try { trWho.focus(); } catch (e) {} };
  trPickQ.addEventListener("input", paintGrid);
  function loadTheirs(force) {
    var name = trWho.value.trim();
    if (!name || (!force && name.toLowerCase() === theirName.toLowerCase())) return;
    var n = ++theirsReq;
    api.playerCollection(name, PACK_ID).then(function (col) {
      if (n !== theirsReq || trWho.value.trim().toLowerCase() !== name.toLowerCase()) return; // they typed on
      if (name.toLowerCase() !== theirName.toLowerCase()) { trGet = []; trSide = "theirs"; }
      theirName = name; theirInv = {}; theirWish = [];
      theirGoods = null; trGoods.wantPacks = trGoods.wantBoosted = trGoods.wantParts = 0; trSpec.want = []; theirSpecials = []; trSerials.get = {};
      api.playerSpecials(name).then(function (l) { if (theirName === name) { theirSpecials = l; paintTable(); paintGrid(); } }, function () {});
      api.profile(name, PACK_ID).then(function (p) { if (theirName === name) { theirWish = p.wishlist; theirGoods = { packs: p.packs, boosted: p.boosted, parts: p.parts }; paintTable(); paintGrid(); paintMatch(); } }, function () {});
      theirSer = {}; col.cards.forEach(function (c) { if (BY_NUM[c.num]) { theirInv[c.num] = c.serials.length; theirSer[c.num] = c.serials.slice(); } });
      if (pendingWant && theirInv[pendingWant] && trGet.indexOf(pendingWant) < 0 && trGet.length < MAXT) { trGet.push(pendingWant); trFresh["get" + pendingWant] = 1; trSide = "theirs"; }
      if (pendingGive && (S.inv[pendingGive] || []).length && trGive.indexOf(pendingGive) < 0 && trGive.length < MAXT) { trGive.push(pendingGive); trFresh["give" + pendingGive] = 1; }
      pendingWant = pendingGive = 0;
      $("#trSugg").innerHTML = ""; paintTable(); paintGrid();
    }, function (e) { if (n !== theirsReq) return; theirInv = null; theirName = ""; trGet = []; paintTable(); paintGrid(); if (e && e.code === "unknown_player") $("#trSummary").textContent = "There's no player named " + name + "."; else offline(e); });
  }
  /* Matching players appear as chips under the box as you type. */
  trWho.addEventListener("input", function () {
    clearTimeout(whoTimer); paintPeople();
    var q = trWho.value.trim();
    if (theirName && q.toLowerCase() !== theirName.toLowerCase()) { theirName = ""; theirInv = null; trGet = []; paintTable(); paintGrid(); }
    whoTimer = setTimeout(function () {
      var box = $("#trSugg");
      if (q.length < 1) { box.innerHTML = ""; return; }
      api.players(q).then(function (names) {
        if (trWho.value.trim() !== q) return;
        box.innerHTML = "";
        names.forEach(function (nm) {
          var b = document.createElement("button"); b.type = "button"; b.className = "tr-sug"; b.innerHTML = avatar(nm) + "<span>" + esc(nm) + "</span>";
          b.onclick = function () { trWho.value = nm; box.innerHTML = ""; loadTheirs(); };
          box.appendChild(b);
        });
        if (!names.length && q.length > 1) box.innerHTML = '<span class="tr-nobody">No players match "' + esc(q) + '"</span>';
        if (names.some(function (nm) { return nm.toLowerCase() === q.toLowerCase(); })) loadTheirs();
      }, function () {});
    }, 200);
  });
  trWho.addEventListener("change", function () { loadTheirs(); });
  trWho.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); var first = $("#trSugg .tr-sug"); if (first) first.click(); else loadTheirs(); } });
  trSend.addEventListener("click", function () {
    if (trSend.disabled) return; trSend.disabled = true; closeSheet();
    var r = trSend.getBoundingClientRect();
    api.offerTrade(theirName, PACK_ID, trGive, trGet, Object.assign({}, trGoods, { giveSpecials: trSpec.give, wantSpecials: trSpec.want, giveSerials: serialsFor("give", trGive), wantSerials: serialsFor("get", trGet) })).then(function (t) {
      TR = t; trGive = []; trGet = []; trSerials = { give: {}, get: {} }; trSpec = { give: [], want: [] }; trGoods = { givePacks: 0, wantPacks: 0, giveBoosted: 0, wantBoosted: 0, giveParts: 0, wantParts: 0 }; sfx.whoosh(); burst(r.left + r.width / 2, r.top + r.height / 2, 30, "#27d3c3", 6);
      say("Offer sent to " + theirName + ". You'll see it under Sent until they answer.", 3000);
      loadTheirs(true); paintTrades(); paintTradeDot();
    }, function (e) { offline(e); paintTable(); });
  });
  /* Open the trading post on the offers waiting for you, if there are any. */
  function enterTrade() { setPane(TR.incoming.length ? "in" : trPane === "in" && !TR.incoming.length ? "new" : trPane); $("#avMe").outerHTML = avatar(ME, "me").replace('class="av', 'id="avMe" class="av'); }
  /* Check for new offers now and then, so the tab dot shows up without a reload. */
  setInterval(function () { if (!document.hidden) loadTrades(); }, 60000);



  /* ---------- special editions: numbered limited cards ---------- */
  var SPECIALS = [];
  function pad3(n) { return String(n).padStart(3, "0"); }
  function specialCardEl(sp) {
    var el = document.createElement("div"); el.className = "spc";
    el.setAttribute("aria-label", sp.name + ", team " + sp.team + ", " + sp.title + ", number " + sp.serial + " of " + sp.total);
    el.innerHTML = '<div class="spc-in"><div class="spc-lines"></div><div class="spc-glow"></div>' +
      '<div class="spc-hd"><div class="spc-num"><small>TEAM</small>' + sp.team + '</div><div class="spc-ed">Beta Edition<b>' + pad3(sp.serial) + ' / ' + sp.total + '</b></div></div>' +
      '<div class="spc-photo"><img src="/photos/' + sp.team + '.webp" alt="" draggable="false"></div>' +
      '<div class="spc-bot"><div class="spc-nm">' + esc(sp.name) + '<small>' + esc(sp.title) + '</small></div><div class="spc-sn">LIMITED<b>No. ' + pad3(sp.serial) + '</b></div></div>' +
      '<div class="spc-sheen"></div><div class="spc-glare"></div><canvas class="spc-fx"></canvas></div>';
    var cv = el.querySelector("canvas"), ctx = cv.getContext("2d"), dots = [], alive = true;
    function size() { cv.width = (el.clientWidth || 200) * 2; cv.height = (el.clientHeight || 280) * 2; dots = []; for (var i = 0; i < 24; i++) dots.push({ x: Math.random(), y: Math.random(), r: Math.random() * 2 + .6, p: Math.random() * 6.28, s: .4 + Math.random() * 1.2 }); }
    function tick(t) {
      if (!alive || !el.isConnected) { alive = false; return; }
      if (!RM) { ctx.clearRect(0, 0, cv.width, cv.height); dots.forEach(function (d) { var a = .2 + .8 * Math.abs(Math.sin(t / 700 * d.s + d.p)); ctx.fillStyle = "rgba(255,255,255," + a.toFixed(2) + ")"; var x = d.x * cv.width, y = d.y * cv.height, r = d.r * 2; ctx.beginPath(); ctx.moveTo(x, y - r * 2); ctx.lineTo(x + r * .5, y - r * .5); ctx.lineTo(x + r * 2, y); ctx.lineTo(x + r * .5, y + r * .5); ctx.lineTo(x, y + r * 2); ctx.lineTo(x - r * .5, y + r * .5); ctx.lineTo(x - r * 2, y); ctx.lineTo(x - r * .5, y - r * .5); ctx.fill(); }); }
      requestAnimationFrame(tick);
    }
    setTimeout(function () { size(); requestAnimationFrame(tick); }, 30);
    function move(e) { var r = el.getBoundingClientRect(), x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
      el.classList.remove("rest"); el.style.setProperty("--mx", x * 100 + "%"); el.style.setProperty("--my", y * 100 + "%"); el.style.setProperty("--ry", ((x - .5) * 26) + "deg"); el.style.setProperty("--rx", ((.5 - y) * 22) + "deg"); }
    function leave() { el.classList.add("rest"); el.style.setProperty("--rx", "0deg"); el.style.setProperty("--ry", "0deg"); el.style.setProperty("--mx", "50%"); el.style.setProperty("--my", "50%"); }
    el.addEventListener("pointermove", move); el.addEventListener("pointerdown", function (e) { try { el.setPointerCapture(e.pointerId); } catch (er) {} move(e); });
    el.addEventListener("pointerleave", leave); el.addEventListener("pointerup", leave); el.addEventListener("pointercancel", leave);
    return el;
  }
  function specialScreen(sp) {
    var wrap = document.createElement("div"); wrap.className = "spc-wrap"; wrap.appendChild(specialCardEl(sp)); modalIn.appendChild(wrap);
    var info = document.createElement("div"); info.className = "serials"; info.innerHTML = "<b>" + esc(sp.title) + "</b><br>Copy " + sp.serial + " of " + sp.total + ". Only " + sp.total + " will ever exist."; modalIn.appendChild(info);
    var row = document.createElement("div"); row.className = "cta-row"; var close = closeButton(); row.appendChild(close); modalIn.appendChild(row);
    return close;
  }
  function specialRow(list, host) {
    host.innerHTML = ""; host.hidden = !list.length; if (!list.length) return;
    var h = document.createElement("h3"); h.className = "sp-h"; h.textContent = "Special editions"; host.appendChild(h);
    var row = document.createElement("div"); row.className = "sp-row";
    list.forEach(function (sp) { var b = document.createElement("button"); b.type = "button"; b.className = "sp-thumb"; b.appendChild(specialCardEl(sp)); b.onclick = function () { present(function () { return specialScreen(sp); }); }; row.appendChild(b); });
    host.appendChild(row);
  }
  function loadSpecials() { return api.specials().then(function (l) { SPECIALS = l; specialRow(l, spHost); }, function () {}); }
  var spHost = document.createElement("div"); spHost.className = "sp-host"; spHost.hidden = true;
  (function () { var g = $("#grid"); g.parentNode.insertBefore(spHost, g); })();

  /* ---------- social: every player, and the latest trades ---------- */
  var SOCIAL = null, socBy = "teams", socReq = 0, seenEv = null;
  var socSig = "";
  function loadSocial() {
    var n = ++socReq;
    return api.social(PACK_ID).then(function (d) { if (n !== socReq) return; var sig = JSON.stringify(d); if (SOCIAL && sig === socSig && !vSocial.hidden) return; socSig = sig; SOCIAL = d; if (!vSocial.hidden) { paintSocial(); paintActivity(); } paintPeople(); }, function () {});
  }
  function badgeHTML(b) { return b ? ' <span class="tagbadge">' + esc(b) + '</span>' : ""; }
  function whoLabel(p) { return (p.firstName ? esc(p.firstName) + ' <small>' + esc(p.name) + '</small>' : esc(p.name)) + badgeHTML(p.badge); }
  function paintSocial() {
    var list = $("#socList"), feed = $("#socFeed"); if (!SOCIAL) { list.innerHTML = ""; feed.innerHTML = ""; return; }
    var rows = SOCIAL.players.slice().sort(function (a, b) { return (b[socBy] - a[socBy]) || (b.teams - a.teams); });
    list.innerHTML = "";
    rows.forEach(function (p, i) {
      var r = document.createElement("div"); r.className = "soc-row";
      r.innerHTML = '<i>' + (i + 1) + '</i><button type="button" class="soc-who">' + avatar(p.name) + '<span>' + whoLabel(p) + '</span></button>' +
        '<span class="soc-stats"><b>' + p[socBy] + '</b> ' + socBy + '</span>' +
        (p.name.toLowerCase() === (ME || "").toLowerCase() ? '' : '<button type="button" class="chip soc-trade">Trade</button>');
      r.querySelector(".soc-who").onclick = function () { openProfile(p.name); };
      var tb = r.querySelector(".soc-trade"); if (tb) tb.onclick = function () { tradeFor(p.name); };
      list.appendChild(r);
    });
    feed.innerHTML = "";
    if (!SOCIAL.recent.length) feed.innerHTML = '<p class="soc-none">No trades yet.</p>';
    SOCIAL.recent.forEach(function (t) {
      var side = function (cards, packs) { var bits = (cards || []).map(function (c) { return BY_NUM[c.num] ? c.num : ""; }).filter(Boolean); if (packs) bits.push(packs + (packs === 1 ? " pack" : " packs")); return bits.length ? bits.join(", ") : "parts"; };
      var d = document.createElement("div"); d.className = "soc-trade-row";
      d.innerHTML = '<b>' + esc(t.from) + '</b> gave ' + esc(side(t.gave, t.gavePacks)) + ' for ' + esc(side(t.got, t.gotPacks)) + ' from <b>' + esc(t.to) + '</b>';
      feed.appendChild(d);
    });
  }
  /* Activity: Mythic and Legendary pulls and trades, newest first. */
  function paintActivity() {
    var box = $("#socAct"); if (!box || !SOCIAL) return;
    var ev = (SOCIAL.activity || []).slice();
    (SOCIAL.recent || []).forEach(function (t) { ev.push({ kind: "trade", who: t.from, other: t.to, at: t.at, gave: t.gave, got: t.got }); });
    // Pulls show the team's rarity today (rarities changed in October 2026), not the one recorded at the time.
    ev.forEach(function (e) { if (e.kind === "pull" && BY_NUM[e.team]) e.tier = BY_NUM[e.team].tier; });
    ev = ev.filter(function (e) { return e.kind === "trade" || (e.kind === "pull" && (e.tier === "mythic" || e.tier === "legendary")); });
    ev.sort(function (a, b) { return b.at - a.at; });
    var first = !seenEv, now = {};
    box.innerHTML = ev.length ? "" : '<p class="soc-none">Nothing yet. Mythic and Legendary pulls and trades show up here.</p>';
    ev.slice(0, 30).forEach(function (e) {
      var d = document.createElement("div"); d.className = "soc-ev"; var html = "";
      if (e.kind === "pull" && BY_NUM[e.team]) {
        var T = TIERS[e.tier] || TIERS.common, t = BY_NUM[e.team], big = e.tier === "mythic" || e.tier === "legendary";
        html = '<span class="ev-i">' + (e.tier === "mythic" ? "\u2728" : e.tier === "legendary" ? "\ud83d\udc9c" : "\ud83c\udff7\ufe0f") + '</span><span class="ev-t"><b>' + esc(e.who) + '</b> pulled ' +
          (!big ? '<b>No. ' + e.serial + '</b> of ' : 'a <b style="color:' + T.color + '">' + T.label + '</b> \u00b7 ') + esc(t.name) + (big && e.serial <= 10 ? ' <span class="bdg g">No. ' + e.serial + '</span>' : '') + '</span>' +
          '<button type="button" class="ev-c" aria-label="See ' + esc(t.name) + '">' + miniCard(e.team, { serial: e.serial }) + '</button>';
      } else if (e.kind === "set") {
        html = '<span class="ev-i">\ud83c\udfc6</span><span class="ev-t"><b>' + esc(e.who) + '</b> finished the <b>' + esc(e.division) + '</b> set</span>';
      } else if (e.kind === "trade") {
        var side = function (cards) { return (cards || []).map(function (c) { return c.num; }).filter(function (n) { return BY_NUM[n]; }).join(", ") || "packs"; };
        html = '<span class="ev-i">\u21c4</span><span class="ev-t"><b>' + esc(e.who) + '</b> traded ' + esc(side(e.gave)) + ' to <b>' + esc(e.other) + '</b> for ' + esc(side(e.got)) + '</span>';
      } else return;
      d.innerHTML = html + '<time>' + ago(e.at) + '</time>';
      var key = e.kind + ":" + e.who + ":" + e.at; now[key] = 1; if (!first && !seenEv[key]) d.classList.add("fresh");
      var c = d.querySelector(".ev-c"); if (c) c.onclick = function () { viewCard(e.team, { serial: e.serial, from: esc(e.who) + "'s pull.", locked: !(S.inv[e.team] || []).length }); };
      box.appendChild(d);
    });
    seenEv = now;
  }
  /* Live: while Social is open and the page is visible, check for new activity every few seconds. */
  setInterval(function () { if (!document.hidden && !vSocial.hidden) loadSocial(); }, 8000);
  $("#socTabAct").onclick = function () { $("#socTabAct").setAttribute("aria-selected", "true"); $("#socTabPpl").setAttribute("aria-selected", "false"); $("#socAct").hidden = false; $("#socPpl").hidden = true; };
  $("#socTabPpl").onclick = function () { $("#socTabAct").setAttribute("aria-selected", "false"); $("#socTabPpl").setAttribute("aria-selected", "true"); $("#socAct").hidden = true; $("#socPpl").hidden = false; };
  Array.prototype.forEach.call(document.querySelectorAll(".soc-sort button"), function (b) {
    b.onclick = function () { socBy = b.dataset.by; Array.prototype.forEach.call(document.querySelectorAll(".soc-sort button"), function (x) { x.setAttribute("aria-selected", String(x === b)); }); paintSocial(); };
  });
  /* Trading starts by picking a person from this list; the table appears once you have. */
  function paintPeople() {
    var box = $("#trPeople"); if (!box) return; box.innerHTML = "";
    if (!SOCIAL) return;
    var q = trWho.value.trim().toLowerCase();
    SOCIAL.players.filter(function (p) {
      return p.name.toLowerCase() !== (ME || "").toLowerCase() && (!q || p.name.toLowerCase().indexOf(q) >= 0 || (p.firstName || "").toLowerCase().indexOf(q) >= 0);
    }).forEach(function (p) {
      var b = document.createElement("button"); b.type = "button"; b.className = "tr-person";
      b.innerHTML = avatar(p.name) + '<span class="tp-n">' + whoLabel(p) + '</span><span class="tp-s">' + p.teams + ' teams</span>';
      b.onclick = function () { trWho.value = p.name; $("#trSugg").innerHTML = ""; loadTheirs(true); };
      box.appendChild(b);
    });
  }
  $("#trChange").onclick = function () { theirName = ""; theirInv = null; trGet = []; trWho.value = ""; paintTable(); paintGrid(); paintPeople(); };

  /* ---------- controller ---------- */
  /* Any standard gamepad (Xbox, PlayStation, Switch Pro in a browser that maps it): A takes / opens / flips, B goes
     back, X turns the pack over, Y reveals the rest, the d-pad or left stick moves, the sticks tilt what you're
     holding, LB / RB switch tabs and Start claims free packs. In the binder the d-pad moves between cards and
     buttons and A presses. */
  var PAD = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, BACK: 8, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
  var padPrev = [], padRaf = 0, padRep = { dir: "", at: 0 }, padTilt = false, padSeen = false;
  function pads() { try { return Array.prototype.filter.call(navigator.getGamepads ? navigator.getGamepads() : [], Boolean); } catch (e) { return []; } }
  function padRumble(ms) {
    var total = Array.isArray(ms) ? ms.reduce(function (a, b) { return a + b; }, 0) : ms;
    pads().forEach(function (p) { try { if (p.vibrationActuator) p.vibrationActuator.playEffect("dual-rumble", { duration: Math.min(total, 600), strongMagnitude: .7, weakMagnitude: .5 }); } catch (e) {} });
  }
  var buzzPhone = buzz;
  buzz = function (ms) { buzzPhone(ms); if (!S.muted && padSeen) padRumble(ms); };
  /* Moves focus to the nearest visible control in a direction, for the binder and the card view. */
  function padMove(dir, root) {
    var all = Array.prototype.filter.call(root.querySelectorAll("button:not([disabled]), [role=button][tabindex], .slot.btn, a[href], input"), function (el) { return el.offsetParent && el.getClientRects().length; });
    var cur = document.activeElement && root.contains(document.activeElement) ? document.activeElement : null;
    if (!cur) { if (all[0]) padFocus(all[0]); return; }
    var c = cur.getBoundingClientRect(), cx = c.left + c.width / 2, cy = c.top + c.height / 2, best = null, bestD = Infinity;
    all.forEach(function (el) {
      if (el === cur) return;
      var r = el.getBoundingClientRect(), dx = r.left + r.width / 2 - cx, dy = r.top + r.height / 2 - cy;
      var along = dir === "left" ? -dx : dir === "right" ? dx : dir === "up" ? -dy : dy, across = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
      if (along <= 4) return;
      var d = along + across * 2.5; if (d < bestD) { bestD = d; best = el; }
    });
    if (best) padFocus(best);
  }
  function padFocus(el) { try { el.focus({ preventScroll: true }); el.scrollIntoView({ block: "nearest", behavior: RM ? "auto" : "smooth" }); } catch (e) {} }
  function padPress(el) { if (el && el.click) el.click(); }
  function padDir(dir) {
    document.body.classList.add("pad");
    if (!modal.hidden) return padMove(dir, modal);
    if (!vBinder.hidden) return padMove(dir, vBinder);
    if (!vTrade.hidden) return padMove(dir, vTrade);
    if (state === "select" && (dir === "left" || dir === "right")) spinTo(Math.round(ringA / 36) * 36 + (dir === "left" ? -36 : 36), 220);
    else if (state === "stack" && (dir === "left" || dir === "right")) { var el = topEl(); if (el && !el._hidden) fling(el, dir === "right" ? 1 : -1); }
    else if (state === "summary" || state === "home") padMove(dir, vOpen);
  }
  function padButton(b) {
    actx(); document.body.classList.add("pad");
    if (b === PAD.LB || b === PAD.RB) {
      if (!modal.hidden) return;
      var tabs = ["open", "binder", "trade"], at = !vBinder.hidden ? 1 : !vTrade.hidden ? 2 : 0;
      show(tabs[(at + (b === PAD.LB ? 2 : 1)) % 3]); return;
    }
    if (b === PAD.START) { if (!claimBtn.hidden) padPress(claimBtn); return; }
    if (!modal.hidden) { if (b === PAD.A && modal.contains(document.activeElement)) padPress(document.activeElement); else if (b === PAD.A || b === PAD.B) closeModal(); return; }
    var page = !vBinder.hidden ? vBinder : !vTrade.hidden ? vTrade : null;
    if (page) {
      if (b === PAD.A) { var f = document.activeElement; if (f && page.contains(f)) { if (f.matches("input")) f.focus(); else padPress(f); } else padMove("down", page); }
      else if (b === PAD.B) show("open");
      return;
    }
    if (state === "home") { if (b === PAD.A) { var f2 = document.activeElement; if (f2 && vOpen.contains(f2) && f2.matches("button")) padPress(f2); else openRing(); } }
    else if (state === "select") { if (b === PAD.A) choose(ringFront < 0 ? Math.floor(SHELF_N / 2) : ringFront); else if (b === PAD.B) { cancelAnimationFrame(ringRaf); paintHome(); } }
    else if (state === "inspect") { if (b === PAD.A) padPress($("#openBtn")); else if (b === PAD.X) padPress($("#turnBtn")); else if (b === PAD.B) back(); }
    else if (state === "stack" || state === "flipping") { if (b === PAD.A) tapTop(); else if (b === PAD.Y) revealAll(); }
    else if (state === "summary") { if (b === PAD.A) { var f3 = document.activeElement; if (f3 && vOpen.contains(f3) && f3 !== againBtn) padPress(f3); else padPress(againBtn); } else if (b === PAD.B) paintHome(); else if (b === PAD.X) show("binder"); }
  }
  /* The sticks tilt the pack in your hand, or the card you're looking at. */
  function padSticks(p) {
    var ax = p.axes || [], x = Math.abs(ax[2] || 0) > .2 ? ax[2] : 0, y = Math.abs(ax[3] || 0) > .2 ? ax[3] : 0;
    if (state === "inspect" && modal.hidden && vBinder.hidden && !g) {
      if (x || y) { rotY = Math.round(rotY / 180) * 180 + x * 55; rotX = -y * 16; setRot(true); padTilt = true; }
      else if (padTilt) { padTilt = false; rotY = Math.round(rotY / 180) * 180; rotX = 0; setRot(false); }
      return;
    }
    var slot = !modal.hidden ? modal.querySelector(".slot") : state === "stack" ? topEl() : null;
    if (!slot) return;
    var tilt = slot.querySelector(".tilt");
    if (x || y) { tilt.classList.remove("rest"); tilt.style.setProperty("--ry", (x * 16) + "deg"); tilt.style.setProperty("--rx", (-y * 14) + "deg"); slot._padTilt = true; }
    else if (slot._padTilt) { slot._padTilt = false; tilt.classList.add("rest"); tilt.style.setProperty("--ry", "0deg"); tilt.style.setProperty("--rx", "0deg"); }
  }
  function padLoop() {
    padRaf = 0;
    var list = pads(); if (!list.length) { padPrev = []; return; }
    var now = performance.now(), dir = "";
    list.forEach(function (p, n) {
      if (p.mapping !== "standard") return; // button numbers below assume the standard layout
      var pi = p.index, prev = padPrev[pi] || [], cur = p.buttons.map(function (b) { return b.pressed || b.value > .5; });
      cur.forEach(function (down, i) { if (down && !prev[i] && i !== PAD.UP && i !== PAD.DOWN && i !== PAD.LEFT && i !== PAD.RIGHT) padButton(i); });
      padPrev[pi] = cur;
      var ax = p.axes || [];
      if (cur[PAD.LEFT] || ax[0] < -.55) dir = "left"; else if (cur[PAD.RIGHT] || ax[0] > .55) dir = "right";
      else if (cur[PAD.UP] || ax[1] < -.55) dir = "up"; else if (cur[PAD.DOWN] || ax[1] > .55) dir = "down";
      if (n === 0) padSticks(p);
    });
    /* A held direction repeats: once, then again after a pause, then steadily. */
    if (!dir) padRep.dir = "";
    else if (dir !== padRep.dir) { padRep = { dir: dir, at: now + 380 }; padDir(dir); }
    else if (now >= padRep.at) { padRep.at = now + 150; padDir(dir); }
    padRaf = requestAnimationFrame(padLoop);
  }
  addEventListener("gamepadconnected", function () {
    document.body.classList.add("pad");
    if (!padSeen) say("Controller connected · A select · B back · X turn over · Y reveal all · LB/RB tabs", 4200);
    padSeen = true; if (!padRaf) padRaf = requestAnimationFrame(padLoop);
  });
  addEventListener("gamepaddisconnected", function () { if (!pads().length) document.body.classList.remove("pad"); });
  /* Mouse or touch after a controller puts the focus rings back the way they were. */
  addEventListener("pointerdown", function () { document.body.classList.remove("pad"); }, true);
  if (pads().length) { document.body.classList.add("pad"); padSeen = true; padRaf = requestAnimationFrame(padLoop); }

  /* ---------- boot ---------- */
  function boot() {
    var hash = (location.hash || "").replace("#", "");
    showOnly("home"); setHud("Loading your packs…", "");
    api.session().then(function (st) {
      applyState(st); S.pending = pendingFrom(st.pending);
      return api.collection(PACK_ID);
    }).then(function (col) {
      applyCollection(col); paintToggles(); paintTabDot();
      if (S.pending) { hidePending(); say("Picking up your last pack", 2400); buildStack(Math.min(S.pending.revealed || 0, 4)); }
      else paintHome();
      paintStatus(); show(hash === "binder" || hash === "trade" ? hash : "open"); loadTrades();
      document.body.classList.add("ready");
    }, function (e) {
      setHud(e && e.status === 0 ? "Can't reach the server" : "Something went wrong", "Reload the page to try again");
    });
  }
  window.__frc = { S: function () { return S; }, tierOf: tierOf, POOL: POOL, TEAMS: TEAMS, DIVS: DIVS, DIV_TEAMS: DIV_TEAMS, state: function () { return state; }, cardEl: cardEl };
  boot();
}
