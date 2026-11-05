// ============================================================================
//  Vonage <-> HubSpot - credentials / relay backend (Vonage Cloud Runtime)
//  No UI here: all UI lives in HubSpot cards. This service only:
//   - runs the HubSpot public-app OAuth handshake + stores per-portal tokens
//   - mints Vonage JWTs and relays Messages/Voice API calls
//   - stores message templates + relays WhatsApp template approval to Meta
//   - logs activity back to the HubSpot contact timeline
//  Persistence = VCR Instance State (no AWS).
// ============================================================================
const express = require('express');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuid } = require('uuid');

const app = express();
// Retired host: when REDIRECT_TO is set (the old VCR instance after the move to AWS) every
// browser-facing GET is redirected to the new host so old install/guide links keep working;
// webhooks and API calls are proxied nowhere - they were re-pointed at the new host already.
if (process.env.REDIRECT_TO) {
  app.use((req, res, next) => {
    if (req.path === '/_/health' || req.path === '/_/metrics') return next();
    if (req.method === 'GET' || req.method === 'HEAD') return res.redirect(308, process.env.REDIRECT_TO.replace(/\/$/, '') + req.originalUrl);
    res.status(410).json({ error: 'moved', detail: `This service now lives at ${process.env.REDIRECT_TO}` });
  });
}
app.use((req, _res, next) => { if (req.path.startsWith('/2v/api')) console.log(`[req] ${req.method} ${req.path} ct=${req.headers['content-type'] || '-'} len=${req.headers['content-length'] || '-'}`); next(); });
app.use(express.json({ limit: '16mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
// ---- Text repair (23 Oct 2026). Polish text from the HubSpot card arrived double-encoded:
// UTF-8 bytes read as Windows-1252, so "imię" became "imiÄ™" and Meta rejected the template.
// fixMojibake() maps the string back to bytes (cp1252) and re-reads them as UTF-8, but only
// when the result is clean; otherwise the text is left exactly as it came.
const CP1252 = { 0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f };
function fixMojibake(str) {
  if (typeof str !== 'string' || !/[Â-ô][\u0080-¿ŒœŠšŸŽžƒˆ˜–-™]/.test(str)) return str;
  const bytes = [];
  for (const ch of str) { const c = ch.codePointAt(0); if (c < 0x100) bytes.push(c); else if (CP1252[c] != null) bytes.push(CP1252[c]); else return str; }
  const out = Buffer.from(bytes).toString('utf8');
  return /�/.test(out) && !/�/.test(str) ? str : out;
}
function fixDeep(v) { if (typeof v === 'string') return fixMojibake(v); if (Array.isArray(v)) return v.map(fixDeep); if (v && typeof v === 'object') { for (const k of Object.keys(v)) v[k] = fixDeep(v[k]); } return v; }
app.use('/2v/api', (req, res, next) => { try { if (req.body && typeof req.body === 'object') fixDeep(req.body); } catch (e) {} next(); });
// ---- Portal auth: every /2v/api call must prove which portal it acts for -------------
// Verified live (5 Nov 2026): hubspot.fetch requests from the cards carry
// X-HubSpot-Signature-v3 + X-HubSpot-Request-Timestamp (HMAC over METHOD + full URL +
// body + timestamp with the app's client secret) and HubSpot appends appId, userId and
// userEmail to the query string, all covered by the signature. So a valid v3 signature
// with our appId proves the request came from our card inside a HubSpot portal, and the
// portalId in the query is the one our own card put there.
// Three ways in:
//   1. valid HubSpot v3 signature (cards, settings page)        -> portal = query portalId
//   2. Bearer <session token> minted by POST /2v/api/session    -> portal = token pid
//      (the hosted flow builder iframe cannot use hubspot.fetch, the card mints a token
//      for it and passes it in the iframe URL)
//   3. adminKey (query or body)                                   -> any portal
// Exempt: HubSpot-called workflow actions (own signature check), the invite status
// poll, admin routes (own adminKey check). PORTAL_AUTH=log keeps the old open behaviour
// and only logs; the default is enforce.
const HS_APP_ID = process.env.HS_APP_ID || '';
const PORTAL_AUTH = process.env.PORTAL_AUTH || 'enforce';
const sessionSecret = () => crypto.createHmac('sha256', HS_CLIENT_SECRET || 'dev').update('vh-session').digest();
function mintSession(pid, hours) {
  const payload = Buffer.from(JSON.stringify({ pid: String(pid), exp: Date.now() + (hours || 12) * 3600 * 1000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function readSession(token) {
  try {
    const [payload, sig] = String(token || '').split('.');
    const expect = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
    if (!sig || sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return d.exp > Date.now() ? String(d.pid) : null;
  } catch { return null; }
}
const AUTH_EXEMPT = [/^\/workflow\//, /^\/admin\//, /^\/hschannel\/register$/, /^\/hs\/token-scopes$/, /^\/session$/];
function requestedPortal(req) {
  const q = req.query || {}; const b = req.body || {};
  const v = q.portalId || b.portalId || q.portal || b.portal || '';
  return Array.isArray(v) ? '' : String(v);
}
function portalAuth(req) {
  const q = req.query || {};
  const adminKey = q.adminKey || (req.body && req.body.adminKey);
  if (process.env.ADMIN_KEY && adminKey === process.env.ADMIN_KEY) return { ok: true, via: 'admin' };
  const want = requestedPortal(req);
  const bearer = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (bearer) { const pid = readSession(bearer); if (pid && (!want || pid === want)) return { ok: true, via: 'session', pid }; }
  if (req.get('X-HubSpot-Signature-v3') && wfSignatureOk(req)) {
    if (HS_APP_ID && q.appId && String(q.appId) !== HS_APP_ID) return { ok: false, why: 'other app' };
    if (!want) return { ok: false, why: 'no portalId' };
    return { ok: true, via: 'hubspot', pid: want };
  }
  return { ok: false, why: bearer ? 'bad session token' : 'no signature' };
}
app.use('/2v/api', (req, res, next) => {
  if (req.method === 'GET' && /^\/install\/[^/]+$/.test(req.path)) return next();
  if (AUTH_EXEMPT.some((re) => re.test(req.path))) return next();
  const a = portalAuth(req);
  if (a.ok) { req.portalAuth = a; return next(); }
  console.log(`[auth] DENY ${req.method} ${req.path} portal=${requestedPortal(req) || '-'} why=${a.why} mode=${PORTAL_AUTH}`);
  if (PORTAL_AUTH !== 'enforce') return next();
  res.status(401).json({ error: 'unauthorised', detail: 'This endpoint accepts requests from the Vonage Messaging HubSpot app only.' });
});
// Short-lived token for the hosted flow builder, minted by the card (HubSpot-signed) only.
app.post('/2v/api/session', (req, res) => {
  const pid = requestedPortal(req);
  if (!pid) return res.status(400).json({ error: 'portalId required' });
  const a = portalAuth(req);
  if (!a.ok || (a.via === 'session')) return res.status(401).json({ error: 'unauthorised' });
  if (a.via === 'hubspot' && a.pid !== pid) return res.status(401).json({ error: 'portal mismatch' });
  res.json({ ok: true, token: mintSession(pid, 12), expiresIn: 12 * 3600 });
});

// ---- WhatsApp template preparation for Meta (23 Oct 2026) ----
// Our editor uses named variables ({{firstname}}) that are filled from the contact at send time.
// Meta only accepts numbered ones ({{1}}, {{2}}) and requires an example value for each, so at
// submit the body is rewritten to numbered form in order of first appearance, with examples; the
// order is stored as tpl.waVarOrder so sending fills the same positions.
const VAR_EXAMPLES = { firstname: 'Anna', lastname: 'Kowalska', name: 'Anna Kowalska', email: 'anna@example.com', phone: '+48500100200', company: 'Acme', reply: 'Yes' };
function cleanTemplateText(t) {
  return String(t || '').replace(/�+/g, '\n').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function toPositional(text, order) {
  // {{ label }} or a broken {{label} - each distinct label gets the next number
  return text.replace(/\{\{\s*([^{}]+?)\s*\}\}?/g, (m, label) => {
    const key = label.trim(); let i = order.indexOf(key);
    if (i < 0) { order.push(key); i = order.length - 1; }
    return '{{' + (i + 1) + '}}';
  });
}
function exampleFor(label) {
  const k = String(label).toLowerCase().replace(/\s+/g, '');
  if (VAR_EXAMPLES[k]) return VAR_EXAMPLES[k];
  if (/^\d+$/.test(k)) return ['Anna', 'Kowalska', '12:00', 'anna@example.com'][Number(k) - 1] || 'sample';
  if (/date|data/.test(k)) return '24.10.2026 12:00';
  if (/mail/.test(k)) return 'anna@example.com';
  if (/imi|name/.test(k)) return 'Anna';
  return label.length <= 30 ? label : 'sample';
}
const POLISH = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/;
app.use(express.urlencoded({ extended: true }));

// ---- Config ----------------------------------------------------------------
// MULTI-TENANT: every portal brings its OWN Vonage account (API key/secret,
// application + private key, sender numbers). There is deliberately NO shared
// house account and NO fallback - a portal that has not connected Vonage
// cannot send messages or place calls. Settings live per portalId in VCR
// state (vh_vonage) and are entered on the hosted install page.
const PORT = process.env.VCR_PORT || process.env.PORT || 3000;
const isVCR = !!process.env.VCR_PORT;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const HS_CLIENT_ID = process.env.HS_CLIENT_ID || '';
const HS_CLIENT_SECRET = process.env.HS_CLIENT_SECRET || '';
const HS_SCOPES = (process.env.HS_SCOPES || 'oauth crm.objects.contacts.read crm.objects.contacts.write crm.lists.read').split(' ');
const HS_API = 'https://api.hubapi.com';
// Optional: granted on (re)install, needed only for the Help Desk / Inbox channel. Existing installs keep working without them.
const HS_OPTIONAL_SCOPES = (process.env.HS_OPTIONAL_SCOPES || 'conversations.read conversations.custom_channels.read conversations.custom_channels.write crm.objects.custom.read').split(' ');
const META_GRAPH = 'https://graph.facebook.com/v20.0';

// ---- Persistence: whole-doc keys on one of three backends -------------------
//   STATE_BACKEND=vcr       VCR Instance State (default when running on VCR)
//   STATE_BACKEND=dynamodb  one DynamoDB item per key (AWS Lambda hosting); items above
//                           ~300k chars are split into k#0..n chunk items behind a meta item;
//                           every item carries a version so concurrent Lambda containers
//                           cannot silently overwrite each other (see ssetStrict / withRetry)
//   STATE_BACKEND=memory    local dev
const STATE_BACKEND = process.env.STATE_BACKEND || (isVCR ? 'vcr' : 'memory');
const STATE_TABLE = process.env.STATE_TABLE || 'vonage-hubspot-state';
let vcrState = null, ddb = null, ddbCmd = null;
try {
  if (STATE_BACKEND === 'vcr') { const { vcr } = require('@vonage/vcr-sdk'); vcrState = vcr.getInstanceState(); }
  if (STATE_BACKEND === 'dynamodb') { ddbCmd = require('@aws-sdk/client-dynamodb'); ddb = new ddbCmd.DynamoDBClient({}); }
} catch (e) { console.error('[state] init failed, using memory:', e.message); }
const mem = {};
const _ver = {}; // DynamoDB: version of each key as last read by this container
const CHUNK = 300000;
class StateConflict extends Error { constructor(key) { super(`state conflict on ${key}`); this.key = key; this.conflict = true; } }
async function ddbGet(key) {
  const r = await ddb.send(new ddbCmd.GetItemCommand({ TableName: STATE_TABLE, Key: { k: { S: key } }, ConsistentRead: true }));
  if (!r.Item) { _ver[key] = 0; return undefined; }
  _ver[key] = Number((r.Item.ver && r.Item.ver.N) || 0);
  if (r.Item.chunks) {
    const n = Number(r.Item.chunks.N); let s = '';
    for (let i = 0; i < n; i++) { const c = await ddb.send(new ddbCmd.GetItemCommand({ TableName: STATE_TABLE, Key: { k: { S: `${key}#${i}` } }, ConsistentRead: true })); s += (c.Item && c.Item.v && c.Item.v.S) || ''; }
    return JSON.parse(s);
  }
  return JSON.parse(r.Item.v.S);
}
async function ddbSet(key, val) {
  const s = JSON.stringify(val); const prev = _ver[key] || 0; const next = prev + 1;
  const cond = prev ? { ConditionExpression: 'ver = :p', ExpressionAttributeValues: { ':p': { N: String(prev) } } } : { ConditionExpression: 'attribute_not_exists(k)' };
  let item;
  if (s.length <= CHUNK) item = { k: { S: key }, v: { S: s }, ver: { N: String(next) }, at: { N: String(Date.now()) } };
  else {
    const n = Math.ceil(s.length / CHUNK);
    for (let i = 0; i < n; i++) await ddb.send(new ddbCmd.PutItemCommand({ TableName: STATE_TABLE, Item: { k: { S: `${key}#${i}` }, v: { S: s.slice(i * CHUNK, (i + 1) * CHUNK) }, at: { N: String(Date.now()) } } }));
    item = { k: { S: key }, chunks: { N: String(n) }, ver: { N: String(next) }, at: { N: String(Date.now()) } };
  }
  try { await ddb.send(new ddbCmd.PutItemCommand(Object.assign({ TableName: STATE_TABLE, Item: item }, cond))); }
  catch (e) { if (e.name === 'ConditionalCheckFailedException') throw new StateConflict(key); throw e; }
  _ver[key] = next;
}
async function sget(key, def) {
  try {
    if (vcrState) { const d = await vcrState.get(key); return d == null ? def : (typeof d === 'string' ? JSON.parse(d) : d); }
    if (ddb) { const d = await ddbGet(key); return d === undefined ? def : d; }
    return key in mem ? mem[key] : def;
  } catch (e) { console.error('[state] get', key, e.message); return def; }
}
// Strict write: throws StateConflict when another container wrote the key since we read it.
async function ssetStrict(key, val) {
  if (vcrState) { await vcrState.set(key, JSON.stringify(val)); return; }
  if (ddb) { await ddbSet(key, val); return; }
  mem[key] = val;
}
// Plain write: last writer wins (refreshes the version once on conflict). Used for the
// small, rarely written keys; the inbox and flow sessions go through withRetry instead.
async function sset(key, val) {
  try { await ssetStrict(key, val); }
  catch (e) {
    if (e.conflict && ddb) { try { await ddbGet(key); await ddbSet(key, val); return; } catch (e2) { console.error('[state] set retry', key, e2.message); return; } }
    console.error('[state] set', key, e.message);
  }
}
// Read-modify-write with retry: fn(doc) mutates the doc; re-read and re-run on conflict.
async function withRetry(key, fn, def) {
  for (let i = 0; i < 6; i++) {
    const doc = await sget(key, def === undefined ? {} : def);
    const result = await fn(doc);
    try { await ssetStrict(key, doc); return result; }
    catch (e) { if (!e.conflict) { console.error('[state] tx', key, e.message); return result; } await new Promise((r) => setTimeout(r, 40 + Math.random() * 120)); }
  }
  console.error('[state] tx gave up after retries', key);
}
// token store: one doc { [portalId]: tokenObj }
const getTokens = async () => sget('vh_tokens', {});
const setTokenFor = async (pid, obj) => { const t = await getTokens(); t[pid] = obj; await sset('vh_tokens', t); };
// connected portals
const getConnected = async () => sget('vh_connected', { ids: [] });
const addConnected = async (pid) => { const c = await getConnected(); if (!c.ids.includes(pid)) { c.ids.push(pid); await sset('vh_connected', c); } };
// install invites: one shareable GUID link per recipient (doc { [guid]: invite })
const getInvites = async () => sget('vh_invites', {});
async function getInvite(guid) { const a = await getInvites(); return a[guid] || null; }
async function putInvite(inv) { const a = await getInvites(); a[inv.guid] = inv; await sset('vh_invites', a); }
// Per-portal Vonage credentials: doc { [portalId]: creds }
// creds: { apiKey, apiSecret, appId, privateKey, waFrom, rcsFrom, smsFrom,
//          voiceFrom, wabaId, wabaToken, verifiedAt, updatedAt }
const allVonage = async () => sget('vh_vonage', {});
async function getVonage(pid) { const a = await allVonage(); return a[pid] || null; }
async function setVonage(pid, creds) { const a = await allVonage(); a[pid] = creds; await sset('vh_vonage', a); }
async function delVonage(pid) { const a = await allVonage(); delete a[pid]; await sset('vh_vonage', a); }
// The only credential resolution there is: this portal's own account, or nothing.
async function vonageCreds(portalId) {
  if (!portalId) return null;
  const c = await getVonage(String(portalId));
  if (!c || !c.appId || !c.privateKey) return null;
  Object.defineProperty(c, '__pid', { value: String(portalId), enumerable: false }); // never persisted
  return c;
}
const NOT_CONFIGURED = { error: 'vonage_not_configured', message: 'This HubSpot account has no Vonage account connected. Open your install page and complete the "Connect your Vonage account" step first.' };

// templates: doc { [portalId]: { [id]: tpl } }
const allTemplates = async () => sget('vh_templates', {});
async function listTemplates(pid) { const a = await allTemplates(); return Object.values(a[pid] || {}); }
async function getTemplate(pid, id) { const a = await allTemplates(); return (a[pid] || {})[id] || null; }
async function putTemplate(pid, tpl) { const a = await allTemplates(); a[pid] = a[pid] || {}; a[pid][tpl.id] = tpl; await sset('vh_templates', a); }
async function delTemplate(pid, id) { const a = await allTemplates(); if (a[pid]) { delete a[pid][id]; await sset('vh_templates', a); } }

// ---- Inbox: unified cross-channel conversation store (VCR state vh_inbox) ---
//  Shape: { [portalId]: { [digitsKey]: thread } }
//  thread: { phone, name, contactId, lastTs, lastText, lastChannel, unread, channels{}, messages[] }
//  A "conversation" is one counterparty (by phone), aggregating every channel
//  (WhatsApp/RCS/SMS) they've used - like a single WhatsApp-style chat.
const digitsOnly = (s) => String(s || '').replace(/[^\d]/g, '');
const getInbox = async () => sget('vh_inbox', {});
// Serialize every read-modify-write of the vh_inbox doc through one in-process
// queue - the whole-doc state model would otherwise lose updates when inbound
// messages (or a send + an inbound) mutate it at the same time.
let _inboxLock = Promise.resolve();
function inboxTx(fn) {
  const run = _inboxLock.then(() => withRetry('vh_inbox', fn, {}));
  _inboxLock = run.then(() => {}, () => {});
  return run;
}
async function recordMessage(portalId, phone, msg, opts) {
  const o = opts || {};
  const key = digitsOnly(phone);
  if (!portalId || !key) return null;
  return inboxTx((inbox) => {
    inbox[portalId] = inbox[portalId] || {};
    const th = inbox[portalId][key] || { phone: '+' + key, name: '', contactId: null, unread: 0, channels: {}, messages: [] };
    if (o.name && !th.name) th.name = o.name;
    if (o.contactId && !th.contactId) th.contactId = o.contactId;
    const m = { id: msg.id || uuid(), dir: o.incoming ? 'in' : 'out', channel: msg.channel || 'sms', type: msg.type || 'text', text: msg.text || '', media: msg.media || '', ts: msg.ts || Date.now() };
    th.messages.push(m);
    if (th.messages.length > 300) th.messages = th.messages.slice(-300);
    th.channels[m.channel] = true;
    th.lastTs = m.ts; th.lastText = m.text || (m.media ? `[${m.type}]` : ''); th.lastChannel = m.channel;
    if (o.incoming) th.unread = (th.unread || 0) + 1;
    inbox[portalId][key] = th;
    return th;
  });
}
// Best-effort: record an outbound message into every connected portal's inbox
// (or a specific one) so sent messages appear in the thread immediately.
async function recordOutbound(portalId, to, channel, type, text, media) {
  try {
    const pids = portalId ? [portalId] : ((await getConnected()).ids || []);
    for (const pid of pids) await recordMessage(pid, to, { channel: channel || 'sms', type: type || 'text', text: text || '', media: media || '' }, { incoming: false });
  } catch (e) { console.error('[inbox] recordOutbound', e.message); }
}

// ============================================================================
//  Vonage helpers
// ============================================================================
// All JWTs are minted from the PORTAL'S OWN app + private key.
// Vonage's external-accounts record for a WhatsApp number carries the WABA id
// (aggregate_id) and the applications the number is linked to. Resolving it here
// removes two real client mistakes seen in production: typing the phone number
// into the WABA field, and entering an application the number is not linked to
// (WhatsApp Manager answers 401 for any other app on the same account).
async function resolveWaba(creds) {
  if (!creds || !creds.apiKey || !creds.apiSecret || !creds.waFrom) return null;
  try {
    const basic = 'Basic ' + Buffer.from(`${creds.apiKey}:${creds.apiSecret}`).toString('base64');
    const r = await fetch(`https://api.nexmo.com/beta/chatapp-accounts/whatsapp/${encodeURIComponent(creds.waFrom)}`, { headers: { Authorization: basic, Accept: 'application/json' } });
    if (!r.ok) return null;
    const j = await r.json();
    return { wabaId: String(j.aggregate_id || ''), apps: Array.isArray(j.applications) ? j.applications : [], name: j.name || '' };
  } catch (e) { return null; }
}
// If the stored WABA id is missing or is obviously the phone number, repair it
// from Vonage and persist - so a mis-filled portal heals on its next request.
async function ensureWaba(pid, creds) {
  if (!creds) return creds;
  const bad = !creds.wabaId || creds.wabaId === creds.waFrom || !/^\d{8,20}$/.test(creds.wabaId);
  if (!bad) return creds;
  const info = await resolveWaba(creds);
  if (info && info.wabaId) { creds.wabaId = info.wabaId; try { await setVonage(pid, creds); } catch (e) {} }
  return creds;
}
// Media for a template header must be uploaded to Meta first and referenced by
// the returned handle - a plain URL in header_handle is rejected. This is Vonage's
// own upload endpoint, signed with the portal's app, so nothing leaves the
// customer's account.
async function waUploadHandle(creds, mediaSrc) {
  const mr = await fetch(mediaSrc); if (!mr.ok) throw new Error('could not fetch header media (' + mr.status + ')');
  const buf = Buffer.from(await mr.arrayBuffer());
  let ft = (mr.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
  if (!/^(image|video|application)\//.test(ft)) ft = 'image/jpeg';
  const boundary = '----VH' + crypto.randomBytes(8).toString('hex');
  const fn = 'media.' + (ft.split('/')[1] || 'jpg');
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="mediafile"; filename="${fn}"\r\nContent-Type: ${ft}\r\n\r\n`;
  const body = Buffer.concat([Buffer.from(head), buf, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const r = await fetch(`https://api.nexmo.com/v2/whatsapp-manager/media/uploads?file_type=${encodeURIComponent(ft)}`, {
    method: 'POST', headers: { Authorization: `Bearer ${appJwt(creds)}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body,
  });
  const j = await r.json().catch(() => ({}));
  if (!j.h) throw new Error('media upload failed: ' + JSON.stringify(j).slice(0, 140));
  return j.h;
}
function appJwt(creds) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({ application_id: creds.appId, iat: now, exp: now + 600, jti: uuid() }, creds.privateKey, { algorithm: 'RS256' });
}
function clientJwt(creds, username) {
  const now = Math.floor(Date.now() / 1000);
  const acl = { paths: { '/*/users/**': {}, '/*/conversations/**': {}, '/*/sessions/**': {}, '/*/devices/**': {}, '/*/push/**': {}, '/*/knocking/**': {}, '/*/legs/**': {} } };
  return jwt.sign({ application_id: creds.appId, sub: username, iat: now, exp: now + 3600, jti: uuid(), acl }, creds.privateKey, { algorithm: 'RS256' });
}
const slug = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'tpl';
function fillVars(text, vars) { return !text ? text : String(text).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (vars && vars[k] != null ? vars[k] : m)); }
// Sender for a channel comes from the portal's own settings - never a default.
function fromFor(creds, channel) {
  if (channel === 'sms') return creds.smsFrom || '';
  if (channel === 'rcs') return creds.rcsFrom || '';
  return creds.waFrom || '';
}
function messagePayload(creds, channel, to, text) {
  const t = String(to).replace(/[^\d]/g, '');
  return { message_type: 'text', text, to: t, from: fromFor(creds, channel), channel: channel === 'sms' ? 'sms' : (channel === 'rcs' ? 'rcs' : 'whatsapp') };
}
// Resolve a media reference (hosted id or full URL) to a public URL
function mediaUrl(ref) {
  if (!ref) return '';
  if (/^https?:\/\//i.test(ref)) return ref;
  return `${BASE_URL}/2v/media/${ref}`; // hosted asset id
}
// RCS suggestion -> Google RBM suggestion object
function rcsSuggestion(s, vars) {
  const text = fillVars(s.text, vars);
  if (s.type === 'url') return { action: { text, postbackData: s.text, openUrlAction: { url: fillVars(s.value, vars) } } };
  if (s.type === 'dial') return { action: { text, postbackData: s.text, dialAction: { phoneNumber: fillVars(s.value, vars) } } };
  return { reply: { text, postbackData: (s.value || s.text || '').toString() } };
}
function rcsCardContent(c, vars) {
  const content = { title: fillVars(c.title, vars), description: fillVars(c.text || c.description, vars) };
  const m = mediaUrl(c.mediaUrl);
  if (m) content.media = { height: 'MEDIUM', contentInfo: { fileUrl: m, forceRefresh: false } };
  if (c.suggestions && c.suggestions.length) content.suggestions = c.suggestions.map((s) => rcsSuggestion(s, vars));
  return content;
}
// WhatsApp interactive reply button
function waButton(b, i, vars) {
  if (b.type === 'url') return { type: 'cta_url', text: fillVars(b.text, vars), url: fillVars(b.value, vars) };
  return { type: 'reply', reply: { id: String(b.id || i + 1), title: fillVars(b.text, vars) } };
}

// Build the Vonage Messages payload for any template/message type.
// `creds` = the sending portal's own Vonage settings (senders come from there).
function buildPayload(creds, tpl, to, vars) {
  const t = String(to).replace(/[^\d]/g, '');
  const channel = tpl.channel || 'sms';
  const from = fromFor(creds, channel);
  const type = tpl.type || 'text';
  const text = fillVars(tpl.body, vars);
  const caption = text || fillVars(tpl.title, vars) || undefined;
  const media = mediaUrl(tpl.mediaUrl);

  // ---- SMS (text only) ----
  if (channel === 'sms') return { message_type: 'text', to: t, from, channel, text };

  // ---- RCS ----
  if (channel === 'rcs') {
    if (type === 'image' && media) return { message_type: 'image', to: t, from, channel, image: { url: media } };
    if (type === 'video' && media) return { message_type: 'video', to: t, from, channel, video: { url: media } };
    if (type === 'file' && media) return { message_type: 'file', to: t, from, channel, file: { url: media } };
    if (type === 'card') {
      return { message_type: 'custom', to: t, from, channel, custom: { contentMessage: { richCard: { standaloneCard: { thumbnailImageAlignment: 'RIGHT', cardOrientation: 'VERTICAL', cardContent: rcsCardContent({ title: tpl.title, text: tpl.body, mediaUrl: tpl.mediaUrl, suggestions: tpl.suggestions }, vars) } } } } };
    }
    if (type === 'carousel') {
      const cardContents = (tpl.cards || []).map((c) => rcsCardContent(c, vars));
      return { message_type: 'custom', to: t, from, channel, custom: { contentMessage: { richCard: { carouselCard: { cardWidth: 'MEDIUM', cardContents } } } } };
    }
    // text (+ suggestions)
    if (tpl.suggestions && tpl.suggestions.length) {
      return { message_type: 'custom', to: t, from, channel, custom: { contentMessage: { text, suggestions: tpl.suggestions.map((s) => rcsSuggestion(s, vars)) } } };
    }
    return { message_type: 'text', to: t, from, channel, text };
  }

  // ---- WhatsApp ----
  if (channel === 'whatsapp') {
    // approved template send (body params only via simple form)
    if ((type === 'text' || type === 'buttons') && tpl.status === 'approved' && tpl.waName) {
      const parameters = (tpl.waVarOrder || tpl.variables || []).map((v) => String((vars && vars[v]) || ''));
      if (tpl.waHeaderVar) {
        const comps = [{ type: 'header', parameters: [{ type: 'text', text: String((vars && vars[tpl.waHeaderVar]) || '') }] }];
        if (parameters.length) comps.push({ type: 'body', parameters: parameters.map((x) => ({ type: 'text', text: x })) });
        return { message_type: 'custom', to: t, from, channel, custom: { type: 'template', template: { name: tpl.waName, language: { policy: 'deterministic', code: tpl.language || 'en_US' }, components: comps } } };
      }
      return { message_type: 'template', to: t, from, channel, template: { name: tpl.waName, parameters }, whatsapp: { policy: 'deterministic', locale: tpl.language || 'en_US' } };
    }
    if (type === 'image' && media) return { message_type: 'image', to: t, from, channel, image: { url: media, caption } };
    if (type === 'video' && media) return { message_type: 'video', to: t, from, channel, video: { url: media, caption } };
    if (type === 'file' && media) return { message_type: 'file', to: t, from, channel, file: { url: media, caption } };
    // interactive buttons (session message)
    if ((type === 'buttons' || (tpl.buttons && tpl.buttons.length))) {
      const replies = (tpl.buttons || []).filter((b) => b.type !== 'url');
      const cta = (tpl.buttons || []).find((b) => b.type === 'url');
      if (cta) {
        return { message_type: 'custom', to: t, from, channel, custom: { type: 'interactive', interactive: { type: 'cta_url', body: { text }, action: { name: 'cta_url', parameters: { display_text: fillVars(cta.text, vars), url: fillVars(cta.value, vars) } } } } };
      }
      return { message_type: 'custom', to: t, from, channel, custom: { type: 'interactive', interactive: { type: 'button', body: { text }, action: { buttons: replies.map((b, i) => waButton(b, i, vars)) } } } };
    }
    return { message_type: 'text', to: t, from, channel, text };
  }
  return { message_type: 'text', to: t, from, channel, text };
}
const buildFromTemplate = buildPayload; // back-compat alias
// ---- Opt-outs (22 Oct 2026). A recipient who replies STOP / taps an "Unsubscribe" button is added to
// the portal's suppression list; every send from this integration to that number is then refused
// (all channels), the contact gets a timeline note, and the contact property vonage_opted_out is set
// to true when the portal has created it. START removes them again.
// doc: vh_optouts = { [pid]: { [digits]: { at, channel, keyword, contactId } } }
const OPTOUT_WORDS = ['stop', 'stopall', 'stop all', 'unsubscribe', 'unsub', 'cancel', 'end', 'quit', 'opt out', 'optout', 'opt-out', 'remove me', 'stop messages'];
const OPTIN_WORDS = ['start', 'unstop', 'subscribe', 'resubscribe', 'opt in', 'optin', 'opt-in'];
const normWord = (t) => String(t || '').toLowerCase().replace(/[^a-z\- ]/g, ' ').replace(/\s+/g, ' ').trim();
const allOptouts = async () => sget('vh_optouts', {});
let optCache = null;
async function optoutsFor(pid) { if (!optCache) optCache = await allOptouts(); return optCache[pid] || {}; }
async function setOptout(pid, digits, rec) {
  const a = await allOptouts(); a[pid] = a[pid] || {};
  if (rec) a[pid][digits] = rec; else delete a[pid][digits];
  await sset('vh_optouts', a); optCache = a;
}
async function isOptedOut(pid, to) { const d = String(to || '').replace(/[^\d]/g, ''); return !!(pid && d && (await optoutsFor(pid))[d]); }
async function setContactOptProp(pid, contactId, value) {
  if (!contactId) return;
  try {
    const r = await hsApi(pid, 'PATCH', `/crm/v3/objects/contacts/${contactId}`, { properties: { vonage_opted_out: value ? 'true' : 'false' } });
    if (!r.ok) console.log(`[optout] property vonage_opted_out not set on ${contactId} (${r.status} - create it in HubSpot to use lists/workflows)`);
  } catch (e) {}
}

async function vonageSendPayload(creds, payload) {
  if (creds && creds.__pid && payload && payload.to && !payload.__allowOptedOut && await isOptedOut(creds.__pid, payload.to)) {
    console.log(`[optout] blocked ${payload.channel} send to ${payload.to} (portal ${creds.__pid})`);
    return { ok: false, status: 403, body: { title: 'Recipient opted out', detail: 'This person replied STOP or tapped Unsubscribe, so no further messages are sent to them. They can reply START to opt back in.' } };
  }
  if (payload && payload.__allowOptedOut) { payload = Object.assign({}, payload); delete payload.__allowOptedOut; }
  // Signed with the portal's OWN application - their numbers/senders must be
  // linked to that app in their Vonage dashboard.
  if (!payload.from) return { ok: false, status: 400, body: { title: 'No sender configured', detail: `Set your ${payload.channel} sender in the Vonage settings step of your install page.` } };
  const r = await fetch('https://api.nexmo.com/v1/messages', { method: 'POST', headers: { Authorization: `Bearer ${appJwt(creds)}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload) });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body: d };
}
async function placeCall(creds, to) {
  const t = String(to).replace(/[^\d]/g, '');
  const fromNum = String(creds.voiceFrom || creds.smsFrom || creds.waFrom || '').replace(/[^\d]/g, '');
  if (!fromNum) return { ok: false, status: 400, body: { title: 'No voice number configured', detail: 'Set your voice number in the Vonage settings step of your install page.' } };
  const r = await fetch('https://api.nexmo.com/v1/calls', { method: 'POST', headers: { Authorization: `Bearer ${appJwt(creds)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ to: [{ type: 'phone', number: t }], from: { type: 'phone', number: fromNum }, ncco: [{ action: 'talk', text: 'Connecting your call from HubSpot.' }] }) });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body: d };
}

// ============================================================================
//  HubSpot helpers
// ============================================================================
// Uninstall cleanup: when a portal uninstalls the app, HubSpot revokes the
// refresh token (invalid_grant / BAD_REFRESH_TOKEN). Drop everything we hold
// for that portal - OAuth tokens, their Vonage credentials, inbox and
// templates - so no customer data or secrets outlive the install.
async function purgePortal(portalId) {
  try {
    const t = await getTokens(); delete t[portalId]; await sset('vh_tokens', t);
    const c = await getConnected(); c.ids = (c.ids || []).filter((x) => String(x) !== String(portalId)); await sset('vh_connected', c);
    await delVonage(String(portalId));
    await inboxTx((ib) => { delete ib[portalId]; });
    const tp = await allTemplates(); delete tp[portalId]; await sset('vh_templates', tp);
    console.log(`[uninstall] purged all data for portal ${portalId}`);
  } catch (e) { console.error('[uninstall] purge failed', portalId, e.message); }
}
async function refreshToken(portalId) {
  const tokens = await getTokens();
  const store = tokens[portalId];
  if (!store) throw new Error('portal not connected');
  if (store.expires_at && Date.now() < store.expires_at - 60000) return store.access_token;
  const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: HS_CLIENT_ID, client_secret: HS_CLIENT_SECRET, refresh_token: store.refresh_token });
  const r = await fetch(`${HS_API}/oauth/v1/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const d = await r.json();
  if (!d.access_token) {
    const msg = JSON.stringify(d);
    if (/invalid_grant|BAD_REFRESH_TOKEN|REFRESH_TOKEN_NOT_FOUND/i.test(msg)) await purgePortal(portalId);
    throw new Error('refresh failed: ' + msg);
  }
  const updated = { ...store, access_token: d.access_token, refresh_token: d.refresh_token || store.refresh_token, expires_at: Date.now() + d.expires_in * 1000 };
  await setTokenFor(portalId, updated);
  return updated.access_token;
}
async function hsApi(portalId, method, p, body) {
  const token = await refreshToken(portalId);
  const r = await fetch(`${HS_API}${p}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body: d };
}
async function logNote(portalId, contactId, text) {
  if (!contactId) return;
  await hsApi(portalId, 'POST', '/crm/v3/objects/notes', { properties: { hs_note_body: text, hs_timestamp: Date.now() }, associations: [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] }] });
}
// Workflow actions can run on any record (contact, meeting, deal, company, ticket).
// The phone number lives on the CONTACT, so for any other record follow its
// associations and use the first associated contact that has a phone number.
const WF_OBJECT_PATHS = { CONTACT: 'contacts', MEETING_EVENT: 'meetings', MEETING: 'meetings', MEETINGS: 'meetings', DEAL: 'deals', COMPANY: 'companies', TICKET: 'tickets', CALL: 'calls', TASK: 'tasks' };
const WF_OBJECT_WORDS = { meetings: 'meeting', deals: 'deal', companies: 'company', tickets: 'ticket', calls: 'call', tasks: 'task', contacts: 'contact' };
async function wfContact(portalId, ev) {
  const objectId = String((ev.object && ev.object.objectId) || ev.objectId || '');
  const rawType = String((ev.object && (ev.object.objectType || ev.object.objectTypeId)) || ev.objectType || '').toUpperCase();
  const props = 'properties=phone,mobilephone,firstname,lastname';
  const phoneOf = (p) => String(p.mobilephone || p.phone || '').replace(/[^\d]/g, '');
  // custom objects (e.g. a portal's own "Spotkanie") arrive as "2-<number>" - use that id as the path
  const custom = /^2-\d+$/.test(rawType);
  let type = custom ? rawType : (WF_OBJECT_PATHS[rawType] || (rawType === '0-1' ? 'contacts' : rawType === '0-3' ? 'deals' : rawType === '0-2' ? 'companies' : rawType === '0-5' ? 'tickets' : rawType === '0-47' ? 'meetings' : ''));
  if (custom) {
    const a = await hsApi(portalId, 'GET', `/crm/v4/objects/${type}/${objectId}/associations/contacts?limit=100`);
    console.log(`[wf] custom object ${type}/${objectId} associations -> ${a.status} ${a.ok ? (a.body.results || []).length + ' contact(s)' : JSON.stringify(a.body).slice(0, 200)}`);
    if (!a.ok) {
      const perm = a.status === 403 || /scope|permission/i.test(JSON.stringify(a.body || {}));
      return { contactId: null, phone: '', via: 'custom object', detail: perm ? 'Vonage does not yet have permission to read custom objects in this HubSpot account. Reconnect the Vonage app in HubSpot and approve the new permission.' : 'This record could not be read.' };
    }
    const ids = (a.body.results || []).map((x) => String(x.toObjectId));
    if (!ids.length) return { contactId: null, phone: '', via: 'custom object', detail: 'This record has no associated contact. Associate a contact that has a phone number with it.' };
    for (const id of ids) {
      const c = await hsApi(portalId, 'GET', `/crm/v3/objects/contacts/${id}?${props}`);
      const p = (c.body && c.body.properties) || {};
      if (phoneOf(p)) return { contactId: id, phone: phoneOf(p), props: p, via: 'custom object' };
    }
    return { contactId: ids[0], phone: '', via: 'custom object', detail: 'None of the contacts associated with this record has a phone number. Add a phone or mobile number to the contact.' };
  }
  if (!type || type === 'contacts') {
    const c = await hsApi(portalId, 'GET', `/crm/v3/objects/contacts/${objectId}?${props}`);
    if (c.ok) { const p = c.body.properties || {}; return { contactId: objectId, phone: phoneOf(p), props: p, via: 'contact' }; }
    if (type === 'contacts') return { contactId: null, phone: '', via: 'contact', detail: 'This contact could not be found.' };
  }
  // not a contact: a known type is used alone (a wrong-type lookup can come back
  // "ok" with zero contacts and give a misleading error); untyped -> try the usual ones
  const order = (type ? [type] : ['meetings', 'deals', 'companies', 'tickets']).filter((t) => t !== 'contacts');
  for (const t of order) {
    if (!type) { const ex = await hsApi(portalId, 'GET', `/crm/v3/objects/${t}/${objectId}`); if (!ex.ok) continue; }
    const a = await hsApi(portalId, 'GET', `/crm/v4/objects/${t}/${objectId}/associations/contacts?limit=100`);
    if (!a.ok) continue;
    const ids = (a.body.results || []).map((x) => String(x.toObjectId));
    const word = WF_OBJECT_WORDS[t] || 'record';
    if (!ids.length) return { contactId: null, phone: '', via: word, detail: `This ${word} has no associated contact. Associate a contact that has a phone number with the ${word}.` };
    for (const id of ids) {
      const c = await hsApi(portalId, 'GET', `/crm/v3/objects/contacts/${id}?${props}`);
      const p = (c.body && c.body.properties) || {};
      if (phoneOf(p)) return { contactId: id, phone: phoneOf(p), props: p, via: word };
    }
    return { contactId: ids[0], phone: '', via: word, detail: `None of the contacts associated with this ${word} has a phone number. Add a phone or mobile number to the contact.` };
  }
  return { contactId: null, phone: '', via: rawType || 'record', detail: 'The record this workflow runs on could not be read, or has no associated contact.' };
}
async function findContactByPhone(portalId, phone) {
  const digits = String(phone).replace(/[^\d]/g, '');
  if (digits.length < 7) return null;
  const r = await hsApi(portalId, 'POST', '/crm/v3/objects/contacts/search', { filterGroups: [{ filters: [{ propertyName: 'phone', operator: 'CONTAINS_TOKEN', value: digits }] }, { filters: [{ propertyName: 'mobilephone', operator: 'CONTAINS_TOKEN', value: digits }] }], properties: ['phone', 'mobilephone', 'firstname', 'lastname'], limit: 5 });
  const tail = digits.slice(-8); // guard against fuzzy token matches (e.g. sample contacts)
  const hit = (r.body.results || []).find((c) => {
    const p = c.properties || {};
    return [p.phone, p.mobilephone].some((v) => v && String(v).replace(/[^\d]/g, '').includes(tail));
  });
  return hit || null;
}

// ============================================================================
//  Routes
// ============================================================================

// ============================================================================
//  SENDER DISCOVERY - every number / WhatsApp number / RCS agent linked to the
//  portal's Vonage application, read from the portal's own account. The typed
//  waFrom/rcsFrom/smsFrom stay the DEFAULT per channel; flows may pick any
//  discovered sender (several RCS agents side by side).
// ============================================================================
async function discoverSenders(creds) {
  const out = { sms: [], voice: [], whatsapp: [], rcs: [], viber: [], at: Date.now(), error: null };
  if (!creds || !creds.apiKey || !creds.apiSecret) { out.error = 'api key/secret missing'; return out; }
  const basic = 'Basic ' + Buffer.from(`${creds.apiKey}:${creds.apiSecret}`).toString('base64');
  const appId = String(creds.appId || '').toLowerCase();
  try {
    const r = await fetch('https://rest.nexmo.com/account/numbers?size=100', { headers: { Authorization: basic } });
    const d = r.ok ? await r.json().catch(() => ({})) : {};
    for (const n of (d.numbers || [])) {
      if (appId && String(n.app_id || '').toLowerCase() !== appId) continue;
      const f = n.features || [];
      const label = `+${n.msisdn} (${n.country || ''} ${n.type || ''})`.replace(/\s+\)/, ')');
      if (f.includes('SMS')) out.sms.push({ id: n.msisdn, label });
      if (f.includes('VOICE')) out.voice.push({ id: n.msisdn, label });
    }
  } catch (e) { out.error = 'numbers: ' + e.message; }
  try {
    const r = await fetch('https://api.nexmo.com/beta/chatapp-accounts?page_size=100', { headers: { Authorization: basic, Accept: 'application/json' } });
    const d = r.ok ? await r.json().catch(() => ({})) : {};
    const arr = Array.isArray(d._embedded) ? d._embedded : ((d._embedded && d._embedded.accounts) || []);
    for (const a of arr) {
      const apps = (a.applications || []).map((x) => String(x).toLowerCase());
      if (appId && !apps.includes(appId)) continue;
      const row = { id: a.external_id, label: a.name ? `${a.name} (${a.external_id})` : a.external_id };
      if (a.provider === 'whatsapp') out.whatsapp.push(row);
      else if (a.provider === 'rcs') out.rcs.push(row);
      else if (String(a.provider || '').startsWith('viber')) out.viber.push(row);
    }
  } catch (e) { out.error = (out.error ? out.error + '; ' : '') + 'external accounts: ' + e.message; }
  return out;
}
app.get('/2v/api/vonage/senders', async (req, res) => {
  try {
    const pid = String(req.query.portalId || '');
    const creds = await getVonage(pid);
    if (!creds) return res.status(400).json(NOT_CONFIGURED);
    if (req.query.refresh || !creds.senders) {
      creds.senders = await discoverSenders(creds);
      // first discovery fills empty defaults
      if (!creds.smsFrom && creds.senders.sms[0]) creds.smsFrom = creds.senders.sms[0].id;
      if (!creds.waFrom && creds.senders.whatsapp[0]) creds.waFrom = creds.senders.whatsapp[0].id;
      if (!creds.rcsFrom && creds.senders.rcs[0]) creds.rcsFrom = creds.senders.rcs[0].id;
      if (!creds.voiceFrom && creds.senders.voice[0]) creds.voiceFrom = creds.senders.voice[0].id;
      await setVonage(pid, creds);
    }
    res.json({ senders: creds.senders, defaults: { sms: creds.smsFrom || '', whatsapp: creds.waFrom || '', rcs: creds.rcsFrom || '', voice: creds.voiceFrom || '' } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/2v/api/vonage/defaults', async (req, res) => {
  try {
    const b = req.body || {}; const pid = String(b.portalId || '');
    const creds = await getVonage(pid);
    if (!creds) return res.status(400).json(NOT_CONFIGURED);
    for (const [k, v] of [['smsFrom', b.sms], ['waFrom', b.whatsapp], ['rcsFrom', b.rcs], ['voiceFrom', b.voice]]) if (v != null) creds[k] = String(v).trim();
    await setVonage(pid, creds);
    res.json({ ok: true, defaults: { sms: creds.smsFrom || '', whatsapp: creds.waFrom || '', rcs: creds.rcsFrom || '', voice: creds.voiceFrom || '' } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// every sender a portal owns (defaults + discovered) - used to route inbound
function allSendersOf(c) {
  const ids = [c.waFrom, c.rcsFrom, c.smsFrom, c.voiceFrom];
  if (c.senders) for (const k of ['sms', 'voice', 'whatsapp', 'rcs', 'viber']) for (const s of (c.senders[k] || [])) ids.push(s.id);
  return ids.filter(Boolean).map((s) => { const d = String(s).replace(/[^\d]/g, ''); return d || String(s).toLowerCase(); });
}

// ============================================================================
//  FLOWS - conversational automations built in the hosted flow builder
//  (/2v/flows?portal=ID). A flow = channel + sender + trigger + ordered steps.
//  step.msg: text (+ quick replies) | tool template | approved WhatsApp template
//  step.then: next | wait (rules: if reply equals/contains/regex/number/any ->
//             go to step; no match -> repeat / go to / end) | goto | end
//  step.actions: HubSpot note, set contact property, hand over (stop automation)
//  Triggers: keyword(s) (exact/contains), any inbound message (catch-all),
//  outbound only (started from a contact, a list, the API or a HubSpot workflow).
// ============================================================================
const allFlows = async () => sget('vh_flows', {});
async function listFlows(pid) { const a = await allFlows(); return Object.values(a[pid] || {}); }
async function getFlow(pid, id) { const a = await allFlows(); return (a[pid] || {})[id] || null; }
async function putFlow(pid, f) { const a = await allFlows(); a[pid] = a[pid] || {}; a[pid][f.id] = f; await sset('vh_flows', a); }
async function delFlow(pid, id) { const a = await allFlows(); if (a[pid]) { delete a[pid][id]; await sset('vh_flows', a); } }
// sessions: { [pid]: { [phone]: { flowId, stepId, startedAt, lastTs, vars, contactId, stopped, channel } } }
let _flowLock = Promise.resolve();
function flowTx(fn) {
  const run = _flowLock.then(() => withRetry('vh_flow_sessions', fn, {}));
  _flowLock = run.then(() => {}, () => {});
  return run;
}
const SESSION_TTL = 24 * 3600 * 1000;
const simSessions = {}; // dry runs for the builder's simulator
const normFlow = (b, pid, existing) => {
  const steps = Array.isArray(b.steps) ? b.steps : [];
  return {
    id: b.id || (existing && existing.id) || `flow_${uuid().slice(0, 8)}`, portalId: pid, name: String(b.name || 'Untitled flow').slice(0, 80),
    channel: ['whatsapp', 'rcs', 'sms'].includes(b.channel) ? b.channel : 'whatsapp', from: String(b.from || ''), enabled: b.enabled !== false,
    trigger: { type: ['keyword', 'any', 'outbound'].includes(b.trigger && b.trigger.type) ? b.trigger.type : 'keyword',
      keywords: ((b.trigger && b.trigger.keywords) || []).map((k) => String(k).trim()).filter(Boolean).slice(0, 20), match: (b.trigger && b.trigger.match) === 'contains' ? 'contains' : 'exact' },
    steps: steps.map((s, i) => ({
      id: s.id || `s${i + 1}_${uuid().slice(0, 4)}`, name: String(s.name || `Step ${i + 1}`).slice(0, 60),
      msg: Object.assign({ kind: 'text', text: '', mediaUrl: '', buttons: [], templateId: '', waName: '', waLang: 'en', waParams: [] }, s.msg || {}),
      then: Object.assign({ mode: 'next', goto: '', rules: [], noMatch: { mode: 'repeat', goto: '', text: '' } }, s.then || {}),
      actions: Array.isArray(s.actions) ? s.actions.slice(0, 5) : []
    })).slice(0, 40),
    createdAt: (existing && existing.createdAt) || Date.now(), updatedAt: Date.now()
  };
};
const stepIndex = (flow, id) => flow.steps.findIndex((s) => s.id === id);
const stepById = (flow, id) => flow.steps[stepIndex(flow, id)] || null;
const nextStepOf = (flow, step) => { const i = stepIndex(flow, step.id); return i >= 0 && flow.steps[i + 1] ? flow.steps[i + 1] : null; };
const normText = (s) => String(s || '').trim().toLowerCase();

// Build the Vonage payload for one step on this flow's channel (+ chosen sender)
async function stepPayload(pid, creds, flow, step, to, vars) {
  const m = step.msg || {}; const ch = flow.channel; let payload;
  if (m.kind === 'template' && m.templateId) {
    const tpl = await getTemplate(pid, m.templateId);
    if (!tpl) throw new Error(`template ${m.templateId} not found`);
    payload = buildPayload(creds, tpl, to, vars);
  } else if (m.kind === 'wa_template' && m.waName) {
    const shape = await waTemplateShape(creds, pid, m.waName, m.waLang || 'en');
    const params = (m.waParams || []).map((p) => fillVars(String(p), vars));
    const comps = [];
    if (shape && shape.headerVars) comps.push({ type: 'HEADER', parameters: params.slice(0, shape.headerVars).map((v) => ({ type: 'text', text: v })) });
    const bodyP = shape ? params.slice(shape.headerVars, shape.headerVars + shape.bodyVars) : params;
    if (bodyP.length) comps.push({ type: 'BODY', parameters: bodyP.map((v) => ({ type: 'text', text: v })) });
    payload = { from: creds.waFrom, to: String(to).replace(/[^\d]/g, ''), channel: 'whatsapp', message_type: 'custom', custom: { type: 'template', template: { name: m.waName, language: { policy: 'deterministic', code: (shape && shape.language) || m.waLang || 'en' }, components: comps } } };
  } else {
    const buttons = (m.buttons || []).filter((b) => b && b.text).slice(0, ch === 'whatsapp' ? 3 : 8);
    let body = m.text || '';
    if (ch === 'sms' && buttons.length) body += '\n' + buttons.map((b, i) => `Reply ${i + 1} for ${b.text}`).join('\n');
    const tpl = { channel: ch, type: 'text', body, mediaUrl: m.mediaUrl || '', title: '' };
    if (ch === 'whatsapp') { if (buttons.length) { tpl.type = 'buttons'; tpl.buttons = buttons.map((b, i) => ({ type: 'reply', id: String(b.value || b.text), text: b.text })); } else if (m.mediaUrl) tpl.type = 'image'; }
    if (ch === 'rcs') { const sugg = buttons.map((b) => ({ type: 'reply', text: b.text, value: String(b.value || b.text) })); if (m.mediaUrl) { tpl.type = 'card'; tpl.title = step.name; tpl.suggestions = sugg; } else tpl.suggestions = sugg; }
    payload = buildPayload(creds, tpl, to, vars);
  }
  if (flow.from && payload.channel === ch) payload.from = flow.from;
  return payload;
}
const describePayload = (p) => {
  const c = p.custom || {};
  if (p.message_type === 'text') return { text: p.text };
  if (c.type === 'template') return { text: `[WhatsApp template ${c.template.name}]` };
  if (c.type === 'interactive') { const i = c.interactive; return { text: i.body && i.body.text, buttons: (i.action && i.action.buttons || []).map((b) => b.reply.title) }; }
  if (c.contentMessage) { const cm = c.contentMessage; const card = cm.richCard && cm.richCard.standaloneCard && cm.richCard.standaloneCard.cardContent; const car = cm.richCard && cm.richCard.carouselCard;
    if (card) return { text: [card.title, card.description].filter(Boolean).join('\n'), media: card.media && card.media.contentInfo.fileUrl, buttons: (card.suggestions || []).map((s) => (s.reply || s.action).text) };
    if (car) return { text: `[carousel: ${car.cardContents.map((x) => x.title).join(' | ')}]` };
    return { text: cm.text, buttons: (cm.suggestions || []).map((s) => (s.reply || s.action).text) }; }
  if (p.image) return { text: p.image.caption || '', media: p.image.url };
  return { text: JSON.stringify(p).slice(0, 200) };
};
async function runActions(ctx, step, vars) {
  for (const a of (step.actions || [])) {
    try {
      if (a.type === 'note' && ctx.contactId) await ctx.note(fillVars(a.value || '', vars));
      if (a.type === 'property' && ctx.contactId && a.name) await ctx.setProperty(a.name, fillVars(a.value || '', vars));
      if (a.type === 'stop') ctx.stopped = true;
    } catch (e) { console.error('[flow] action', a.type, e.message); }
  }
}
// Send a step, then follow `then` until the flow waits or ends. Returns the session to store (or null = ended).
async function advance(ctx, flow, step, vars, depth) {
  if (!step || depth > 25) return null;
  const payload = await stepPayload(ctx.pid, ctx.creds, flow, step, ctx.to, vars);
  await ctx.send(payload, step);
  const t = step.then || {};
  if (t.mode === 'wait') return { flowId: flow.id, stepId: step.id };
  await runActions(ctx, step, vars);
  if (ctx.stopped) return { stopped: true };
  if (t.mode === 'end') return null;
  const nxt = t.mode === 'goto' ? stepById(flow, t.goto) : nextStepOf(flow, step);
  return advance(ctx, flow, nxt, vars, depth + 1);
}
function matchRule(rule, reply, replyId, step) {
  const v = normText(rule.value), t = normText(reply), id = normText(replyId);
  const btns = (step.msg && step.msg.buttons) || [];
  const n = /^\d{1,2}$/.test(t) ? +t : 0;
  const btnHit = (b) => normText(b.text) === v || normText(b.value) === v;
  switch (rule.op) {
    case 'any': return true;
    case 'equals': return t === v || (id && id === v) || btns.some((b) => btnHit(b) && (normText(b.text) === t || (normText(b.value) && normText(b.value) === t) || (id && normText(b.value) === id))) || (n && btns[n - 1] && btnHit(btns[n - 1]));
    case 'contains': return !!v && (t.includes(v) || id.includes(v));
    case 'regex': try { return new RegExp(rule.value, 'i').test(reply || ''); } catch { return false; }
    case 'number': return /^[+-]?\d+([.,]\d+)?$/.test(String(reply || '').trim());
    default: return false;
  }
}
// Continue a waiting session with an inbound reply.
async function resume(ctx, flow, session, reply, replyId) {
  const step = stepById(flow, session.stepId); if (!step) return null;
  const vars = Object.assign({}, session.vars || {}, { reply });
  const t = step.then || {};
  let target = null, hit = false, endNow = false;
  const rules = (t.rules || []).filter((r) => r && r.op);
  for (const r of rules) { if (matchRule(r, reply, replyId, step)) { hit = true; if (r.goto === '__end') endNow = true; else target = r.goto ? stepById(flow, r.goto) : nextStepOf(flow, step); break; } }
  if (!rules.length) { hit = true; if (t.goto === '__end') endNow = true; else target = t.goto ? stepById(flow, t.goto) : nextStepOf(flow, step); }
  const go = async (tgt) => { await runActions(ctx, step, vars); if (ctx.stopped) return { vars, stopped: true }; if (!tgt) return null; const r = await advance(ctx, flow, tgt, vars, 0); return r ? Object.assign({ vars }, r) : null; };
  if (endNow) return go(null);
  if (target) return go(target);
  if (hit) return go(null); // matched but no next step = flow finished
  const nm = t.noMatch || { mode: 'repeat' };
  if (nm.mode === 'goto' && stepById(flow, nm.goto)) return go(stepById(flow, nm.goto));
  if (nm.mode === 'end') { if (nm.text) await ctx.send(messagePayload(ctx.creds, flow.channel, ctx.to, fillVars(nm.text, vars)), step); return null; }
  if (nm.text) await ctx.send(messagePayload(ctx.creds, flow.channel, ctx.to, fillVars(nm.text, vars)), step);
  else await ctx.send(await stepPayload(ctx.pid, ctx.creds, flow, step, ctx.to, vars), step); // repeat the question
  return { flowId: flow.id, stepId: step.id, vars };
}
// Real-send context for a portal + phone
function liveCtx(pid, creds, to, contactId, flow) {
  return { pid, creds, to, contactId, stopped: false,
    send: async (payload, step) => {
      const r = await vonageSendPayload(creds, payload);
      const d = describePayload(payload);
      console.log(`[flow ${flow.id}] -> ${to} step=${step && step.name} ok=${r.ok} ${r.ok ? (r.body && r.body.message_uuid) || '' : JSON.stringify(r.body || {}).slice(0, 200)}`);
      recordOutbound(pid, to, payload.channel, 'text', `[flow ${flow.name}] ${d.text || ''}`.slice(0, 500), d.media || '').catch(() => {});
      if (contactId) logNote(pid, contactId, `[${payload.channel.toUpperCase()} flow "${flow.name}"] ${(d.text || '').slice(0, 300)}`).catch(() => {});
      if (!r.ok) throw new Error(`vonage ${r.status}: ${JSON.stringify(r.body || {}).slice(0, 200)}`);
    },
    note: (text) => logNote(pid, contactId, text),
    setProperty: (name, value) => hsApi(pid, 'PATCH', `/crm/v3/objects/contacts/${contactId}`, { properties: { [name]: value } })
  };
}
async function contactVars(pid, to, contactId) {
  const vars = { phone: '+' + String(to).replace(/[^\d]/g, ''), firstname: '', lastname: '', name: '' };
  try {
    const c = contactId ? await hsApi(pid, 'GET', `/crm/v3/objects/contacts/${contactId}?properties=firstname,lastname,email,company`) : null;
    const p = (c && c.body && c.body.properties) || {};
    vars.firstname = p.firstname || ''; vars.lastname = p.lastname || ''; vars.email = p.email || ''; vars.company = p.company || '';
    vars.name = [p.firstname, p.lastname].filter(Boolean).join(' ');
  } catch (e) {}
  return vars;
}
async function saveSession(pid, to, sess) {
  const key = String(to).replace(/[^\d]/g, '');
  return flowTx((s) => { s[pid] = s[pid] || {}; if (!sess) delete s[pid][key]; else s[pid][key] = Object.assign({ startedAt: Date.now() }, s[pid][key] || {}, sess, { lastTs: Date.now() }); });
}
async function startFlow(pid, flow, to, contactId, extraVars) {
  const creds = await vonageCreds(pid); if (!creds) throw new Error('vonage_not_configured');
  if (!contactId) { try { const c = await findContactByPhone(pid, to); if (c) contactId = c.id; } catch (e) {} }
  const vars = Object.assign(await contactVars(pid, to, contactId), extraVars || {});
  const ctx = liveCtx(pid, creds, to, contactId, flow);
  const sess = await advance(ctx, flow, flow.steps[0], vars, 0);
  await saveSession(pid, to, sess ? Object.assign({ channel: flow.channel, contactId, vars }, sess) : null);
  return { ok: true, waiting: !!(sess && sess.stepId), stopped: !!(sess && sess.stopped) };
}
// Inbound hook (called from handleInbound after the message is recorded)
async function flowOnInbound(pid, channel, from, text, replyId, contactId) {
  const key = String(from).replace(/[^\d]/g, '');
  const flows = (await listFlows(pid)).filter((f) => f.enabled && f.channel === channel && f.steps.length);
  if (!flows.length) return false;
  const sessions = await sget('vh_flow_sessions', {});
  const sess = sessions[pid] && sessions[pid][key];
  const live = sess && Date.now() - (sess.lastTs || 0) < SESSION_TTL ? sess : null;
  const t = normText(text);
  const kw = (f, mode) => f.trigger.type === 'keyword' && f.trigger.keywords.some((k) => mode === 'exact' ? normText(k) === t : (f.trigger.match === 'contains' && t.includes(normText(k))));
  let flow = flows.find((f) => kw(f, 'exact'));
  if (live && live.stopped && !flow) return false; // handed over to a human
  const creds = await vonageCreds(pid); if (!creds) return false;
  if (!flow && live) {
    const f = flows.find((x) => x.id === live.flowId);
    if (f) {
      const ctx = liveCtx(pid, creds, key, live.contactId || contactId, f);
      const next = await resume(ctx, f, live, text, replyId);
      await saveSession(pid, key, next ? Object.assign({ channel, contactId: live.contactId || contactId }, live, next) : null);
      return true;
    }
  }
  if (!flow) flow = flows.find((f) => kw(f, 'contains')) || flows.find((f) => f.trigger.type === 'any');
  if (!flow) return false;
  await startFlow(pid, flow, key, contactId, {});
  return true;
}
// Dry-run context for the builder simulator (nothing is sent or stored)
function simCtx(pid, flow, out) {
  return { pid, creds: { waFrom: 'whatsapp-sender', rcsFrom: 'rcs-agent', smsFrom: 'sms-sender' }, to: '447700900000', contactId: 'sim', stopped: false,
    send: async (payload, step) => out.push(Object.assign({ step: step && step.name, from: payload.from, channel: payload.channel }, describePayload(payload))),
    note: async (text) => out.push({ system: `HubSpot note: ${text}` }), setProperty: async (n, v) => out.push({ system: `Set contact property ${n} = ${v}` }) };
}

// ---- Flows API --------------------------------------------------------------
app.get('/2v/api/flows', async (req, res) => { const pid = String(req.query.portalId || ''); if (!pid) return res.status(400).json({ error: 'portalId required' }); const list = await listFlows(pid); list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)); res.json({ flows: list }); });
app.post('/2v/api/flows', async (req, res) => { try { const b = req.body || {}; const pid = String(b.portalId || ''); if (!pid) return res.status(400).json({ error: 'portalId required' }); const existing = b.id ? await getFlow(pid, b.id) : null; const f = normFlow(b, pid, existing); await putFlow(pid, f); res.json({ ok: true, flow: f }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.delete('/2v/api/flows/:id', async (req, res) => { const pid = String(req.query.portalId || ''); if (!pid) return res.status(400).json({ error: 'portalId required' }); await delFlow(pid, req.params.id); res.json({ ok: true }); });
app.post('/2v/api/flows/:id/start', async (req, res) => {
  try {
    const { portalId, to, contactId, vars } = req.body || {}; const pid = String(portalId || '');
    const flow = await getFlow(pid, req.params.id); if (!flow) return res.status(404).json({ error: 'flow not found' });
    if (!to) return res.status(400).json({ error: 'to required' });
    res.json(await startFlow(pid, flow, String(to).replace(/[^\d]/g, ''), contactId || null, vars || {}));
  } catch (e) { res.status(e.message === 'vonage_not_configured' ? 400 : 500).json({ error: e.message }); }
});
app.post('/2v/api/flows/:id/start-list', async (req, res) => {
  try {
    const { portalId, listId } = req.body || {}; const pid = String(portalId || '');
    const flow = await getFlow(pid, req.params.id); if (!flow) return res.status(404).json({ error: 'flow not found' });
    const m = await hsApi(pid, 'GET', `/crm/v3/lists/${listId}/memberships?limit=100`);
    const ids = ((m.body && m.body.results) || []).map((x) => x.recordId).filter(Boolean);
    const read = ids.length ? await hsApi(pid, 'POST', '/crm/v3/objects/contacts/batch/read', { properties: ['phone', 'mobilephone'], inputs: ids.map((id) => ({ id })) }) : { body: { results: [] } };
    const results = [];
    for (const c of ((read.body && read.body.results) || [])) {
      const phone = String(c.properties.mobilephone || c.properties.phone || '').replace(/[^\d]/g, '');
      if (!phone) { results.push({ contactId: c.id, ok: false, error: 'no phone' }); continue; }
      try { await startFlow(pid, flow, phone, c.id, {}); results.push({ contactId: c.id, to: phone, ok: true }); } catch (e) { results.push({ contactId: c.id, to: phone, ok: false, error: e.message }); }
    }
    res.json({ ok: true, started: results.filter((r) => r.ok).length, total: results.length, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/2v/api/flows/:id/simulate', async (req, res) => {
  try {
    const { portalId, text, reset, flow: draft } = req.body || {}; const pid = String(portalId || '');
    const flow = draft ? normFlow(draft, pid, null) : await getFlow(pid, req.params.id);
    if (!flow || !flow.steps.length) return res.status(400).json({ error: 'flow has no steps' });
    const key = pid + ':' + flow.id; const out = [];
    if (reset) delete simSessions[key];
    const ctx = simCtx(pid, flow, out);
    const vars = { firstname: 'Sam', lastname: 'Taylor', name: 'Sam Taylor', phone: '+447700900000', email: 'sam@example.com', company: 'Example Ltd' };
    let sess = simSessions[key];
    if (sess && text != null) { const next = await resume(ctx, flow, sess, String(text), ''); sess = next ? Object.assign({}, sess, next) : null; }
    else { const r = await advance(ctx, flow, flow.steps[0], vars, 0); sess = r && r.stepId ? Object.assign({ vars }, r) : null; }
    if (sess) simSessions[key] = sess; else delete simSessions[key];
    res.json({ ok: true, messages: out, waiting: !!(sess && sess.stepId), step: sess && sess.stepId ? (stepById(flow, sess.stepId) || {}).name : null, ended: !sess });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/2v/api/flows/sessions', async (req, res) => { const pid = String(req.query.portalId || ''); const s = await sget('vh_flow_sessions', {}); res.json({ sessions: s[pid] || {} }); });
app.delete('/2v/api/flows/sessions', async (req, res) => { const pid = String(req.query.portalId || ''); await flowTx((s) => { if (req.query.phone) { if (s[pid]) delete s[pid][String(req.query.phone).replace(/[^\d]/g, '')]; } else s[pid] = {}; }); res.json({ ok: true }); });
// HubSpot workflow action "Start Vonage flow" (signed like the send actions)
app.post('/2v/api/workflow/flow', async (req, res) => {
  const ev = req.body || {}; const portalId = (ev.origin && ev.origin.portalId) || ev.portalId; const objectId = (ev.object && ev.object.objectId) || ev.objectId; const f = ev.inputFields || ev.fields || {};
  if (!wfSignatureOk(req)) return res.status(401).json({ error: 'bad signature' });
  if (!portalId || !objectId) return res.status(200).json({ outputFields: { hs_execution_state: 'FAIL_PERMANENT', status: 'missing_portal_or_object' } });
  try {
    const want = normText(f.flow || '');
    const flow = (await listFlows(String(portalId))).find((x) => x.id === f.flow || normText(x.name) === want);
    if (!flow) return res.status(200).json({ outputFields: { hs_execution_state: 'FAIL_PERMANENT', status: 'flow_not_found', detail: `No flow named "${f.flow}" in the Vonage flow builder.` } });
    const who = await wfContact(portalId, ev);
    console.log(`[wf flow] object=${objectId} type=${(ev.object && ev.object.objectType) || '?'} via=${who.via} contact=${who.contactId} phone=${who.phone ? 'yes' : 'no'}`);
    const phone = who.phone;
    if (!phone) return res.status(200).json({ outputFields: { hs_execution_state: 'FAIL_PERMANENT', status: 'no_phone_on_contact', detail: who.detail || 'The contact has no phone or mobile number.' } });
    const r = await startFlow(String(portalId), flow, phone, who.contactId, {});
    return res.status(200).json({ outputFields: { hs_execution_state: 'SUCCESS', status: r.waiting ? 'started_waiting_for_reply' : 'started' } });
  } catch (e) {
    if (e.message === 'vonage_not_configured') return res.status(200).json({ outputFields: { hs_execution_state: 'FAIL_PERMANENT', status: 'vonage_not_configured' } });
    console.error('[wf flow]', e.message); return res.status(502).json({ error: e.message });
  }
});
app.get('/2v/flows', (_req, res) => { res.set('Cache-Control', 'no-store'); res.sendFile(path.join(__dirname, 'public', 'flows.html')); });

app.get('/_/health', (req, res) => res.sendStatus(200));
app.get('/_/metrics', (req, res) => res.json({}));
app.get('/', (req, res) => res.json({ ok: true, service: 'vonage-hubspot', multiTenant: true, hsConfigured: !!HS_CLIENT_ID }));
app.get('/2v/health', (req, res) => res.json({ ok: true, multiTenant: true, hsConfigured: !!HS_CLIENT_ID, host: req.headers.host }));

// ---- OAuth -----------------------------------------------------------------
app.get('/2v/oauth/install', (req, res) => {
  const state = req.query.state || req.query.guid || '';
  const url = `https://app.hubspot.com/oauth/authorize?client_id=${encodeURIComponent(HS_CLIENT_ID)}&redirect_uri=${encodeURIComponent(BASE_URL + '/2v/oauth/callback')}&scope=${encodeURIComponent(HS_SCOPES.join(' '))}&optional_scope=${encodeURIComponent(HS_OPTIONAL_SCOPES.join(' '))}${state ? `&state=${encodeURIComponent(state)}` : ''}`;
  res.redirect(url);
});
// Admin: which scopes does the stored token for a portal carry? (scopes only, never the token)
app.get('/2v/api/hs/token-scopes', async (req, res) => {
  if (!process.env.ADMIN_KEY || req.query.adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'bad admin key' });
  try { const t = await refreshToken(String(req.query.portalId)); const m = await (await fetch(`${HS_API}/oauth/v1/access-tokens/${t}`)).json(); res.json({ portalId: m.hub_id, scopes: m.scopes || [], user: m.user ? 'set' : null }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/2v/oauth/callback', async (req, res) => {
  try {
    const code = req.query.code;
    const guid = req.query.state || '';
    const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: HS_CLIENT_ID, client_secret: HS_CLIENT_SECRET, redirect_uri: BASE_URL + '/2v/oauth/callback', code });
    const r = await fetch(`${HS_API}/oauth/v1/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const d = await r.json();
    if (!d.access_token) return res.status(400).send('Token exchange failed: ' + JSON.stringify(d));
    const meta = await (await fetch(`${HS_API}/oauth/v1/access-tokens/${d.access_token}`)).json();
    const portalId = meta.hub_id;
    console.log(`[oauth] portal ${portalId} granted scopes: ${(meta.scopes || []).join(' ')}`);
    await setTokenFor(portalId, { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() + d.expires_in * 1000, hub_id: portalId });
    await addConnected(portalId);
    // Help Desk: if the conversation permissions were ticked on this install, connect WhatsApp automatically
    if ((meta.scopes || []).includes('conversations.custom_channels.write')) {
      const hc = await getHsChannel();
      if (hc.channelId && !(hc.accounts || {})[portalId]) hsChannelConnect(String(portalId)).then((r) => console.log(`[hschannel] auto-connect portal ${portalId}:`, JSON.stringify(r).slice(0, 300))).catch((e) => console.error('[hschannel] auto-connect', e.message));
    }
    // Tie this install back to the invite link and return to its setup page.
    if (guid) {
      const inv = await getInvite(guid);
      if (inv) { inv.portalId = portalId; inv.connectedAt = Date.now(); await putInvite(inv); }
      return res.redirect(`${BASE_URL}/2v/install/${encodeURIComponent(guid)}?connected=1`);
    }
    res.send(`<h2>Connected to HubSpot portal ${portalId}.</h2><p>You can close this window.</p>`);
  } catch (e) { res.status(500).send('OAuth error: ' + e.message); }
});

// ---- Self-serve install: GUID invite link + hosted setup page --------------
app.post('/2v/api/install/new', async (req, res) => {
  const key = (req.body && req.body.adminKey) || req.query.adminKey;
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'bad admin key' });
  const guid = uuid();
  const inv = { guid, label: (req.body && req.body.label) || '', createdAt: Date.now(), portalId: null, connectedAt: null };
  await putInvite(inv);
  res.json({ ok: true, guid, url: `${BASE_URL}/2v/install/${guid}` });
});
app.get('/2v/api/install/:guid', async (req, res) => {
  const inv = await getInvite(req.params.guid);
  if (!inv) return res.status(404).json({ ok: false, error: 'This install link was not recognised.' });
  res.json({ ok: true, guid: inv.guid, label: inv.label || '', connected: !!inv.portalId, portalId: inv.portalId || null, connectedAt: inv.connectedAt || null });
});
app.get('/2v/install/:guid', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'install.html')));
// Public documentation/guide page (same content, no invite required)
app.get(['/2v/guide', '/2v/docs'], (_req, res) => res.sendFile(path.join(__dirname, 'public', 'install.html')));
// Printable WhatsApp guide for the people who send the messages (templates, approval, workflow actions).
app.get(['/2v/guide/whatsapp.pdf', '/2v/whatsapp-guide.pdf'], (_req, res) => res.sendFile(path.join(__dirname, 'public', 'Vonage-HubSpot-WhatsApp-Guide.pdf')));

// HubSpot app webhooks (target of the project's webhooks component).
// Handles GDPR privacy-deletion: when a contact is privacy-deleted in a
// portal, scrub every inbox thread linked to that contact across our state.
app.post('/2v/webhooks/hubspot', async (req, res) => {
  res.sendStatus(200);
  try {
    const events = Array.isArray(req.body) ? req.body : [req.body];
    for (const ev of events) {
      const type = ev && (ev.subscriptionType || ev.type);
      if (type === 'contact.privacyDeletion') {
        const pid = String(ev.portalId || ev.appId && ev.portalId || '');
        const cid = String(ev.objectId || '');
        if (!pid || !cid) continue;
        await inboxTx((ib) => {
          const threads = ib[pid] || {};
          for (const k of Object.keys(threads)) if (String(threads[k].contactId) === cid) delete threads[k];
        });
        console.log(`[gdpr] privacy-deleted contact ${cid} scrubbed from portal ${pid} inbox`);
      }
    }
  } catch (e) { console.error('[hswebhook]', e.message); }
});

// ---- Quick send from the card ---------------------------------------------
app.post('/2v/api/send', async (req, res) => {
  const t0 = Date.now();
  try {
    const { portalId, contactId, channel, to, text } = req.body || {};
    console.log(`[send] in channel=${channel} to=${to} portal=${portalId} contact=${contactId}`);
    if (!to || !text) return res.status(400).json({ error: 'to and text required' });
    const creds = await vonageCreds(portalId);
    if (!creds) return res.status(400).json(NOT_CONFIGURED);
    const r = await vonageSendPayload(creds, messagePayload(creds, channel || 'whatsapp', to, text));
    // Respond to the card immediately; log to the timeline in the background so
    // the HubSpot fetch proxy never waits on the (slower) HubSpot note write.
    res.status(r.ok ? 200 : 502).json(r);
    console.log(`[send] out ok=${r.ok} status=${r.status} ${Date.now() - t0}ms`);
    if (r.ok) {
      recordOutbound(portalId, to, channel || 'whatsapp', 'text', text).catch(() => {});
      if (portalId) logNote(portalId, contactId, `[${(channel || 'whatsapp').toUpperCase()} sent] ${text}`).catch((e) => console.error('[send] logNote failed', e.message));
    }
  } catch (e) { console.error('[send] error', e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// Shape of an approved template as Meta holds it: how many {{n}} placeholders the
// header and body carry, and whether the (name, language) pair is actually APPROVED.
// null when the WABA cannot be read - callers then fall back to the old behaviour.
// Template names on Meta are lowercase with underscores; people type the display
// form ("Spotk Kids"). Compare on letters+digits only so "Spotk Kids", "spotk-kids"
// and "spotk_kids" are the same template.
const waNameKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
// Every template on the portal's WABA, or null when the WABA cannot be read.
async function waTemplateList(creds, portalId) {
  try {
    const c = await ensureWaba(String(portalId), creds);
    if (!c || !c.wabaId) return null;
    const r = await fetch(`https://api.nexmo.com/v2/whatsapp-manager/wabas/${c.wabaId}/templates`, { headers: { Authorization: `Bearer ${appJwt(c)}`, Accept: 'application/json' } });
    if (!r.ok) return null;
    const d = await r.json().catch(() => ({}));
    return d.templates || [];
  } catch { return null; }
}
async function waTemplateShape(creds, portalId, name, lang) {
  try {
    const all = await waTemplateList(creds, portalId);
    if (!all) return null;
    const exact = all.filter((t) => String(t.name).toLowerCase() === String(name).trim().toLowerCase());
    const list = exact.length ? exact : all.filter((t) => waNameKey(t.name) === waNameKey(name));
    if (!list.length) return null;
    const t = list.find((x) => (x.language || '') === lang) || list.find((x) => (x.language || '').split('_')[0] === lang.split('_')[0]) || list[0];
    const comps = t.components || [];
    const count = (txt) => ((txt || '').match(/\{\{\s*\d+\s*\}\}/g) || []).length;
    const header = comps.find((x) => (x.type || '').toUpperCase() === 'HEADER');
    const body = comps.find((x) => (x.type || '').toUpperCase() === 'BODY');
    return { name: t.name, language: t.language, status: t.status, approved: (t.status || '').toUpperCase() === 'APPROVED', headerVars: header && header.text ? count(header.text) : 0, bodyVars: count(body && body.text) };
  } catch { return null; }
}

// ---- Custom workflow actions (HubSpot Automation) --------------------------
// Executions POSTed by HubSpot when a workflow reaches a "... via Vonage"
// action. Registered as `workflow-action` components in the HubSpot project
// (src/app/workflow-actions/). Signature: v1 = sha256(clientSecret + rawBody).
// HubSpot signs workflow-action executions with X-HubSpot-Signature-Version v2:
//   sha256(clientSecret + METHOD + full request URI incl. query string + rawBody), hex.
// (v1 = sha256(secret + body) is only used for the old webhook subscriptions, and
// v3 = base64 HMAC-SHA256(secret, METHOD + URI + body + timestamp) comes with
// X-HubSpot-Signature-v3.) We accept whichever HubSpot sends. The URI must be the
// public one HubSpot called - behind the VCR proxy req.protocol is http, so build
// it from BASE_URL.
function wfSignatureOk(req) {
  try {
    const body = req.rawBody ? req.rawBody.toString('utf8') : '';
    const uri = BASE_URL + req.originalUrl;
    const method = req.method.toUpperCase();
    const v3 = req.get('X-HubSpot-Signature-v3');
    if (v3) {
      const ts = req.get('X-HubSpot-Request-Timestamp') || '';
      if (!ts || Math.abs(Date.now() - Number(ts)) > 5 * 60 * 1000) { console.error('[wf] v3 timestamp out of window'); return false; }
      const expect = crypto.createHmac('sha256', HS_CLIENT_SECRET).update(method + uri + body + ts).digest('base64');
      if (expect.length === v3.length && crypto.timingSafeEqual(Buffer.from(v3), Buffer.from(expect))) return true;
    }
    const sig = req.get('X-HubSpot-Signature');
    if (!sig) { console.error('[wf] no signature header'); return false; }
    const ver = (req.get('X-HubSpot-Signature-Version') || 'v1').toLowerCase();
    const candidates = {
      v2: crypto.createHash('sha256').update(HS_CLIENT_SECRET + method + uri + body).digest('hex'),
      v1: crypto.createHash('sha256').update(HS_CLIENT_SECRET + body).digest('hex'),
    };
    for (const [v, expect] of Object.entries(candidates)) {
      if (expect.length === sig.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return true;
    }
    console.error(`[wf] signature mismatch: header version=${ver} uri=${uri} bodyBytes=${body.length}`);
    return false;
  } catch (e) { console.error('[wf] signature check error', e.message); return false; }
}
app.post('/2v/api/workflow/send', async (req, res) => {
  const channel = ['sms', 'rcs', 'whatsapp'].includes(req.query.channel) ? req.query.channel : 'sms';
  const ev = req.body || {};
  const portalId = (ev.origin && ev.origin.portalId) || ev.portalId;
  const objectId = (ev.object && ev.object.objectId) || ev.objectId;
  const f = ev.inputFields || ev.fields || {};
  console.log(`[wf] exec channel=${channel} portal=${portalId} object=${objectId} wf=${ev.context && ev.context.workflowId}`);
  if (!wfSignatureOk(req)) { console.error('[wf] bad signature'); return res.status(401).json({ error: 'bad signature' }); }
  if (!portalId || !objectId) return res.status(200).json({ outputFields: { hs_execution_state: 'FAIL_PERMANENT', status: 'missing_portal_or_object' } });
  try {
    // record -> contact -> phone (mobile first). A meeting/deal/company/ticket
    // workflow uses the first associated contact that has a phone number.
    const who = await wfContact(portalId, ev);
    console.log(`[wf] object=${objectId} type=${(ev.object && ev.object.objectType) || '?'} via=${who.via} contact=${who.contactId} phone=${who.phone ? 'yes' : 'no'}`);
    const phone = who.phone;
    const contactId = who.contactId;
    if (!phone) return res.status(200).json({ outputFields: { hs_execution_state: 'FAIL_PERMANENT', status: 'no_phone_on_contact', detail: who.detail || 'The contact has no phone or mobile number.' } });
    const creds = await vonageCreds(portalId);
    if (!creds) return res.status(200).json({ outputFields: { hs_execution_state: 'FAIL_PERMANENT', status: 'vonage_not_configured' } });

    let r; let summary;
    if (channel === 'whatsapp') {
      const name = String(f.templateName || '').trim();
      if (!name) return res.status(200).json({ outputFields: { hs_execution_state: 'FAIL_PERMANENT', status: 'template_name_required' } });
      const lang = String(f.language || 'en').trim();
      // keep positions: an EMPTY variable (e.g. a contact property with no value)
      // must not shift the next one into its place - report it instead
      const rawVars = [f.var1, f.var2, f.var3].map((v) => (v == null ? '' : String(v).trim()));
      const vars = rawVars.filter((v) => v !== '');
      // Look the template up on the WABA so the components match what Meta approved:
      // header placeholder (if any) takes the first variable, the body takes the rest.
      // A count mismatch is rejected by Meta asynchronously as 1022 while HubSpot
      // already shows "sent" - so check it here and tell the workflow the truth.
      const shape = await waTemplateShape(creds, portalId, name, lang);
      // Meta rejects (1022) a template sent with a language code it was not approved in,
      // e.g. "pl" typed in the workflow for a template approved as en_US - so once the
      // template is found, send it in the language it actually exists in.
      const sendLang = shape && shape.language ? shape.language : lang;
      console.log(`[wf] template=${name} typedLang=${lang} sendLang=${sendLang} vars=${vars.length} shape=${shape ? JSON.stringify(shape) : 'null (not found on WABA, or WABA not readable)'}`);
      if (!shape) {
        // Sending a name Meta does not know is a guaranteed async 1022 (Meta 132001)
        // after HubSpot was already told "sent" - so when the WABA is readable and the
        // name simply is not there, fail now and say which names exist.
        const all = await waTemplateList(creds, portalId);
        if (all) {
          const names = [...new Set(all.filter((t) => (t.status || '').toUpperCase() === 'APPROVED').map((t) => t.name))];
          return res.status(200).json({ outputFields: { hs_execution_state: 'FAIL_PERMANENT', status: 'template_not_found', detail: `Template "${name}" does not exist on your WhatsApp Business Account. Approved templates: ${names.join(', ') || 'none'}.` } });
        }
      }
      let components = [];
      if (shape) {
        const need = shape.headerVars + shape.bodyVars;
        const where = (i) => (i < shape.headerVars ? 'header' : 'body');
        const firstEmpty = rawVars.slice(0, need).findIndex((v) => v === '');
        const extraFilled = rawVars.slice(need).some((v) => v !== '');
        if (firstEmpty !== -1 && rawVars.some((v) => v !== '') && !extraFilled) {
          return res.status(200).json({ outputFields: { hs_execution_state: 'FAIL_PERMANENT', status: 'template_variable_empty', detail: `Template "${shape.name}" needs ${need} variable(s). Variable ${firstEmpty + 1} (${where(firstEmpty)}) is empty for this contact - check that the contact property it uses has a value.` } });
        }
        if (vars.length !== need) {
          return res.status(200).json({ outputFields: { hs_execution_state: 'FAIL_PERMANENT', status: 'template_variable_mismatch', detail: `Template "${name}" (${shape.language}) expects ${need} variable(s) (${shape.headerVars} in header, ${shape.bodyVars} in body); ${vars.length} given.` } });
        }
        if (!shape.approved) {
          return res.status(200).json({ outputFields: { hs_execution_state: 'FAIL_PERMANENT', status: 'template_not_approved', detail: `Template "${name}" (${shape.language}) is ${shape.status}.` } });
        }
        if (shape.headerVars) components.push({ type: 'HEADER', parameters: vars.slice(0, shape.headerVars).map((v) => ({ type: 'text', text: v })) });
        if (shape.bodyVars) components.push({ type: 'BODY', parameters: vars.slice(shape.headerVars).map((v) => ({ type: 'text', text: v })) });
      } else if (vars.length) {
        components = [{ type: 'BODY', parameters: vars.map((v) => ({ type: 'text', text: v })) }];
      }
      r = await vonageSendPayload(creds, {
        from: creds.waFrom, to: phone, channel: 'whatsapp', message_type: 'custom',
        custom: { type: 'template', template: { name: (shape && shape.name) || name, language: { policy: 'deterministic', code: sendLang }, components } },
      });
      console.log(`[wf] sent template=${name} lang=${sendLang} components=${JSON.stringify(components)} -> ${r.status} ${r.ok ? (r.body && r.body.message_uuid) || '' : JSON.stringify(r.body || {}).slice(0, 200)}`);
      summary = `template "${name}" (${sendLang})`;
    } else {
      const text = String(f.message || '').trim();
      if (!text) return res.status(200).json({ outputFields: { hs_execution_state: 'FAIL_PERMANENT', status: 'message_required' } });
      r = await vonageSendPayload(creds, messagePayload(creds, channel, phone, text));
      summary = text.slice(0, 120);
    }
    console.log(`[wf] send ok=${r.ok} status=${r.status}`);
    if (r.ok) {
      recordOutbound(portalId, phone, channel, 'text', `[workflow] ${summary}`).catch(() => {});
      logNote(portalId, contactId, `[${channel.toUpperCase()} sent by workflow] ${summary}`).catch(() => {});
      return res.status(200).json({ outputFields: { hs_execution_state: 'SUCCESS', status: 'sent', messageUuid: (r.body && r.body.message_uuid) || '' } });
    }
    // 4xx from Vonage = permanent (bad sender/number); 5xx = let HubSpot retry
    if (r.status >= 500) return res.status(502).json({ error: 'vonage_5xx' });
    return res.status(200).json({ outputFields: { hs_execution_state: 'FAIL_PERMANENT', status: `vonage_${r.status}`, detail: JSON.stringify(r.body || {}).slice(0, 300) } });
  } catch (e) {
    console.error('[wf] error', e.message);
    return res.status(502).json({ error: e.message }); // transient -> HubSpot retries
  }
});

// ---- Templates CRUD --------------------------------------------------------
// Admin, read-only: Meta's raw record for one WhatsApp template (status, rejection reason, components)
// Admin: dump / load the whole persisted state (used for host migrations). Keys are the
// known vh_* whole-doc keys; sizes let you see what is big before moving it.
const STATE_KEYS = ['vh_tokens', 'vh_connected', 'vh_vonage', 'vh_invites', 'vh_templates', 'vh_inbox', 'vh_flows', 'vh_flow_sessions', 'vh_optouts', 'vh_media', 'vh_hschannel'];
app.get('/2v/api/admin/state', async (req, res) => {
  if (!process.env.ADMIN_KEY || req.query.adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'bad admin key' });
  const out = {}; const sizes = {};
  for (const k of STATE_KEYS) { const v = await sget(k, null); if (v != null) { out[k] = v; sizes[k] = Buffer.byteLength(JSON.stringify(v)); } }
  if (req.query.sizes) return res.json({ sizes });
  res.json({ sizes, data: out });
});
app.post('/2v/api/admin/state', async (req, res) => {
  const { adminKey, data } = req.body || {};
  if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'bad admin key' });
  const written = [];
  for (const [k, v] of Object.entries(data || {})) { if (STATE_KEYS.includes(k)) { await sset(k, v); written.push(k); } }
  res.json({ ok: true, written });
});
// Admin: re-point a portal's Vonage application webhooks at THIS host (after a hosting
// move). Uses the portal's stored credentials; merge-PUT keeps every other capability.
app.post('/2v/api/admin/rewire', async (req, res) => {
  const { adminKey, portalId } = req.body || {};
  if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'bad admin key' });
  try {
    const pid = String(portalId || ''); const creds = await getVonage(pid);
    if (!creds || !creds.apiKey || !creds.apiSecret || !creds.appId) return res.status(400).json({ error: 'portal has no api key/secret/app stored' });
    const basic = 'Basic ' + Buffer.from(`${creds.apiKey}:${creds.apiSecret}`).toString('base64');
    const r = await fetch(`https://api.nexmo.com/v2/applications/${encodeURIComponent(creds.appId)}`, { headers: { Authorization: basic } });
    if (!r.ok) return res.status(400).json({ error: `application fetch failed (${r.status})` });
    const appDoc = await r.json(); const caps = appDoc.capabilities || {};
    caps.messages = caps.messages || {};
    caps.messages.webhooks = { inbound_url: { address: `${BASE_URL}/2v/webhooks/inbound?portal=${pid}`, http_method: 'POST' }, status_url: { address: `${BASE_URL}/2v/webhooks/status`, http_method: 'POST' } };
    caps.voice = caps.voice || {};
    caps.voice.webhooks = { answer_url: { address: `${BASE_URL}/2v/voice/answer?portal=${pid}`, http_method: 'GET' }, event_url: { address: `${BASE_URL}/2v/voice/events`, http_method: 'POST' } };
    const body = Object.assign({}, appDoc, { capabilities: caps }); delete body._links; delete body.id;
    const put = await fetch(`https://api.nexmo.com/v2/applications/${encodeURIComponent(creds.appId)}`, { method: 'PUT', headers: { Authorization: basic, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const out = await put.json().catch(() => ({}));
    if (!put.ok) return res.status(400).json({ error: `PUT failed (${put.status})`, detail: out });
    creds.webhooksWired = true; await setVonage(pid, creds);
    res.json({ ok: true, appId: creds.appId, inbound: caps.messages.webhooks.inbound_url.address });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/2v/api/admin/wa-template', async (req, res) => {
  if (!process.env.ADMIN_KEY || req.query.adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'bad admin key' });
  try {
    const creds = await ensureWaba(String(req.query.portalId), await vonageCreds(req.query.portalId));
    const r = await fetch(`https://api.nexmo.com/v2/whatsapp-manager/wabas/${creds.wabaId}/templates`, { headers: { Authorization: `Bearer ${appJwt(creds)}`, Accept: 'application/json' } });
    const d = await r.json().catch(() => ({}));
    res.status(r.status).json({ templates: (d.templates || []).filter((t) => waNameKey(t.name) === waNameKey(req.query.name)), raw: d.templates ? undefined : d });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/2v/api/templates', async (req, res) => {
  const { portalId, channel } = req.query;
  if (!portalId) return res.status(400).json({ error: 'portalId required' });
  let list = await listTemplates(portalId);
  // Status comes from Vonage/Meta, not from whatever the last click returned. A
  // template that was created and then re-submitted five times showed "error"
  // while it was already approved - so overlay the live WABA status on every load.
  try {
    const creds = await ensureWaba(String(portalId), await vonageCreds(portalId));
    if (creds && creds.wabaId && list.some((t) => t.channel === 'whatsapp' && t.waName)) {
      const r = await fetch(`https://api.nexmo.com/v2/whatsapp-manager/wabas/${creds.wabaId}/templates`, { headers: { Authorization: `Bearer ${appJwt(creds)}`, Accept: 'application/json' } });
      const d = r.ok ? await r.json().catch(() => ({})) : {};
      const live = {};
      // key by name AND language: Meta keeps one record per language, and an old rejected language must not overwrite the current one
      for (const w of (d.templates || [])) { live[String(w.name).toLowerCase() + '|' + String(w.language || '').toLowerCase()] = w; if (!live[String(w.name).toLowerCase()]) live[String(w.name).toLowerCase()] = w; }
      for (const t of list) {
        const w = t.channel === 'whatsapp' && t.waName ? (live[String(t.waName).toLowerCase() + '|' + String(t.language || 'en_US').toLowerCase()] || live[String(t.waName).toLowerCase()]) : null;
        if (!w) continue;
        const st = String(w.status || '').toLowerCase();
        const reason = w.rejected_reason || w.rejection_reason || (w.quality_score && w.quality_score.reasons ? w.quality_score.reasons.join(', ') : '');
        const next = { status: st, error: st === 'rejected' ? (reason || 'Rejected by Meta') : null };
        if (t.status !== next.status || (t.error || null) !== next.error) { Object.assign(t, next); try { await putTemplate(portalId, t); } catch (e) {} }
      }
    }
  } catch (e) { console.log('[templates] status overlay skipped:', e.message); }
  if (channel) list = list.filter((t) => t.channel === channel);
  list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  res.json({ templates: list });
});
app.post('/2v/api/templates', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.portalId || !b.name || !b.channel) return res.status(400).json({ error: 'portalId, name, channel required' });
    const id = b.id || `${slug(b.name)}_${uuid().slice(0, 8)}`;
    const existing = await getTemplate(b.portalId, id);
    const tpl = {
      id, portalId: b.portalId, name: b.name, channel: b.channel, type: b.type || 'text',
      body: b.body || '', header: b.header || '', footer: b.footer || '', title: b.title || '',
      buttons: b.buttons || [], suggestions: b.suggestions || [], cards: b.cards || [],
      mediaUrl: b.mediaUrl || '', variables: b.variables || [], language: b.language || 'en_US', category: b.category || 'MARKETING',
      waName: b.waName || (existing && existing.waName) || '',
      status: (existing && existing.status) || (b.channel === 'whatsapp' ? 'draft' : 'ready'),
      metaResponse: (existing && existing.metaResponse) || null, createdAt: (existing && existing.createdAt) || Date.now(), updatedAt: Date.now(),
    };
    await putTemplate(b.portalId, tpl);
    res.json({ ok: true, template: tpl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/2v/api/templates/:id', async (req, res) => {
  const portalId = req.query.portalId || (req.body || {}).portalId;
  if (!portalId) return res.status(400).json({ error: 'portalId required' });
  await delTemplate(portalId, req.params.id);
  res.json({ ok: true });
});
app.post('/2v/api/templates/:id/submit', async (req, res) => {
  try {
    const portalId = req.query.portalId || (req.body || {}).portalId;
    const tpl = await getTemplate(portalId, req.params.id);
    if (!tpl) return res.status(404).json({ ok: false, error: 'template not found', message: 'This template no longer exists. Refresh the list and try again.' });
    if (tpl.channel !== 'whatsapp') return res.status(400).json({ ok: false, error: 'only WhatsApp templates require approval', message: 'Only WhatsApp templates need Meta approval.' });
    tpl.waName = tpl.waName || slug(tpl.name);
    if (['submitted', 'pending', 'approved'].includes(String(tpl.status || '').toLowerCase())) return res.json({ ok: true, status: tpl.status, message: 'Already submitted - nothing to do.' });
    // Templates are created through Vonage's WhatsApp Manager with the portal's own
    // app JWT - the same call 2stars has made for months. Going to Meta's Graph API
    // directly needed a Business Management token that customers on a Vonage-managed
    // WABA usually cannot even obtain, so the WABA ID is now the only requirement.
    const pcreds = await ensureWaba(String(portalId || ''), await vonageCreds(portalId));
    if (!pcreds) return res.status(400).json(NOT_CONFIGURED);
    const wabaId = (pcreds.wabaId || '').trim();
    if (!wabaId) {
      tpl.status = 'pending_creds'; tpl.updatedAt = Date.now(); await putTemplate(portalId, tpl);
      return res.json({ ok: false, queued: true, status: tpl.status, message: 'Saved & queued. Add your WhatsApp Business Account ID in the Vonage settings page to submit templates for approval.' });
    }
    // Clean and convert for Meta (see toPositional). The stored body is repaired too.
    tpl.body = cleanTemplateText(fixMojibake(tpl.body)); if (tpl.header) tpl.header = cleanTemplateText(fixMojibake(tpl.header));
    // Header: Meta allows ONE variable in a text header, numbered separately from the body.
    let hdrText = tpl.header || '', hdrExample = null; tpl.waHeaderVar = null;
    if (hdrText && /\{\{/.test(hdrText)) {
      const hOrder = []; hdrText = toPositional(hdrText, hOrder);
      if (hOrder.length > 1) {
        const msg = 'A WhatsApp header can contain only one variable. Keep one {{...}} in the header and move the others to the body.';
        tpl.status = 'error'; tpl.error = msg; tpl.updatedAt = Date.now(); await putTemplate(portalId, tpl);
        return res.status(400).json({ ok: false, error: msg, message: msg });
      }
      tpl.waHeaderVar = hOrder[0]; hdrExample = exampleFor(hOrder[0]);
    }
    const order = []; let waBody = toPositional(tpl.body, order);
    if (/\{\{\d+\}\}\s*$/.test(waBody)) waBody += '.';           // Meta: a body may not end with a variable
    if (/^\s*\{\{\d+\}\}/.test(waBody)) waBody = '- ' + waBody;   // ...or start with one
    tpl.waVarOrder = order;
    let lang = tpl.language || 'en_US';
    if (/^en/i.test(lang) && POLISH.test(tpl.body)) { console.log(`[tpl] ${tpl.id}: Polish text marked ${lang}, submitting as pl`); lang = 'pl'; tpl.language = 'pl'; }
    const bodyComp = { type: 'BODY', text: waBody };
    if (order.length) bodyComp.example = { body_text: [order.map(exampleFor)] };
    const components = [bodyComp];
    const mediaFmt = { image: 'IMAGE', video: 'VIDEO', file: 'DOCUMENT' }[tpl.type];
    if (mediaFmt && tpl.mediaUrl) components.unshift({ type: 'HEADER', format: mediaFmt, example: { header_handle: [await waUploadHandle(pcreds, mediaUrl(tpl.mediaUrl))] } });
    else if (hdrText) components.unshift(Object.assign({ type: 'HEADER', format: 'TEXT', text: hdrText }, hdrExample ? { example: { header_text: [hdrExample] } } : {}));
    if (tpl.footer) components.push({ type: 'FOOTER', text: tpl.footer });
    if (tpl.buttons && tpl.buttons.length) {
      const buttons = tpl.buttons.map((b) => b.type === 'url' ? { type: 'URL', text: b.text, url: b.value }
        : b.type === 'phone' ? { type: 'PHONE_NUMBER', text: b.text, phone_number: b.value }
        : { type: 'QUICK_REPLY', text: b.text });
      components.push({ type: 'BUTTONS', buttons });
    }
    // A rejected or failed template is resubmitted under a new name (Meta keeps the old one).
    if (['rejected', 'error'].includes(String(tpl.status || '').toLowerCase())) tpl.waName = slug(tpl.name) + '_' + Date.now().toString(36).slice(-4);
    const payload = { name: tpl.waName, language: lang, category: (tpl.category || 'MARKETING').toUpperCase(), parameter_format: 'POSITIONAL', components };
    const r = await fetch(`https://api.nexmo.com/v2/whatsapp-manager/wabas/${wabaId}/templates`, { method: 'POST', headers: { Authorization: `Bearer ${appJwt(pcreds)}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload) });
    let d = await r.json().catch(() => ({}));
    console.log(`[tpl] submit ${tpl.id} as ${payload.name} (${payload.language}) vars=${order.length} -> ${r.status} ${JSON.stringify(d).slice(0, 300)}`);
    if (!r.ok && /already exists/i.test((d && (d.title + ' ' + d.detail)) || '') && !tpl.submittedAt) {
      // a template with this name already exists on the account and it is not this one
      payload.name = tpl.waName = slug(tpl.name) + '_' + Date.now().toString(36).slice(-4);
      const r2 = await fetch(`https://api.nexmo.com/v2/whatsapp-manager/wabas/${wabaId}/templates`, { method: 'POST', headers: { Authorization: `Bearer ${appJwt(pcreds)}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload) });
      d = await r2.json().catch(() => ({}));
      console.log(`[tpl] retry ${tpl.id} as ${payload.name} -> ${r2.status} ${JSON.stringify(d).slice(0, 300)}`);
      if (r2.ok) { tpl.status = 'submitted'; tpl.error = null; tpl.submittedAt = Date.now(); tpl.metaResponse = d; tpl.updatedAt = Date.now(); await putTemplate(portalId, tpl); return res.json({ ok: true, status: tpl.status, message: `Submitted to Meta as "${payload.name}" (the original name was already taken on your WhatsApp account).`, body: d }); }
    }
    // "Already exists" means an earlier click created it - that is a success, not an
    // error. Keep the human-readable reason on the template so the card can show it.
    const already = !r.ok && /already exists/i.test((d && (d.title + ' ' + d.detail)) || '');
    const okNow = r.ok || already;
    tpl.status = okNow ? 'submitted' : 'error';
    tpl.error = okNow ? null : [d && d.title, d && d.detail].filter(Boolean).join(' - ') || ('Vonage returned ' + r.status);
    tpl.metaResponse = d; tpl.updatedAt = Date.now(); if (okNow) tpl.submittedAt = tpl.submittedAt || Date.now(); await putTemplate(portalId, tpl);
    res.status(okNow ? 200 : 502).json({ ok: okNow, status: tpl.status, error: tpl.error, message: already ? 'Already submitted - it is with Meta for review.' : (okNow ? 'Submitted to Meta for review.' : tpl.error), body: d });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Real WhatsApp templates (live from Vonage WhatsApp Manager / Meta) -----
// These are the portal's actual approved WABA templates, read with the portal's own app JWT
// app JWT (the app the number is linked to). Summarised for the card picker.
function summariseWaTemplate(t) {
  const comps = t.components || [];
  const body = comps.find((c) => (c.type || '').toUpperCase() === 'BODY');
  const header = comps.find((c) => (c.type || '').toUpperCase() === 'HEADER');
  const bodyText = (body && body.text) || '';
  const varCount = (bodyText.match(/\{\{\s*\d+\s*\}\}/g) || []).length;
  const headerFormat = header && (header.format || (header.text ? 'TEXT' : ''));
  return {
    name: t.name, language: t.language || 'en', status: t.status, category: t.category,
    bodyText, varCount, headerFormat: headerFormat || '', hasMediaHeader: !!headerFormat && headerFormat !== 'TEXT',
  };
}
// Delete a template from the WhatsApp Business Account itself. Permanent: Meta
// removes every language of that name, and it needs re-approval to come back.
// Vonage accepts the query form (probed 7 Oct: the path form answers
// "Either name or hsm_ids must be provided").
app.delete('/2v/api/wa/templates', async (req, res) => {
  try {
    const pid = String(req.query.portalId || ''); const name = String(req.query.name || '').trim();
    if (!pid || !name) return res.status(400).json({ ok: false, error: 'portalId and name required' });
    const creds = await ensureWaba(pid, await vonageCreds(pid));
    if (!creds) return res.status(400).json(NOT_CONFIGURED);
    if (!creds.wabaId) return res.status(400).json({ ok: false, error: 'No WhatsApp Business Account found for this portal.' });
    const r = await fetch(`https://api.nexmo.com/v2/whatsapp-manager/wabas/${creds.wabaId}/templates?name=${encodeURIComponent(name)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${appJwt(creds)}`, Accept: 'application/json' } });
    const t = await r.text(); let d = {}; try { d = JSON.parse(t); } catch (e) {}
    if (!r.ok) return res.status(r.status).json({ ok: false, error: d.detail || d.title || `status ${r.status}` });
    // the tool's own copy, if it was submitted under this name, is a draft again
    try { for (const tpl of await listTemplates(pid)) { if (tpl.channel === 'whatsapp' && String(tpl.waName || '').toLowerCase() === name.toLowerCase()) { tpl.status = 'draft'; tpl.error = null; tpl.updatedAt = Date.now(); await putTemplate(pid, tpl); } } } catch (e) {}
    res.json({ ok: true, name });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/2v/api/wa/templates', async (req, res) => {
  try {
    const creds = await ensureWaba(String(req.query.portalId || ''), await vonageCreds(req.query.portalId));
    if (!creds) return res.status(400).json(NOT_CONFIGURED);
    if (!creds.wabaId) return res.status(400).json({ ok: false, error: 'No WhatsApp Business Account found for ' + (creds.waFrom || 'your WhatsApp number') + '. Check the number in the Vonage settings page belongs to this Vonage account.' });
    const r = await fetch(`https://api.nexmo.com/v2/whatsapp-manager/wabas/${creds.wabaId}/templates`, { headers: { Authorization: `Bearer ${appJwt(creds)}`, Accept: 'application/json' } });
    const d = await r.json().catch(() => ({}));
    if (r.status === 401) return res.status(401).json({ ok: false, error: `Vonage refused: the Application ID in Settings (${creds.appId}) is not the application your WhatsApp number ${creds.waFrom} is linked to. Use that application's ID and private key.`, body: d });
    if (!r.ok) return res.status(r.status).json({ ok: false, error: (d && (d.title || d.detail)) || `status ${r.status}`, body: d });
    const all = (d.templates || []).map(summariseWaTemplate);
    const templates = all.filter((t) => (t.status || '').toUpperCase() === 'APPROVED');
    // `all` carries every status (pending / rejected too) so the Templates card can show the real WABA list
    res.json({ ok: true, templates, total: all.length, all, raw: req.query.raw ? d.templates : undefined });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// Send a real WhatsApp template by name from the portal's WABA number.
app.post('/2v/api/wa/send-template', async (req, res) => {
  try {
    const { portalId, contactId, to, name, language, bodyParams } = req.body || {};
    if (!to || !name) return res.status(400).json({ error: 'to and name required' });
    const creds = await vonageCreds(portalId);
    if (!creds) return res.status(400).json(NOT_CONFIGURED);
    const components = [];
    if (Array.isArray(bodyParams) && bodyParams.length) {
      components.push({ type: 'BODY', parameters: bodyParams.map((v) => ({ type: 'text', text: String(v) })) });
    }
    const payload = {
      from: creds.waFrom, to: String(to).replace(/[^\d]/g, ''), channel: 'whatsapp', message_type: 'custom',
      custom: { type: 'template', template: { name, language: { policy: 'deterministic', code: language || 'en' }, components } },
    };
    const r = await fetch('https://api.nexmo.com/v1/messages', { method: 'POST', headers: { Authorization: `Bearer ${appJwt(creds)}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload) });
    const d = await r.json().catch(() => ({}));
    res.status(r.ok ? 200 : r.status).json({ ok: r.ok, status: r.status, body: d });
    if (r.ok) {
      recordOutbound(portalId, to, 'whatsapp', 'template', `Template: ${name}`).catch(() => {});
      if (portalId) logNote(portalId, contactId, `[WHATSAPP sent] template "${name}"`).catch((e) => console.error('[wa] logNote', e.message));
    }
  } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// ---- HubSpot lists / audiences --------------------------------------------
app.get('/2v/api/hs/lists', async (req, res) => {
  try {
    const r = await hsApi(req.query.portalId, 'POST', '/crm/v3/lists/search', { query: '', count: 100, offset: 0 });
    const lists = ((r.body && r.body.lists) || []).map((l) => ({ id: l.listId, name: l.name, size: l.additionalProperties && l.additionalProperties.hs_list_size }));
    res.status(r.ok ? 200 : r.status).json({ ok: r.ok, lists, raw: r.ok ? undefined : r.body });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/2v/api/hs/lists/:listId/members', async (req, res) => {
  try {
    const portalId = req.query.portalId;
    const m = await hsApi(portalId, 'GET', `/crm/v3/lists/${req.params.listId}/memberships?limit=100`);
    const ids = ((m.body && m.body.results) || []).map((x) => x.recordId).filter(Boolean);
    if (!ids.length) return res.json({ ok: true, members: [] });
    const read = await hsApi(portalId, 'POST', '/crm/v3/objects/contacts/batch/read', { properties: ['phone', 'mobilephone', 'firstname', 'lastname'], inputs: ids.map((id) => ({ id })) });
    const members = ((read.body && read.body.results) || []).map((c) => ({ contactId: c.id, name: [c.properties.firstname, c.properties.lastname].filter(Boolean).join(' '), phone: c.properties.mobilephone || c.properties.phone || '' }));
    res.json({ ok: true, members });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/2v/api/hs/contacts-with-phone', async (req, res) => {
  try {
    const r = await hsApi(req.query.portalId, 'POST', '/crm/v3/objects/contacts/search', { filterGroups: [{ filters: [{ propertyName: 'phone', operator: 'HAS_PROPERTY' }] }, { filters: [{ propertyName: 'mobilephone', operator: 'HAS_PROPERTY' }] }], properties: ['phone', 'mobilephone', 'firstname', 'lastname'], limit: 100 });
    const members = ((r.body && r.body.results) || []).map((c) => ({ contactId: c.id, name: [c.properties.firstname, c.properties.lastname].filter(Boolean).join(' '), phone: c.properties.mobilephone || c.properties.phone || '' }));
    res.json({ ok: r.ok, members });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Bulk campaign send + calls -------------------------------------------
app.post('/2v/api/campaign/send', async (req, res) => {
  try {
    const { portalId, templateId, channel, text, recipients } = req.body || {};
    if (!Array.isArray(recipients) || !recipients.length) return res.status(400).json({ error: 'recipients[] required' });
    const creds = await vonageCreds(portalId);
    if (!creds) return res.status(400).json(NOT_CONFIGURED);
    const tpl = templateId ? await getTemplate(portalId, templateId) : null;
    const results = [];
    for (const rcp of recipients) {
      if (!rcp.to) { results.push({ to: rcp.to, ok: false, error: 'no number' }); continue; }
      const payload = tpl ? buildFromTemplate(creds, tpl, rcp.to, rcp.vars || {}) : messagePayload(creds, channel || 'sms', rcp.to, fillVars(text || '', rcp.vars || {}));
      const out = await vonageSendPayload(creds, payload);
      if (out.ok && portalId && rcp.contactId) await logNote(portalId, rcp.contactId, `[${(payload.channel || channel).toUpperCase()} sent] ${tpl ? `template "${tpl.name}"` : (text || '')}`).catch(() => {});
      results.push({ to: rcp.to, ok: out.ok, status: out.status, error: out.ok ? undefined : (out.body && (out.body.title || out.body.detail)) });
    }
    res.json({ ok: true, sent: results.filter((r) => r.ok).length, total: results.length, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Blast a real approved WhatsApp template to a list. Each param may contain the
// token {{firstname}}, replaced per recipient; other values are static.
app.post('/2v/api/campaign/wa-template', async (req, res) => {
  try {
    const { portalId, recipients, name, language, params } = req.body || {};
    if (!Array.isArray(recipients) || !recipients.length) return res.status(400).json({ error: 'recipients[] required' });
    if (!name) return res.status(400).json({ error: 'name required' });
    const creds = await vonageCreds(portalId);
    if (!creds) return res.status(400).json(NOT_CONFIGURED);
    const results = [];
    for (const rcp of recipients) {
      if (!rcp.to) { results.push({ to: rcp.to, ok: false, error: 'no number' }); continue; }
      const fn = rcp.firstname || (rcp.name || '').split(' ')[0] || '';
      const bodyParams = (params || []).map((p) => String(p).replace(/\{\{\s*firstname\s*\}\}/gi, fn));
      const components = bodyParams.length ? [{ type: 'BODY', parameters: bodyParams.map((v) => ({ type: 'text', text: String(v) })) }] : [];
      const payload = { from: creds.waFrom, to: String(rcp.to).replace(/[^\d]/g, ''), channel: 'whatsapp', message_type: 'custom', custom: { type: 'template', template: { name, language: { policy: 'deterministic', code: language || 'en' }, components } } };
      const r = await fetch('https://api.nexmo.com/v1/messages', { method: 'POST', headers: { Authorization: `Bearer ${appJwt(creds)}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload) });
      const d = await r.json().catch(() => ({}));
      if (r.ok && portalId && rcp.contactId) logNote(portalId, rcp.contactId, `[WHATSAPP sent] template "${name}"`).catch(() => {});
      results.push({ to: rcp.to, ok: r.ok, status: r.status, error: r.ok ? undefined : (d && (d.title || d.detail)) });
    }
    res.json({ ok: true, sent: results.filter((x) => x.ok).length, total: results.length, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/2v/api/call', async (req, res) => {
  try {
    const { portalId, contactId, to } = req.body || {};
    if (!to) return res.status(400).json({ error: 'to required' });
    const creds = await vonageCreds(portalId);
    if (!creds) return res.status(400).json(NOT_CONFIGURED);
    const out = await placeCall(creds, to);
    if (out.ok && portalId && contactId) await logNote(portalId, contactId, `[CALL placed] ${to}`).catch(() => {});
    res.status(out.ok ? 200 : 502).json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/2v/api/campaign/call', async (req, res) => {
  try {
    const { portalId, recipients } = req.body || {};
    if (!Array.isArray(recipients) || !recipients.length) return res.status(400).json({ error: 'recipients[] required' });
    const creds = await vonageCreds(portalId);
    if (!creds) return res.status(400).json(NOT_CONFIGURED);
    const results = [];
    for (const rcp of recipients) {
      const out = await placeCall(creds, rcp.to);
      if (out.ok && portalId && rcp.contactId) await logNote(portalId, rcp.contactId, `[CALL placed] ${rcp.to}`).catch(() => {});
      results.push({ to: rcp.to, ok: out.ok, status: out.status, error: out.ok ? undefined : (out.body && (out.body.title || out.body.detail)) });
    }
    res.json({ ok: true, placed: results.filter((r) => r.ok).length, total: results.length, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/2v/api/portals', async (req, res) => { const c = await getConnected(); res.json({ portals: c.ids || [] }); });

// Resolve a record's phone + name (works for contacts AND leads/other objects
// by following the association to the primary contact when needed).
app.get('/2v/api/hs/resolve', async (req, res) => {
  try {
    const { portalId, objectType, objectId } = req.query;
    const isContact = ['0-1', 'contacts', 'contact'].includes(String(objectType));
    if (isContact) {
      const r = await hsApi(portalId, 'GET', `/crm/v3/objects/contacts/${objectId}?properties=phone,mobilephone,firstname,lastname`);
      const p = (r.body && r.body.properties) || {};
      return res.json({ phone: p.mobilephone || p.phone || '', name: [p.firstname, p.lastname].filter(Boolean).join(' '), contactId: objectId });
    }
    const own = await hsApi(portalId, 'GET', `/crm/v3/objects/${objectType}/${objectId}?properties=phone,mobilephone,firstname,lastname,hs_lead_name`);
    const op = (own.body && own.body.properties) || {};
    let phone = op.mobilephone || op.phone || '';
    let name = op.hs_lead_name || [op.firstname, op.lastname].filter(Boolean).join(' ');
    let contactId = null;
    if (!phone) {
      const assoc = await hsApi(portalId, 'GET', `/crm/v3/objects/${objectType}/${objectId}/associations/contacts`);
      const cid = ((assoc.body && assoc.body.results) || [])[0];
      const toId = cid && (cid.toObjectId || cid.id);
      if (toId) {
        contactId = toId;
        const c = await hsApi(portalId, 'GET', `/crm/v3/objects/contacts/${toId}?properties=phone,mobilephone,firstname,lastname`);
        const cp = (c.body && c.body.properties) || {};
        phone = cp.mobilephone || cp.phone || '';
        name = name || [cp.firstname, cp.lastname].filter(Boolean).join(' ');
      }
    }
    res.json({ phone, name, contactId: contactId || objectId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Media hosting (upload to VCR state, served publicly for Vonage) -------
const allMedia = async () => sget('vh_media', {});
app.post('/2v/api/media', async (req, res) => {
  try {
    const { contentType, dataBase64, filename } = req.body || {};
    if (!dataBase64) return res.status(400).json({ error: 'dataBase64 required' });
    const id = uuid().replace(/-/g, '').slice(0, 16);
    const m = await allMedia(); m[id] = { contentType: contentType || 'application/octet-stream', b64: dataBase64, filename: filename || id }; await sset('vh_media', m);
    res.json({ ok: true, id, url: `${BASE_URL}/2v/media/${id}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/2v/media/:id', async (req, res) => {
  const m = await allMedia(); const item = m[req.params.id];
  if (!item) return res.sendStatus(404);
  res.set('Content-Type', item.contentType).set('Cache-Control', 'public, max-age=86400').send(Buffer.from(item.b64, 'base64'));
});

// ---- Preview the exact Vonage payload a template would send ----------------
app.post('/2v/api/preview', async (req, res) => {
  try {
    const { portalId, templateId, template, to, vars } = req.body || {};
    const tpl = template || (templateId ? await getTemplate(portalId, templateId) : null);
    if (!tpl) return res.status(400).json({ error: 'template or templateId required' });
    // Preview works without creds - senders show as placeholders until configured
    const creds = (await vonageCreds(portalId)) || { waFrom: '<your WhatsApp number>', rcsFrom: '<your RCS sender>', smsFrom: '<your SMS sender>' };
    res.json({ ok: true, payload: buildPayload(creds, tpl, to || '447700900000', vars || {}) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Ad-hoc rich send (inline template object, no save needed) -------------
app.post('/2v/api/send-rich', async (req, res) => {
  try {
    const { portalId, contactId, template, to, vars } = req.body || {};
    if (!template || !to) return res.status(400).json({ error: 'template and to required' });
    const creds = await vonageCreds(portalId);
    if (!creds) return res.status(400).json(NOT_CONFIGURED);
    const out = await vonageSendPayload(creds, buildPayload(creds, template, to, vars || {}));
    if (out.ok) {
      recordOutbound(portalId, to, template.channel || 'sms', template.type || 'text', fillVars(template.body, vars || {}), mediaUrl(template.mediaUrl)).catch(() => {});
      if (portalId && contactId) logNote(portalId, contactId, `[${(template.channel || '').toUpperCase()} ${template.type || 'text'} sent]`).catch(() => {});
    }
    res.status(out.ok ? 200 : 502).json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Unified inbox: conversations, thread, mark-read ----------------------
app.get('/2v/api/inbox/conversations', async (req, res) => {
  try {
    const { portalId, channel } = req.query;
    if (!portalId) return res.status(400).json({ error: 'portalId required' });
    const inbox = await getInbox();
    let list = Object.values(inbox[portalId] || {}).map((t) => ({
      phone: t.phone, name: t.name || '', contactId: t.contactId || null,
      lastText: t.lastText || '', lastTs: t.lastTs || 0, lastChannel: t.lastChannel || '',
      channels: Object.keys(t.channels || {}), unread: t.unread || 0, count: (t.messages || []).length,
    }));
    if (channel) list = list.filter((t) => t.channels.includes(channel));
    list.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
    res.json({ ok: true, conversations: list, unreadTotal: list.reduce((s, t) => s + (t.unread || 0), 0) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/2v/api/inbox/thread', async (req, res) => {
  try {
    const { portalId, phone } = req.query;
    if (!portalId || !phone) return res.status(400).json({ error: 'portalId and phone required' });
    const key = digitsOnly(phone);
    const inbox = await getInbox();
    const th = (inbox[portalId] || {})[key];
    if (!th) return res.json({ ok: true, phone: '+' + key, name: '', contactId: null, channels: [], messages: [] });
    if (th.unread) inboxTx((ib) => { if ((ib[portalId] || {})[key]) ib[portalId][key].unread = 0; }).catch(() => {}); // opening = read
    res.json({ ok: true, phone: th.phone, name: th.name || '', contactId: th.contactId || null, channels: Object.keys(th.channels || {}), messages: th.messages || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/2v/api/inbox/read', async (req, res) => {
  try {
    const { portalId, phone } = req.body || {};
    const key = digitsOnly(phone);
    await inboxTx((ib) => { if ((ib[portalId] || {})[key]) ib[portalId][key].unread = 0; });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/2v/api/inbox/delete', async (req, res) => {
  try {
    const { portalId, phone } = req.body || {};
    const key = digitsOnly(phone);
    await inboxTx((ib) => { if (ib[portalId]) delete ib[portalId][key]; });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Per-portal Vonage account settings ------------------------------------
const maskTail = (s) => (s ? '••••' + String(s).slice(-4) : '');
function sanitizeCreds(c) {
  if (!c) return null;
  return {
    apiKey: c.apiKey || '', apiSecretMasked: maskTail(c.apiSecret), appId: c.appId || '',
    privateKeyLoaded: !!c.privateKey, waFrom: c.waFrom || '', rcsFrom: c.rcsFrom || '',
    smsFrom: c.smsFrom || '', voiceFrom: c.voiceFrom || '', wabaId: c.wabaId || '',
    wabaTokenMasked: maskTail(c.wabaToken), webhooksWired: !!c.webhooksWired,
    verifiedAt: c.verifiedAt || null, updatedAt: c.updatedAt || null,
  };
}
app.get('/2v/api/vonage/settings', async (req, res) => {
  const pid = req.query.portalId;
  if (!pid) return res.status(400).json({ error: 'portalId required' });
  res.json({ ok: true, configured: !!(await vonageCreds(pid)), settings: sanitizeCreds(await getVonage(String(pid))) });
});
app.delete('/2v/api/vonage/settings', async (req, res) => {
  const pid = req.query.portalId || (req.body || {}).portalId;
  if (!pid) return res.status(400).json({ error: 'portalId required' });
  await delVonage(String(pid));
  res.json({ ok: true });
});
// Save + verify + auto-wire. Verification is real: we mint a JWT with their
// key, and fetch their application with their api key/secret. If autoWire
// (default true) we point the app's messages + voice webhooks at this service
// tagged with their portal id, preserving all other capabilities.
app.post('/2v/api/vonage/settings', async (req, res) => {
  try {
    const b = req.body || {};
    const pid = String(b.portalId || '');
    if (!pid) return res.status(400).json({ error: 'portalId required' });
    const prev = (await getVonage(pid)) || {};
    const creds = {
      apiKey: (b.apiKey != null ? b.apiKey : prev.apiKey || '').trim(),
      apiSecret: (b.apiSecret != null && b.apiSecret !== '' ? b.apiSecret : prev.apiSecret || ''),
      appId: (b.appId != null ? b.appId : prev.appId || '').trim(),
      privateKey: (b.privateKey ? String(b.privateKey).replace(/\\n/g, '\n') : prev.privateKey || ''),
      waFrom: String(b.waFrom != null ? b.waFrom : prev.waFrom || '').replace(/[^\d]/g, ''),
      rcsFrom: (b.rcsFrom != null ? b.rcsFrom : prev.rcsFrom || '').trim(),
      smsFrom: (b.smsFrom != null ? b.smsFrom : prev.smsFrom || '').trim(),
      voiceFrom: String(b.voiceFrom != null ? b.voiceFrom : prev.voiceFrom || '').replace(/[^\d]/g, ''),
      wabaId: (b.wabaId != null ? b.wabaId : prev.wabaId || '').trim(),
      wabaToken: (b.wabaToken != null && b.wabaToken !== '' ? b.wabaToken : prev.wabaToken || ''),
      webhooksWired: prev.webhooksWired || false, verifiedAt: prev.verifiedAt || null, updatedAt: Date.now(),
    };
    if (!creds.appId || !creds.privateKey) return res.status(400).json({ error: 'Application ID and private key are required' });
    if (!creds.waFrom && !creds.rcsFrom && !creds.smsFrom && !creds.voiceFrom) return res.status(400).json({ error: 'Configure at least one sender (WhatsApp number, RCS sender, SMS sender or voice number)' });

    // 1) private key must actually sign a JWT for this app
    try { appJwt(creds); } catch (e) { return res.status(400).json({ error: 'Private key rejected: ' + e.message }); }

    // 2) verify api key/secret + app ownership; needed for webhook auto-wiring
    let appDoc = null;
    if (creds.apiKey && creds.apiSecret) {
      const basic = 'Basic ' + Buffer.from(`${creds.apiKey}:${creds.apiSecret}`).toString('base64');
      const r = await fetch(`https://api.nexmo.com/v2/applications/${encodeURIComponent(creds.appId)}`, { headers: { Authorization: basic } });
      if (r.status === 401) return res.status(400).json({ error: 'Vonage API key/secret rejected (401)' });
      if (r.status === 404) return res.status(400).json({ error: `Application ${creds.appId} not found on API key ${creds.apiKey}` });
      if (!r.ok) return res.status(400).json({ error: `Vonage application check failed (${r.status})` });
      appDoc = await r.json();
    }

    // 2b) WhatsApp: fill the WABA id from Vonage and check the number is linked to THIS app
    let waWarning = null, wabaResolved = false;
    if (creds.waFrom && creds.apiKey && creds.apiSecret) {
      const info = await resolveWaba(creds);
      if (info) {
        if (info.wabaId && info.wabaId !== creds.wabaId) { creds.wabaId = info.wabaId; wabaResolved = true; }
        if (info.apps.length && !info.apps.includes(creds.appId)) {
          waWarning = `WhatsApp number ${creds.waFrom} is linked to application ${info.apps.join(', ')}, not to ${creds.appId}. WhatsApp sends and templates will fail until it is linked to this application (Vonage dashboard: Applications > this app > Link external accounts).`;
        }
      } else {
        waWarning = `WhatsApp number ${creds.waFrom} was not found on API key ${creds.apiKey}. Check the number belongs to this Vonage account.`;
      }
    }

    // 3) auto-wire the app's webhooks to this service (tagged with the portal)
    const autoWire = b.autoWire !== false;
    let wired = false, wireError = null;
    if (autoWire && appDoc) {
      try {
        const basic = 'Basic ' + Buffer.from(`${creds.apiKey}:${creds.apiSecret}`).toString('base64');
        const caps = appDoc.capabilities || {};
        caps.messages = caps.messages || {};
        caps.messages.webhooks = {
          inbound_url: { address: `${BASE_URL}/2v/webhooks/inbound?portal=${pid}`, http_method: 'POST' },
          status_url: { address: `${BASE_URL}/2v/webhooks/status`, http_method: 'POST' },
        };
        caps.voice = caps.voice || {};
        caps.voice.webhooks = {
          answer_url: { address: `${BASE_URL}/2v/voice/answer?portal=${pid}`, http_method: 'GET' },
          event_url: { address: `${BASE_URL}/2v/voice/events`, http_method: 'POST' },
        };
        const put = await fetch(`https://api.nexmo.com/v2/applications/${encodeURIComponent(creds.appId)}`, {
          method: 'PUT', headers: { Authorization: basic, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: appDoc.name, capabilities: caps, privacy: appDoc.privacy }),
        });
        wired = put.ok;
        if (!put.ok) wireError = `webhook wiring failed (${put.status})`;
      } catch (e) { wireError = e.message; }
    }
    creds.webhooksWired = wired || creds.webhooksWired;
    creds.verifiedAt = appDoc ? Date.now() : creds.verifiedAt;
    await setVonage(pid, creds);
    console.log(`[vonage-settings] saved for portal ${pid} app=${creds.appId} verified=${!!appDoc} wired=${wired}`);
    res.json({ ok: true, waWarning, wabaResolved, verified: !!appDoc, appName: appDoc ? appDoc.name : null, webhooksWired: wired, wireError, settings: sanitizeCreds(creds) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Vonage inbound / status / voice webhooks -----------------------------
// Each portal's own Vonage application webhooks at
//   {BASE_URL}/2v/webhooks/inbound?portal={portalId}
// (wired automatically when they save their settings). An inbound is delivered
// ONLY to the owning portal: the ?portal= tag first, else matched by the
// receiving number/sender against each portal's configured senders. Never
// broadcast - portals are paying customers on their own accounts.
async function portalForInbound(m, hinted) {
  if (hinted) return String(hinted);
  const toRaw = m.to && (m.to.number || m.to.id || m.to);
  const to = String(toRaw || '').replace(/[^\d]/g, '') || String(toRaw || '').toLowerCase();
  if (!to) return null;
  const all = await allVonage();
  for (const [pid, c] of Object.entries(all)) {
    if (allSendersOf(c).includes(to)) return pid;
  }
  return null;
}
async function handleInbound(m, hintedPortal) {
  const from = m.from && (m.from.number || m.from.id || m.from);
  if (!from) return;
  const pid = await portalForInbound(m, hintedPortal);
  if (!pid) { console.log('[inbound] no portal matched for to=', JSON.stringify(m.to)); return; }
  const channel = m.channel || 'whatsapp';
  const mtype = m.message_type || 'text';
  const replyObj = m.reply || m.button || (m.message && m.message.content && m.message.content.reply) || null;
  const replyId = replyObj ? String(replyObj.id || replyObj.payload || '') : '';
  const text = m.text || (replyObj && (replyObj.title || replyObj.text || replyObj.id)) || (m[mtype] && m[mtype].caption) || (m.message && m.message.content && m.message.content.text) || '';
  const media = (m.image && m.image.url) || (m.video && m.video.url) || (m.file && m.file.url) || (m.audio && m.audio.url) || '';
  const profileName = (m.profile && m.profile.name) || (m.from && m.from.name) || '';
  const ts = m.timestamp ? (Date.parse(m.timestamp) || Date.now()) : Date.now();
  let name = profileName, contactId = null;
  try { const c = await findContactByPhone(pid, from); if (c) { contactId = c.id; name = [c.properties.firstname, c.properties.lastname].filter(Boolean).join(' ') || profileName; } } catch (e) {}
  const isButton = !!replyObj;
  await recordMessage(pid, from, { channel, type: isButton ? 'button' : mtype, text, media, ts }, { name, contactId, incoming: true });
  if (contactId) logNote(pid, contactId, isButton
    ? `[${channel.toUpperCase()} button clicked] "${text}"${replyId && replyId !== text ? ` (value: ${replyId})` : ''}`
    : `[${channel.toUpperCase()} received] ${text || '[' + mtype + ']'}`).catch(() => {});
  // Help Desk / Inbox: publish into the HubSpot conversation when a custom channel account is connected
  hsChannelPublishIncoming(pid, channel, from, name, text, media, m.message_uuid, ts).catch((e) => console.error('[hschannel] publish', e.message));
  // Opt-out / opt-in keywords (typed, or a button whose label or value is one of them)
  const word = normWord(text), wordId = normWord(replyId);
  const digits = String(from).replace(/[^\d]/g, '');
  if (OPTOUT_WORDS.includes(word) || OPTOUT_WORDS.includes(wordId)) {
    await setOptout(pid, digits, { at: Date.now(), channel, keyword: text, contactId: contactId || null });
    console.log(`[optout] ${digits} opted out on ${channel} ("${text}") portal ${pid}`);
    if (contactId) { logNote(pid, contactId, `[Opted out] Replied "${text}" on ${channel}. No further messages will be sent to this number from Vonage until they reply START.`).catch(() => {}); setContactOptProp(pid, contactId, true); }
    try { const creds = await vonageCreds(pid); if (creds) { const r = await vonageSendPayload(creds, Object.assign(messagePayload(creds, channel, from, 'You have been unsubscribed and will not receive further messages from us. Reply START to subscribe again.'), { __allowOptedOut: true })); if (r.ok) recordOutbound(pid, from, channel, 'text', 'You have been unsubscribed and will not receive further messages from us. Reply START to subscribe again.').catch(() => {}); } } catch (e) {}
    return; // no flow handling for an opt-out
  }
  if ((OPTIN_WORDS.includes(word) || OPTIN_WORDS.includes(wordId)) && await isOptedOut(pid, digits)) {
    await setOptout(pid, digits, null);
    console.log(`[optout] ${digits} opted back in on ${channel} portal ${pid}`);
    if (contactId) { logNote(pid, contactId, `[Opted in] Replied "${text}" on ${channel}. Messages from Vonage are allowed again.`).catch(() => {}); setContactOptProp(pid, contactId, false); }
  }
  // conversational flows (keyword / catch-all / waiting sessions)
  try { const handled = await flowOnInbound(pid, channel, from, text, replyId, contactId); if (handled) console.log(`[flow] handled inbound from ${from} on ${channel}`); } catch (e) { console.error('[flow] inbound', e.message); }
}
// ---- Opt-out list for a portal (cards / support) ----
app.get('/2v/api/optouts', async (req, res) => {
  const pid = String(req.query.portalId || ''); if (!pid) return res.status(400).json({ error: 'portalId required' });
  const list = Object.entries(await optoutsFor(pid)).map(([n, r]) => ({ phone: '+' + n, at: new Date(r.at).toISOString(), channel: r.channel, keyword: r.keyword, contactId: r.contactId }));
  res.json({ count: list.length, optouts: list.sort((a, b) => b.at.localeCompare(a.at)) });
});
app.post('/2v/api/optouts/remove', async (req, res) => {
  const { portalId, phone } = req.body || {}; const d = String(phone || '').replace(/[^\d]/g, '');
  if (!portalId || !d) return res.status(400).json({ error: 'portalId and phone required' });
  await setOptout(String(portalId), d, null); res.json({ ok: true });
});

// ---- HubSpot Help Desk / Inbox via the Custom Channels API ----------------------------------------
// One channel "Vonage WhatsApp" is registered ONCE for the app (needs the developer API key + app id);
// each portal then connects a channel account to its help desk (or inbox). Incoming WhatsApp messages
// are published into the HubSpot conversation; agent replies arrive at /2v/hubspot/channel and are
// sent over WhatsApp from the portal's own number.
// state: vh_hschannel = { channelId, appId, registeredAt, accounts: { [pid]: { channelAccountId, inboxId, inboxType, from } } }
const getHsChannel = async () => sget('vh_hschannel', { channelId: null, accounts: {} });
async function hsChannelPublishIncoming(pid, channel, from, name, text, media, uuid, ts) {
  if (channel !== 'whatsapp') return;
  const hc = await getHsChannel(); const acc = hc.channelId && hc.accounts && hc.accounts[pid];
  if (!acc) return;
  const body = {
    text: text || (media ? media : '[message]'), messageDirection: 'INCOMING', integrationThreadId: null,
    integrationIdempotencyId: uuid || undefined, channelAccountId: acc.channelAccountId,
    senders: [{ deliveryIdentifier: { type: 'HS_PHONE_NUMBER', value: '+' + String(from).replace(/[^\d]/g, '') }, name: name || undefined }],
    recipients: [{ deliveryIdentifier: { type: 'HS_PHONE_NUMBER', value: '+' + String(acc.from).replace(/[^\d]/g, '') } }],
    timestamp: new Date(ts || Date.now()).toISOString(),
  };
  const r = await hsApi(pid, 'POST', `/conversations/v3/custom-channels/${hc.channelId}/messages`, body);
  if (!r.ok) console.error(`[hschannel] publish failed ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
}
// One-time app registration. Body: { devApiKey, appId, adminKey }. adminKey = ADMIN_KEY env.
app.post('/2v/api/hschannel/register', async (req, res) => {
  const { devApiKey, appId, adminKey } = req.body || {};
  if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'bad admin key' });
  // Preferred: register the channel directly with HubSpot (the developer key never leaves the admin's machine)
  // and pass only the resulting channelId here.
  if (req.body.channelId) {
    const hc0 = await getHsChannel(); hc0.channelId = String(req.body.channelId); hc0.appId = String(appId || hc0.appId || ''); hc0.registeredAt = Date.now(); await sset('vh_hschannel', hc0);
    console.log('[hschannel] channel id set', hc0.channelId); return res.json({ ok: true, channelId: hc0.channelId });
  }
  if (!devApiKey || !appId) return res.status(400).json({ error: 'devApiKey and appId required' });
  const r = await fetch(`${HS_API}/conversations/v3/custom-channels?hapikey=${encodeURIComponent(devApiKey)}&appId=${encodeURIComponent(appId)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Vonage WhatsApp', webhookUrl: BASE_URL + '/2v/hubspot/channel',
      channelDescription: 'WhatsApp conversations through your Vonage account',
      capabilities: { deliveryIdentifierTypes: ['HS_PHONE_NUMBER'], threadingModel: 'DELIVERY_IDENTIFIER', allowOutgoingMessages: true, richText: [], allowInlineImages: false, outgoingAttachmentTypes: [] },
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return res.status(r.status).json({ error: 'HubSpot refused the channel', hubspot: d });
  const hc = await getHsChannel(); hc.channelId = String(d.id || d.channelId); hc.appId = String(appId); hc.registeredAt = Date.now(); await sset('vh_hschannel', hc);
  console.log('[hschannel] registered channel', hc.channelId);
  res.json({ ok: true, channelId: hc.channelId });
});
// Per portal: list inboxes, then connect the portal's WhatsApp number to one (help desk preferred).
app.get('/2v/api/hschannel/inboxes', async (req, res) => {
  const pid = String(req.query.portalId || ''); if (!pid) return res.status(400).json({ error: 'portalId required' });
  const r = await hsApi(pid, 'GET', '/conversations/v3/conversations/inboxes');
  if (!r.ok) return res.status(r.status).json({ error: r.status === 403 ? 'missing_scope' : 'hubspot_error', detail: 'Reinstall the app from your install page to grant the conversations permissions.', hubspot: r.body });
  res.json({ inboxes: (r.body.results || []).map((i) => ({ id: i.id, name: i.name, type: i.type })) });
});
// Connect a portal's WhatsApp number to its help desk (preferred) or inbox. Returns { ok, ... } or { error, status }.
async function hsChannelConnect(pid, inboxId) {
  const hc = await getHsChannel(); if (!hc.channelId) return { status: 409, error: 'channel_not_registered' };
  const creds = await vonageCreds(pid); if (!creds || !creds.waFrom) return { status: 400, error: 'no_whatsapp_sender', detail: 'Set a WhatsApp sender in the Vonage settings first.' };
  let target = inboxId, targetType = null;
  if (!target) {
    const r = await hsApi(pid, 'GET', '/conversations/v3/conversations/inboxes');
    if (!r.ok) return { status: r.status, error: r.status === 403 ? 'missing_scope' : 'hubspot_error', hubspot: r.body };
    const list = r.body.results || []; const pick = list.find((i) => i.type === 'HELP_DESK') || list[0];
    if (!pick) return { status: 404, error: 'no_inbox', detail: 'This HubSpot account has no inbox or help desk.' };
    target = pick.id; targetType = pick.type;
  }
  const from = '+' + String(creds.waFrom).replace(/[^\d]/g, '');
  const r = await hsApi(pid, 'POST', `/conversations/v3/custom-channels/${hc.channelId}/channel-accounts`, {
    inboxId: String(target), name: 'WhatsApp ' + from, authorized: true, deliveryIdentifier: { type: 'HS_PHONE_NUMBER', value: from },
  });
  if (!r.ok) return { status: r.status, error: 'connect_failed', hubspot: r.body };
  hc.accounts = hc.accounts || {}; hc.accounts[pid] = { channelAccountId: String(r.body.id), inboxId: String(target), inboxType: targetType, from: creds.waFrom, connectedAt: Date.now() };
  await sset('vh_hschannel', hc);
  console.log(`[hschannel] portal ${pid} connected account ${r.body.id} to ${targetType || 'inbox'} ${target}`);
  return { ok: true, channelAccountId: String(r.body.id), inboxId: String(target), inboxType: targetType };
}
app.post('/2v/api/hschannel/connect', async (req, res) => {
  const { portalId, inboxId } = req.body || {}; const pid = String(portalId || '');
  if (!pid) return res.status(400).json({ error: 'portalId required' });
  const r = await hsChannelConnect(pid, inboxId);
  res.status(r.ok ? 200 : (r.status || 500)).json(r);
});
app.get('/2v/api/hschannel/status', async (req, res) => {
  const pid = String(req.query.portalId || ''); const hc = await getHsChannel();
  res.json({ registered: !!hc.channelId, connected: !!(hc.accounts && hc.accounts[pid]), account: (hc.accounts || {})[pid] || null });
});
// Agent replies from the help desk / inbox arrive here (signed by HubSpot with the app secret).
app.post('/2v/hubspot/channel', async (req, res) => {
  if (!wfSignatureOk(req)) { console.error('[hschannel] webhook with bad signature rejected'); return res.sendStatus(401); }
  res.sendStatus(200);
  const events = Array.isArray(req.body) ? req.body : [req.body];
  for (const ev of events) {
    try {
      if (!ev || ev.type !== 'OUTGOING_CHANNEL_MESSAGE_CREATED' || !ev.message) { console.log('[hschannel] event', ev && ev.type); continue; }
      const pid = String(ev.portalId); const msg = ev.message;
      const rcp = (msg.recipients || [])[0]; const to = rcp && rcp.deliveryIdentifier && rcp.deliveryIdentifier.value;
      const text = msg.text || (msg.richText ? String(msg.richText).replace(/<[^>]+>/g, '') : '');
      if (!to || !text) { console.log('[hschannel] outgoing without recipient/text'); continue; }
      const creds = await vonageCreds(pid); if (!creds) { console.error('[hschannel] portal not configured', pid); continue; }
      const r = await vonageSendPayload(creds, messagePayload(creds, 'whatsapp', to, text));
      console.log(`[hschannel] agent reply portal ${pid} to ${to} -> ${r.status}${r.ok ? '' : ' ' + JSON.stringify(r.body).slice(0, 200)}`);
      if (r.ok) recordOutbound(pid, to, 'whatsapp', 'text', text).catch(() => {});
    } catch (e) { console.error('[hschannel] outgoing', e.message); }
  }
});

app.post('/2v/webhooks/inbound', async (req, res) => {
  res.sendStatus(200);
  try { await handleInbound(req.body || {}, req.query.portal || null); } catch (e) { console.error('[inbound]', e.message); }
});
app.post('/2v/webhooks/status', (req, res) => {
  const b = req.body || {}; const err = b.error || {};
  const line = `[status] ${b.channel || ''} ${b.message_uuid || ''} to=${b.to || ''} ${b.status || ''}${err.code ? ` error=${err.code} ${err.title || ''} ${err.detail || ''}` : ''}`;
  if (/rejected|failed|undeliverable/i.test(b.status || '')) console.error(line); else console.log(line);
  res.sendStatus(200);
});
app.get('/2v/voice/token', async (req, res) => {
  const creds = await vonageCreds(req.query.portalId);
  if (!creds) return res.status(400).json(NOT_CONFIGURED);
  res.json({ token: clientJwt(creds, String(req.query.user || 'agent')), applicationId: creds.appId });
});
app.get('/2v/voice/answer', async (req, res) => {
  const creds = await vonageCreds(req.query.portal || req.query.portalId);
  const fromNum = creds ? String(creds.voiceFrom || creds.smsFrom || creds.waFrom || '').replace(/[^\d]/g, '') : '';
  if (!fromNum) return res.json([{ action: 'talk', text: 'This account has no Vonage voice number configured. Please complete Vonage setup.' }]);
  res.json([{ action: 'talk', text: 'Connecting your call' }, { action: 'connect', from: fromNum, endpoint: [{ type: 'phone', number: (req.query.to || '').replace(/[^\d]/g, '') }] }]);
});
app.post('/2v/voice/events', (req, res) => res.sendStatus(200));

// On AWS Lambda (function URL / API Gateway v2) export a handler instead of listening.
if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
  const serverless = require('serverless-http');
  module.exports.handler = serverless(app, { binary: ['image/*', 'application/pdf', 'application/octet-stream', 'audio/*', 'video/*'] });
  console.log(`vonage-hubspot relay as Lambda handler (state=${STATE_BACKEND}, base=${BASE_URL})`);
} else {
  app.listen(PORT, () => console.log(`vonage-hubspot relay on :${PORT} (state=${STATE_BACKEND}, multi-tenant: every portal uses its own Vonage account)`));
}
