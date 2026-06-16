'use strict';

/**
 * Tontine "Stay Alive" watcher
 * -----------------------------
 * Long-running process that, on a randomized schedule concentrated in the first
 * part of each Eastern-time day, logs into tontine.cash and performs the daily
 * "stay alive" check-in for YOUR OWN account.
 *
 * Why Playwright and not plain n8n/HTTP:
 *   /stayAlive requires a Google reCAPTCHA Enterprise token, which can only be
 *   minted by running grecaptcha.enterprise.execute() inside a real browser.
 *   So we drive a headless Chromium, satisfy the captcha legitimately, then
 *   call the same API the site itself calls.
 *
 * Behaviour:
 *   - If today is already secured (our own prior success, or the site reports
 *     you're already "safe"), it does nothing and stays silent.
 *   - On a successful press, it posts ONE confirmation to a Discord webhook.
 *   - On failure (like the MSCHF server-side outage), it captures the same
 *     diagnostics we gathered by hand and posts a throttled troubleshooting
 *     report, then keeps retrying.
 *
 * Everything tunable lives in the CONFIG block / environment variables.
 */

const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// CONFIG (override via environment variables)
// ---------------------------------------------------------------------------
const CFG = {
  email:        req('TONTINE_EMAIL'),
  password:     req('TONTINE_PASSWORD'),
  discordWebhook: process.env.DISCORD_WEBHOOK_URL || '',      // optional but recommended

  apiBase:  process.env.TONTINE_API || 'https://uodh02r6ni.execute-api.us-east-1.amazonaws.com/prod',
  siteKey:  process.env.RECAPTCHA_SITE_KEY || '6LdgVmwdAAAAALyRxAIZLSh_d8gySMXw_Y18b-8X',
  timezone: process.env.TZ_NAME || 'America/New_York',

  // Scheduling --------------------------------------------------------------
  attemptsPerDay: int('ATTEMPTS_PER_DAY', 12),   // how many tries spread across the window
  windowHours:    num('WINDOW_HOURS', 12),       // window = first N hours of the ET day
  attemptOnStart: bool('ATTEMPT_ON_START', true),// fire one attempt immediately on boot

  // Overtime: if the window ends without a check-in (e.g. server is down),
  // keep trying at a steady cadence until just before the midnight deadline.
  overtime:            bool('OVERTIME', true),
  overtimeIntervalMin: int('OVERTIME_INTERVAL_MIN', 20),
  overtimeJitterMin:   int('OVERTIME_JITTER_MIN', 8),
  overtimeStopHour:    int('OVERTIME_STOP_HOUR', 23),
  overtimeStopMinute:  int('OVERTIME_STOP_MINUTE', 45),

  // Notifications -----------------------------------------------------------
  errorRenotifyHours: num('ERROR_RENOTIFY_HOURS', 3), // suppress identical errors for this long
  notifyMissedDay:    bool('NOTIFY_MISSED_DAY', true),

  // Browser -----------------------------------------------------------------
  rotateToken: bool('ROTATE_TOKEN', false), // mirror app's getNewToken before stayAlive
  userAgent: process.env.USER_AGENT ||
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
    '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  navTimeoutMs: int('NAV_TIMEOUT_MS', 45000),
  attemptTimeoutMs: int('ATTEMPT_TIMEOUT_MS', 120000), // abort a stuck attempt after this

  // Health / status feed (for Unraid health badge + Homarr/Homepage) ---------
  healthPort:    int('HEALTH_PORT', 8080),       // serves /health and /status
  healthStaleMs: int('HEALTH_STALE_MS', 120000), // /health is 503 if no heartbeat within this
  statsUrl: process.env.STATS_URL || 'https://tontine-stats.s3.us-east-1.amazonaws.com/stats.json',
  watchStats:   bool('WATCH_STATS', true),       // alert on alive/safe changes
  statsPollMin: num('STATS_POLL_MIN', 15),       // how often to poll the stats endpoint

  statePath: process.env.STATE_PATH || path.join(__dirname, 'data', 'state.json'),
  debug: bool('DEBUG', false),
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function req(name) {
  const v = process.env[name];
  if (!v) { console.error(`[fatal] missing required env var ${name}`); process.exit(1); }
  return v;
}
function int(name, d)  { const v = process.env[name]; return v === undefined ? d : parseInt(v, 10); }
function num(name, d)  { const v = process.env[name]; return v === undefined ? d : parseFloat(v); }
function bool(name, d) { const v = process.env[name]; return v === undefined ? d : /^(1|true|yes|on)$/i.test(v); }
const sleep = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));

function log(level, msg, extra) {
  const line = `${new Date().toISOString()} [${level}] ${msg}`;
  if (level === 'error') console.error(line); else console.log(line);
  if (extra !== undefined && CFG.debug) console.log(JSON.stringify(extra, null, 2));
}

// ----- timezone math (no external deps) ------------------------------------
function tzOffsetMinutes(date) {
  // minutes the ET wall clock is ahead of UTC (negative, e.g. -240 in EDT)
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: CFG.timezone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = dtf.formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return (asUTC - date.getTime()) / 60000;
}
function etWallToUTC(y, m, d, H, Min) {
  const naive = Date.UTC(y, m - 1, d, H, Min, 0);
  let off = tzOffsetMinutes(new Date(naive));
  let utc = naive - off * 60000;
  off = tzOffsetMinutes(new Date(utc));       // refine once for DST edges
  return new Date(naive - off * 60000);
}
function etDateStr(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: CFG.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date); // YYYY-MM-DD
}
function etClock(date = new Date()) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: CFG.timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}
function nextMidnightETMs() {
  const [y, m, d] = etDateStr().split('-').map(Number);
  return etWallToUTC(y, m, d + 1, 0, 0).getTime();
}

// ----- state ----------------------------------------------------------------
function loadState() {
  try { return JSON.parse(fs.readFileSync(CFG.statePath, 'utf8')); }
  catch { return { date: null, status: 'pending', attempts: 0, lastErrorCategory: null, lastErrorAt: null }; }
}
function saveState(s) {
  fs.mkdirSync(path.dirname(CFG.statePath), { recursive: true });
  fs.writeFileSync(CFG.statePath, JSON.stringify(s, null, 2));
}

// ----- jwt decode (local logging only; never sent to Discord) --------------
function decodeJwt(jwt) {
  try {
    const b64 = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
    return JSON.parse(Buffer.from(b64 + pad, 'base64').toString('utf8'));
  } catch (e) { return { decodeError: String(e) }; }
}

// ----- discord --------------------------------------------------------------
async function discord(embed) {
  if (!CFG.discordWebhook) { log('info', '(no webhook configured) ' + embed.title); return; }
  try {
    const r = await fetch(CFG.discordWebhook, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (!r.ok) log('error', `discord webhook returned ${r.status}`);
  } catch (e) { log('error', 'discord post failed: ' + e.message); }
}
function trunc(s, n = 800) { s = typeof s === 'string' ? s : JSON.stringify(s); return s.length > n ? s.slice(0, n) + '…' : s; }

// ----- health / status feed -------------------------------------------------
const health = {
  startedAt: new Date().toISOString(),
  lastBeat: Date.now(),
  today: null,
  status: 'starting',      // starting | pending | success | failed
  attemptsToday: 0,
  lastAttemptAt: null,
  lastResult: null,        // success | already | error:<category>
  lastError: null,
  lastSuccessAt: null,
  game: null,              // { alive, safe, dead } from the stats endpoint
};
function beat() { health.lastBeat = Date.now(); }
setInterval(beat, 30000);  // liveness pulse independent of the schedule

function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label || 'op'} timed out after ${ms}ms`)), ms)),
  ]);
}

let _statsCache = { at: 0, data: null };
async function fetchStats() {
  if (Date.now() - _statsCache.at < 30000 && _statsCache.data) return _statsCache.data; // 30s cache
  try {
    const r = await withTimeout(fetch(CFG.statsUrl), 8000, 'stats');
    if (!r.ok) return _statsCache.data;
    const data = await r.json();
    _statsCache = { at: Date.now(), data };
    return data;
  } catch { return _statsCache.data; }
}

// ----- stats watch: alert on alive (purges) and safe (check-ins working) -----
function gamePath() { return path.join(path.dirname(CFG.statePath), 'game.json'); }
function loadGame() {
  try { return JSON.parse(fs.readFileSync(gamePath(), 'utf8')); }
  catch { return { date: null, safeSeenToday: false, lastAlive: null, lastSafe: null }; }
}
function saveGame(g) { fs.mkdirSync(path.dirname(gamePath()), { recursive: true }); fs.writeFileSync(gamePath(), JSON.stringify(g, null, 2)); }

async function pollStats() {
  const stats = await fetchStats();
  if (!stats) return;
  health.game = { alive: stats.alive, safe: stats.safe, dead: stats.dead };
  if (!CFG.watchStats) return;

  const today = etDateStr();
  let g = loadGame();
  if (g.date !== today) {
    // New ET day: 'safe' resets to 0 server-side, so don't treat that as a drop.
    // Preserve lastAlive so an overnight purge (missed-day eliminations) is still caught.
    g = { date: today, safeSeenToday: stats.safe > 0, lastAlive: g.lastAlive, lastSafe: stats.safe };
  }

  // alive decreased -> a round of eliminations went through
  if (typeof g.lastAlive === 'number' && stats.alive < g.lastAlive) {
    const drop = g.lastAlive - stats.alive;
    await discord({
      title: '🔴 Tontine — players eliminated',
      description: `Alive dropped **${g.lastAlive} → ${stats.alive}** (−${drop}). A round of eliminations went through.`,
      color: 0xe67e22,
      fields: [
        { name: 'Alive', value: String(stats.alive), inline: true },
        { name: 'Safe today', value: String(stats.safe), inline: true },
      ],
      timestamp: new Date().toISOString(),
    });
  }

  // safe crossed 0 -> >0 for the first time today -> check-ins are registering again
  if (!g.safeSeenToday && stats.safe > 0) {
    g.safeSeenToday = true;
    await discord({
      title: '🟢 Tontine — check-ins are registering',
      description: `**${stats.safe}** marked safe today — the stay-alive endpoint looks healthy.`,
      color: 0x2ecc71,
      fields: [{ name: 'Alive', value: String(stats.alive), inline: true }],
      timestamp: new Date().toISOString(),
    });
  }

  g.lastAlive = stats.alive; g.lastSafe = stats.safe; g.date = today;
  saveGame(g);
}

function startStatsWatch() {
  const tick = () => pollStats().catch(e => log('error', 'stats poll: ' + (e && e.message || e)));
  tick();
  setInterval(tick, Math.max(1, CFG.statsPollMin) * 60000);
}

function startHealthServer() {
  const server = http.createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0];
    const fresh = Date.now() - health.lastBeat <= CFG.healthStaleMs;
    if (url === '/health') {
      res.writeHead(fresh ? 200 : 503, { 'Content-Type': 'text/plain' });
      res.end(fresh ? 'ok' : 'stale');
      return;
    }
    if (url === '/status' || url === '/') {
      let game = health.game;
      if (!game) { const s = await fetchStats(); if (s) game = { alive: s.alive, safe: s.safe, dead: s.dead }; }
      const body = {
        service: 'tontine-stayalive',
        ok: fresh,
        startedAt: health.startedAt,
        nowET: `${etDateStr()} ${etClock()} ET`,
        today: health.today,
        checkin: {
          status: health.status,
          attemptsToday: health.attemptsToday,
          lastAttemptAt: health.lastAttemptAt,
          lastResult: health.lastResult,
          lastError: health.lastError,
          lastSuccessAt: health.lastSuccessAt,
        },
        game: game || null,
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body, null, 2));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
  server.on('error', e => log('error', 'health server error: ' + e.message));
  server.listen(CFG.healthPort, () => log('info', `health/status on :${CFG.healthPort} (/health, /status)`));
}

// ---------------------------------------------------------------------------
// The attempt: drive a headless browser through login -> captcha -> stayAlive
// ---------------------------------------------------------------------------
async function runAttempt() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  });
  try {
    const ctx = await browser.newContext({ userAgent: CFG.userAgent, viewport: { width: 390, height: 844 }, locale: 'en-US' });
    const page = await ctx.newPage();
    await page.goto('https://tontine.cash/', { waitUntil: 'domcontentloaded', timeout: CFG.navTimeoutMs });
    await page.waitForFunction(() => window.grecaptcha && window.grecaptcha.enterprise, null, { timeout: CFG.navTimeoutMs }).catch(() => {});

    const result = { steps: {} };

    // 1) login (no captcha required)
    const login = await page.evaluate(async ({ apiBase, email, password }) => {
      try {
        const r = await fetch(apiBase + '/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        const text = await r.text(); let body; try { body = JSON.parse(text); } catch { body = text; }
        return { status: r.status, body };
      } catch (e) { return { status: 0, body: String(e && e.message || e) }; }
    }, { apiBase: CFG.apiBase, email: CFG.email, password: CFG.password });
    result.steps.login = login;
    if (login.status !== 200 || !(login.body && login.body.token)) return result;
    result.tokenDecoded = decodeJwt(login.body.token);

    // 2) seed token + reload so the Nuxt app initialises logged-in, then read isSafe.
    //    Reloading lets the app do its own mounted() token rotation, so the token
    //    sitting in localStorage afterwards is exactly what the real button would use.
    await page.evaluate(t => localStorage.setItem('token', t), login.body.token);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: CFG.navTimeoutMs }).catch(() => {});
    await page.waitForFunction(() => window.grecaptcha && window.grecaptcha.enterprise, null, { timeout: CFG.navTimeoutMs }).catch(() => {});

    let isSafe = null;
    try {
      isSafe = await page.evaluate(async () => {
        const s = ms => new Promise(r => setTimeout(r, ms));
        for (let i = 0; i < 20; i++) {
          try {
            const st = window.$nuxt && window.$nuxt.$store;
            if (st && st.state && st.state.isLoggedIn && st.getters && typeof st.getters.isSafe !== 'undefined') {
              return !!st.getters.isSafe;
            }
          } catch (e) {}
          await s(400);
        }
        return null;
      });
    } catch { isSafe = null; }
    result.isSafe = isSafe;
    if (isSafe === true) { result.alreadyDone = true; return result; }

    // 3) mint captcha + call stayAlive with the freshest localStorage token
    const sa = await page.evaluate(async ({ apiBase, siteKey }) => {
      const out = {};
      const token = localStorage.getItem('token');
      out.usedTokenPresent = !!token;
      let captchaToken = null, captchaError = null;
      try {
        captchaToken = await new Promise((res, rej) => {
          if (!window.grecaptcha || !window.grecaptcha.enterprise) { rej(new Error('grecaptcha.enterprise unavailable')); return; }
          window.grecaptcha.enterprise.ready(() => {
            window.grecaptcha.enterprise.execute(siteKey, { action: 'login' }).then(res).catch(rej);
          });
        });
      } catch (e) { captchaError = String(e && e.message || e); }
      out.captcha = { ok: !!captchaToken, tokenLength: captchaToken ? captchaToken.length : 0, error: captchaError };
      if (!captchaToken) return out;
      try {
        const r = await fetch(apiBase + '/stayAlive', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, captchaToken }),
        });
        const text = await r.text(); let body; try { body = JSON.parse(text); } catch { body = text; }
        out.stayAlive = { status: r.status, body };
      } catch (e) { out.stayAlive = { status: 0, body: String(e && e.message || e) }; }
      return out;
    }, { apiBase: CFG.apiBase, siteKey: CFG.siteKey });

    result.steps.captcha = sa.captcha;
    if (sa.stayAlive) result.steps.stayAlive = sa.stayAlive;
    if (sa.stayAlive && sa.stayAlive.status === 200 && sa.stayAlive.body && sa.stayAlive.body.token) {
      result.newTokenDecoded = decodeJwt(sa.stayAlive.body.token);
    }
    return result;
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Interpret a raw attempt into a friendly verdict
// ---------------------------------------------------------------------------
function classify(r) {
  if (!r || !r.steps || !r.steps.login) {
    return { kind: 'error', category: 'launch', summary: 'Could not reach the site or run the page.' };
  }
  if (r.alreadyDone) return { kind: 'already', summary: 'Already checked in for today (no action needed).' };

  const login = r.steps.login;
  if (login.status !== 200 || !(login.body && login.body.token)) {
    const msg = typeof login.body === 'object' ? (login.body.error || login.body.message || JSON.stringify(login.body)) : String(login.body);
    let summary = `Login failed (HTTP ${login.status}): ${msg}`;
    if (/account not found/i.test(msg)) summary = 'Login failed: email not recognised — check TONTINE_EMAIL.';
    else if (/password|credential/i.test(msg)) summary = 'Login failed: wrong password — check TONTINE_PASSWORD.';
    return { kind: 'error', category: 'login', summary };
  }

  const cap = r.steps.captcha;
  if (!cap || !cap.ok) {
    return { kind: 'error', category: 'captcha',
      summary: `reCAPTCHA did not return a token (${cap && cap.error ? cap.error : 'unknown'}). ` +
               `Headless score or a block is the usual cause. Retrying.` };
  }

  const sa = r.steps.stayAlive;
  if (!sa) return { kind: 'error', category: 'nostayalive', summary: 'Stay Alive step did not run.' };
  const bodyText = typeof sa.body === 'object' ? JSON.stringify(sa.body) : String(sa.body);

  if (sa.status === 200 && sa.body && sa.body.token) return { kind: 'success', summary: 'Stay Alive accepted — you are checked in.' };
  if (/already/i.test(bodyText)) return { kind: 'already', summary: 'Server reports you are already checked in.' };
  if (sa.status === 400 && /invalid token/i.test(bodyText)) {
    return { kind: 'error', category: 'server-invalid-token',
      summary: 'Stay Alive rejected a freshly issued, valid token ("Invalid token"). This matches the known ' +
               'MSCHF server-side outage — not your account and not this script. Retrying.' };
  }
  if (sa.status >= 500) return { kind: 'error', category: 'server-5xx', summary: `Stay Alive returned HTTP ${sa.status} (MSCHF server error). Retrying.` };
  return { kind: 'error', category: 'stayalive-other', summary: `Stay Alive failed (HTTP ${sa.status}): ${trunc(bodyText, 200)}` };
}

function diagBlock(r) {
  const lines = [];
  const s = r.steps || {};
  if (s.login)     lines.push(`login:      HTTP ${s.login.status}`);
  if ('isSafe' in r) lines.push(`isSafe:     ${r.isSafe}`);
  if (s.captcha)   lines.push(`captcha:    ok=${s.captcha.ok} len=${s.captcha.tokenLength}${s.captcha.error ? ' err=' + s.captcha.error : ''}`);
  if (s.stayAlive) lines.push(`stayAlive:  HTTP ${s.stayAlive.status} ${trunc(typeof s.stayAlive.body === 'object' ? JSON.stringify(s.stayAlive.body) : s.stayAlive.body, 120)}`);
  return lines.join('\n') || 'no steps recorded';
}

// ---------------------------------------------------------------------------
// One attempt + all the bookkeeping/notifying around it
// ---------------------------------------------------------------------------
async function doAttempt(today) {
  let state = loadState();
  if (state.date !== today) state = { date: today, status: 'pending', attempts: 0, lastErrorCategory: null, lastErrorAt: null };
  state.attempts = (state.attempts || 0) + 1;

  health.today = today;
  health.attemptsToday = state.attempts;
  health.lastAttemptAt = new Date().toISOString();

  let raw;
  try { raw = await withTimeout(runAttempt(), CFG.attemptTimeoutMs, 'attempt'); }
  catch (e) { raw = { steps: {}, fatal: String(e && e.message || e) }; }
  beat();

  const verdict = classify(raw);
  log('info', `attempt #${state.attempts} -> ${verdict.kind}: ${verdict.summary}`, raw);

  if (verdict.kind === 'success') {
    state.status = 'success';
    saveState(state);
    health.status = 'success'; health.lastResult = 'success'; health.lastError = null; health.lastSuccessAt = new Date().toISOString();
    const stats = await fetchStats();
    const fields = [{ name: 'When', value: `${today} ${etClock()} ET (attempt #${state.attempts})` }];
    if (stats) fields.push(
      { name: 'Alive', value: String(stats.alive), inline: true },
      { name: 'Safe today', value: String(stats.safe), inline: true },
    );
    await discord({
      title: '✅ Tontine — checked in',
      description: verdict.summary,
      color: 0x2ecc71,
      fields,
      timestamp: new Date().toISOString(),
    });
    return 'success';
  }

  if (verdict.kind === 'already') {
    // silent: mark done so we stop attempting and stay quiet for the rest of the day
    state.status = 'success';
    saveState(state);
    health.status = 'success'; health.lastResult = 'already'; health.lastError = null;
    log('info', 'already checked in — going silent for the rest of the ET day');
    return 'already';
  }

  health.status = 'failed'; health.lastResult = 'error:' + verdict.category; health.lastError = verdict.summary;

  // error path: throttle identical categories
  const now = Date.now();
  const sameCat = state.lastErrorCategory === verdict.category;
  const recent = state.lastErrorAt && (now - state.lastErrorAt) < CFG.errorRenotifyHours * 3600 * 1000;
  if (!(sameCat && recent)) {
    state.lastErrorCategory = verdict.category;
    state.lastErrorAt = now;
    await discord({
      title: '⚠️ Tontine — check-in failed',
      description: verdict.summary,
      color: 0xe74c3c,
      fields: [
        { name: 'Category', value: verdict.category, inline: true },
        { name: 'Attempt',  value: `#${state.attempts} (${etClock()} ET)`, inline: true },
        { name: 'Diagnostics', value: '```\n' + diagBlock(raw) + '\n```' },
      ],
      footer: { text: 'Will keep retrying on schedule.' },
      timestamp: new Date().toISOString(),
    });
  }
  saveState(state);
  return 'error';
}

// ---------------------------------------------------------------------------
// Build a randomized schedule across the first WINDOW_HOURS of the ET day
// ---------------------------------------------------------------------------
function buildSchedule(today) {
  const [y, m, d] = today.split('-').map(Number);
  const start = etWallToUTC(y, m, d, 0, 0).getTime();
  const end = start + CFG.windowHours * 3600 * 1000;
  const span = end - start;
  const N = Math.max(1, CFG.attemptsPerDay);
  const times = [];
  for (let i = 0; i < N; i++) {                 // one random time per evenly-sized bucket
    const a = start + (span * i) / N;
    const b = start + (span * (i + 1)) / N;
    times.push(new Date(a + Math.random() * (b - a)));
  }
  return times.filter(t => t.getTime() > Date.now()).sort((x, z) => x - z);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
async function main() {
  log('info', `tontine stay-alive watcher up | tz=${CFG.timezone} attempts/day=${CFG.attemptsPerDay} ` +
              `window=${CFG.windowHours}h overtime=${CFG.overtime} webhook=${CFG.discordWebhook ? 'yes' : 'no'}`);
  startHealthServer();
  startStatsWatch();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    beat();
    const today = etDateStr();
    let state = loadState();
    if (state.date !== today) { state = { date: today, status: 'pending', attempts: 0, lastErrorCategory: null, lastErrorAt: null }; saveState(state); }
    health.today = today;
    health.attemptsToday = state.attempts || 0;
    health.status = state.status === 'success' ? 'success' : (health.status === 'failed' ? 'failed' : 'pending');

    if (state.status === 'success') { await sleep(Math.min(nextMidnightETMs() - Date.now(), 3600000)); continue; }

    log('info', `new/resumed day ${today} — building schedule`);
    if (CFG.attemptOnStart && loadState().status !== 'success') {
      if (await doAttempt(today) === 'error') { /* fall through to schedule */ }
    }

    for (const t of buildSchedule(today)) {
      if (loadState().status === 'success' || etDateStr() !== today) break;
      const wait = t.getTime() - Date.now();
      if (wait > 0) { log('info', `next scheduled attempt at ${etClock(t)} ET (in ${(wait / 60000).toFixed(0)}m)`); await sleep(wait); }
      if (etDateStr() !== today) break;
      await doAttempt(today);
    }

    // overtime: keep trying past the window until just before the deadline
    if (CFG.overtime && loadState().status !== 'success' && etDateStr() === today) {
      const [yy, mm, dd] = today.split('-').map(Number);
      const stopAt = etWallToUTC(yy, mm, dd, CFG.overtimeStopHour, CFG.overtimeStopMinute).getTime();
      log('info', `entering overtime until ${CFG.overtimeStopHour}:${String(CFG.overtimeStopMinute).padStart(2, '0')} ET`);
      while (Date.now() < stopAt && etDateStr() === today && loadState().status !== 'success') {
        await doAttempt(today);
        if (loadState().status === 'success') break;
        const jitter = (Math.random() * 2 - 1) * CFG.overtimeJitterMin * 60000;
        await sleep(CFG.overtimeIntervalMin * 60000 + jitter);
      }
    }

    if (CFG.notifyMissedDay && loadState().status !== 'success' && etDateStr() === today) {
      await discord({
        title: '🚨 Tontine — DAY NOT SECURED',
        description: 'Every attempt today failed. If the deadline is near, check in manually now.',
        color: 0xc0392b,
        fields: [{ name: 'Date', value: today }, { name: 'Attempts', value: String(loadState().attempts) }],
        timestamp: new Date().toISOString(),
      });
    }

    const until = nextMidnightETMs() - Date.now();
    log('info', `day ${today} done (status=${loadState().status}); sleeping ${(until / 3600000).toFixed(1)}h to next ET midnight`);
    await sleep(Math.max(until, 1000));
  }
}

main().catch(e => { log('error', 'fatal: ' + (e && e.stack || e)); process.exit(1); });
