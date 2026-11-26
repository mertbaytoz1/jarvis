/* =========================================================
   J.A.R.V.I.S — kişisel asistan (iPhone · iPad · PC)
   Tek dosyalık istemci uygulaması. Sunucu gerekmez.
   ========================================================= */
'use strict';
const JARVIS_VERSION = '11';

/* ---------- yardımcılar ---------- */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const decodeHtml = s => { const t = document.createElement('textarea'); t.innerHTML = s || ''; return t.value; };

/* ---------- ayarlar (yalnız bu cihaz) ---------- */
const DEFAULTS = {
  geminiKey: '', groqKey: '', orKey: '',
  geminiModel: 'gemini-3.8-flash',
  groqModel: 'openai/gpt-oss-120b',
  orModel: 'openrouter/free',
  clientId: '', deviceName: isIOS ? (/iPad/.test(navigator.userAgent) || navigator.maxTouchPoints > 1 && !/iPhone/.test(navigator.userAgent) ? 'iPad' : 'iPhone') : 'Bilgisayar',
  ytKey: '', ytMode: 'auto', tavilyKey: '',
  voice: '', rate: 1.0, wake: false, deviceId: uid(), googleWanted: false
};
const S = Object.assign({}, DEFAULTS, load('jarvis.settings', {}));
// kapatılmış eski varsayılan modelleri güncelle
const RETIRED = { geminiModel: ['gemini-2.5-flash', 'gemini-2.0-flash'], groqModel: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'], orModel: ['meta-llama/llama-3.3-70b-instruct:free'] };
Object.entries(RETIRED).forEach(([k, old]) => { if (old.includes(S[k])) S[k] = DEFAULTS[k]; });
save('jarvis.settings', S);

/* ---------- hafıza (cihazlar arası senkron) ---------- */
const MEM0 = { profile: { name: '', hitap: 'efendim', vip: '', about: '', city: '', updated: 0 }, facts: [], removed: [], history: [], devices: {}, sent: [], updated: 0 };
let M = Object.assign(structuredClone(MEM0), load('jarvis.mem', {}));
const saveMem = () => { M.updated = Date.now(); save('jarvis.mem', M); scheduleSync(); };

/* ---------- canlı durum ---------- */
let state = 'idle';             // idle | listening | thinking | speaking
let token = null, tokenExp = 0; // Google erişim belirteci
let mails = [], tasks = [];
let activeBrain = '—';
let agent = null;               // PC ajanı durumu
let fileResults = [];          // son dosya arama sonuçları
let pending = [];              // konuşmadan sonra çalışacak uzun işler
let weather = null, events = [], news = null, wa = null;

/* ---------- zaman (her şey cihazın yerel saatinden) ---------- */
const pad2 = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;   // yerel tarih (UTC değil)
const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; } })();
const dayPart = h => h < 5 ? 'gece' : h < 11 ? 'sabah' : h < 14 ? 'öğle' : h < 18 ? 'öğleden sonra' : h < 22 ? 'akşam' : 'gece';
const longDate = d => d.toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const clock = d => d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
function timeBlock() {
  const now = new Date(), rows = [];
  for (let i = -1; i < 8; i++) {
    const d = new Date(now); d.setDate(d.getDate() + i);
    const tag = { '-1': 'dün', 0: 'BUGÜN', 1: 'yarın', 2: 'öbür gün' }[i] || '';
    rows.push(`${tag ? tag + ': ' : ''}${d.toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long' })} = ${ymd(d)}`);
  }
  return `ZAMAN (kesin bilgi, kullanıcının cihaz saatinden alındı; eğitim verilerindeki tarihleri DEĞİL bunu kullan):
Şu an: ${longDate(now)}, saat ${clock(now)} (${dayPart(now.getHours())})${TZ ? ', saat dilimi ' + TZ : ''}.
Gün tablosu ("yarın", "cuma", "haftaya salı" gibi ifadeleri bu tabloyla tarihe çevir):
${rows.join('\n')}
${now.getHours() < 5 ? 'Not: Şu an gece yarısını geçti. Kullanıcı "yarın" derse uyandıktan sonraki günü, yani BUGÜN\'ün tarihini kastediyor olabilir; emin değilsen hangi günü kastettiğini sor.\n' : ''}Selamlaşmayı saate göre yap (gece "günaydın" deme). Sohbet geçmişindeki mesajların başındaki [ ] içindeki zaman, o mesajın ne zaman yazıldığını gösterir; eski mesajlardaki "bugün/yarın" ifadelerini o güne göre yorumla.`;
}
function msgStamp(t) {
  const d = new Date(t), now = new Date();
  const days = Math.round((new Date(ymd(now)) - new Date(ymd(d))) / 864e5);
  return `[${days === 0 ? 'bugün' : days === 1 ? 'dün' : d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', weekday: 'long' })} ${clock(d)}] `;
}
function timeAnswer(t) {
  const s = t.toLocaleLowerCase('tr'), now = new Date(), h = M.profile.hitap || 'efendim';
  if (/saat kaç|saati söyle|saat ne/.test(s)) return `Saat ${clock(now)}, ${h}.`;
  if (/(bugün|bu gün).*(günlerden|ayın kaçı|tarih|ne günü|hangi gün)|günlerden ne|tarih ne|bugünün tarihi|ayın kaçı|hangi gündeyiz/.test(s)) return `Bugün ${longDate(now)}, ${h}.`;
  if (/yarın (günlerden|ne günü|hangi gün|ayın kaçı)/.test(s)) { const d = new Date(now); d.setDate(d.getDate() + 1); return `Yarın ${longDate(d)}.`; }
  return null;
}

/* =========================================================
   ARAYÜZ
   ========================================================= */
function tickClock() {
  const d = new Date();
  $('#clk').textContent = d.toLocaleTimeString('tr-TR');
  $('#dt').textContent = d.toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long' }).toUpperCase();
}
setInterval(tickClock, 1000); tickClock();

let toastT;
function toast(msg, ms = 3500) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), ms);
}

function addLog(role, text, from) {
  const el = document.createElement('div');
  el.className = 'msg ' + role;
  el.innerHTML = esc(text) + (from && role !== 'sys' ? ` <span style="font-size:11px;color:var(--dim)">· ${esc(from)}</span>` : '');
  const log = $('#log'); log.appendChild(el); log.scrollTop = log.scrollHeight;
  while (log.children.length > 60) log.firstChild.remove();
}

function chip(id, on, label, warn) {
  const c = $(id); c.classList.toggle('on', !!on); c.classList.toggle('warn', !!warn);
  c.innerHTML = '<i></i>' + esc(label);
}
function refreshChips() {
  chip('#cBrain', activeBrain !== '—', 'BEYİN: ' + activeBrain.toUpperCase(), !hasBrain());
  chip('#cGoogle', !!token, token ? 'GOOGLE: BAĞLI' : 'GOOGLE: BAĞLI DEĞİL', !token && S.clientId);
  const others = Object.entries(M.devices).filter(([id, d]) => id !== S.deviceId && Date.now() - d.last < 3 * 60e3);
  chip('#cDev', others.length, 'CİHAZLAR: ' + (others.length + 1) + (others.length ? ' (' + others.map(o => o[1].name).join(', ') + ')' : ''));
  chip('#cWake', S.wake && SR, S.wake ? '"HEY JARVIS": AÇIK' : '"HEY JARVIS": KAPALI');
  chip('#cAgent', agentOnline(), agent ? 'PC AJANI: ' + (agentOnline() ? 'ÇEVRİMİÇİ' : 'ÇEVRİMDIŞI') : 'PC AJANI: YOK', agent && !agentOnline());
}
function setState(s, label) {
  state = s;
  $('#stateLbl').textContent = label || ({ idle: 'BEKLEMEDE', listening: 'DİNLİYORUM', thinking: 'ANALİZ EDİYORUM', speaking: 'KONUŞUYOR' })[s];
  $('#mic').classList.toggle('rec', s === 'listening');
}

/* mobil sekmeler */
$$('.tabs button').forEach(b => b.onclick = () => {
  $$('.tabs button').forEach(x => x.classList.toggle('act', x === b));
  ['pMail', 'core', 'pTask'].forEach(id => $('#' + id).classList.toggle('show', id === b.dataset.tab));
  if (b.dataset.tab === 'core') sizeCanvas();
});

/* =========================================================
   SES EFEKTLERİ (Web Audio)
   ========================================================= */
let AC;
function blip(freqs, dur = .09, type = 'sine', vol = .06) {
  try {
    AC = AC || new (window.AudioContext || window.webkitAudioContext)();
    let t = AC.currentTime;
    freqs.forEach(f => {
      const o = AC.createOscillator(), g = AC.createGain();
      o.type = type; o.frequency.setValueAtTime(f, t);
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(.0001, t + dur);
      o.connect(g).connect(AC.destination); o.start(t); o.stop(t + dur); t += dur * .8;
    });
  } catch {}
}
const fx = {
  boot: () => blip([220, 330, 440, 660, 880], .12, 'triangle', .05),
  listen: () => blip([660, 990], .07),
  stop: () => blip([880, 520], .07),
  ok: () => blip([740, 1100], .06, 'triangle'),
  err: () => blip([300, 200], .12, 'sawtooth', .04)
};

/* =========================================================
   REAKTÖR ANİMASYONU
   ========================================================= */
const cv = $('#reactor'), ctx = cv.getContext('2d');
let level = 0, target = 0;
function sizeCanvas() {
  const r = cv.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
  cv.width = Math.max(1, r.width * dpr); cv.height = Math.max(1, r.height * dpr);
}
new ResizeObserver(sizeCanvas).observe(cv);

function draw(ts) {
  const t = ts / 1000, w = cv.width, h = cv.height, cx = w / 2, cy = h / 2;
  const R = Math.min(w, h) * .44;
  const amber = state === 'listening';
  const col = (a) => amber ? `rgba(255,179,71,${a})` : `rgba(62,240,255,${a})`;
  const spd = { idle: 1, listening: 1.8, thinking: 4, speaking: 2 }[state];

  if (state === 'speaking') target = .45 + .55 * Math.abs(Math.sin(t * 7.3) * Math.sin(t * 3.1 + 1));
  else if (state === 'listening') target = .25 + .35 * Math.abs(Math.sin(t * 5));
  else if (state === 'thinking') target = .3;
  else target = .08 + .05 * Math.sin(t * 1.5);
  level += (target - level) * .15;

  ctx.clearRect(0, 0, w, h);
  ctx.save(); ctx.translate(cx, cy);
  ctx.shadowBlur = R * .06; ctx.shadowColor = col(.8);

  // dış tik halkası
  ctx.save(); ctx.rotate(t * .08 * spd);
  for (let i = 0; i < 120; i++) {
    const a = i / 120 * Math.PI * 2, big = i % 10 === 0;
    ctx.strokeStyle = col(big ? .9 : .35); ctx.lineWidth = big ? R * .012 : R * .006;
    ctx.beginPath(); ctx.moveTo(Math.cos(a) * R, Math.sin(a) * R);
    ctx.lineTo(Math.cos(a) * (R - (big ? R * .07 : R * .03)), Math.sin(a) * (R - (big ? R * .07 : R * .03))); ctx.stroke();
  }
  ctx.restore();

  // tarama yayı (düşünürken)
  if (state === 'thinking') {
    ctx.save(); ctx.rotate(t * 3);
    const g = ctx.createConicGradient ? ctx.createConicGradient(0, 0, 0) : null;
    if (g) { g.addColorStop(0, col(.0)); g.addColorStop(.85, col(.0)); g.addColorStop(1, col(.35)); ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, 0, R * .93, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  }

  // segmentli halka
  ctx.save(); ctx.rotate(-t * .25 * spd);
  ctx.lineWidth = R * .045; ctx.strokeStyle = col(.75);
  for (let i = 0; i < 6; i++) {
    const a = i / 6 * Math.PI * 2;
    ctx.beginPath(); ctx.arc(0, 0, R * .82, a, a + Math.PI * 2 / 6 * .72); ctx.stroke();
  }
  ctx.restore();

  // kesikli halka
  ctx.save(); ctx.rotate(t * .5 * spd);
  ctx.setLineDash([R * .02, R * .03]); ctx.lineWidth = R * .015; ctx.strokeStyle = col(.5);
  ctx.beginPath(); ctx.arc(0, 0, R * .71, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
  ctx.restore();

  // iç üçlü yay
  ctx.save(); ctx.rotate(-t * .9 * spd);
  ctx.lineWidth = R * .02; ctx.strokeStyle = col(.9);
  for (let i = 0; i < 3; i++) { const a = i / 3 * Math.PI * 2; ctx.beginPath(); ctx.arc(0, 0, R * .58, a, a + 1.4); ctx.stroke(); }
  ctx.restore();

  // radyal ses çubukları
  const N = 72;
  for (let i = 0; i < N; i++) {
    const a = i / N * Math.PI * 2 + t * .2;
    const n = .5 + .5 * Math.sin(i * 1.7 + t * 9) * Math.sin(i * .45 - t * 4);
    const len = R * (.03 + level * .16 * n);
    const r0 = R * .34;
    ctx.strokeStyle = col(.35 + .6 * n * level + .1); ctx.lineWidth = R * .014;
    ctx.beginPath(); ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
    ctx.lineTo(Math.cos(a) * (r0 + len), Math.sin(a) * (r0 + len)); ctx.stroke();
  }

  // çekirdek
  const pr = R * (.2 + level * .07);
  const cg = ctx.createRadialGradient(0, 0, 0, 0, 0, pr * 1.7);
  cg.addColorStop(0, amber ? 'rgba(255,240,210,1)' : 'rgba(225,255,255,1)');
  cg.addColorStop(.35, col(.85)); cg.addColorStop(1, col(0));
  ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(0, 0, pr * 1.7, 0, Math.PI * 2); ctx.fill();
  ctx.lineWidth = R * .012; ctx.strokeStyle = col(.9);
  ctx.beginPath(); ctx.arc(0, 0, pr * 1.15, 0, Math.PI * 2); ctx.stroke();

  // yörünge noktaları
  for (let k = 0; k < 2; k++) {
    const a = t * (k ? -1.3 : .9) * spd, rr = R * (k ? .71 : .95);
    ctx.fillStyle = k ? 'rgba(255,179,71,.95)' : col(1);
    ctx.beginPath(); ctx.arc(Math.cos(a) * rr, Math.sin(a) * rr, R * .018, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

/* =========================================================
   KONUŞMA (TTS)
   ========================================================= */
let voices = [];
function loadVoices() {
  voices = speechSynthesis.getVoices();
  const sel = $('#sVoice'); if (!sel) return;
  const tr = voices.filter(v => /^tr/i.test(v.lang)), other = voices.filter(v => !/^tr/i.test(v.lang));
  sel.innerHTML = '<option value="">Otomatik (Türkçe)</option>' +
    tr.map(v => `<option value="${esc(v.name)}">★ ${esc(v.name)} (${v.lang})</option>`).join('') +
    other.map(v => `<option value="${esc(v.name)}">${esc(v.name)} (${v.lang})</option>`).join('');
  sel.value = S.voice;
}
if ('speechSynthesis' in window) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }

function pickVoice() {
  if (S.voice) { const v = voices.find(v => v.name === S.voice); if (v) return v; }
  const tr = voices.filter(v => /^tr/i.test(v.lang));
  return tr.find(v => /enhanced|premium|neural|natural/i.test(v.name)) || tr[0] || null;
}

function speak(text) {
  return new Promise(resolve => {
    if (!('speechSynthesis' in window) || !text) return resolve();
    stopRec(true);
    speechSynthesis.cancel();
    const parts = text.replace(/\s+/g, ' ').match(/[^.!?…]+[.!?…]*/g) || [text];
    const v = pickVoice();
    setState('speaking');
    ytDuck(true);
    parts.forEach((p, i) => {
      const u = new SpeechSynthesisUtterance(p.trim());
      u.lang = 'tr-TR'; if (v) u.voice = v; u.rate = +S.rate || 1; u.pitch = .95;
      if (i === parts.length - 1) u.onend = u.onerror = () => { ytDuck(false); setState('idle'); resumeWake(); resolve(); };
      speechSynthesis.speak(u);
    });
  });
}

/* =========================================================
   DİNLEME (STT) — bas-konuş + "Hey Jarvis"
   ========================================================= */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, recMode = null, awaitCmd = 0, wakeTimer;
const WAKE = /(?:^|\s)(?:hey\s+|hay\s+|hi\s+)?(?:jarvis|carvis|çarvis|jarviz|cervis|ciarvis|jarviş|cavis)(?=$|[\s,.!?])[,.!?]?\s*/i;

function stopRec(silent) {
  clearTimeout(wakeTimer);
  if (rec) { rec.onend = null; try { rec.abort(); } catch {} rec = null; }
  if (!silent && recMode === 'ptt') fx.stop();
  recMode = null;
  if (state === 'listening') setState('idle');
}

function startRec(mode) {
  if (!SR) { toast('Bu tarayıcı konuşma tanımayı desteklemiyor. Klavyedeki mikrofonla dikte edebilirsiniz.'); $('#txt').focus(); return; }
  stopRec(true);
  rec = new SR(); recMode = mode;
  rec.lang = 'tr-TR'; rec.interimResults = true; rec.continuous = mode === 'wake'; rec.maxAlternatives = 1;
  let finalText = '';
  rec.onresult = e => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) {
        const said = r[0].transcript.trim();
        if (mode === 'ptt') finalText += ' ' + said;
        else onWakeHeard(said);
      } else interim += r[0].transcript;
    }
    if (mode === 'ptt' || awaitCmd > Date.now()) $('#live').textContent = (finalText + ' ' + interim).trim();
  };
  rec.onerror = e => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { toast('Mikrofon izni verilmedi.'); S.wake = false; save('jarvis.settings', S); refreshChips(); }
  };
  rec.onend = () => {
    const m = recMode; rec = null; recMode = null;
    if (m === 'ptt') {
      setState('idle'); $('#live').textContent = '';
      if (finalText.trim()) handleUser(finalText.trim());
    } else if (m === 'wake') { wakeTimer = setTimeout(resumeWake, 300); }
  };
  try { rec.start(); } catch { return; }
  if (mode === 'ptt') { setState('listening'); fx.listen(); }
}

function onWakeHeard(said) {
  if (awaitCmd > Date.now()) { awaitCmd = 0; setState('idle'); $('#live').textContent = ''; handleUser(said); return; }
  const m = said.match(WAKE);
  if (!m) return;
  const cmd = said.slice(m.index + m[0].length).trim();
  fx.listen();
  if (cmd.length > 2) handleUser(cmd);
  else { awaitCmd = Date.now() + 8000; setState('listening', 'EMRİNİZİ BEKLİYORUM'); speakShort(); }
}
async function speakShort() {
  await speak(['Buyurun.', 'Dinliyorum.', 'Emredin.'][Math.floor(Math.random() * 3)]);
  awaitCmd = Date.now() + 8000; setState('listening', 'EMRİNİZİ BEKLİYORUM');
}
function resumeWake() {
  if (S.wake && SR && !rec && state !== 'speaking' && state !== 'thinking' && !document.hidden) startRec('wake');
}
document.addEventListener('visibilitychange', () => document.hidden ? stopRec(true) : resumeWake());

$('#mic').onclick = () => {
  if (state === 'speaking') { speechSynthesis.cancel(); setState('idle'); return; }
  if (recMode === 'ptt') { try { rec.stop(); } catch {} return; }
  startRec('ptt');
};
$('#reactor').onclick = () => $('#mic').click();
$('#txt').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.value.trim()) { const v = e.target.value.trim(); e.target.value = ''; handleUser(v); }
});
$$('.q[data-cmd]').forEach(b => b.onclick = () => handleUser(b.dataset.cmd));
$$('.q[data-music]').forEach(b => b.onclick = () => music(b.dataset.music));

/* =========================================================
   BEYİN YÖNLENDİRİCİ — birden fazla servis, otomatik yedek
   ========================================================= */
const hasBrain = () => !!(S.geminiKey || S.groqKey || S.orKey);

function providers() {
  const list = [];
  if (S.geminiKey) list.push({ name: 'Gemini', mk: 'geminiModel', call: callGemini, discover: discoverGemini });
  if (S.groqKey) list.push({ name: 'Groq', mk: 'groqModel', call: (s, m) => callOpenAI('https://api.groq.com/openai/v1/chat/completions', S.groqKey, S.groqModel, s, m), discover: discoverGroq });
  if (S.orKey) list.push({ name: 'OpenRouter', mk: 'orModel', call: (s, m) => callOpenAI('https://openrouter.ai/api/v1/chat/completions', S.orKey, S.orModel, s, m, { 'HTTP-Referer': location.origin, 'X-Title': 'Jarvis' }), discover: discoverOpenRouter });
  return list;
}

async function fetchJSON(url, opts, ms = 25000) {
  const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ac.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${r.status} ${j.error?.message || j.error || ''}`.trim());
    return j;
  } finally { clearTimeout(tm); }
}

async function callGemini(sys, msgs) {
  const contents = [];
  msgs.forEach(m => {
    const role = m.role === 'user' ? 'user' : 'model';
    if (contents.length && contents.at(-1).role === role) contents.at(-1).parts[0].text += '\n' + m.content;
    else contents.push({ role, parts: [{ text: m.content }] });
  });
  if (contents[0]?.role !== 'user') contents.unshift({ role: 'user', parts: [{ text: '(oturum başladı)' }] });
  const j = await fetchJSON(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(S.geminiModel)}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': S.geminiKey },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents, generationConfig: { temperature: .7, maxOutputTokens: 4096 } })
  });
  const txt = j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
  if (!txt) throw new Error('boş cevap');
  return txt;
}

async function callOpenAI(url, key, model, sys, msgs, extra = {}) {
  const j = await fetchJSON(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, ...extra },
    body: JSON.stringify({ model, temperature: .7, max_tokens: 4096, ...(/gpt-oss/.test(model) ? { reasoning_effort: 'low' } : {}), messages: [{ role: 'system', content: sys }, ...msgs] })
  });
  const txt = j.choices?.[0]?.message?.content?.trim();
  if (!txt) throw new Error('boş cevap');
  return txt;
}

const MODEL_GONE = /404|not.?found|decommission|deprecat|does not exist|no longer|model_not_found|invalid model|not a valid model|not supported|unknown model|no endpoints/i;

async function discoverGemini() {
  const j = await fetchJSON('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': S.geminiKey } });
  const ok = (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace(/^models\//, '')).filter(n => !/image|tts|live|audio|embedding|robotics|computer|exp/i.test(n));
  const ver = n => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [0, 0])[1]);
  const rank = n => (/-flash$/.test(n) ? 3 : /-flash-lite$/.test(n) ? 2 : /flash/.test(n) && !/preview/.test(n) ? 1 : 0);
  ok.sort((a, b) => rank(b) - rank(a) || ver(b) - ver(a));
  return ok[0];
}
async function discoverGroq() {
  const j = await fetchJSON('https://api.groq.com/openai/v1/models', { headers: { Authorization: 'Bearer ' + S.groqKey } });
  const ids = (j.data || []).filter(m => m.active !== false).map(m => m.id).filter(i => !/whisper|guard|tts|orpheus|playai|compound/i.test(i));
  return ['openai/gpt-oss-120b', 'qwen/qwen3.6-27b', 'openai/gpt-oss-20b'].find(i => ids.includes(i)) || ids.find(i => /gpt-oss|qwen|llama|kimi/i.test(i)) || ids[0];
}
async function discoverOpenRouter() {
  const j = await fetchJSON('https://openrouter.ai/api/v1/models', {});
  const ids = (j.data || []).map(m => m.id);
  if (ids.includes('openrouter/free')) return 'openrouter/free';
  const free = ids.filter(i => i.endsWith(':free'));
  return free.find(i => /gpt-oss-120b/.test(i)) || free.find(i => /llama|qwen|gemma|deepseek|mistral/i.test(i)) || free[0];
}

async function think(sys, msgs) {
  const errs = [];
  for (const p of providers()) {
    try {
      let out;
      try { out = await p.call(sys, msgs); }
      catch (e) {
        if (!MODEL_GONE.test(e.message)) throw e;
        const m = await p.discover().catch(() => null);
        if (!m || m === S[p.mk]) throw e;
        addLog('sys', `◆ ${p.name} modeli güncellendi: ${S[p.mk]} → ${m}`);
        S[p.mk] = m; save('jarvis.settings', S);
        out = await p.call(sys, msgs);
      }
      if (activeBrain !== p.name) { activeBrain = p.name; refreshChips(); }
      return out;
    } catch (e) { errs.push(p.name + ': ' + e.message); console.warn(p.name, e); }
  }
  activeBrain = '—'; refreshChips();
  throw new Error(errs.join(' | ') || 'anahtar yok');
}

function systemPrompt(userText = '') {
  const p = M.profile, now = new Date();
  const wantNews = /brifing|haber|gündem|günaydın|spor|siyaset|maç|seçim|meclis|neler oluyor|bugün neler/i.test(userText);
  const mailCtx = mails.slice(0, 8).map((m, i) => `${i + 1}. [önem ${m.score}] ${m.from} — "${m.subject}" — ${m.snippet.slice(0, 140)} (${m.ago})`).join('\n') || (token ? 'Okunmamış önemli mail yok.' : 'Google bağlı değil.');
  const stale = mails.filter(m => m.hours >= 24).length;
  const taskCtx = tasks.map(t => `- ${t.title}${t.due ? ' (son tarih ' + t.due + ')' : ''}`).join('\n') || (token ? 'Liste boş.' : 'Google bağlı değil.');
  return `${timeBlock()}

Sen JARVIS'sin: ${p.name || 'kullanıcının'} kişisel yapay zeka asistanısın. Kullanıcıya "${p.hitap || 'efendim'}" diye hitap et.
Kişiliğin: sakin, zeki, son derece kibar, ince ve kuru bir espri anlayışı olan sadık bir asistan. Her zaman Türkçe konuş.
Cevapların SESLİ okunacak: markdown, yıldız, emoji, madde işareti, link kullanma. Genelde 1-3 kısa cümle; brifing ve mail okumada en fazla 6 cümle.
Konuştuğun cihaz: ${S.deviceName}.

KULLANICI HAKKINDA:
${p.about || '(henüz bilgi yok)'}
Önemli kişiler: ${p.vip || '(belirtilmedi)'}
Hatırladıkların:
${M.facts.map(f => '- ' + f.text).join('\n') || '(henüz yok)'}

GÜNCEL DURUM:
Okunmamış önemli mailler:
${mailCtx}
${stale ? `Dikkat: ${stale} önemli mail 1 günden uzun süredir okunmamış; uygun olduğunda hatırlat.` : ''}
Yapılacaklar:
${taskCtx}
Hava durumu: ${weatherText() || 'bilinmiyor'}
Bugünkü takvim:
${calendarText() || (token ? 'Bugün takvimde etkinlik yok.' : 'Google bağlı değil.')}
${wantNews ? newsContext() : ''}
WHATSAPP (bilgisayardaki bildirimlerden):
${whatsappContext()}
Şu an çalan müzik: ${ytCur && $('#yt').classList.contains('on') ? `${ytCur.title} — ${ytCur.channel}${ytQueue.length > 1 ? ` (sırada ${ytQueue.length - ytIdx - 1} şarkı daha)` : ''}` : 'yok'}
Bilgisayar ajanı: ${agent ? (agentOnline() ? `çevrimiçi (${agent.name}, ${agent.files} dosya dizinli)` : 'çevrimdışı, bilgisayar kapalı veya uykuda olabilir') : 'kurulmamış'}
Son dosya arama sonuçları:
${fileResults.map(f => `${f.n}. ${f.name} — ${f.folder} — ${f.date}`).join('\n') || '(yok)'}

EYLEMLER: Bir iş yapman gerektiğinde cevabının EN SONUNA, her biri ayrı satırda olacak şekilde şu komutları ekle. Bu satırlar sesli okunmaz:
[[GOREV_EKLE: görev metni | YYYY-AA-GG]]   (tarih yoksa | ve sonrasını yazma)
[[GOREV_TAMAM: listedeki görevin adı]]
[[HATIRLA: kullanıcı hakkında kalıcı, önemli bilgi]]   (kendisi hakkında önemli bir şey söylediğinde veya "bunu hatırla" dediğinde)
[[UNUT: unutulacak bilgi]]
[[MAIL_YENILE]]
[[MUZIK: sonraki | onceki | oynat | durdur]]
[[YOUTUBE: arama sorgusu | sarki veya liste]]   (kullanıcı müzik/şarkı/sanatçı/video çalmak istediğinde. Belirli bir şarkı → sarki, örn. "Duman'dan Bu Akşam'ı çal" → [[YOUTUBE: Duman Bu Akşam | sarki]]. Tür, ruh hali, sanatçının şarkıları veya "biraz müzik" → liste, örn. "biraz Türkçe rock" → [[YOUTUBE: Türkçe rock karışık | liste]]; "sevdiğim şeylerden çal" → hafızadaki zevkine göre bir sorgu yaz.)
[[SES: ac | kis]]   (çalan müziğin sesi)
[[ARA: internette aranacak kısa sorgu]]   (güncel ya da bilmediğin bir bilgi gerektiğinde: fiyatlar, döviz, maç sonuçları, son dakika olaylar, "şu an kim", açılış saatleri, bir ürün/kişi/yer hakkında güncel bilgi, ya da kullanıcı "internette/Google'da ara" dediğinde. Kendi bilgin eski olabilir; emin değilsen ARA kullan. Bu durumda sadece "Hemen bakıyorum" de, cevabı sonuçlar gelince vereceksin.)
SEN MÜZİK ÇALABİLİRSİN: YouTube üzerinden her şarkıyı çalabilirsin. Asla "müzik çalamıyorum" veya "başka bir uygulamadan aç" deme; her müzik isteğinde mutlaka [[YOUTUBE: …]] komutunu ekle.
Müzik açarken sadece "Hemen açıyorum" gibi çok kısa bir cümle söyle.
[[DOSYA_ARA: anahtar kelimeler | dosya türü | son kaç gün]]   (bilgisayardaki dosyayı bulmak için; tür örn. pdf, word, excel, foto, video, müzik; tür ve gün bilinmiyorsa boş bırak. Örn. "geçen ay indirdiğim kira sözleşmesi pdf'i" → [[DOSYA_ARA: kira sözleşmesi | pdf | 45]])
[[DOSYA_GONDER: sonuç numarası]]   (kullanıcı son arama sonuçlarından birini telefonuna istediğinde)
Dosya ararken veya gönderirken sadece "Hemen bakıyorum" gibi kısa bir cümle söyle; sonuçları sistem ayrıca okuyacak. Tek sonuç varsa ve kullanıcı açıkça "gönder" dediyse aramadan sonra numarayı sorma.
Kullanıcı bir şeyi hatırlatmanı isterse (örn. "Ali'nin mesajına bakmayı hatırlat") bunu görev olarak ekle.
BRİFİNG istendiğinde şu sırayla, akıcı ve doğal konuş (en fazla 10 cümle): selam ve hava (yağmur, kar veya sert rüzgâr varsa şemsiye ya da mont öner), bugünkü takvim (ilk etkinliğe ne kadar kaldığını söyle), önemli mailler, WhatsApp'ta bekleyen mesajlar (kimden, ne zamandan beri, kısaca ne yazmışlar; uzun süredir bakılmamışları özellikle hatırlat), yapılacaklar ve gecikenler, en son spor ve siyaset gündeminden 2-3'er başlık.
HABERLERİ özetlerken: sadece verilen başlıklara dayan, tamamen tarafsız ol, yorum, taraf tutma ya da kendi değerlendirmeni katma; iddiaları "… açıkladı", "… iddia edildi" gibi kaynağına bağla; başlıklarda olmayan ayrıntı uydurma.
WHATSAPP mesajlarını aktarırken kısa ve doğal ol ("Ahmet akşam maça gelip gelmeyeceğinizi soruyor"); mesajları birebir okumak yerine özetle, kullanıcı isterse tam metni oku. Grup mesajlarında grup adını söyle. Cevap yazmanı isterse, WhatsApp'tan kendisinin göndermesi gerektiğini söyle.
Bilmediğin şeyi uydurma. Google bağlı değilse mail ve görevler için sağ üstteki güç düğmesiyle bağlanmasını söyle.`;
}

/* =========================================================
   KOMUT İŞLEME
   ========================================================= */
let busy = false;
let lastUserText = '';
async function handleUser(text) {
  if (busy) return;
  lastUserText = text;
  busy = true; stopRec(true);
  addLog('u', text);
  pushHistory('u', text);
  setState('thinking');
  let reply;
  try {
    const ta = timeAnswer(text);
    if (ta) reply = ta;
    else if (!hasBrain()) reply = await offlineBrain(text);
    else {
      const msgs = M.history.slice(-14).map(h => ({ role: h.r === 'u' ? 'user' : 'assistant', content: h.r === 'u' ? msgStamp(h.t) + h.c : h.c }));
      const raw = await think(systemPrompt(text), msgs);
      reply = await runActions(raw);
      // "Google'da ara" dendiği halde yapay zeka arama komutu vermezse
      if (searchIntent(text) && !/\[\[\s*ARA/i.test(raw)) { pending.push(() => webAnswer(searchQuery(text), text)); reply = 'Hemen bakıyorum.'; }
      // Yapay zeka müzik komutunu unutursa isteği Jarvis kendisi yakalar
      if (musicIntent(text) && !/\[\[\s*YOUTUBE/i.test(raw) && !/\[\[\s*MUZIK/i.test(raw)) {
        const q = musicQuery(text);
        pending.push(() => playYouTube(q.query, q.kind));
        reply = 'Hemen açıyorum.';
      }
    }
  } catch (e) {
    console.error(e); fx.err();
    reply = 'Üzgünüm, beyin modüllerimin hiçbirine ulaşamadım. Anahtarları ve internet bağlantısını kontrol eder misiniz?';
    addLog('sys', 'HATA: ' + e.message.slice(0, 400));
  }
  busy = false;
  addLog('j', reply);
  pushHistory('j', reply);
  const jobs = pending; pending = [];
  await speak(reply);
  for (const job of jobs) { try { await job(); } catch (e) { addLog('sys', 'HATA: ' + e.message); } }
}

function pushHistory(r, c) {
  M.history.push({ r, c, t: Date.now(), d: S.deviceName });
  M.history = M.history.slice(-40);
  saveMem();
}

async function runActions(raw) {
  const re = /\[\[\s*([A-ZÇĞİÖŞÜ_]+)\s*:?\s*([^\]]*)\]\]/g;
  const acts = [...raw.matchAll(re)];
  const clean = raw.replace(re, '').replace(/[*#_`>]/g, '').replace(/\n{2,}/g, '\n').trim();
  for (const [, cmd, arg0] of acts) {
    const arg = arg0.trim();
    try {
      switch (cmd) {
        case 'GOREV_EKLE': { const [title, due] = arg.split('|').map(s => s.trim()); await addTask(title, due); break; }
        case 'GOREV_TAMAM': await completeTaskByName(arg); break;
        case 'HATIRLA': remember(arg); break;
        case 'UNUT': forget(arg); break;
        case 'MAIL_YENILE': await loadMails(); break;
        case 'MUZIK': music(arg.toLowerCase().replace('ö', 'o')); break;
        case 'YOUTUBE': { const [q, k] = arg.split('|').map(x => (x || '').trim().toLowerCase()); pending.push(() => playYouTube(arg.split('|')[0].trim(), /liste/.test(k || '') ? 'liste' : 'sarki')); break; }
        case 'SES': ytVolume(/a[cç]/.test(arg.toLowerCase()) ? 'ac' : 'kis'); break;
        case 'ARA': { const q = arg, ut = lastUserText; pending.push(() => webAnswer(q, ut)); break; }
        case 'DOSYA_ARA': { const [q, ft, d] = arg.split('|').map(x => (x || '').trim()); pending.push(() => fileSearch(q, ft, parseInt(d) || 0)); break; }
        case 'DOSYA_GONDER': pending.push(() => fileSend(parseInt(arg) || 1)); break;
      }
    } catch (e) { addLog('sys', cmd + ' yapılamadı: ' + e.message); }
  }
  return clean || 'Tamamdır.';
}


/* müzik isteğini yerelde tanıma (yapay zekadan bağımsız yedek) */
function musicIntent(t) {
  const s = t.toLocaleLowerCase('tr');
  if (/(sonraki|önceki|durdur|duraklat|devam et|sesi (aç|kıs)|bu şarkı ne)/.test(s)) return false;
  if (/(^|\s)(çal|çalsana|çalar mısın|çalabilir misin|çalın|dinlet|dinletir misin)(\s|$|[.!?,])|dinlemek istiyorum|youtube'?(da|dan|ta|tan)/.test(s)) return true;
  return /(^|\s)(aç|açsana|açar mısın|koy|koysana)(\s|$|[.!?,])/.test(s) && /(şarkı|müzik|parça|klip|albüm|youtube|playlist|liste)/.test(s);
}
function musicQuery(t) {
  const liste = /(biraz|karışık|şarkıları|şarkılarından|bir şeyler|tarzı|türü|playlist|çalma listesi|müzik)/i.test(t);
  let q = t.replace(/['’`´]\p{L}+/gu, '')                              // Haram Geceler'i → Haram Geceler, Duman'dan → Duman
    .replace(/(^|\s)(hey|jarvis|lütfen|bana|bize|biraz|bir|youtube|youtubedan|youtubeda|şarkısını|şarkısı|şarkıyı|şarkı|şarkılarından|şarkıları|parçasını|parça|müziğini|müzik|klibini|çal|çalsana|çalar|mısın|misin|çalabilir|çalın|aç|açsana|açar|koy|koysana|dinlet|dinletir|dinlemek|istiyorum|şimdi|hemen)(?=\s|$|[.!?,])/giu, ' ')
    .replace(/[.!?,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!q) q = (M.profile.about && /müzik|rock|pop|rap|caz|jazz|arabesk|türkü/i.test(M.profile.about)) ? M.profile.about.match(/(rock|pop|rap|caz|jazz|arabesk|türkü|klasik)/i)?.[0] + ' karışık' : 'Türkçe pop karışık';
  return { query: q + (liste && !/karışık|playlist|liste/i.test(q) ? ' karışık' : ''), kind: liste ? 'liste' : 'sarki' };
}

/* anahtar yokken basit yerel cevaplar */
async function offlineBrain(t) {
  const s = t.toLocaleLowerCase('tr');
  const h = M.profile.hitap || 'efendim';
  if (/sonraki|geç|atla/.test(s) && /şarkı|parça|müzik/.test(s)) { music('sonraki'); return 'Sıradaki parçaya geçiyorum.'; }
  if (searchIntent(t)) { pending.push(() => webAnswer(searchQuery(t), t)); return 'Hemen bakıyorum.'; }
  if (musicIntent(t)) { const q = musicQuery(t); pending.push(() => playYouTube(q.query, q.kind)); return 'Hemen açıyorum.'; }
  if (/önceki/.test(s) && /şarkı|parça/.test(s)) { music('onceki'); return 'Önceki parçaya dönüyorum.'; }
  if (/durdur|duraklat|devam et|oynat/.test(s)) { music('oynat'); return 'Müzik komutunu ilettim.'; }
  if (/brifing|günaydın/.test(s)) return briefingText();
  if (/haber|gündem|spor|siyaset/.test(s)) return news ? 'Spor: ' + (news.spor || []).slice(0, 3).map(x => x.title).join('. ') + '. Siyaset: ' + (news.siyaset || []).slice(0, 3).map(x => x.title).join('. ') + '.' : 'Haber akışı henüz hazır değil.';
  if (/whatsapp|mesaj/.test(s)) { const w = waGroups().filter(x => x.waiting); return !wa ? 'WhatsApp verisine ulaşamıyorum.' : w.length ? 'WhatsApp\'ta bekleyenler: ' + w.map(x => `${x.sender}, ${x.waiting} mesaj, ${ago(x.first)}`).join('; ') + '.' : 'WhatsApp\'ta bekleyen mesajınız yok.'; }
  if (/hava/.test(s)) return weatherText() ? 'Hava: ' + weatherText() + '.' : 'Hava durumu bilgisine ulaşamadım.';
  if (/takvim|ajanda|toplantı/.test(s)) return calendarText() ? 'Bugün: ' + calendarText().replace(/\n/g, ', ') : 'Bugün takviminizde etkinlik görünmüyor.';
  if (/gönder/.test(s) && fileResults.length) { const n = parseInt(s.match(/\d+/)?.[0]) || (/ikinci/.test(s) ? 2 : /üçüncü/.test(s) ? 3 : 1); pending.push(() => fileSend(n)); return 'Gönderiyorum.'; }
  if (/dosya|bul\b|bulur/.test(s)) { pending.push(() => fileSearch(t, '', 0)); return 'Bilgisayarınızda arıyorum.'; }
  if (/mail|posta|e-?posta/.test(s)) return mailText();
  if (/hatırlat|ekle/.test(s)) {
    const title = t.replace(/(bana|jarvis|lütfen|listeme|listeye|ekle|hatırlat|bunu)/gi, '').trim();
    if (title) { await addTask(title); return `"${title}" listenize eklendi, ${h}.`; }
  }
  if (/görev|yapılacak|liste/.test(s)) return taskText();
  return `Beyin modülüm henüz çevrimdışı, ${h}. Ayarlardan bir API anahtarı girerseniz sizinle gerçek bir sohbete hazırım.`;
}
const mailText = () => !token ? 'Google hesabınız bağlı değil.' :
  mails.length ? `${mails.length} okunmamış önemli mailiniz var. ` + mails.slice(0, 3).map(m => `${m.from}: ${m.subject}.`).join(' ') : 'Okunmamış önemli mailiniz yok.';
const taskText = () => !token ? 'Google hesabınız bağlı değil.' :
  tasks.length ? `Listenizde ${tasks.length} iş var: ` + tasks.slice(0, 5).map(t => t.title).join(', ') + '.' : 'Yapılacaklar listeniz boş.';
function briefingText() {
  const hr = new Date().getHours();
  const g = hr < 5 ? 'İyi geceler' : hr < 12 ? 'Günaydın' : hr < 18 ? 'İyi günler' : hr < 22 ? 'İyi akşamlar' : 'İyi geceler';
  const wx = weatherText(), cal = calendarText();
  const n = news ? ` Spor gündeminde: ${(news.spor || []).slice(0, 2).map(x => x.title).join('. ')}. Siyasette: ${(news.siyaset || []).slice(0, 2).map(x => x.title).join('. ')}.` : '';
  const ww = waGroups().filter(x => x.waiting);
  const wtxt = ww.length ? ` WhatsApp'ta ${ww.map(x => x.sender + ' ' + x.waiting + ' mesaj').join(', ')} bekliyor.` : '';
  return `${g} ${M.profile.name || M.profile.hitap}. ${wx ? 'Hava: ' + wx + '.' : ''} ${cal ? 'Bugün takviminizde: ' + cal.replace(/\n/g, ', ') + '.' : ''} ${mailText()}${wtxt} ${taskText()}${n}`;
}

/* =========================================================
   HAFIZA
   ========================================================= */
function remember(text) {
  if (!text || M.facts.some(f => f.text.toLowerCase() === text.toLowerCase())) return;
  M.facts.push({ id: uid(), text, t: Date.now() }); saveMem(); renderFacts(); fx.ok();
  addLog('sys', '◆ HAFIZAYA EKLENDİ: ' + text);
}
function forget(text) {
  const q = text.toLowerCase();
  const gone = M.facts.filter(f => f.text.toLowerCase().includes(q) || q.includes(f.text.toLowerCase()));
  gone.forEach(f => M.removed.push(f.id));
  M.facts = M.facts.filter(f => !gone.includes(f)); saveMem(); renderFacts();
}
function renderFacts() {
  const box = $('#facts');
  box.innerHTML = M.facts.length ? M.facts.map(f => `<div class="fact">◆ ${esc(f.text)}<button data-id="${f.id}">SİL</button></div>`).join('')
    : '<div class="hint">Henüz bir şey öğrenmedim. Sohbet ettikçe ya da "bunu hatırla" dedikçe burası dolacak.</div>';
  box.querySelectorAll('button').forEach(b => b.onclick = () => {
    M.removed.push(b.dataset.id); M.facts = M.facts.filter(f => f.id !== b.dataset.id); saveMem(); renderFacts();
  });
}

/* =========================================================
   MÜZİK — iPhone'da Kestirmeler üzerinden
   ========================================================= */
const SHORTCUTS = { sonraki: 'Jarvis Sonraki', onceki: 'Jarvis Önceki', oynat: 'Jarvis Oynat' };
function music(action) {
  if (ytActive()) return ytControl(action === 'oynat' ? 'toggle' : action === 'onceki' ? 'prev' : action === 'durdur' ? 'pause' : 'next');
  const name = SHORTCUTS[action === 'durdur' ? 'oynat' : action] || SHORTCUTS.sonraki;
  if (isIOS) {
    fx.ok();
    setTimeout(() => { location.href = 'shortcuts://run-shortcut?name=' + encodeURIComponent(name); }, 150);
  } else {
    toast('Müzik kontrolü iPhone/iPad\'de Kestirmeler ile çalışır. Kurulum rehberine bakın.');
  }
}


/* =========================================================
   YOUTUBE MÜZİK — arama: YouTube Data API · çalma: iPhone'da YouTube
   uygulaması (Premium ile arka planda), bilgisayarda Jarvis içi oynatıcı
   ========================================================= */
let ytQueue = [], ytIdx = 0, ytPlayer = null, ytIsPlaying = false, ytVol = 100, ytCur = null;
const ytMode = () => S.ytMode === 'app' || S.ytMode === 'embed' ? S.ytMode : (isIOS ? 'app' : 'embed');
const ytActive = () => ytMode() === 'embed' && !!ytPlayer && ytQueue.length > 0 && $('#yt').classList.contains('on');

async function ytApiGet(path, params) {
  const u = new URL('https://www.googleapis.com/youtube/v3/' + path);
  Object.entries({ ...params, key: S.ytKey }).forEach(([k, v]) => u.searchParams.set(k, v));
  return fetchJSON(u.toString(), {});
}
const ytItem = (id, sn, list) => ({ id, list, title: decodeHtml(sn.title), channel: decodeHtml(sn.channelTitle || sn.videoOwnerChannelTitle || ''), thumb: sn.thumbnails?.medium?.url || sn.thumbnails?.default?.url || '' });

async function ytFind(query, kind) {
  const embed = ytMode() === 'embed';
  if (kind === 'liste') {
    const pl = await ytApiGet('search', { part: 'snippet', type: 'playlist', maxResults: 5, q: query, regionCode: 'TR', relevanceLanguage: 'tr' });
    const p0 = pl.items?.[0];
    if (p0) {
      const listId = p0.id.playlistId;
      const it = await ytApiGet('playlistItems', { part: 'snippet', playlistId: listId, maxResults: 30 });
      const vids = (it.items || []).filter(x => x.snippet?.resourceId?.videoId && !/deleted|private/i.test(x.snippet.title))
        .map(x => ytItem(x.snippet.resourceId.videoId, x.snippet, listId));
      if (vids.length) { vids.listTitle = decodeHtml(p0.snippet.title); return vids; }
    }
  }
  const r = await ytApiGet('search', { part: 'snippet', type: 'video', videoCategoryId: 10, maxResults: kind === 'liste' ? 15 : 8, q: query, regionCode: 'TR', relevanceLanguage: 'tr', ...(embed ? { videoEmbeddable: 'true' } : {}) });
  return (r.items || []).map(x => ytItem(x.id.videoId, x.snippet));
}

async function playYouTube(query, kind = 'sarki') {
  query = (query || '').trim(); if (!query) return;
  const h = M.profile.hitap || 'efendim';
  if (!S.ytKey) {
    const url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query);
    if (isIOS) location.href = 'youtube://www.youtube.com/results?search_query=' + encodeURIComponent(query); else window.open(url, '_blank');
    return say(`YouTube'da aramayı açtım, ${h}. Şarkıyı doğrudan çalabilmem için ayarlara YouTube anahtarı eklemeniz gerekiyor.`);
  }
  setState('thinking', 'YOUTUBE ARANIYOR');
  let list;
  try { list = await ytFind(query, kind); }
  catch (e) {
    setState('idle');
    return say(/quota/i.test(e.message) ? `Bugünkü YouTube arama kotası doldu, ${h}. Yarın sıfırlanacak.` : 'YouTube araması yapılamadı: ' + e.message.slice(0, 120));
  }
  setState('idle');
  if (!list.length) return say(`YouTube'da bununla eşleşen bir şey bulamadım, ${h}.`);
  ytQueue = list; ytIdx = 0;
  addLog('sys', `▶ YOUTUBE: ${list.listTitle ? list.listTitle + ' (' + list.length + ' şarkı)' : list[0].title}`);
  pushHistory('j', `(YouTube'da çalınıyor: ${list[0].title} — ${list[0].channel})`);
  ytStart();
}

function ytStart() {
  const v = ytQueue[ytIdx]; if (!v) return;
  ytCur = v;
  const box = $('#yt');
  box.classList.add('on'); box.classList.toggle('embed', ytMode() === 'embed'); box.classList.toggle('app', ytMode() === 'app');
  $('#ytTitle').textContent = v.title; $('#ytCh').textContent = v.channel; $('#ytThumb').src = v.thumb;
  $('#ytPos').textContent = ytQueue.length > 1 ? `· ${ytIdx + 1}/${ytQueue.length}` : '';
  if (ytMode() === 'embed') ytEmbed(v); else ytOpenApp(v);
}

function ytOpenApp(v) {
  const q = `v=${v.id}${v.list ? '&list=' + v.list : ''}`;
  box_playing(false);
  // YouTube uygulaması (Premium hesabıyla arka planda çalar); yoksa web sürümü
  location.href = `youtube://www.youtube.com/watch?${q}`;
  setTimeout(() => { if (!document.hidden) window.open(`https://www.youtube.com/watch?${q}`, '_blank'); }, 1800);
}

function ytApiLoad() {
  return new Promise((res, rej) => {
    if (window.YT?.Player) return res();
    window.onYouTubeIframeAPIReady = res;
    const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; s.onerror = () => rej(new Error('YouTube oynatıcı yüklenemedi'));
    document.head.appendChild(s);
  });
}
async function ytEmbed(v) {
  try { await ytApiLoad(); } catch (e) { toast(e.message); return ytOpenApp(v); }
  if (ytPlayer?.loadVideoById) { ytPlayer.loadVideoById(v.id); return; }
  ytPlayer = new YT.Player('ytFrame', {
    videoId: v.id, host: 'https://www.youtube-nocookie.com',
    playerVars: { autoplay: 1, playsinline: 1, rel: 0, modestbranding: 1 },
    events: {
      onReady: e => { e.target.setVolume(ytVol); e.target.playVideo(); },
      onStateChange: e => { box_playing(e.data === 1); if (e.data === 0) ytControl('next', true); },
      onError: () => { addLog('sys', 'Bu video Jarvis içinde çalınamıyor, sıradakine geçiyorum.'); ytControl('next', true); }
    }
  });
}
function box_playing(on) { ytIsPlaying = on; $('#yt').classList.toggle('playing', on); $('#ytTog').textContent = on ? '⏸' : '▶'; }

function ytControl(action, auto) {
  if (!ytQueue.length) return;
  if (action === 'next') { if (ytIdx < ytQueue.length - 1) { ytIdx++; ytStart(); } else if (!auto) toast('Sıradaki şarkı yok.'); else box_playing(false); return; }
  if (action === 'prev') { if (ytPlayer?.getCurrentTime && ytPlayer.getCurrentTime() > 8) ytPlayer.seekTo(0); else if (ytIdx > 0) { ytIdx--; ytStart(); } return; }
  if (action === 'open') { const v = ytQueue[ytIdx]; ytPlayer?.pauseVideo?.(); return ytOpenApp(v); }
  if (action === 'close') { ytPlayer?.stopVideo?.(); $('#yt').classList.remove('on'); box_playing(false); return; }
  if (!ytPlayer?.getPlayerState) return;
  if (action === 'pause' || (action === 'toggle' && ytIsPlaying)) ytPlayer.pauseVideo(); else ytPlayer.playVideo();
}
$$('#yt [data-yt]').forEach(b => b.onclick = () => ytControl(b.dataset.yt));

// Jarvis konuşurken müziğin sesini kıs
function ytDuck(on) {
  if (!ytPlayer?.setVolume || !ytIsPlaying) return;
  ytPlayer.setVolume(on ? Math.round(ytVol * .2) : ytVol);
}
function ytVolume(dir) {
  ytVol = Math.max(5, Math.min(100, ytVol + (dir === 'ac' ? 20 : -20)));
  ytPlayer?.setVolume?.(ytVol);
}


/* =========================================================
   İNTERNETTE ARAMA — Tavily (ücretsiz 1000/ay) › PC ajanı üzerinden Tavily
   › Vikipedi › "Google'da aç" düğmesi
   ========================================================= */
function searchIntent(t) {
  const s = t.toLocaleLowerCase('tr');
  if (/araştır/.test(s)) return true;                                     // "araştır", "araştırır mısın"
  const where = /(google|internet|web(?!cam)|online|çevrimiçi)/.test(s);   // "annemi ara" telefon etmek demek; tek başına arama sayılmaz
  return where && /(^|\s)(ara|arar|arasana|bak|bakar|baksana|bul|bulur|sorgula)(\s|$|[.!?,]|\s?(mısın|misin|bakalım))/.test(s);
}
function searchQuery(t) {
  let q = t.replace(/(^|\s)(jarvis|lütfen|bana|bir|google'?(da|dan|la|a)?|internette|internetten|internete|webde|ara|arar|arasana|mısın|misin|araştır|araştırır|araştırsana|bak|bakar|baksana|bakalım|bakabilir|hakkında|sorgula)(?=\s|$|[.!?,])/giu, ' ')
    .replace(/[?.!,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!q || /^(bunu|şunu|onu|bunları|şunları)$/i.test(q)) {           // "bunu araştır" → önceki sorunu ara
    const prev = M.history.filter(h => h.r === 'u').slice(-2, -1)[0];
    q = prev ? prev.c : t;
  }
  return q;
}

async function tavilySearch(q) {
  const body = { query: q, search_depth: 'basic', max_results: 5, include_answer: true, topic: 'general' };
  try {
    const j = await fetchJSON('https://api.tavily.com/search', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + S.tavilyKey }, body: JSON.stringify(body) }, 20000);
    return { answer: j.answer || '', results: (j.results || []).map(r => ({ title: r.title, url: r.url, text: (r.content || '').slice(0, 700) })), via: 'Tavily' };
  } catch (e) {
    // tarayıcı engellediyse (CORS / ağ) aramayı PC ajanı yapsın
    if (e instanceof TypeError && agentOnline()) {
      const r = await agentCmd('websearch', { query: q, key: S.tavilyKey }, 30000);
      return { answer: r.answer || '', results: r.results || [], via: 'Tavily (PC)' };
    }
    throw e;
  }
}
async function wikiSearch(q) {
  const s = await fetchJSON(`https://tr.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=3&format=json&origin=*`, {}, 12000);
  const hits = s.query?.search || [];
  const out = [];
  for (const h of hits.slice(0, 2)) {
    try {
      const p = await fetchJSON(`https://tr.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(h.title.replace(/ /g, '_'))}`, {}, 12000);
      if (p.extract) out.push({ title: p.title, url: p.content_urls?.desktop?.page || '', text: p.extract.slice(0, 900) });
    } catch {}
  }
  return { answer: '', results: out, via: 'Vikipedi' };
}

async function webSearch(q) {
  const errs = [];
  if (S.tavilyKey) { try { const r = await tavilySearch(q); if (r.results.length || r.answer) return r; } catch (e) { errs.push('Tavily: ' + e.message); } }
  try { const r = await wikiSearch(q); if (r.results.length) return r; } catch (e) { errs.push('Vikipedi: ' + e.message); }
  if (errs.length) console.warn('arama', errs);
  return { answer: '', results: [], via: '', errs };
}

function addSources(res, q) {
  const el = document.createElement('div'); el.className = 'msg sys';
  const g = `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  el.innerHTML = '🔎 ' + (res.results.length ? `${esc(res.via)}: ` + res.results.slice(0, 3).map(r => {
    let host = ''; try { host = new URL(r.url).hostname.replace(/^www\./, ''); } catch {}
    return `<a href="${esc(r.url)}" target="_blank" rel="noopener" style="color:var(--c2)">${esc(host || r.title)}</a>`;
  }).join(' · ') + ' · ' : '') + `<a href="${esc(g)}" target="_blank" rel="noopener" style="color:var(--a)">GOOGLE'DA AÇ ↗</a>`;
  const log = $('#log'); log.appendChild(el); log.scrollTop = log.scrollHeight;
}

async function webAnswer(q, userText) {
  q = (q || '').trim(); if (!q) return;
  const h = M.profile.hitap || 'efendim';
  setState('thinking', 'İNTERNETTE ARANIYOR');
  const res = await webSearch(q);
  addSources(res, q);
  if (!res.results.length && !res.answer) {
    setState('idle');
    return say(S.tavilyKey ? `İnternette buna dair bir sonuç bulamadım, ${h}. Google'da açmak için ekrandaki bağlantıya dokunabilirsiniz.`
      : `Bunu internette aramam için ayarlara ücretsiz bir Tavily anahtarı eklemeniz gerekiyor, ${h}. Şimdilik ekrandaki bağlantıyla Google'da açabilirsiniz.`);
  }
  const ctx = (res.answer ? `Hızlı özet: ${res.answer}\n` : '') + res.results.map((r, i) => `[${i + 1}] ${r.title} (${r.url})\n${r.text}`).join('\n\n');
  if (!hasBrain()) { setState('idle'); return say(res.answer || res.results[0].text.split(/(?<=[.!?])\s/).slice(0, 2).join(' ')); }
  const sys = systemPrompt(userText) + `

İNTERNET ARAMA SONUÇLARI (${res.via}, sorgu: "${q}", ${longDate(new Date())} ${clock(new Date())} itibarıyla):
${ctx}

Kullanıcının sorusunu SADECE bu sonuçlara dayanarak, sesli okunacak şekilde 1-4 kısa cümleyle cevapla. Sayıları ve tarihleri sonuçlardaki gibi ver. Sonuçlar çelişiyorsa ya da cevap içlerinde yoksa bunu açıkça söyle, uydurma. Siyasi konularda tarafsız kal. Kaynağı kısaca an ("… sitesine göre"). Bu cevapta hiçbir [[ ]] komutu kullanma.`;
  try {
    const out = (await think(sys, [{ role: 'user', content: msgStamp(Date.now()) + (userText || q) }])).replace(/\[\[[^\]]*\]\]/g, '').replace(/[*#_`>]/g, '').trim();
    setState('idle'); await say(out);
  } catch (e) { setState('idle'); await say(res.answer || 'Sonuçları özetlerken bir sorun oldu; ekrandaki kaynaklara bakabilirsiniz.'); }
}

/* =========================================================
   GOOGLE — giriş, Gmail, Tasks, Drive senkron
   ========================================================= */
const SCOPES = 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/tasks https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/calendar.readonly';
const SCOPE_VER = 2; // izin listesi değişince yeniden onay istenir
let tokenClient = null;

(function restoreToken() {
  const t = load('jarvis.token', null);
  if (t && t.exp > Date.now() + 60e3) { token = t.v; tokenExp = t.exp; }
})();

function initGoogle() {
  if (!S.clientId || !window.google?.accounts?.oauth2) return false;
  if (tokenClient && tokenClient._cid === S.clientId) return true;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: S.clientId, scope: SCOPES,
    callback: async r => {
      if (r.error) { toast('Google girişi başarısız: ' + r.error); return; }
      token = r.access_token; tokenExp = Date.now() + (r.expires_in - 60) * 1000;
      save('jarvis.token', { v: token, exp: tokenExp });
      S.googleWanted = true; S.scopeVer = SCOPE_VER; save('jarvis.settings', S);
      fx.ok(); refreshChips(); addLog('sys', '◆ GOOGLE HESABI BAĞLANDI');
      await afterGoogle();
    }
  });
  tokenClient._cid = S.clientId;
  return true;
}

function connectGoogle(silent) {
  if (!S.clientId) { if (!silent) { toast('Önce ayarlardan Google Client ID girin.'); openSettings(); } return; }
  if (!initGoogle()) { if (!silent) toast('Google kütüphanesi yükleniyor, birkaç saniye sonra tekrar deneyin.'); return; }
  tokenClient.requestAccessToken({ prompt: S.googleWanted && S.scopeVer === SCOPE_VER ? '' : 'consent' });
}
$('#gBtn').onclick = () => connectGoogle(false);

async function gfetch(url, opts = {}) {
  if (!token || Date.now() > tokenExp) { token = null; refreshChips(); throw new Error('Google oturumu yok veya süresi doldu'); }
  const r = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + token, ...(opts.headers || {}) } });
  if (r.status === 401) { token = null; localStorage.removeItem('jarvis.token'); refreshChips(); throw new Error('Google oturumunun süresi doldu'); }
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error?.message || r.status); }
  if (r.status === 204) return null;
  const ct = r.headers.get('content-type') || '';
  return ct.includes('json') ? r.json() : r.text();
}

async function afterGoogle() {
  await Promise.allSettled([loadMails(), loadTasks(), loadCalendar(), syncNow()]);
}

/* ----- Gmail ----- */
const KEYWORDS = /fatura|ödeme|borç|banka|kredi|acil|önemli|toplantı|son gün|son tarih|randevu|mahkeme|vergi|sgk|e-devlet|maaş|teklif|sözleşme|güvenlik|şifre|doğrulama|kargo|teslim|mülakat|invoice|urgent|payment|meeting|deadline/i;

function scoreMail(m) {
  let s = 0;
  const vip = (M.profile.vip || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
  if (m.labels.includes('IMPORTANT')) s += 2;
  if (m.labels.includes('STARRED')) s += 2;
  if (vip.some(v => m.fromRaw.toLowerCase().includes(v))) s += 4;
  if (KEYWORDS.test(m.subject + ' ' + m.snippet)) s += 2;
  if (m.labels.includes('CATEGORY_PROMOTIONS')) s -= 4;
  if (m.labels.includes('CATEGORY_SOCIAL')) s -= 2;
  if (m.labels.includes('CATEGORY_UPDATES')) s -= 1;
  if (/no-?reply|noreply|bülten|newsletter/i.test(m.fromRaw)) s -= 1;
  return s;
}

async function loadMails() {
  if (!token) return;
  const q = encodeURIComponent('in:inbox is:unread newer_than:7d');
  const list = await gfetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=30`);
  const ids = (list.messages || []).map(m => m.id);
  const full = await Promise.all(ids.map(id =>
    gfetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`).catch(() => null)));
  mails = full.filter(Boolean).map(x => {
    const H = n => (x.payload?.headers || []).find(h => h.name.toLowerCase() === n)?.value || '';
    const fromRaw = H('from');
    const hours = (Date.now() - +x.internalDate) / 36e5;
    const m = {
      id: x.id, fromRaw, from: fromRaw.replace(/<.*?>/, '').replace(/"/g, '').trim() || fromRaw,
      subject: H('subject') || '(konusuz)', snippet: decodeHtml(x.snippet), labels: x.labelIds || [],
      hours, ago: hours < 1 ? 'az önce' : hours < 24 ? Math.round(hours) + ' saat önce' : Math.round(hours / 24) + ' gün önce'
    };
    m.score = scoreMail(m);
    return m;
  }).filter(m => m.score >= 1).sort((a, b) => b.score - a.score || a.hours - b.hours);
  renderMails();
}

function renderMails() {
  $('#nMail').textContent = mails.length;
  $('#mails').innerHTML = mails.length ? mails.slice(0, 20).map((m, i) => `
    <div class="mail ${m.score >= 5 ? 'crit' : m.score >= 3 ? 'hot' : ''}" style="animation-delay:${i * 60}ms" data-id="${m.id}">
      <div class="f">${esc(m.from)}</div><div class="s">${esc(m.subject)}</div><div class="p">${esc(m.snippet)}</div>
      <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--dim);margin-top:4px"><span>${esc(m.ago)}</span><span>ÖNEM ${m.score}</span></div>
      <div class="bar"><b style="width:${Math.min(100, 20 + m.score * 12)}%"></b></div>
    </div>`).join('') : `<div class="empty">${token ? 'Okunmamış önemli mail yok. Harika.' : 'Google\'a bağlanınca önemli mailleriniz burada listelenecek.'}</div>`;
  $$('#mails .mail').forEach(el => el.onclick = () => window.open('https://mail.google.com/mail/u/0/#inbox/' + el.dataset.id, '_blank'));
}
$('#refMail').onclick = () => token ? loadMails().then(() => fx.ok()).catch(e => toast(e.message)) : connectGoogle();

/* ----- Google Tasks ----- */
const TASKS = 'https://tasks.googleapis.com/tasks/v1/lists/@default/tasks';
async function loadTasks() {
  if (!token) return;
  const j = await gfetch(TASKS + '?showCompleted=false&maxResults=100');
  tasks = (j.items || []).filter(t => t.title).map(t => ({ id: t.id, title: t.title, due: t.due ? t.due.slice(0, 10) : '' }))
    .sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
  renderTasks();
}
function renderTasks() {
  $('#nTask').textContent = tasks.length;
  const today = ymd(new Date());
  $('#tasks').innerHTML = tasks.length ? tasks.map((t, i) => `
    <div class="task" style="animation-delay:${i * 50}ms"><button class="ck" data-id="${t.id}" title="Tamamlandı"></button>
      <div><div class="t">${esc(t.title)}</div>${t.due ? `<div class="d" style="${t.due < today ? 'color:var(--r)' : ''}">◷ ${new Date(t.due + 'T12:00').toLocaleDateString('tr-TR', { day: 'numeric', month: 'long' })}${t.due < today ? ' · GECİKTİ' : ''}</div>` : ''}</div>
    </div>`).join('') : `<div class="empty">${token ? 'Liste boş. "Jarvis, yarın faturayı öde diye ekle" diyebilirsiniz.' : 'Google Tasks ile senkronize edilir. Tüm cihazlarınızda aynı liste.'}</div>`;
  $$('#tasks .ck').forEach(b => b.onclick = () => completeTask(b.dataset.id));
}
$('#refTask').onclick = () => token ? loadTasks().then(() => fx.ok()).catch(e => toast(e.message)) : connectGoogle();

async function addTask(title, due) {
  if (!title) return;
  if (!token) throw new Error('Google bağlı değil');
  const body = { title };
  if (due && /^\d{4}-\d{2}-\d{2}$/.test(due)) body.due = due + 'T00:00:00.000Z';
  await gfetch(TASKS, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  addLog('sys', '◆ GÖREV EKLENDİ: ' + title); fx.ok();
  await loadTasks();
}
async function completeTask(id) {
  await gfetch(`${TASKS}/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'completed' }) });
  fx.ok(); await loadTasks();
}
async function completeTaskByName(name) {
  const q = name.toLocaleLowerCase('tr');
  const t = tasks.find(t => t.title.toLocaleLowerCase('tr').includes(q) || q.includes(t.title.toLocaleLowerCase('tr')));
  if (!t) throw new Error('görev bulunamadı');
  await completeTask(t.id); addLog('sys', '◆ TAMAMLANDI: ' + t.title);
}

/* ----- Drive appData senkron: profil, hafıza, sohbet, cihazlar ----- */
const SYNC_FILE = 'jarvis-memory.json';
let syncFileId = load('jarvis.syncId', null), syncTimer = null, syncing = false;

function scheduleSync() { clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, 2500); }

function merge(a, b) {
  const out = structuredClone(MEM0);
  out.profile = (a.profile?.updated || 0) >= (b.profile?.updated || 0) ? a.profile : b.profile;
  out.removed = [...new Set([...(a.removed || []), ...(b.removed || [])])].slice(-300);
  const facts = new Map();
  [...(a.facts || []), ...(b.facts || [])].forEach(f => { if (!out.removed.includes(f.id)) facts.set(f.id, f); });
  out.facts = [...facts.values()].sort((x, y) => x.t - y.t);
  const hist = new Map();
  [...(a.history || []), ...(b.history || [])].forEach(h => hist.set(h.t + h.r + h.c.slice(0, 20), h));
  out.history = [...hist.values()].sort((x, y) => x.t - y.t).slice(-40);
  out.devices = { ...(b.devices || {}) };
  Object.entries(a.devices || {}).forEach(([k, v]) => { if (!out.devices[k] || out.devices[k].last < v.last) out.devices[k] = v; });
  const sent = new Map();
  [...(a.sent || []), ...(b.sent || [])].forEach(x => sent.set(x.t + x.name, x));
  out.sent = [...sent.values()].sort((x, y) => x.t - y.t).slice(-20);
  out.updated = Math.max(a.updated || 0, b.updated || 0);
  return out;
}

async function syncNow() {
  if (!token || syncing) return;
  syncing = true;
  try {
    M.devices[S.deviceId] = { name: S.deviceName, last: Date.now() };
    if (!syncFileId) {
      const q = encodeURIComponent(`name='${SYNC_FILE}'`);
      const l = await gfetch(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id)`);
      syncFileId = l.files?.[0]?.id || null;
    }
    let remote = null;
    if (syncFileId) {
      const txt = await gfetch(`https://www.googleapis.com/drive/v3/files/${syncFileId}?alt=media`).catch(() => null);
      try { remote = typeof txt === 'string' ? JSON.parse(txt) : txt; } catch {}
    }
    await readAgentStatus().catch(() => {});
    await readWhatsApp().catch(() => {});
    const before = new Set(M.history.map(h => h.t));
    if (remote) {
      const merged = merge(M, remote);
      merged.history.filter(h => !before.has(h.t)).forEach(h => addLog(h.r === 'u' ? 'u' : 'j', h.c, h.d));
      const profChanged = JSON.stringify(merged.profile) !== JSON.stringify(M.profile);
      const newSent = merged.sent.filter(x => !M.sent.some(y => y.t === x.t));
      M = merged; if (profChanged) fillSettings();
      if (newSent.length) { renderSent(); newSent.forEach(x => { if (x.from !== S.deviceName) { toast('📁 Yeni dosya geldi: ' + x.name); addLog('sys', '◆ GELEN DOSYA: ' + x.name); } }); }
      renderFacts();
    }
    const body = JSON.stringify(M);
    if (syncFileId) {
      await gfetch(`https://www.googleapis.com/upload/drive/v3/files/${syncFileId}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
    } else {
      const boundary = 'jrv' + uid();
      const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: SYNC_FILE, parents: ['appDataFolder'] })}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
      const r = await gfetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body: multipart });
      syncFileId = r.id;
    }
    save('jarvis.syncId', syncFileId);
    save('jarvis.mem', M);
    chip('#cSync', true, 'SENKRON: ' + new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }));
  } catch (e) {
    console.warn('sync', e); chip('#cSync', false, 'SENKRON: HATA', true);
    if (/404/.test(e.message)) { syncFileId = null; save('jarvis.syncId', null); }
  } finally { syncing = false; refreshChips(); }
}
setInterval(() => { if (token && !document.hidden) syncNow(); }, 45e3);
setInterval(() => { if (token && !document.hidden) { loadMails().catch(() => {}); loadTasks().catch(() => {}); loadCalendar().catch(() => {}); } }, 5 * 60e3);
setInterval(() => { if (!document.hidden) { refreshWeather(); loadNews().catch(() => {}); } }, 30 * 60e3);
document.addEventListener('visibilitychange', () => { if (!document.hidden && token) afterGoogle(); });


/* ----- PC Ajanı: dosya bul & gönder (Drive appData üzerinden komut kanalı) ----- */
const APPF = 'https://www.googleapis.com/drive/v3/files';
const agentOnline = () => !!agent && Date.now() - agent.last < 2.5 * 60e3;

async function appFind(name) {
  const l = await gfetch(`${APPF}?spaces=appDataFolder&q=${encodeURIComponent(`name='${name}'`)}&fields=files(id)`);
  return l.files?.[0]?.id || null;
}
async function appRead(id) {
  const t = await gfetch(`${APPF}/${id}?alt=media`);
  return typeof t === 'string' ? JSON.parse(t) : t;
}
async function appCreate(name, obj) {
  const b = 'jrv' + uid();
  const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: ['appDataFolder'] })}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(obj)}\r\n--${b}--`;
  return gfetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body });
}
async function readAgentStatus() {
  const id = await appFind('agent-status.json');
  if (!id) { agent = null; return; }
  agent = await appRead(id);
  updateAgentInfo();
}
function updateAgentInfo() {
  const el = $('#agentInfo'); if (!el) return;
  if (!token) el.textContent = 'Google bağlı değil. Önce ⏻ ile bağlanın.';
  else if (!agent) el.textContent = 'PC ajanı henüz kurulmamış. Kurulum rehberindeki 7. adıma bakın.';
  else el.innerHTML = `${agentOnline() ? '<span style="color:var(--g)">● ÇEVRİMİÇİ</span>' : '<span style="color:var(--a)">● ÇEVRİMDIŞI</span>'} · ${esc(agent.name)} · ${(agent.files || 0).toLocaleString('tr-TR')} dosya dizinli${agent.indexing ? ' · dizin güncelleniyor' : ''}`;
  refreshChips();
}

async function agentCmd(type, payload, timeoutMs) {
  if (!token) throw new Error('Google bağlı değil');
  const id = uid();
  await appCreate(`cmd-${id}.json`, { id, type, ...payload, t: Date.now(), from: S.deviceName });
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await sleep(2000);
    const rid = await appFind(`res-${id}.json`).catch(() => null);
    if (rid) {
      const res = await appRead(rid);
      gfetch(`${APPF}/${rid}`, { method: 'DELETE' }).catch(() => {});
      if (!res.ok) throw new Error(res.error || 'ajan hatası');
      return res;
    }
  }
  throw new Error('zaman aşımı');
}

const fmtSize = b => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
const ORD = ['', 'Birinci', 'İkinci', 'Üçüncü', 'Dördüncü', 'Beşinci', 'Altıncı', 'Yedinci', 'Sekizinci'];

async function fileSearch(query, ftype = '', days = 0) {
  if (!query && !ftype) return;
  const h = M.profile.hitap || 'efendim';
  if (!token) return say(`Önce Google hesabınızı bağlamanız gerekiyor, ${h}.`);
  await readAgentStatus().catch(() => {});
  if (!agent) return say(`Bilgisayar ajanı henüz kurulmamış, ${h}. Kurulum rehberinin yedinci adımı tam da bunun için.`);
  openFiles(); $('#fq').value = [query, ftype].filter(Boolean).join(' ');
  $('#fRes').innerHTML = '<div class="hint">◌ Bilgisayarda aranıyor…</div>';
  setState('thinking', 'BİLGİSAYARDA ARANIYOR');
  let res;
  try { res = await agentCmd('search', { query, ftype, days }, agentOnline() ? 45000 : 20000); }
  catch (e) {
    setState('idle'); $('#fRes').innerHTML = `<div class="hint">${esc(e.message)}</div>`;
    return say(e.message === 'zaman aşımı' ? `Bilgisayara ulaşamadım, ${h}. Kapalı ya da uyku modunda olabilir.` : 'Arama yapılamadı: ' + e.message);
  }
  fileResults = res.results || [];
  renderFiles();
  if (!fileResults.length) return say(`Bilgisayarınızda bununla eşleşen bir dosya bulamadım, ${h}.${res.indexing ? ' Dizin hâlâ güncelleniyor, birazdan tekrar deneyebiliriz.' : ' Farklı bir kelimeyle deneyelim mi?'}`);
  const top = fileResults.slice(0, 3).map(f => `${ORD[f.n]}: ${f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ')}, ${f.folder.split(/[\\/]/).filter(Boolean).pop() || ''} klasöründe`).join('. ');
  say(fileResults.length === 1
    ? `Bir dosya buldum: ${top.replace(/^Birinci: /, '')}. Telefonunuza göndereyim mi?`
    : `${fileResults.length} dosya buldum. ${top}. Hangisini göndereyim?`);
}

async function fileSend(n) {
  const f = fileResults.find(x => x.n === n);
  const h = M.profile.hitap || 'efendim';
  if (!f) return say(`O numarada bir dosya yok, ${h}.`);
  openFiles();
  const btn = $(`#fRes [data-n="${n}"]`); if (btn) { btn.textContent = 'GÖNDERİLİYOR…'; btn.disabled = true; }
  setState('thinking', 'GÖNDERİLİYOR');
  try {
    const big = f.size > 50 * 1048576;
    if (big) say('Dosya biraz büyük, yüklenmesi birkaç dakika sürebilir.');
    const res = await agentCmd('send', { path: f.path, n }, 15 * 60e3);
    f.link = res.link;
    M.sent.push({ name: res.name || f.name, link: res.link, t: Date.now(), from: S.deviceName });
    M.sent = M.sent.slice(-20); saveMem();
    renderFiles(); renderSent(); fx.ok();
    say(`${f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ')} gönderildi. Ekrandaki Aç düğmesine dokunabilirsiniz.`);
  } catch (e) {
    renderFiles();
    say(e.message === 'zaman aşımı' ? 'Gönderim çok uzun sürdü, bilgisayar bağlantısını kontrol eder misiniz?' : 'Gönderilemedi: ' + e.message);
  }
}

async function say(text) {
  addLog('j', text); pushHistory('j', text);
  await speak(text);
}

function renderFiles() {
  $('#fRes').innerHTML = fileResults.length ? fileResults.map(f => `
    <div class="file" style="animation-delay:${f.n * 50}ms"><div class="no">${f.n}</div>
      <div class="meta"><div class="nm">${esc(f.name)}</div><div class="fd">&lrm;${esc(f.folder)} · ${esc(f.date)} · ${fmtSize(f.size)}</div></div>
      ${f.link ? `<a class="btn" href="${esc(f.link)}" target="_blank" rel="noopener">AÇ</a>` : `<button class="btn" data-n="${f.n}">GÖNDER</button>`}
    </div>`).join('') : '<div class="hint">Sonuç yok.</div>';
  $$('#fRes button[data-n]').forEach(b => b.onclick = () => fileSend(+b.dataset.n));
}
function renderSent() {
  const list = [...(M.sent || [])].reverse();
  $('#fSent').innerHTML = list.length ? list.map(x => `
    <div class="file"><div class="meta"><div class="nm">${esc(x.name)}</div><div class="fd">&lrm;${esc(x.from || '')} · ${new Date(x.t).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' })}</div></div>
      ${x.link ? `<a class="btn" href="${esc(x.link)}" target="_blank" rel="noopener">AÇ</a>` : ''}</div>`).join('')
    : '<div class="hint">Henüz gönderilen dosya yok. Gönderilen dosyalar Google Drive\'ınızdaki "Jarvis Gönderilenler" klasöründe de durur.</div>';
}
function openFiles() { updateAgentInfo(); renderSent(); $('#files').classList.add('open'); }
$('#qFiles').onclick = () => { openFiles(); if (token) readAgentStatus().catch(() => {}); setTimeout(() => $('#fq').focus(), 100); };
$('#fClose').onclick = () => $('#files').classList.remove('open');
const doFq = () => { const v = $('#fq').value.trim(); if (v) fileSearch(v, '', 0); };
$('#fGo').onclick = doFq;
$('#fq').addEventListener('keydown', e => { if (e.key === 'Enter') doFq(); });


/* =========================================================
   HAVA DURUMU — Open-Meteo (ücretsiz, anahtarsız)
   ========================================================= */
const WMO = {0:['Açık','☀'],1:['Az bulutlu','🌤'],2:['Parçalı bulutlu','⛅'],3:['Kapalı','☁'],45:['Sisli','🌫'],48:['Kırağılı sis','🌫'],
  51:['Hafif çisenti','🌦'],53:['Çisenti','🌦'],55:['Yoğun çisenti','🌧'],56:['Dondurucu çisenti','🌧'],57:['Dondurucu çisenti','🌧'],
  61:['Hafif yağmurlu','🌦'],63:['Yağmurlu','🌧'],65:['Sağanak yağmurlu','🌧'],66:['Dondurucu yağmur','🌧'],67:['Dondurucu yağmur','🌧'],
  71:['Hafif karlı','🌨'],73:['Karlı','🌨'],75:['Yoğun karlı','❄'],77:['Kar taneli','🌨'],80:['Hafif sağanaklı','🌦'],81:['Sağanaklı','🌧'],
  82:['Şiddetli sağanaklı','⛈'],85:['Kar sağanaklı','🌨'],86:['Yoğun kar sağanaklı','❄'],95:['Gök gürültülü fırtınalı','⛈'],96:['Dolulu fırtınalı','⛈'],99:['Dolulu fırtınalı','⛈']};

function getPosition() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('konum yok'));
    navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lon: p.coords.longitude, name: '' }), rej, { timeout: 10000, maximumAge: 3 * 3600e3 });
  });
}
async function cityCoords(name) {
  const c = load('jarvis.geo', null);
  if (c && c.q === name) return c;
  // "Istanbul, Türkiye", "Kadıköy / İstanbul", "istanbul" gibi yazımları da dene
  const base = name.split(/[,/(]/)[0].trim();
  const tries = [...new Set([base, base.toLocaleUpperCase('tr')[0] + base.slice(1).toLocaleLowerCase('tr'),
    base.replace(/^I/, 'İ'), base.replace(/^i/, 'İ'), name.split(/[,/]/).pop().trim()])].filter(Boolean);
  for (const q of tries) {
    const j = await fetchJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=5&language=tr`, {});
    const r = (j.results || []).find(x => x.country_code === 'TR') || j.results?.[0];
    if (r) { const out = { q: name, lat: r.latitude, lon: r.longitude, name: r.name }; save('jarvis.geo', out); return out; }
  }
  throw new Error(`"${name}" şehri bulunamadı`);
}
async function loadWeather() {
  let loc;
  if (M.profile.city) loc = await cityCoords(M.profile.city);
  else {
    try { loc = await getPosition(); }
    catch (e) { throw new Error(e.code === 1 ? 'konum izni verilmedi' : 'konum alınamadı'); }
  }
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&hourly=precipitation_probability,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code,sunset&timezone=auto&forecast_days=1`;
  const j = await fetchJSON(u, {});
  const hr = new Date().getHours();
  const rainHours = (j.hourly?.time || []).map((t, i) => ({ h: +t.slice(11, 13), p: j.hourly.precipitation_probability[i] }))
    .filter(x => x.h >= hr && x.p >= 50);
  weather = {
    city: loc.name || M.profile.city || '', temp: Math.round(j.current.temperature_2m), feels: Math.round(j.current.apparent_temperature),
    code: j.current.weather_code, wind: Math.round(j.current.wind_speed_10m),
    max: Math.round(j.daily.temperature_2m_max[0]), min: Math.round(j.daily.temperature_2m_min[0]),
    rain: j.daily.precipitation_probability_max[0], rainFrom: rainHours[0]?.h, dcode: j.daily.weather_code[0]
  };
  renderWeather();
}
function locative(name) { // İstanbul'da, İzmir'de, Sinop'ta, Tokat'ta
  const low = name.toLocaleLowerCase('tr'), v = [...low].reverse().find(c => 'aeıioöuü'.includes(c)) || 'a';
  const back = 'aıou'.includes(v), hard = 'fstkçşhp'.includes(low.at(-1));
  return `${name}'${hard ? 't' : 'd'}${back ? 'a' : 'e'}`;
}

let wxErrShown = false;
function weatherError(e) {
  console.warn('hava', e);
  const msg = e.message || String(e);
  const noCity = !M.profile.city;
  $('#wx').innerHTML = `<b style="font-size:13px;cursor:pointer;color:var(--a)">${noCity ? '📍 ŞEHİR EKLE' : '⚠ HAVA'}</b>`;
  $('#wx').title = msg + ' — dokunarak ' + (noCity ? 'şehrinizi girin' : 'tekrar deneyin');
  if (!wxErrShown) {
    wxErrShown = true;
    addLog('sys', noCity ? `HAVA: ${msg}. Ayarlar'a şehrinizi yazın (örn. İstanbul).` : `HAVA: ${msg}. Ayarlar'daki şehir adını kontrol edin (sadece şehir adı, örn. İstanbul).`);
  }
}
const refreshWeather = () => loadWeather().then(() => { wxErrShown = false; $('#wx').title = 'Hava durumu · yenilemek için dokunun'; }).catch(weatherError);
$('#wx').onclick = () => { if (!M.profile.city && $('#wx').textContent.includes('ŞEHİR')) { openSettings(); setTimeout(() => $('#sCity').focus(), 150); } else { $('#wx').style.opacity = .4; refreshWeather().finally(() => $('#wx').style.opacity = 1); } };
function weatherText() {
  if (!weather) return '';
  const w = weather, d = WMO[w.code]?.[0] || '';
  let t = `${w.city ? locative(w.city) + ' ' : ''}şu an ${w.temp} derece, ${d.toLocaleLowerCase('tr')}; hissedilen ${w.feels}. Gün içinde en yüksek ${w.max}, en düşük ${w.min} derece`;
  if (w.rainFrom !== undefined) t += `, saat ${w.rainFrom} civarından itibaren yağış ihtimali yüksek (%${w.rain})`;
  else if (w.rain >= 30) t += `, yağış ihtimali %${w.rain}`;
  if (w.wind >= 35) t += `, rüzgâr sert (${w.wind} km/s)`;
  return t;
}
function renderWeather() {
  const w = weather; if (!w) return;
  $('#wx').innerHTML = `<b>${WMO[w.code]?.[1] || ''} ${w.temp}°</b><span><small>${esc((w.city || '').toLocaleUpperCase('tr'))}</small><small>${w.min}° / ${w.max}°${w.rain >= 30 ? ' · ☂ %' + w.rain : ''}</small></span>`;
}

/* =========================================================
   GOOGLE TAKVİM
   ========================================================= */
async function loadCalendar() {
  if (!token) return;
  const s0 = new Date(); s0.setHours(0, 0, 0, 0);
  const e0 = new Date(s0); e0.setDate(e0.getDate() + 1); e0.setHours(23, 59, 59);
  try {
    const j = await gfetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=25&timeMin=${s0.toISOString()}&timeMax=${e0.toISOString()}`);
    events = (j.items || []).filter(e => e.status !== 'cancelled').map(e => ({
      title: e.summary || '(başlıksız)', loc: e.location || '', allDay: !e.start.dateTime,
      start: new Date(e.start.dateTime || e.start.date + 'T00:00'), end: new Date(e.end.dateTime || e.end.date + 'T00:00')
    }));
  } catch (e) {
    if (/insufficient|scope|403/i.test(e.message)) { S.scopeVer = 1; save('jarvis.settings', S); $('#agenda').innerHTML = '<div class="empty">Takvim izni için ⏻ düğmesiyle bir kez yeniden bağlanın.</div>'; return; }
    if (/has not been used|disabled/i.test(e.message)) { $('#agenda').innerHTML = '<div class="empty">Google Cloud\'da "Google Calendar API"yi etkinleştirin.</div>'; return; }
    throw e;
  }
  renderAgenda();
}
const hm = d => d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
function todayEvents() { const t = new Date().toDateString(); return events.filter(e => e.start.toDateString() === t || (e.allDay && e.start <= new Date() && e.end > new Date())); }
function renderAgenda() {
  const now = new Date(), today = todayEvents();
  const tomorrow = events.filter(e => !today.includes(e)).slice(0, 3);
  $('#nCal').textContent = today.length;
  const row = (e, i) => `<div class="ev ${e.end < now ? 'past' : e.start <= now ? 'now' : ''}" style="animation-delay:${i * 60}ms"><div class="tm">${e.allDay ? 'TÜM GÜN' : hm(e.start)}</div><div><div class="tt">${esc(e.title)}</div>${e.loc ? `<div class="lc">⌖ ${esc(e.loc)}</div>` : ''}</div></div>`;
  $('#agenda').innerHTML = (today.length ? today.map(row).join('') : '<div class="empty">Bugün takviminiz boş.</div>') +
    (tomorrow.length ? '<div class="lc" style="font-family:Orbitron;font-size:10px;letter-spacing:.2em;color:var(--dim);margin:8px 4px 2px">YARIN</div>' + tomorrow.map(row).join('') : '');
}
function calendarText() {
  const now = new Date();
  return todayEvents().filter(e => e.end > now).map(e => {
    if (e.allDay) return `tüm gün: ${e.title}`;
    const mins = Math.round((e.start - now) / 60000);
    const left = mins > 0 ? ` (${mins < 60 ? mins + ' dakika' : Math.floor(mins / 60) + ' saat' + (mins % 60 ? ' ' + (mins % 60) + ' dakika' : '')} sonra)` : ' (şu an devam ediyor)';
    return `saat ${hm(e.start)}: ${e.title}${e.loc ? ', yer: ' + e.loc : ''}${left}`;
  }).join('\n');
}

/* =========================================================
   HABERLER — GitHub Actions'ın saatlik topladığı news.json
   ========================================================= */
async function loadNews() {
  const r = await fetch('news.json?t=' + Math.floor(Date.now() / 600000), { cache: 'no-store' });
  if (!r.ok) throw new Error('news.json yok');
  news = await r.json();
}
function newsContext() {
  if (!news) return 'Haber akışı: henüz yok (GitHub haber görevi kurulmamış olabilir).';
  const age = Math.round((Date.now() - new Date(news.updated)) / 60000);
  const fmt = arr => (arr || []).slice(0, 10).map(x => `- ${x.title} (${x.source})`).join('\n');
  return `GÜNCEL HABER BAŞLIKLARI (${age < 90 ? age + ' dakika' : Math.round(age / 60) + ' saat'} önce derlendi, kaynak: Google Haberler):
SPOR:
${fmt(news.spor)}
SİYASET / DÜNYA:
${fmt(news.siyaset)}`;
}


/* =========================================================
   WHATSAPP — PC ajanının Windows bildirimlerinden okuduğu mesajlar
   ========================================================= */
async function readWhatsApp() {
  const id = await appFind('whatsapp.json');
  if (!id) { wa = null; renderWhatsApp(); return; }
  const prev = new Set((wa?.messages || []).filter(m => m.present).map(m => m.id));
  wa = await appRead(id);
  const fresh = (wa.messages || []).filter(m => m.present && !prev.has(m.id) && Date.now() - m.t < 10 * 60e3);
  if (prev.size && fresh.length) { fx.ok(); toast(`💬 ${fresh[0].sender}: ${fresh[0].text || 'yeni mesaj'}`); }
  renderWhatsApp();
}
function waGroups() {
  const g = new Map();
  (wa?.messages || []).forEach(m => {
    if (!g.has(m.sender)) g.set(m.sender, { sender: m.sender, msgs: [], waiting: 0, first: Infinity, last: 0 });
    const x = g.get(m.sender); x.msgs.push(m); x.last = Math.max(x.last, m.t);
    if (m.present) { x.waiting++; x.first = Math.min(x.first, m.t); }
  });
  return [...g.values()].sort((a, b) => (b.waiting > 0) - (a.waiting > 0) || b.last - a.last);
}
const ago = t => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'az önce' : m < 60 ? m + ' dakika önce' : m < 1440 ? Math.floor(m / 60) + ' saat önce' : Math.floor(m / 1440) + ' gün önce'; };
function renderWhatsApp() {
  const box = $('#wa'); if (!box) return;
  if (!wa) { $('#nWa').textContent = '–'; box.innerHTML = `<div class="empty">${agent ? 'WhatsApp bildirimi bekleniyor. Bilgisayarda WhatsApp bildirimlerinin açık olduğundan emin olun.' : 'PC ajanı kurulunca bilgisayarınızdaki WhatsApp mesajları burada.'}</div>`; return; }
  const groups = waGroups(), waiting = groups.filter(x => x.waiting);
  $('#nWa').textContent = waiting.length;
  box.innerHTML = groups.length ? groups.slice(0, 12).map((x, i) => {
    const lastMsg = x.msgs.reduce((a, b) => b.t > a.t ? b : a);
    return `<div class="wa ${x.waiting ? '' : 'seen'}" style="animation-delay:${i * 50}ms">
      <div class="f"><div>${esc(x.sender)}${x.waiting ? `<span class="cnt">${x.waiting}</span>` : ''}</div><span>${ago(x.last)}</span></div>
      <div class="p">${wa.content ? esc(lastMsg.text) : '(içerik gizli)'}</div></div>`;
  }).join('') : '<div class="empty">Son 48 saatte WhatsApp mesajı yok.</div>';
  if (wa.error) box.innerHTML += `<div class="empty" style="color:var(--a)">Okuma hatası: ${esc(wa.error)}</div>`;
}
function whatsappContext() {
  if (!wa) return agent ? 'Henüz WhatsApp verisi yok.' : 'PC ajanı kurulmamış; WhatsApp okunamıyor.';
  const stale = Date.now() - wa.updated > 10 * 60e3 ? ` (DİKKAT: son güncelleme ${ago(wa.updated)}, bilgisayar kapalı olabilir)` : '';
  const groups = waGroups();
  if (!groups.length) return 'Son 48 saatte mesaj yok.' + stale;
  return groups.slice(0, 10).map(x => {
    const status = x.waiting ? `${x.waiting} mesaj BEKLİYOR (ilki ${ago(x.first)}, muhtemelen henüz bakılmadı)` : `hepsi görülmüş görünüyor, son mesaj ${ago(x.last)}`;
    const texts = wa.content ? ' Mesajlar: ' + x.msgs.slice(0, 4).reverse().map(m => `"${(m.text || '').slice(0, 160)}"`).join(' / ') : '';
    return `- ${x.sender}: ${status}.${texts}`;
  }).join('\n') + stale;
}

/* =========================================================
   AYARLAR
   ========================================================= */
function fillSettings() {
  $('#sName').value = M.profile.name; if ($('#sCity')) $('#sCity').value = M.profile.city || ''; $('#sHitap').value = M.profile.hitap; $('#sVip').value = M.profile.vip; $('#sAbout').value = M.profile.about;
  $('#kGem').value = S.geminiKey; $('#kGroq').value = S.groqKey; $('#kOr').value = S.orKey;
  $('#mGem').value = S.geminiModel; $('#mGroq').value = S.groqModel; $('#mOr').value = S.orModel;
  $('#sCid').value = S.clientId; $('#sDev').value = S.deviceName; $('#sRate').value = S.rate; $('#sWake').value = S.wake ? '1' : '0';
  $('#sVoice').value = S.voice; if ($('#kTav')) $('#kTav').value = S.tavilyKey || ''; if ($('#kYt')) { $('#kYt').value = S.ytKey || ''; $('#sYtMode').value = S.ytMode || 'auto'; }
}
function openSettings() { fillSettings(); renderFacts(); loadVoices(); $('#settings').classList.add('open'); }
$('#setBtn').onclick = openSettings;
$('#sClose').onclick = () => $('#settings').classList.remove('open');
$('#sTest').onclick = () => { readSettings(); speak(`Merhaba ${M.profile.name || ''}. Ben Jarvis. Sesim kulağınıza hoş geliyor mu?`); };
function readSettings() {
  const p = { name: $('#sName').value.trim(), hitap: $('#sHitap').value.trim() || 'efendim', vip: $('#sVip').value.trim(), about: $('#sAbout').value.trim(), city: $('#sCity') ? $('#sCity').value.trim() : (M.profile.city || '') };
  if (JSON.stringify(p) !== JSON.stringify({ name: M.profile.name, hitap: M.profile.hitap, vip: M.profile.vip, about: M.profile.about, city: M.profile.city || '' }))
    M.profile = { ...p, updated: Date.now() };
  Object.assign(S, {
    geminiKey: $('#kGem').value.trim(), groqKey: $('#kGroq').value.trim(), orKey: $('#kOr').value.trim(),
    geminiModel: $('#mGem').value.trim() || DEFAULTS.geminiModel, groqModel: $('#mGroq').value.trim() || DEFAULTS.groqModel, orModel: $('#mOr').value.trim() || DEFAULTS.orModel,
    clientId: $('#sCid').value.trim(), deviceName: $('#sDev').value.trim() || DEFAULTS.deviceName,
    tavilyKey: $('#kTav') ? $('#kTav').value.trim() : S.tavilyKey,
    ytKey: $('#kYt') ? $('#kYt').value.trim() : S.ytKey, ytMode: $('#sYtMode') ? $('#sYtMode').value : S.ytMode,
    voice: $('#sVoice').value, rate: +$('#sRate').value || 1, wake: $('#sWake').value === '1'
  });
}
$('#sSave').onclick = () => {
  readSettings(); save('jarvis.settings', S); saveMem();
  $('#settings').classList.remove('open'); fx.ok(); refreshChips();
  toast('Ayarlar kaydedildi.');
  if (S.clientId && !token) connectGoogle(true);
  localStorage.removeItem('jarvis.geo'); refreshWeather();
  stopRec(true); resumeWake();
};

/* =========================================================
   AÇILIŞ SEKANSI
   ========================================================= */
async function bootSequence() {
  const lines = [
    ['ÇEKİRDEK SİSTEMLER · SÜRÜM ' + JARVIS_VERSION + ($('#kTav') ? '' : ' (index.html ESKİ!)'), $('#kTav') ? 'TAMAM' : 'GÜNCELLE'],
    ['İNTERNET ARAMA', S.tavilyKey ? 'TAVILY' : 'VİKİPEDİ'],
    ['SES SENTEZİ · TÜRKÇE', 'speechSynthesis' in window ? 'TAMAM' : 'YOK'],
    ['KONUŞMA TANIMA', SR ? 'TAMAM' : 'KLAVYE'],
    ['BEYİN YÖNLENDİRİCİ', hasBrain() ? providers().map(p => p.name).join(' › ').toUpperCase() : 'YEREL MOD'],
    ['GOOGLE ARAYÜZÜ', S.clientId ? 'HAZIR' : 'AYAR BEKLİYOR'],
    ['HAFIZA BANKASI', M.facts.length + ' KAYIT'],
    ['CİHAZ AĞI · ' + S.deviceName.toUpperCase(), 'ÇEVRİMİÇİ']
  ];
  const box = $('#bootLines'), bar = $('#bootBar b');
  for (let i = 0; i < lines.length; i++) {
    const d = document.createElement('div'); d.innerHTML = `▸ ${esc(lines[i][0])} <b>${esc(lines[i][1])}</b>`;
    box.appendChild(d); bar.style.width = ((i + 1) / lines.length * 100) + '%';
    await sleep(230 + Math.random() * 180);
  }
  $('#bootBtn').classList.add('ready');
}

$('#bootBtn').onclick = async () => {
  fx.boot();
  try { speechSynthesis.speak(new SpeechSynthesisUtterance('')); } catch {} // iOS ses kilidini aç
  $('#boot').classList.add('gone');
  sizeCanvas(); refreshChips();
  renderMails(); renderTasks(); renderWhatsApp();
  // geçmiş sohbetin son birkaç satırı
  M.history.slice(-4).forEach(h => addLog(h.r, h.c, h.d !== S.deviceName ? h.d : ''));
  if (S.clientId && S.googleWanted && !token) connectGoogle(true);
  if (token) afterGoogle();
  refreshWeather();
  loadNews().catch(() => {});

  await sleep(500);
  if (!M.profile.name) {
    await speak('Merhaba. Ben Jarvis, kişisel asistanınız. Sizi tanımak isterim. Lütfen adınızı ve size nasıl hitap etmemi istediğinizi yazın.');
    openSettings();
  } else {
    const hr = new Date().getHours();
    const g = hr < 5 ? 'İyi geceler' : hr < 12 ? 'Günaydın' : hr < 18 ? 'İyi günler' : hr < 22 ? 'İyi akşamlar' : 'İyi geceler';
    const msg = `${g} ${M.profile.name}. Tüm sistemler çevrimiçi.`;
    addLog('j', msg); await speak(msg);
  }
  resumeWake();
};

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
window.addEventListener('load', () => { initGoogle(); });
bootSequence();
