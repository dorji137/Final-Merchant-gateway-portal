const crypto = require('crypto');
const { URL } = require('url');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const PDFDocument = require('pdfkit');
const { MongoClient } = require('mongodb');

const MERCHANT_ID_DEFAULT = process.env.MERCHANT_ID || '863990030700270';
const CARDZONE_MKREQ_URL = process.env.CARDZONE_MKREQ_URL || 'https://3dsecure.bob.bt/3dss/mkReq';
const CARDZONE_REDIRECT_URL =
  process.env.CARDZONE_REDIRECT_URL ||
  process.env.CARDZONE_MERCREQ_URL ||
  'https://3dsecure.bob.bt/3dss/mercReq';
const CARDZONE_INQUIRY_URL =
  process.env.CARDZONE_INQUIRY_URL ||
  '';
const CARDZONE_PROFILE_URL = process.env.CARDZONE_PROFILE_URL || '';
const MONGODB_URI = process.env.MONGODB_URI || '';
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'nanodb';
const ENABLE_MKREQ_MAC = process.env.ENABLE_MKREQ_MAC === 'true';
const TEMP_DIR = process.env.VERCEL ? '/tmp' : path.join(os.tmpdir(), 'cardzone-backend');
const PAYMENT_LINK_TTL_MS = Number(process.env.PAYMENT_LINK_TTL_MS || 30 * 60 * 1000);
const INVOICE_DEFAULT_DUE_MS = Number(process.env.INVOICE_DEFAULT_DUE_MS || 7 * 24 * 60 * 60 * 1000);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 12 * 60 * 60 * 1000);

const txStore = new Map();
const sessionStore = new Map();

let mongoClientPromise = null;

async function getMongoDb() {
  if (!MONGODB_URI) throw new Error('MONGODB_URI is not configured');
  if (!mongoClientPromise) {
    const client = new MongoClient(MONGODB_URI);
    mongoClientPromise = client.connect().catch((err) => {
      mongoClientPromise = null;
      throw err;
    });
  }
  const client = await mongoClientPromise;
  return client.db(MONGODB_DB_NAME);
}

async function replaceCollectionContents(collectionName, obj) {
  const db = await getMongoDb();
  const coll = db.collection(collectionName);
  const keys = Object.keys(obj);

  if (keys.length) {
    const ops = keys.map((key) => ({
      replaceOne: {
        filter: { _id: key },
        replacement: { _id: key, ...obj[key] },
        upsert: true,
      },
    }));
    await coll.bulkWrite(ops);
    await coll.deleteMany({ _id: { $nin: keys } });
  } else {
    await coll.deleteMany({});
  }
}

async function readCollectionAsObject(collectionName) {
  const db = await getMongoDb();
  const docs = await db.collection(collectionName).find({}).toArray();
  const out = {};
  for (const doc of docs) {
    const { _id, ...rest } = doc;
    out[_id] = rest;
  }
  return out;
}

function deriveInvoicePrefix(merchantName) {
  const firstWord = String(merchantName || '').trim().split(/[\s_-]+/)[0] || 'INV';
  const cleaned = firstWord.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return cleaned.slice(0, 10) || 'INV';
}

async function nextInvoiceNumber(username, merchantName) {
  const year = new Date().getFullYear();
  const counterId = `invoiceNumber:${username || 'default'}:${year}`;
  const db = await getMongoDb();
  const result = await db.collection('counters').findOneAndUpdate(
    { _id: counterId },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  const seq = result?.seq ?? result?.value?.seq ?? 1;
  const prefix = deriveInvoicePrefix(merchantName);
  return `${prefix}-${year}-${String(seq).padStart(3, '0')}`;
}

async function saveInvoice(invoice) {
  const db = await getMongoDb();
  await db.collection('invoices').replaceOne({ _id: invoice._id }, invoice, { upsert: true });
}

async function getInvoice(invoiceNumber) {
  const id = String(invoiceNumber || '').trim();
  if (!id) return null;
  const db = await getMongoDb();
  return db.collection('invoices').findOne({ _id: id });
}

async function listInvoicesForUsername(username, statusFilter) {
  const db = await getMongoDb();
  const query = { username };
  if (statusFilter) query.status = statusFilter;
  return db.collection('invoices').find(query).sort({ createdAt: -1 }).toArray();
}

async function updateInvoiceStatus(invoiceNumber, status) {
  const db = await getMongoDb();
  await db.collection('invoices').updateOne(
    { _id: invoiceNumber },
    { $set: { status, updatedAt: new Date().toISOString() } }
  );
}

async function saveTransactionHistory(record) {
  const db = await getMongoDb();
  await db.collection('transactions').replaceOne({ _id: record._id }, record, { upsert: true });
}

async function listTransactionsForUsername(username) {
  const db = await getMongoDb();
  return db.collection('transactions').find({ username }).sort({ resolvedAt: -1 }).toArray();
}

async function deleteInvoiceById(invoiceNumber) {
  const db = await getMongoDb();
  await db.collection('invoices').deleteOne({ _id: invoiceNumber });
}

function getRequestBaseUrl(req) {
  if (process.env.CALLBACK_BASE_URL) return process.env.CALLBACK_BASE_URL;
  const fallbackProto = req.socket?.encrypted ? 'https' : 'http';
  const proto = (req.headers['x-forwarded-proto'] || fallbackProto).toString().split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString().split(',')[0].trim();
  return `${proto}://${host}`;
}

function escapeHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 2 * 1024 * 1024) {
        reject(new Error('Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function parseForm(body) {
  const params = new URLSearchParams(body);
  const obj = {};
  for (const [k, v] of params.entries()) obj[k] = v;
  return obj;
}

function parseRawPayload(raw, contentType) {
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(raw || '{}');
    } catch {
      return {};
    }
  }
  return parseForm(raw || '');
}

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload, null, 2));
}

function html(res, status, content) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(content);
}

function redirect(res, location) {
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.end();
}

function generateTxnId() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const MM = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const rand = String(Math.floor(Math.random() * 100000)).padStart(5, '0');
  return `${yyyy}${MM}${dd}${hh}${mm}${ss}${rand}`.slice(0, 20);
}

function formatPurchDate(date = new Date()) {
  const yyyy = date.getFullYear();
  const MM = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}${MM}${dd}${hh}${mm}${ss}`;
}

function amountToMinorUnits(amountText) {
  const n = Number(amountText);
  if (!Number.isFinite(n) || n <= 0) throw new Error('Invalid amount. Amount must be greater than 0.');
  return String(Math.round(n * 100));
}

function base64Url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function createRsaKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const publicDer = crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' });
  return {
    publicKeyPem: publicKey,
    privateKeyPem: privateKey,
    publicKeyBase64Url: base64Url(publicDer),
  };
}

function signSha256WithRsaBase64Url(message, privateKeyPem) {
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(message, 'utf8');
  signer.end();
  return base64Url(signer.sign(privateKeyPem));
}

function verifySha256WithRsaBase64Url(message, signatureBase64Url, publicKeyPemOrDerBase64Url) {
  try {
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(message, 'utf8');
    verifier.end();

    let publicKey;
    if (publicKeyPemOrDerBase64Url.includes('BEGIN PUBLIC KEY')) {
      publicKey = publicKeyPemOrDerBase64Url;
    } else {
      const der = Buffer.from(
        publicKeyPemOrDerBase64Url.replace(/-/g, '+').replace(/_/g, '/'),
        'base64'
      );
      publicKey = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' }).export({
        format: 'pem',
        type: 'spki',
      });
    }

    const sig = Buffer.from(signatureBase64Url.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    return verifier.verify(publicKey, sig);
  } catch {
    return false;
  }
}

function mkReqSignString({ merchantId, purchaseId, pubKey }) {
  return `${merchantId || ''}${purchaseId || ''}${pubKey || ''}`;
}

function normalizeCurrency(value) {
  const v = String(value || '').trim();
  return /^\d{3}$/.test(v) ? v : '';
}

function normalizeMerchantId(value) {
  return String(value || '').replace(/\D/g, '');
}

function parseCookies(req) {
  const header = String(req.headers.cookie || '');
  const out = {};
  if (!header) return out;

  const parts = header.split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(val);
  }
  return out;
}

function getSessionTokenFromRequest(req) {
  const cookies = parseCookies(req);
  return String(cookies.portalSession || '').trim();
}

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of sessionStore.entries()) {
    if (!session?.expiresAt || Date.parse(session.expiresAt) <= now) {
      sessionStore.delete(token);
    }
  }
}

function getAuthenticatedSession(req) {
  cleanupExpiredSessions();
  const token = getSessionTokenFromRequest(req);
  if (!token) return null;
  const session = sessionStore.get(token);
  if (!session) return null;
  if (!session.expiresAt || Date.parse(session.expiresAt) <= Date.now()) {
    sessionStore.delete(token);
    return null;
  }
  return session;
}

function setSessionCookie(res, token, maxAgeSeconds) {
  res.setHeader(
    'Set-Cookie',
    `portalSession=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'portalSession=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  if (!hash || !salt) return false;
  try {
    const candidate = crypto.scryptSync(String(password), salt, 64);
    const expected = Buffer.from(hash, 'hex');
    if (candidate.length !== expected.length) return false;
    return crypto.timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

async function loadMerchantUserDbRaw() {
  try {
    return await readCollectionAsObject('merchantUsers');
  } catch {
    return {};
  }
}

async function saveMerchantUserDbRaw(usersObj) {
  await replaceCollectionContents('merchantUsers', usersObj);
}

async function saveMerchantPortalDb(portalObj) {
  await replaceCollectionContents('merchantPortalProfiles', portalObj);
}

function findUsernameKey(usersObj, username) {
  const target = String(username || '').trim().toLowerCase();
  if (!target) return null;
  return Object.keys(usersObj).find(key => key.toLowerCase() === target) || null;
}

const LOGO_DATA_URL_RE = /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,[a-z0-9+/]+=*$/i;
const LOGO_MAX_CHARS = 1_500_000;

function validateLogoUrl(logoUrl) {
  if (!logoUrl) return null;
  if (logoUrl.length > LOGO_MAX_CHARS) {
    return 'Logo image is too large (max ~1MB). Please use a smaller image.';
  }
  if (/^https?:\/\//i.test(logoUrl)) return null;
  if (LOGO_DATA_URL_RE.test(logoUrl)) return null;
  return 'Logo must be an http(s) URL or an uploaded image file';
}

async function loadMerchantUserDb() {
  const users = await loadMerchantUserDbRaw();
  const out = new Map();

  for (const [usernameRaw, userDef] of Object.entries(users)) {
    const username = String(usernameRaw || '').trim();
    if (!username || !userDef || typeof userDef !== 'object') continue;

    const passwordHash = String(userDef.passwordHash || '').trim();
    const passwordSalt = String(userDef.passwordSalt || '').trim();
    if (!passwordHash || !passwordSalt) continue;

    const merchantIdsByCurrency = {};
    const inputMap = userDef.merchantIdsByCurrency;
    if (inputMap && typeof inputMap === 'object' && !Array.isArray(inputMap)) {
      for (const [currencyRaw, midRaw] of Object.entries(inputMap)) {
        const currency = normalizeCurrency(currencyRaw);
        const merchantId = normalizeMerchantId(midRaw);
        if (currency && merchantId) merchantIdsByCurrency[currency] = merchantId;
      }
    }

    const fallbackMerchantId = normalizeMerchantId(userDef.merchantId);
    const defaultCurrency = normalizeCurrency(userDef.defaultCurrency);
    const displayName = String(userDef.displayName || username).trim() || username;
    const role = String(userDef.role || 'merchant').trim().toLowerCase() === 'developer' ? 'developer' : 'merchant';

    out.set(username.toLowerCase(), {
      username,
      passwordHash,
      passwordSalt,
      displayName,
      role,
      merchantId: fallbackMerchantId,
      merchantIdsByCurrency,
      defaultCurrency,
    });
  }

  return out;
}

function getSessionMerchantRouting(session, requestedCurrency = '') {
  const map = session?.merchantIdsByCurrency && typeof session.merchantIdsByCurrency === 'object'
    ? session.merchantIdsByCurrency
    : {};
  const supportedCurrencies = Object.keys(map).filter(code => normalizeCurrency(code));
  const preferredCurrency = normalizeCurrency(requestedCurrency);

  if (preferredCurrency && map[preferredCurrency]) {
    return { merchantId: map[preferredCurrency], currency: preferredCurrency, source: 'session-currency-map' };
  }

  const defaultCurrency = normalizeCurrency(session?.defaultCurrency);
  if (defaultCurrency && map[defaultCurrency]) {
    return { merchantId: map[defaultCurrency], currency: defaultCurrency, source: 'session-default-currency' };
  }

  if (supportedCurrencies.length) {
    const currency = supportedCurrencies[0];
    return { merchantId: map[currency], currency, source: 'session-first-currency' };
  }

  const merchantId = normalizeMerchantId(session?.merchantId);
  if (merchantId) {
    return { merchantId, currency: '', source: 'session-single-mid' };
  }

  return null;
}

function buildSessionClientView(session) {
  const routing = getSessionMerchantRouting(session);
  const currencyMap = session?.merchantIdsByCurrency && typeof session.merchantIdsByCurrency === 'object'
    ? session.merchantIdsByCurrency
    : {};
  const supportedCurrencies = Object.keys(currencyMap).filter(code => normalizeCurrency(code));

  return {
    username: String(session?.username || ''),
    displayName: String(session?.displayName || session?.username || ''),
    role: session?.role === 'developer' ? 'developer' : 'merchant',
    merchantId: routing?.merchantId || '',
    defaultCurrency: routing?.currency || '',
    merchantIdsByCurrency: currencyMap,
    supportedCurrencies,
  };
}

async function loadMerchantPortalDb() {
  try {
    return await readCollectionAsObject('merchantPortalProfiles');
  } catch {
    return {};
  }
}

function buildDefaultPortalModel(sessionView = {}) {
  const currencyMap = sessionView?.merchantIdsByCurrency && typeof sessionView.merchantIdsByCurrency === 'object'
    ? sessionView.merchantIdsByCurrency
    : {};

  return {
    merchantName: sessionView.displayName || sessionView.username || 'Merchant',
    logoUrl: '',
    address: '',
    email: '',
    phone: '',
    usdSettings: {
      merchantId: currencyMap['840'] || '',
      secretKey: '',
      keyVersion: '',
    },
    inrSettings: {
      merchantId: currencyMap['356'] || '',
      secretKey: '',
      keyVersion: '',
    },
    settings: {
      useCustomerNames: true,
      sendInvoiceViaEmail: true,
      allowExternalPayments: true,
      paymentMessage: 'Thank you for your payment.',
      successfulPaymentMessage: 'Payment completed successfully.',
      termsAndConditions: 'All payments are final unless otherwise specified in your contract.',
    },
  };
}

function mergePortalModel(defaultModel, customModel) {
  const source = customModel && typeof customModel === 'object' ? customModel : {};
  const usd = source.usdSettings && typeof source.usdSettings === 'object' ? source.usdSettings : {};
  const inr = source.inrSettings && typeof source.inrSettings === 'object' ? source.inrSettings : {};
  const settings = source.settings && typeof source.settings === 'object' ? source.settings : {};

  return {
    ...defaultModel,
    ...source,
    usdSettings: {
      ...defaultModel.usdSettings,
      ...usd,
    },
    inrSettings: {
      ...defaultModel.inrSettings,
      ...inr,
    },
    settings: {
      ...defaultModel.settings,
      ...settings,
    },
  };
}

async function getPortalModelForSession(sessionView) {
  const db = await loadMerchantPortalDb();
  const usernameKey = String(sessionView?.username || '').trim();
  const displayKey = String(sessionView?.displayName || '').trim();

  const defaultModel = buildDefaultPortalModel(sessionView);
  const customModel = db[usernameKey] || db[displayKey] || null;
  return mergePortalModel(defaultModel, customModel);
}

async function loadMerchantCurrencyDb() {
  try {
    const db = await getMongoDb();
    const docs = await db.collection('merchantCurrencyWhitelist').find({}).toArray();
    const map = new Map();

    for (const doc of docs) {
      const id = normalizeMerchantId(doc._id);
      const code = normalizeCurrency(doc.currency);
      if (id && code) map.set(id, code);
    }

    return map;
  } catch {
    return new Map();
  }
}

function extractCurrencyCandidates(payload) {
  if (!payload || typeof payload !== 'object') return [];

  const keys = [
    'currency', 'currencies', 'currencyCode', 'currencyCodes',
    'defaultCurrency', 'txnCurrency', 'supportedCurrencies', 'allowedCurrencies',
  ];

  const out = new Set();

  for (const k of keys) {
    const raw = payload[k];
    if (Array.isArray(raw)) {
      for (const item of raw) {
        const n = normalizeCurrency(item?.code || item?.currency || item);
        if (n) out.add(n);
      }
      continue;
    }

    if (raw && typeof raw === 'object') {
      const n = normalizeCurrency(raw.code || raw.currency || raw.value);
      if (n) out.add(n);
      continue;
    }

    const n = normalizeCurrency(raw);
    if (n) out.add(n);
  }

  if (payload.data && typeof payload.data === 'object') {
    for (const c of extractCurrencyCandidates(payload.data)) out.add(c);
  }

  return [...out];
}

async function fetchCardzoneMerchantProfile(merchantId) {
  if (!CARDZONE_PROFILE_URL) return null;

  const endpoint = CARDZONE_PROFILE_URL.includes('{merchantId}')
    ? CARDZONE_PROFILE_URL.replace('{merchantId}', encodeURIComponent(merchantId))
    : CARDZONE_PROFILE_URL;

  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ merchantId }),
  });

  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }

  if (!r.ok) return null;
  return data;
}

async function resolveMerchantCurrency(merchantId) {
  const mid = normalizeMerchantId(merchantId);
  if (!mid) return { currency: '', source: 'missing-mid' };

  const db = await loadMerchantCurrencyDb();
  const dbCurrency = db.get(mid);
  if (dbCurrency) {
    return { currency: dbCurrency, source: 'mid-database' };
  }

  try {
    const profile = await fetchCardzoneMerchantProfile(mid);
    const candidates = extractCurrencyCandidates(profile || {});
    if (candidates.length) {
      return { currency: candidates[0], source: 'merchant-profile' };
    }
  } catch {
    // Ignore lookup failures and fail clearly if MID is not configured
  }

  return { currency: '', source: 'not-configured' };
}

function getMpiReqMacFieldSequence(fields) {
  const lineItems = Array.isArray(fields.MPI_LINE_ITEM) ? fields.MPI_LINE_ITEM : [];
  const flattenedLineItems = lineItems
    .map(item => `${item.MPI_ITEM_ID || ''}${item.MPI_ITEM_REMARK || ''}${item.MPI_ITEM_QUANTITY || ''}${item.MPI_ITEM_AMOUNT || ''}${item.MPI_ITEM_CURRENCY || ''}`)
    .join('');

  // NOTE: Phone fields (MPI_HOME_PHONE*, MPI_MOBILE_PHONE*, MPI_WORK_PHONE*) are intentionally 
  // excluded from MAC signing to avoid field concatenation issues. Will be added back 
  // once Cardzone confirms correct field order and null-handling requirements.
  return [
    ['MPI_TRANS_TYPE', fields.MPI_TRANS_TYPE],
    ['MPI_MERC_ID', fields.MPI_MERC_ID],
    ['MPI_PAN', fields.MPI_PAN],
    ['MPI_CARD_HOLDER_NAME', fields.MPI_CARD_HOLDER_NAME],
    ['MPI_PAN_EXP', fields.MPI_PAN_EXP],
    ['MPI_CVV2', fields.MPI_CVV2],
    ['MPI_TRXN_ID', fields.MPI_TRXN_ID],
    ['MPI_ORI_TRXN_ID', fields.MPI_ORI_TRXN_ID],
    ['MPI_PURCH_DATE', fields.MPI_PURCH_DATE],
    ['MPI_PURCH_CURR', fields.MPI_PURCH_CURR],
    ['MPI_PURCH_AMT', fields.MPI_PURCH_AMT],
    ['MPI_ADDR_MATCH', fields.MPI_ADDR_MATCH],
    ['MPI_BILL_ADDR_CITY', fields.MPI_BILL_ADDR_CITY],
    ['MPI_BILL_ADDR_STATE', fields.MPI_BILL_ADDR_STATE],
    ['MPI_BILL_ADDR_CNTRY', fields.MPI_BILL_ADDR_CNTRY],
    ['MPI_BILL_ADDR_POSTCODE', fields.MPI_BILL_ADDR_POSTCODE],
    ['MPI_BILL_ADDR_LINE1', fields.MPI_BILL_ADDR_LINE1],
    ['MPI_BILL_ADDR_LINE2', fields.MPI_BILL_ADDR_LINE2],
    ['MPI_BILL_ADDR_LINE3', fields.MPI_BILL_ADDR_LINE3],
    ['MPI_SHIP_ADDR_CITY', fields.MPI_SHIP_ADDR_CITY],
    ['MPI_SHIP_ADDR_STATE', fields.MPI_SHIP_ADDR_STATE],
    ['MPI_SHIP_ADDR_CNTRY', fields.MPI_SHIP_ADDR_CNTRY],
    ['MPI_SHIP_ADDR_POSTCODE', fields.MPI_SHIP_ADDR_POSTCODE],
    ['MPI_SHIP_ADDR_LINE1', fields.MPI_SHIP_ADDR_LINE1],
    ['MPI_SHIP_ADDR_LINE2', fields.MPI_SHIP_ADDR_LINE2],
    ['MPI_SHIP_ADDR_LINE3', fields.MPI_SHIP_ADDR_LINE3],
    ['MPI_EMAIL', fields.MPI_EMAIL],
    ['MPI_LINE_ITEM_FLATTENED', flattenedLineItems],
    ['MPI_RESPONSE_TYPE', fields.MPI_RESPONSE_TYPE],
  ];
}

function mpiReqSignString(fields) {
  return getMpiReqMacFieldSequence(fields)
    .map(([, value]) => value || '')
    .join('');
}

function buildMpiReqMacDebugRows(fields) {
  return getMpiReqMacFieldSequence(fields).map(([field, value]) => ({
    field,
    value: value || '',
  }));
}

function logMpiReqSigningDetails(fields, preSignString, generatedMac) {
  const sequenceRows = buildMpiReqMacDebugRows(fields);
  console.log('\n========== MPIReq MAC SIGNING DEBUG ==========');
  console.log('[Cardzone][signing] MPIReq payload fields:');
  console.log(JSON.stringify(fields, null, 2));
  console.log('\n[Cardzone][signing] MAC field sequence in exact order (name -> value):');
  sequenceRows.forEach((row, idx) => {
    const val = row.value || '';
    const preview = val.length > 60 ? val.substring(0, 60) + '...' : val;
    console.log(`  [${idx + 1}] ${row.field}: "${preview}"`);
  });
  console.log('\n[Cardzone][signing] Field names in sequence:');
  console.log(sequenceRows.map(item => item.field).join(' -> '));
  console.log('\n[Cardzone][signing] Concatenated pre-sign string:');
  console.log(`"${preSignString}"`);
  console.log(`Pre-sign string length: ${preSignString.length} characters`);
  console.log('\n[Cardzone][signing] Generated MPI_MAC (Base64URL, no padding):');
  console.log(generatedMac);
  console.log('============================================\n');
}

function mpiResVerifyString(fields) {
  return [
    fields.MPI_MERC_ID,
    fields.MPI_TRXN_ID,
    fields.MPI_ERROR_CODE,
    fields.MPI_APPR_CODE,
    fields.MPI_RRN,
    fields.MPI_BIN,
    fields.MPI_REFERRAL_CODE,
    fields.MPI_CARDHOLDER_INFO,
  ].map(v => v || '').join('');
}

const RESPONSE_CODE_DESCRIPTIONS = {
  '0': 'APPROVED',
  '00': 'APPROVED',
  '00_NR': 'APPROVED NO RECEIPT',
  '00_NRR': 'APPROVED NO RECEIPT REQ',
  '1': 'REFER TO CARD ISSUER',
  '2': 'REFER TO CARD ISSUER SPECIAL CONDITION',
  '3': 'INVALID MERCHANT',
  '4': 'PICK UP CARD',
  '5': 'DO NOT HONOUR',
  '6': 'CHECK VALUE ERROR',
  '8': 'SIGNATURE REQUIRED',
  '10': 'APPROVED PARTIAL AMT',
  '11': 'APPROVED VIP',
  '12': 'INVALID TRXN',
  '13': 'INVALID AMT',
  '14': 'INVALID CARD NUMBER',
  '19': 'REENTER TRXN',
  '20': 'AMOUNT_MISSMATCH',
  '22': 'MPS NO CHEQUE ACC',
  '23': 'MPS NO SAVING ACC',
  '24': 'MPS NO CREDIT ACC',
  '25': 'UNABLE TO LOCATE RECORD ON FILE',
  '30': 'FORMAT ERROR',
  '31': 'BANK NOT SUPPORTED BY SWITCH',
  '34': 'FRAUD CARD',
  '39': 'NO CREDIT ACCOUNT',
  '40': 'FUNCTION NOT SUPPORTED BY ISSUER',
  '41': 'LOST CARD',
  '43': 'STOLEN CARD',
  '44': 'BLOCK TERMINATE CLOSE DESTROY CARD',
  '45': 'NEW UNACTIVATED CARD',
  '46': 'CLOSED CARD ACCT',
  '51': 'INSUFFICIENT FUNDS',
  '52': 'NO CURRENT ACCOUNT',
  '53': 'NO SAVING ACCOUNT',
  '54': 'EXPIRED CARD',
  '55': 'INCORRECT PIN',
  '56': 'NO CARD RECORD',
  '57': 'TRXN NOT PERMITTED TO CARD',
  '58': 'TRXN NOT PERMITTED TO TERMINAL',
  '59': 'SUSPECTED FRAUD',
  '5C': 'NOT SUPPORTED BY ISSUER',
  '61': 'EXCEED AMT LMT',
  '62': 'RESTRICTED CARD',
  '63': 'MPS MAC VER ERROR',
  '65': 'EXCEED CNT LMT',
  '68': 'ISSUER TIMEOUT',
  '72': 'UNACTIVATED ACCOUNT',
  '75': 'PIN TRY EXCEEDED',
  '76': 'INVALID PROD CODE',
  '77': 'RECONCILE ERROR OR HOST TEXT IF SENT',
  '78': 'UNACTIVATED/BLOCK CARD',
  '79': 'DECLINED',
  '80': 'BATCH NUMBER NOT FOUND',
  '82': 'NEGATIVE ONLINE CAM/CVV RESULTS',
  '83': 'ISSUER BLOCKED DUE TO SECURITY REASON',
  '84': 'VALIDATE ARQC ERROR',
  '85': 'NOT DECLINED',
  '86': 'CANNOT VERIFY PIN',
  '87': 'PIN REQUIRED',
  '88': 'CRYPTO FAILED',
  '89': 'BAD TERMINAL ID',
  '91': 'ISSUER OR SWITCH IS INOPERATIVE',
  '92': 'ROUTING ERROR',
  '93': 'CARD VIOLATION CANNOT COMPLETE',
  '94': 'DUPLICATE TRXN',
  '95': 'RECONCILE ERROR',
  '96': 'SYSTEM MALFUNCTION',
  '97': 'ACCOUNT CURRENCY ERROR',
  '98': 'CUP ISSUER TIMEOUT',
  '99': 'PIN BLOCK ERROR',
  '9G': 'BLOCKED BY CARDHOLDER',
  'A0': 'MAC VER ERROR',
  'A1': 'VEHICLE AND DRIVER MISMATCH',
  'A2': 'PIN MANDOTORY',
  'A3': 'VELOCITY EXCEEDED',
  'A4': 'ACQUIRER TIMEOUT',
  'A5': 'ACQUIRER LINK DOWN',
  'A6': 'REVERSAL IN PROGRESS',
  'B0': 'CARDLESS RESERVATION NOT FOUND',
  'B1': 'CARDLESS RESERVATION TIMEOUT',
  'B2': 'CARDLESS RESERVATION EXPIRED',
  'B3': 'CARDLESS RESERVATION LIMIT EXCEEDED',
  'B4': 'CARDLESS RESERVATION CANCEL NOT ALLOWED',
  'B5': 'CARDLESS INVALU ONE TIME PIN',
  'B6': 'CARDLESS EXCEEDED PIN TRY',
  'B7': 'MOBILE REGISTRATION INACTIVE',
  'B8': 'MOBILE REGISTRATION DUPLICATE ACTIVE',
  'B9': 'MOBILE REG NOT FOUND',
  'C0': 'DB CONN ERROR',
  'C2': 'INVAULD CHIP CARD DATA',
  'ERR': 'ATM HOST UNKNOWN ERR',
  'ERR_CN': 'ATM NOTE COUNT ERR CN',
  'ERR_CS': 'ATM CASS SETUP ERR CS',
  'ERR_CT': 'ATM CANCEL OR TIMEOUT ERR CT',
  'ERR_DC': 'ATM CURRENCY NOT MATCHED ERR DC',
  'ERR_DE': 'ATM DISPENSE ERR DE',
  'ERR_DF': 'ATM DEVICE FAULT ERR DF',
  'ERR_EI': 'ATM EXCEED SINGLE CASS NOTE ERR EI',
  'ERR_EM': 'ATM EXCEED MAX NOTE ERR EM',
  'ERR_H': 'ATM HOST ERR H',
  'ERR_IA': 'ATM INVALID AMT ERR IA',
  'ERR_IB': 'ATM INVALID BILLER ID',
  'ERR_IN': 'ATM INVALID NOTE ID ERR IN',
  'ERR_MA': 'ATM MAX AMT ERR MA',
  'ERR_MI': 'ATM MIN AMT ERR MI',
  'ERR_TO': 'ATM HOST TIMEOUT ERR TO',
  'FP': 'FIRST PAGE',
  'FP_NR': 'FIRST PAGE NO RECEIPT',
  'G1': 'GIFT OUT OF STOCK',
  'G2': 'INVALID GIFT',
  'LP': 'LAST PAGE',
  'LP_NR': 'LAST PAGE NO RECEIPT',
  'M0': 'EXCEED MERCHANT DAILY TOPUP LMT',
  'M1': 'TOPUP BELOW MINIMUM LMT',
  'M2': 'TOPUP ABOVE MAXIMUM LMT',
  'MP': 'MIDDLE PAGE',
  'MP_NR': 'MIDDLE PAGE NO RECEIPT',
  'N7': 'INVALID CVV2',
  'NR': 'NO RECEIPT',
  'P0': 'FORCE PIN CHANGE',
  'P1': 'PIN CREATE NOT ALLOWED',
  'R0': 'CASH RETRACT',
  'RR': 'REQUEST REVERSAL',
  'S1': 'NO STANDIN TRXN',
  'S2': 'STANDIN IN PROGRESS',
  'S3': 'NO MORESOFTPIN AVAILABLE',
  'S4': 'NO PACKAGE AVAILABLE',
  'S5': 'NO SOFTPIN PACKAGES FOUND',
};

function getResponseReasonFromCode(responseCode, fallbackReason = '') {
  const code = String(responseCode || '').trim().toUpperCase();
  if (!code) return String(fallbackReason || '').trim();

  if (RESPONSE_CODE_DESCRIPTIONS[code]) {
    return RESPONSE_CODE_DESCRIPTIONS[code];
  }

  if (/^0+$/.test(code)) {
    return RESPONSE_CODE_DESCRIPTIONS['00'] || RESPONSE_CODE_DESCRIPTIONS['0'] || String(fallbackReason || '').trim();
  }

  if (/^\d+$/.test(code)) {
    const normalizedNumericCode = String(Number.parseInt(code, 10));
    if (RESPONSE_CODE_DESCRIPTIONS[normalizedNumericCode]) {
      return RESPONSE_CODE_DESCRIPTIONS[normalizedNumericCode];
    }
  }

  return String(fallbackReason || '').trim();
}

function extractFinalResultFields(fields = {}) {
  return {
    authorizationCode: String(fields.MPI_APPR_CODE || '').trim(),
    referenceNumber: String(fields.MPI_RRN || '').trim(),
    responseCode: String(fields.MPI_ERROR_CODE || '').trim(),
    responseReason: String(fields.MPI_ERROR_DESC || fields.MPI_CARDHOLDER_INFO || '').trim(),
    referralCode: String(fields.MPI_REFERRAL_CODE || '').trim(),
    bin: String(fields.MPI_BIN || '').trim(),
  };
}

function hasSufficientFinalResult(finalResult) {
  if (!finalResult) return false;
  return !!(
    finalResult.responseCode ||
    finalResult.authorizationCode ||
    finalResult.referenceNumber ||
    finalResult.responseReason
  );
}

function buildFinalResultRecord({ fields, source, resolvedAt }) {
  if (!fields || typeof fields !== 'object') return null;

  const extracted = extractFinalResultFields(fields);
  if (!Object.values(extracted).some(Boolean)) return null;

  return {
    source,
    resolvedAt: resolvedAt || new Date().toISOString(),
    ...extracted,
  };
}

function mapFinalPaymentStatus(finalResult) {
  if (!hasSufficientFinalResult(finalResult)) return 'PENDING';
  const rc = String(finalResult.responseCode || '').trim().toUpperCase();
  if (rc === '00' || rc === '000' || rc === '0' || rc === '00_NR' || rc === '00_NRR' || /^0+$/.test(rc)) {
    return 'SUCCESS';
  }
  return 'FAILED';
}

function mapTransactionLifecycleStatus({ callbackReceived, finalResult }) {
  if (!callbackReceived && !finalResult) return 'PENDING';
  return mapFinalPaymentStatus(finalResult);
}

function txFilePath(txnId) {
  const safeId = String(txnId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(TEMP_DIR, `txn_${safeId}.json`);
}

function paymentLinkFilePath(token) {
  const safeToken = String(token || '').replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(TEMP_DIR, `paylink_${safeToken}.json`);
}

async function saveTransaction(tx) {
  txStore.set(tx.txnId, tx);
  await fs.mkdir(TEMP_DIR, { recursive: true });
  await fs.writeFile(txFilePath(tx.txnId), JSON.stringify(tx, null, 2), 'utf8');
}

async function getTransaction(txnId) {
  const id = String(txnId || '').trim();
  if (!id) return null;

  const inMemory = txStore.get(id);
  if (inMemory) return inMemory;

  try {
    const content = await fs.readFile(txFilePath(id), 'utf8');
    const tx = JSON.parse(content);
    txStore.set(id, tx);
    return tx;
  } catch {
    return null;
  }
}

async function savePaymentLink(link) {
  await fs.mkdir(TEMP_DIR, { recursive: true });
  await fs.writeFile(paymentLinkFilePath(link.token), JSON.stringify(link, null, 2), 'utf8');
}

async function getPaymentLink(token) {
  const id = String(token || '').trim();
  if (!id) return null;

  try {
    const content = await fs.readFile(paymentLinkFilePath(id), 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function generatePaymentLinkToken() {
  return crypto.randomBytes(18).toString('base64url');
}

async function expirePaymentLink(token) {
  const link = await getPaymentLink(token);
  if (!link) return;
  link.expiresAt = new Date(0).toISOString();
  await savePaymentLink(link);
}

async function doMkReq({ merchantId, purchaseId, merchantPublicKeyBase64Url, merchantPrivateKeyPem }) {
  const payload = {
    merchantId,
    purchaseId,
    pubKey: merchantPublicKeyBase64Url,
  };

  if (ENABLE_MKREQ_MAC) {
    payload.mac = signSha256WithRsaBase64Url(mkReqSignString(payload), merchantPrivateKeyPem);
  } else {
    console.log('[Cardzone][mkReq] mac omitted unless explicitly enabled by Cardzone.');
  }

  console.log('[Cardzone][mkReq] method=POST contentType=application/json endpoint=', CARDZONE_MKREQ_URL);
  const r = await fetch(CARDZONE_MKREQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`mkReq did not return JSON. HTTP ${r.status}. Body: ${text.slice(0, 500)}`);
  }

  if (!r.ok) {
    throw new Error(`mkReq failed. HTTP ${r.status}. Body: ${JSON.stringify(data)}`);
  }

  return { requestPayload: payload, responsePayload: data };
}

function parseCardzoneResponseBody(rawText, contentType = '') {
  const text = String(rawText || '');
  const type = String(contentType || '').toLowerCase();

  if (!text.trim()) return {};

  if (type.includes('application/json') || text.trim().startsWith('{') || text.trim().startsWith('[')) {
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }

  if (type.includes('application/x-www-form-urlencoded') || type.includes('text/plain') || text.includes('=')) {
    return parseForm(text);
  }

  return {};
}

async function doInquiry(tx, originalTxnId) {
  if (!CARDZONE_INQUIRY_URL) {
    throw new Error('Inquiry URL not configured. Set CARDZONE_INQUIRY_URL env var to enable inquiry fallback.');
  }

  const requestFields = {
    MPI_TRANS_TYPE: 'INQ',
    MPI_MERC_ID: tx.merchantId,
    MPI_ORI_TRXN_ID: originalTxnId,
  };

  const signInput = mpiReqSignString(requestFields);
  requestFields.MPI_MAC = signSha256WithRsaBase64Url(signInput, tx.security.merchantPrivateKeyPem);

  console.log('[Cardzone][inquiry] endpoint=', CARDZONE_INQUIRY_URL);
  console.log('[Cardzone][inquiry] txnId=', originalTxnId);

  const response = await fetch(CARDZONE_INQUIRY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json, application/x-www-form-urlencoded, text/plain',
    },
    body: new URLSearchParams(requestFields).toString(),
  });

  const rawBody = await response.text();
  const responseFields = parseCardzoneResponseBody(rawBody, response.headers.get('content-type') || '');

  if (!response.ok) {
    throw new Error(`Inquiry failed. HTTP ${response.status}. Body: ${rawBody.slice(0, 500)}`);
  }

  const hasMac = !!responseFields.MPI_MAC;
  const verifyInput = hasMac ? mpiResVerifyString(responseFields) : '';
  const macVerified =
    hasMac && !!tx.security?.cardzonePublicKeyBase64Url
      ? verifySha256WithRsaBase64Url(verifyInput, responseFields.MPI_MAC, tx.security.cardzonePublicKeyBase64Url)
      : false;

  return {
    requestedAt: new Date().toISOString(),
    endpoint: CARDZONE_INQUIRY_URL,
    requestFields,
    signInput,
    responseStatus: response.status,
    responseContentType: response.headers.get('content-type') || '',
    responseFields,
    rawBody,
    macVerification: {
      hasMac,
      macVerified,
      verifyInput,
      verifyNote: hasMac
        ? (macVerified ? 'Inquiry MPIRes MAC verified successfully' : 'Inquiry MPIRes MAC verification failed')
        : 'No MPI_MAC received on inquiry response',
    },
  };
}

function renderAutoPostPage(action, fields) {
  const inputs = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join('\n');

  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Redirecting...</title></head>
<body onload="document.forms[0].submit()" style="font-family:Arial,sans-serif;padding:24px">
  <p>Redirecting to secure Cardzone payment page...</p>
  <form id="payForm" method="post" action="${escapeHtml(action)}">${inputs}</form>
  <noscript><button type="submit" form="payForm">Continue</button></noscript>
  <script>document.forms[0].submit();</script>
</body>
</html>`;
}

function renderMessagePage(title, message, details) {
  const detailBlock = details
    ? `<pre style="background:#111827;color:#e5e7eb;padding:14px;border-radius:10px;overflow:auto">${escapeHtml(JSON.stringify(details, null, 2))}</pre>`
    : '';

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body{font-family:Arial,sans-serif;background:#f5f7fb;padding:24px;color:#111827}
    .card{max-width:900px;margin:0 auto;background:#fff;padding:24px;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.08)}
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    ${detailBlock}
  </div>
</body>
</html>`;
}

function renderResultPage(tx, paymentStatus, finalResult, homeUrl = '/', customSuccessMessage = '', merchantProfile = null) {
  const isSuccess = paymentStatus === 'SUCCESS';
  const isPaymentLinkFlow = tx?.initiationSource === 'payment-link' || !!tx?.paymentLinkToken;
  const responseCode = finalResult?.responseCode || '';
  const responseReason = getResponseReasonFromCode(responseCode, finalResult?.responseReason || '');
  const merchantName = String(merchantProfile?.merchantName || '').trim() || 'Secure Payment Gateway';
  const logoUrl = String(merchantProfile?.logoUrl || '').trim();
  const merchantAddress = String(merchantProfile?.address || '').trim();
  const addressLines = merchantAddress ? merchantAddress.split('\n').filter(Boolean) : [];

  const CURRENCY_NAMES = {
    '840': 'USD', '356': 'INR', '064': 'BTN', '524': 'NPR', '144': 'LKR',
    '586': 'PKR', '050': 'BDT', '702': 'SGD', '978': 'EUR', '826': 'GBP',
    '036': 'AUD', '124': 'CAD', '392': 'JPY', '156': 'CNY', '410': 'KRW',
  };

  const currencyCode = tx?.currency || '';
  const currencyDisplay = CURRENCY_NAMES[currencyCode] || currencyCode || '';
  const amountFormatted = tx?.amountMajor
    ? (currencyDisplay ? currencyDisplay + ' ' : '') + parseFloat(tx.amountMajor).toFixed(2)
    : '—';

  let txDate = '';
  try {
    txDate = tx.createdAt
      ? new Date(tx.createdAt).toLocaleString('en-GB', {
          day: '2-digit', month: 'short', year: 'numeric',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
        })
      : new Date().toLocaleString('en-GB');
  } catch { txDate = tx.createdAt || new Date().toString(); }

  const accentColor  = isSuccess ? '#16a34a' : '#dc2626';
  const statusColor  = isSuccess ? '#2f7a3d' : '#7f1d1d';
  const statusBg     = isSuccess ? '#ecfdf5' : '#fef2f2';
  const statusBorder = isSuccess ? '#6ee7b7' : '#fca5a5';
  const iconBg       = isSuccess ? '#22c55e' : '#ef4444';
  const statusLabel  = isSuccess ? 'Payment Successful' : 'Payment Failed';
  const reasonText   = responseReason || (isSuccess ? 'Transaction approved' : 'Transaction declined');

  // Build detail rows
  const rowDefs = [
    { lbl: 'Transaction ID',          val: tx.txnId,                             type: 'mono'   },
    { lbl: 'Order Reference',         val: tx.orderRef,                          type: 'mono'   },
    { lbl: 'Amount',                  val: amountFormatted,                      type: 'amount' },
    ...(isSuccess ? [{ lbl: 'Authorization Code', val: finalResult?.authorizationCode || '—', type: 'mono' }] : []),
    { lbl: 'Reference Number (RRN)',  val: finalResult?.referenceNumber || '—',  type: 'mono'   },
    { lbl: 'Response Code',           val: responseCode || '—',                  type: 'mono'   },
    { lbl: 'Response Description',    val: reasonText,                           type: 'text'   },
    { lbl: 'Merchant ID',             val: tx.merchantId || '—',                 type: 'mono'   },
    ...(tx.customerName ? [{ lbl: 'Customer Name', val: tx.customerName, type: 'text' }] : []),
    { lbl: 'Transaction Date & Time', val: txDate,                               type: 'text'   },
    { lbl: 'Payment Status',          val: paymentStatus,                        type: 'status' },
  ];

  const tableRows = rowDefs.map(r => {
    const valStyle =
      r.type === 'mono'   ? 'font-family:Consolas,monospace;color:#1e293b' :
      r.type === 'amount' ? 'font-size:20px;font-weight:700;color:' + accentColor :
      r.type === 'status' ? 'font-weight:700;color:' + statusColor :
      'color:#1e293b';
    return '<tr>' +
      '<td style="padding:11px 14px 11px 0;font-size:12.5px;font-weight:600;color:#64748b;' +
        'border-bottom:1px solid #f1f5f9;width:42%;vertical-align:top">' + escapeHtml(r.lbl) + '</td>' +
      '<td style="padding:11px 0;font-size:13px;word-break:break-word;border-bottom:1px solid #f1f5f9;' +
        'vertical-align:top;' + valStyle + '">' + escapeHtml(String(r.val || '—')) + '</td>' +
      '</tr>';
  }).join('');

  // Payload for client-side receipt download (JSON-safe)
  const receiptPayload = JSON.stringify({
    isSuccess,
    statusLabel,
    accentColor,
    statusColor,
    statusBg,
    statusBorder,
    iconBg,
    txnId:        tx.txnId || '',
    orderRef:     tx.orderRef || '',
    amount:       amountFormatted,
    authCode:     (isSuccess ? finalResult?.authorizationCode : '') || '',
    rrn:          finalResult?.referenceNumber || '',
    responseCode: responseCode || '',
    responseReason: reasonText,
    merchantId:   tx.merchantId || '',
    customerName: tx.customerName || '',
    txDate,
    status:       paymentStatus,
  }).replace(/<\/script>/gi, '<\\/script>');

  const homeButtonHtml = isPaymentLinkFlow
    ? ''
    : `<a class="btn btn-home" href="${escapeHtml(homeUrl)}">&#8592;&nbsp;Back to Home</a>`;

  return `<!doctype html><html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Payment Receipt \u2014 ${escapeHtml(tx.txnId)}</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;}
    body{margin:0;padding:32px 16px;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif;color:#1e293b;min-height:100vh;}
    .wrap{max-width:660px;margin:0 auto;}
    /* ── Card ── */
    .card{background:#fff;border-radius:16px;box-shadow:0 20px 60px rgba(15,45,94,.12);overflow:hidden;}
    /* ── Merchant letterhead ── */
    .letterhead{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:22px 28px;border-bottom:1px solid #e2e8f0;}
    .brand-logo{max-height:56px;max-width:200px;object-fit:contain;}
    .brand-name{font-size:24px;font-weight:700;color:#2f7a3d;font-family:Georgia,'Times New Roman',serif;}
    .brand-address{text-align:right;font-size:12.5px;color:#334155;line-height:1.5;}
    .brand-address .addr-name{font-weight:700;}
    /* ── Status banner ── */
    .sbanner{background:${statusBg};border-bottom:2px solid ${statusBorder};
      padding:24px 28px;display:flex;align-items:center;gap:18px;}
    .sicon{width:54px;height:54px;flex-shrink:0;border-radius:50%;background:${iconBg};color:#fff;
      display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:700;
      box-shadow:0 6px 18px ${iconBg}55;}
    .slabel{font-size:21px;font-weight:700;color:${statusColor};}
    .stxn{font-size:12px;color:#64748b;margin-top:3px;}
    /* ── Details ── */
    .body{padding:22px 28px;}
    .sec-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.9px;color:#94a3b8;
      margin-bottom:14px;padding-bottom:8px;border-bottom:1px solid #e2e8f0;}
    table{width:100%;border-collapse:collapse;}
    /* ── Action buttons ── */
    .actions{padding:18px 28px 22px;display:flex;gap:10px;flex-wrap:wrap;}
    .btn{flex:1;min-width:130px;display:inline-flex;align-items:center;justify-content:center;gap:7px;
      padding:11px 16px;border-radius:10px;font-size:13.5px;font-weight:600;cursor:pointer;
      border:none;text-decoration:none;transition:opacity .15s,transform .1s;}
    .btn:active{transform:scale(.97);}
    .btn-dl{background:${accentColor};color:#fff;}
    .btn-dl:hover{opacity:.88;}
    .btn-print{background:#f1f5f9;color:#334155;border:1px solid #cbd5e1;}
    .btn-print:hover{background:#e2e8f0;}
    .btn-home{background:#2f7a3d;color:#fff;}
    .btn-home:hover{background:#256030;}
    /* ── Footer ── */
    .ftr{padding:14px 28px 18px;background:#f8fafc;border-top:1px solid #e2e8f0;
      font-size:11px;color:#94a3b8;text-align:center;line-height:1.7;}
    /* ── Print styles ── */
    @media print{
      body{background:#fff;padding:0;}
      .wrap{max-width:100%;}
      .card{box-shadow:none;border-radius:0;}
      .actions{display:none!important;}
      .ftr{font-size:9px;}
      @page{margin:12mm;}
    }
    @media(max-width:580px){
      .letterhead,.body,.actions,.ftr{padding-left:16px;padding-right:16px;}
      .sbanner{padding-left:16px;padding-right:16px;}
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="letterhead">
        <div>
          ${logoUrl ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(merchantName)}" class="brand-logo" />` : `<div class="brand-name">${escapeHtml(merchantName)}</div>`}
        </div>
        <div class="brand-address">
          <div class="addr-name">${escapeHtml(merchantName)}</div>
          ${addressLines.map(line => `<div>${escapeHtml(line)}</div>`).join('')}
        </div>
      </div>
      <div class="sbanner">
        <div class="sicon">${isSuccess ? '&#10004;' : '&#10008;'}</div>
        <div>
          <div class="slabel">${escapeHtml(statusLabel)}</div>
          <div class="stxn">Transaction ID: ${escapeHtml(tx.txnId)}</div>
        </div>
      </div>
      <div class="body">
        ${isSuccess && customSuccessMessage ? `<div style="margin-bottom:16px;padding:12px;border-radius:10px;background:#ecfdf5;border:1px solid #6ee7b7;color:#065f46;font-size:13.5px">${escapeHtml(customSuccessMessage)}</div>` : ''}
        <div class="sec-title">Transaction Details</div>
        <table>${tableRows}</table>
      </div>
      <div class="actions">
        <button class="btn btn-dl" onclick="downloadReceiptPdf()">&#8659;&nbsp;Download PDF Receipt</button>
        <button class="btn btn-print" onclick="window.print()">&#128438;&nbsp;Print Receipt</button>
        ${homeButtonHtml}
      </div>
      <div class="ftr">
        This is an official electronic receipt issued on behalf of ${escapeHtml(merchantName)} via the Secure Payment Gateway.<br>
        Retain a copy for your records. For disputes or queries, share this receipt with the merchant or portal owner.
      </div>
    </div>
  </div>
  <script>
    var R=${receiptPayload};
    function downloadReceiptPdf(){
      if (!R || !R.txnId) return;
      window.location.href = '/api/receipt.pdf?txnId=' + encodeURIComponent(R.txnId);
    }
  </script>
</body></html>`;
}

async function generateReceiptPdfBuffer(tx, paymentStatus, finalResult) {
  const isSuccess = paymentStatus === 'SUCCESS';
  const responseCode = String(finalResult?.responseCode || '').trim();
  const responseReason = getResponseReasonFromCode(responseCode, finalResult?.responseReason || '');
  const CURRENCY_NAMES = {
    '840': 'USD', '356': 'INR', '064': 'BTN', '524': 'NPR', '144': 'LKR',
    '586': 'PKR', '050': 'BDT', '702': 'SGD', '978': 'EUR', '826': 'GBP',
    '036': 'AUD', '124': 'CAD', '392': 'JPY', '156': 'CNY', '410': 'KRW',
  };

  const currencyCode = tx?.currency || '';
  const currencyDisplay = CURRENCY_NAMES[currencyCode] || currencyCode || '';
  const amountFormatted = tx?.amountMajor
    ? `${currencyDisplay ? `${currencyDisplay} ` : ''}${Number.parseFloat(tx.amountMajor).toFixed(2)}`
    : '—';

  const txDate = tx?.createdAt
    ? new Date(tx.createdAt).toLocaleString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
      })
    : new Date().toLocaleString('en-GB');

  const rows = [
    ['Transaction ID', tx.txnId || '—'],
    ['Order Reference', tx.orderRef || '—'],
    ['Amount', amountFormatted],
    ...(isSuccess ? [['Authorization Code', finalResult?.authorizationCode || '—']] : []),
    ['Reference Number (RRN)', finalResult?.referenceNumber || '—'],
    ['Response Code', responseCode || '—'],
    ['Response Description', responseReason || (isSuccess ? 'Transaction approved' : 'Transaction declined')],
    ['Merchant ID', tx.merchantId || '—'],
    ...(tx.customerName ? [['Customer Name', tx.customerName]] : []),
    ['Transaction Date & Time', txDate],
    ['Payment Status', paymentStatus],
  ];

  return await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const accent = isSuccess ? '#059669' : '#dc2626';

    doc.fillColor('#0f2d5e').font('Helvetica-Bold').fontSize(18).text('Secure Payment Gateway');
    doc.moveDown(0.2);
    doc.fillColor('#64748b').font('Helvetica').fontSize(10).text('Official Electronic Payment Receipt');
    doc.moveDown(1);

    doc.fillColor(accent).font('Helvetica-Bold').fontSize(14).text(isSuccess ? 'Payment Successful' : 'Payment Failed');
    doc.moveDown(0.3);
    doc.fillColor('#334155').font('Helvetica').fontSize(10).text(`Transaction ID: ${tx.txnId || '—'}`);
    doc.moveDown(1);

    const startX = doc.x;
    let y = doc.y;
    const labelWidth = 190;
    const valueX = startX + labelWidth;
    const rowGap = 8;

    for (const [label, value] of rows) {
      doc.fillColor('#64748b').font('Helvetica-Bold').fontSize(10).text(label, startX, y, { width: labelWidth - 10 });
      doc.fillColor('#111827').font('Helvetica').fontSize(10).text(String(value || '—'), valueX, y, { width: 320 });
      y = Math.max(doc.y, y) + rowGap;
      doc.moveTo(startX, y - 4).lineTo(545, y - 4).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
    }

    doc.moveDown(1.2);
    doc.fillColor('#94a3b8').font('Helvetica').fontSize(9)
      .text('This is an official electronic receipt issued by the Secure Payment Gateway.', 50, y + 14)
      .text('Retain a copy for your records. For disputes, share this receipt with the merchant or portal owner.');

    doc.end();
  });
}

async function resolveLogoBuffer(logoUrl) {
  const url = String(logoUrl || '').trim();
  if (!url) return null;

  try {
    if (url.startsWith('data:')) {
      const match = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/i.exec(url);
      return match ? Buffer.from(match[1], 'base64') : null;
    }
    if (/^https?:\/\//i.test(url)) {
      const res = await fetch(url);
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    }
  } catch {
    return null;
  }
  return null;
}

async function generateInvoicePdfBuffer(invoice, merchantProfile = null) {
  const CURRENCY_NAMES = {
    '840': 'USD', '356': 'INR', '064': 'BTN', '524': 'NPR', '144': 'LKR',
    '586': 'PKR', '050': 'BDT', '702': 'SGD', '978': 'EUR', '826': 'GBP',
    '036': 'AUD', '124': 'CAD', '392': 'JPY', '156': 'CNY', '410': 'KRW',
  };
  const currencyDisplay = CURRENCY_NAMES[invoice.currency] || invoice.currency || '';
  const amountFormatted = `${currencyDisplay ? `${currencyDisplay} ` : ''}${Number.parseFloat(invoice.amount || 0).toFixed(2)}`;

  const fmtDate = (iso) => {
    try {
      return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    } catch {
      return iso || '—';
    }
  };

  const rows = [
    ['Invoice Number', invoice._id],
    ['Invoice Date', fmtDate(invoice.invoiceDate)],
    ['Due Date', fmtDate(invoice.dueDate)],
    ['Amount', amountFormatted],
    ['Customer Name', invoice.customerName || '—'],
    ['Merchant', invoice.merchantName || '—'],
    ['Status', String(invoice.status || 'pending').toUpperCase()],
  ];

  const logoBuffer = await resolveLogoBuffer(merchantProfile?.logoUrl);

  return await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    let logoRendered = false;
    if (logoBuffer) {
      try {
        const imgY = doc.y;
        doc.image(logoBuffer, doc.x, imgY, { fit: [140, 50] });
        doc.y = imgY + 55;
        logoRendered = true;
      } catch {
        logoRendered = false;
      }
    }

    if (!logoRendered) {
      doc.fillColor('#0f2d5e').font('Helvetica-Bold').fontSize(18).text(invoice.merchantName || 'Invoice');
      doc.moveDown(0.2);
    }
    doc.fillColor('#64748b').font('Helvetica').fontSize(10).text('Payment Invoice');
    doc.moveDown(1.2);

    const startX = doc.x;
    let y = doc.y;
    const labelWidth = 190;
    const valueX = startX + labelWidth;
    const rowGap = 8;

    for (const [label, value] of rows) {
      doc.fillColor('#64748b').font('Helvetica-Bold').fontSize(10).text(label, startX, y, { width: labelWidth - 10 });
      doc.fillColor('#111827').font('Helvetica').fontSize(10).text(String(value || '—'), valueX, y, { width: 320 });
      y = Math.max(doc.y, y) + rowGap;
      doc.moveTo(startX, y - 4).lineTo(545, y - 4).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
    }

    if (invoice.customerMessage) {
      doc.moveDown(1);
      doc.fillColor('#334155').font('Helvetica-Bold').fontSize(10).text('Message');
      doc.fillColor('#111827').font('Helvetica').fontSize(9).text(invoice.customerMessage, { width: 495 });
    }

    if (invoice.termsAndConditions) {
      doc.moveDown(1);
      doc.fillColor('#334155').font('Helvetica-Bold').fontSize(10).text('Terms & Conditions');
      doc.fillColor('#475569').font('Helvetica').fontSize(9).text(invoice.termsAndConditions, { width: 495 });
    }

    doc.moveDown(1.2);
    doc.fillColor('#94a3b8').font('Helvetica').fontSize(9)
      .text('This invoice was generated by the Secure Payment Gateway merchant portal.');

    doc.end();
  });
}

async function generateTransactionReceiptPdfBuffer(tx, merchantProfile = null) {
  const CURRENCY_NAMES = {
    '840': 'USD', '356': 'INR', '064': 'BTN', '524': 'NPR', '144': 'LKR',
    '586': 'PKR', '050': 'BDT', '702': 'SGD', '978': 'EUR', '826': 'GBP',
    '036': 'AUD', '124': 'CAD', '392': 'JPY', '156': 'CNY', '410': 'KRW',
  };
  const currencyDisplay = CURRENCY_NAMES[tx.currency] || tx.currency || '';
  const amountFormatted = `${currencyDisplay ? `${currencyDisplay} ` : ''}${Number.parseFloat(tx.amountMajor || 0).toFixed(2)}`;

  const fmtDateTime = (iso) => {
    try {
      return new Date(iso).toLocaleString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
      });
    } catch {
      return iso || '—';
    }
  };

  const rows = [
    ['Transaction ID', tx._id],
    ['Order Reference', tx.orderRef || '—'],
    ['Amount', amountFormatted],
    ['Authorization Code', tx.authorizationCode || '—'],
    ['Reference Number (RRN)', tx.referenceNumber || '—'],
    ['Response Code', tx.responseCode || '—'],
    ['Response Description', tx.responseReason || '—'],
    ['Merchant ID', tx.merchantId || '—'],
    ['Customer Name', tx.customerName || '—'],
    ['Transaction Date & Time', fmtDateTime(tx.resolvedAt)],
    ['Payment Status', String(tx.status || '').toUpperCase()],
  ];

  const logoBuffer = await resolveLogoBuffer(merchantProfile?.logoUrl);

  return await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    let logoRendered = false;
    if (logoBuffer) {
      try {
        const imgY = doc.y;
        doc.image(logoBuffer, doc.x, imgY, { fit: [140, 50] });
        doc.y = imgY + 55;
        logoRendered = true;
      } catch {
        logoRendered = false;
      }
    }

    if (!logoRendered) {
      doc.fillColor('#0f2d5e').font('Helvetica-Bold').fontSize(18).text(merchantProfile?.merchantName || tx.username || 'Receipt');
      doc.moveDown(0.2);
    }
    doc.fillColor('#64748b').font('Helvetica').fontSize(10).text('Receipt');
    doc.moveDown(1.2);

    const startX = doc.x;
    let y = doc.y;
    const labelWidth = 190;
    const valueX = startX + labelWidth;
    const rowGap = 8;

    for (const [label, value] of rows) {
      doc.fillColor('#64748b').font('Helvetica-Bold').fontSize(10).text(label, startX, y, { width: labelWidth - 10 });
      doc.fillColor('#111827').font('Helvetica').fontSize(10).text(String(value || '—'), valueX, y, { width: 320 });
      y = Math.max(doc.y, y) + rowGap;
      doc.moveTo(startX, y - 4).lineTo(545, y - 4).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
    }

    doc.moveDown(1.2);
    doc.fillColor('#94a3b8').font('Helvetica').fontSize(9)
      .text('This receipt was generated by the Secure Payment Gateway merchant portal.');

    doc.end();
  });
}

async function handleReceiptPdf(req, res) {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const txnId = String(u.searchParams.get('txnId') || '').trim();

  if (!txnId) {
    return html(res, 400, renderMessagePage('Invalid request', 'txnId is required to download receipt.'));
  }

  const tx = await getTransaction(txnId);
  if (!tx) {
    return html(res, 404, renderMessagePage('Transaction not found', 'No transaction record found for this reference.', { txnId }));
  }

  const callbackReceived = !!tx.callback;
  const callbackResultTrusted = !tx.macVerification?.hasMac || !!tx.macVerification?.macVerified;
  let finalResult = tx.finalResult;

  if (finalResult?.source === 'callback' && !callbackResultTrusted) {
    finalResult = null;
  }

  if (!finalResult && callbackResultTrusted) {
    finalResult = buildFinalResultRecord({
      fields: tx.callback?.fields,
      source: 'callback',
      resolvedAt: tx.callback?.receivedAt,
    });
  }

  const effectiveStatus = mapTransactionLifecycleStatus({
    callbackReceived,
    finalResult,
  });

  if (effectiveStatus === 'PENDING') {
    return html(
      res,
      202,
      renderMessagePage('Payment processing', 'Payment is still processing. Try downloading receipt after completion.', {
        txnId,
        status: effectiveStatus,
      })
    );
  }

  const safeTxnId = String(tx.txnId || '').replace(/[^a-zA-Z0-9_-]/g, '') || 'transaction';
  const pdfBuffer = await generateReceiptPdfBuffer(tx, effectiveStatus, finalResult);

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="payment-receipt-${safeTxnId}.pdf"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', String(pdfBuffer.length));
  return res.end(pdfBuffer);
}

function renderDeveloperHome(baseUrl) {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Cardzone Payment Backend</title></head>
<body style="font-family:Arial,sans-serif;padding:24px">
  <h1>Cardzone payment backend is running</h1>
  <p>This deployment is backend-only. Customer checkout UI must be hosted on merchant website.</p>
  <ul>
    <li>POST ${escapeHtml(baseUrl)}/api/initiate</li>
    <li>POST ${escapeHtml(baseUrl)}/callback</li>
    <li>GET/POST ${escapeHtml(baseUrl)}/return</li>
    <li>GET ${escapeHtml(baseUrl)}/health</li>
  </ul>
</body>
</html>`;
}

function renderLoginPage(baseUrl, errorMessage = '') {
  const safeError = escapeHtml(String(errorMessage || '').trim());
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Merchant Login</title>
  <style>
    :root{--bg:#eef3fb;--card:#fff;--text:#10213a;--muted:#5f6f86;--brand:#0f2d5e;--brand2:#1a4a8a;--accent:#165dff;--border:#d9e3f3}
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:linear-gradient(180deg,#f8fbff 0%, var(--bg) 100%);font-family:Segoe UI,Arial,sans-serif;color:var(--text);padding:20px}
    .card{width:100%;max-width:440px;background:var(--card);border:1px solid var(--border);border-radius:16px;box-shadow:0 16px 40px rgba(16,33,58,.1);overflow:hidden}
    .head{background:linear-gradient(135deg,var(--brand) 0%,var(--brand2) 100%);padding:18px 20px;color:#fff}
    .head h1{margin:0;font-size:20px}
    .head p{margin:6px 0 0;opacity:.85;font-size:12.5px}
    .body{padding:20px}
    label{display:block;font-size:12.5px;font-weight:700;margin:0 0 6px;color:#2c3f5f}
    input{width:100%;border:1px solid #cfdced;border-radius:10px;padding:11px 12px;margin-bottom:12px;font-size:14px;outline:none}
    input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(22,93,255,.12)}
    button{width:100%;border:0;border-radius:10px;padding:12px 16px;background:linear-gradient(180deg,var(--accent),#0e4bd4);color:#fff;font-weight:700;cursor:pointer}
    .error{margin:0 0 12px;padding:10px;border-radius:10px;background:#fff2f2;border:1px solid #ffd2d2;color:#8b2323;font-size:12.5px}
    .tiny{margin-top:10px;color:var(--muted);font-size:12px}
  </style>
</head>
<body>
  <section class="card">
    <div class="head">
      <h1>Merchant Login</h1>
      <p>Sign in to open your mapped payment portal.</p>
    </div>
    <div class="body">
      ${safeError ? `<p class="error">${safeError}</p>` : ''}
      <form id="loginForm" method="post" action="/api/login" autocomplete="on">
        <label for="username">Username</label>
        <input id="username" name="username" required placeholder="Enter username" />
        <label for="password">Password</label>
        <input id="password" name="password" type="password" required placeholder="Enter password" />
        <button id="loginBtn" type="submit">Login</button>
      </form>
      <div class="tiny">Gateway: ${escapeHtml(baseUrl)}</div>
    </div>
  </section>
  <script>
    (function () {
      const form = document.getElementById('loginForm');
      const loginBtn = document.getElementById('loginBtn');
      form.addEventListener('submit', async function (event) {
        event.preventDefault();
        loginBtn.disabled = true;
        loginBtn.textContent = 'Signing in...';
        try {
          const formData = new FormData(form);
          const payload = {
            username: String(formData.get('username') || '').trim(),
            password: String(formData.get('password') || '')
          };

          const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify(payload)
          });

          const data = await res.json().catch(function () { return {}; });
          if (!res.ok) {
            throw new Error(data.error || 'Invalid username or password.');
          }

          window.location.href = '/portal';
        } catch (error) {
          window.alert(error.message || 'Unable to login.');
          loginBtn.disabled = false;
          loginBtn.textContent = 'Login';
        }
      });
    })();
  </script>
</body>
</html>`;
}

function renderMerchantPortalPage(baseUrl, sessionView, portalModel) {
  const safeSessionJson = JSON.stringify(sessionView || {}).replace(/</g, '\\u003c');
  const safePortalJson = JSON.stringify(portalModel || {}).replace(/</g, '\\u003c');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Merchant Portal</title>
  <style>
    :root{--sidebar:#111827;--sidebar2:#1f2937;--text:#0f172a;--muted:#64748b;--bg:#f8fafc;--card:#ffffff;--line:#e2e8f0;--accent:#2563eb}
    *{box-sizing:border-box}
    body{margin:0;font-family:Segoe UI,Arial,sans-serif;background:var(--bg);color:var(--text)}
    .app{display:grid;grid-template-columns:290px 1fr;min-height:100vh}
    .sidebar{background:linear-gradient(180deg,var(--sidebar),var(--sidebar2));color:#e5e7eb;padding:18px 14px;overflow:auto}
    .brand{font-weight:800;font-size:17px;letter-spacing:.2px;margin:2px 8px 16px}
    .menu-group{margin:8px 0}
    .menu-head,.menu-item{width:100%;text-align:left;border:0;background:transparent;color:#dbe2ee;padding:9px 10px;border-radius:8px;cursor:pointer;font-size:13.5px}
    .menu-head{font-weight:700;color:#fff}
    .menu-item{padding-left:22px;color:#c9d4e6}
    .menu-head:hover,.menu-item:hover,.menu-item.active{background:rgba(255,255,255,.08)}
    .submenu{display:grid;gap:4px;margin-top:4px}

    .content{padding:22px 22px 26px}
    .topbar{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:16px}
    .title{margin:0;font-size:24px}
    .subtitle{margin:4px 0 0;color:var(--muted);font-size:13px}
    .actions{display:flex;gap:8px;flex-wrap:wrap}
    .btn{border:1px solid var(--line);background:#fff;color:#1f2f49;border-radius:8px;padding:9px 12px;font-size:12.5px;font-weight:700;cursor:pointer}
    .btn.primary{background:var(--accent);color:#fff;border-color:var(--accent)}

    .section{display:none}
    .section.active{display:block}
    .grid{display:grid;grid-template-columns:repeat(12,1fr);gap:14px}
    .card{grid-column:span 12;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
    .card h3{margin:0;padding:12px 14px;border-bottom:1px solid var(--line);font-size:15px}
    .card-body{padding:12px 14px}
    .kv{display:grid;grid-template-columns:220px 1fr;border-top:1px solid var(--line)}
    .kv:first-child{border-top:0}
    .kv div{padding:9px 10px;font-size:13px}
    .kv .k{background:#f8fafc;color:#475569;font-weight:700}
    .kv input:not([type=checkbox]),.kv select,.kv textarea{width:100%;border:1px solid var(--line);border-radius:8px;padding:7px 9px;font-size:13px;font-family:inherit}
    .kv input[type=checkbox]{width:auto;margin-right:6px;vertical-align:middle}
    .kv textarea{resize:vertical}
    .status-pill{display:inline-block;padding:3px 10px;border-radius:999px;font-size:11.5px;font-weight:700;color:#fff}
    .status-pill.paid{background:#16a34a}
    .status-pill.pending{background:#f59e0b}
    .status-pill.failed{background:#dc2626}
    .status-pill.expired{background:#64748b}
    .row-icon-btn{border:0;background:transparent;cursor:pointer;font-size:15px;padding:2px 4px;line-height:1}
    .row-icon-btn:hover{opacity:.7}
    .detail-modal{position:fixed;inset:0;background:rgba(15,23,42,.5);display:flex;align-items:center;justify-content:center;padding:20px;z-index:50}
    .detail-modal-inner{background:#fff;border-radius:12px;max-width:520px;width:100%;max-height:80vh;display:flex;flex-direction:column;padding:20px}
    .detail-modal-head{display:flex;align-items:center;gap:10px;margin-bottom:12px}
    .detail-modal-head h3{margin:0;font-size:16px}
    .detail-modal-body{overflow:auto;flex:1}
    .detail-modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}
    .form-actions{padding:12px 10px;display:flex;align-items:center;gap:10px}
    .credential-box{display:none;margin-top:10px;padding:10px;border:1px solid var(--line);border-radius:8px;background:#f8fafc}
    .credential-body{margin-top:6px;font-family:monospace;font-size:13px}
    .logo{height:52px;width:auto;max-width:180px;object-fit:contain}
    .muted{color:var(--muted)}
    .list{margin:0;padding-left:18px;color:#334155;font-size:13px;display:grid;gap:6px}

    .col-6{grid-column:span 6}
    .col-4{grid-column:span 4}
    .col-3{grid-column:span 3}
    .col-8{grid-column:span 8}
    .col-12{grid-column:span 12}

    .dash-header{display:flex;align-items:center;gap:14px}
    .dash-header .logo{max-height:52px;max-width:180px;object-fit:contain}
    .stat-tile{padding:2px}
    .stat-label{font-size:11.5px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.4px}
    .stat-value{font-size:24px;font-weight:800;margin-top:6px;color:#0f172a}
    .stat-value.good{color:#16a34a}
    .stat-value.warn{color:#f59e0b}

    @media (max-width:1080px){
      .app{grid-template-columns:1fr}
      .sidebar{position:sticky;top:0;max-height:42vh;z-index:2}
      .col-6,.col-4,.col-3,.col-8{grid-column:span 12}
      .kv{grid-template-columns:1fr}
    }
  </style>
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <div class="brand">Merchant Portal</div>

      <div class="menu-group">
        <button class="menu-head nav-btn" data-target="dashboard">User Dashboard</button>
      </div>

      <div class="menu-group">
        <button class="menu-head">Invoices</button>
        <div class="submenu">
          <button class="menu-item nav-btn" data-target="invoices-create">Create Invoice</button>
          <button class="menu-item nav-btn" data-target="invoices-all">View All Invoices</button>
          <button class="menu-item nav-btn" data-target="invoices-payments">View My Payments</button>
          <button class="menu-item nav-btn" data-target="invoices-emails">View Emails Sent</button>
        </div>
      </div>

      ${sessionView?.role === 'developer' ? `
      <div class="menu-group">
        <button class="menu-head">Developer Tools</button>
        <div class="submenu">
          <button class="menu-item nav-btn" data-target="developer-add-merchant">Add New Merchant</button>
          <button class="menu-item nav-btn" data-target="developer-merchants-list">All Merchants</button>
        </div>
      </div>
      ` : ''}

      <div class="menu-group">
        <button class="menu-head">My Account</button>
        <div class="submenu">
          <button class="menu-item nav-btn" data-target="merchant-profile">Merchant Profile</button>
          <button class="menu-item nav-btn" data-target="account-password">Change Password</button>
          <button class="menu-item nav-btn" data-target="account-edit">Edit Username</button>
          <button class="menu-item" id="logoutBtn">Logout</button>
        </div>
      </div>
    </aside>

    <main class="content">
      <div class="topbar">
        <div>
          <h1 class="title">Welcome, <span id="welcomeName"></span></h1>
          <p class="subtitle">Create and track invoices, and manage your merchant profile from one place.</p>
        </div>
        <div class="actions">
          <button class="btn primary" id="topbarLogoutBtn">Logout</button>
        </div>
      </div>

      <section class="section active" id="dashboard">
        <div class="dash-header">
          <img id="dashLogo" class="logo" alt="Merchant Logo" style="display:none" />
          <div>
            <h2 id="dashWelcome" style="margin:0;font-size:22px"></h2>
            <div class="muted" style="font-size:12.5px;margin-top:2px">Here's how your business is doing</div>
          </div>
        </div>

        <div class="grid" style="margin-top:16px">
          <article class="card col-3"><div class="card-body stat-tile"><div class="stat-label">Total Revenue</div><div class="stat-value" id="statRevenue">—</div></div></article>
          <article class="card col-3"><div class="card-body stat-tile"><div class="stat-label">Paid</div><div class="stat-value good" id="statPaid">—</div></div></article>
          <article class="card col-3"><div class="card-body stat-tile"><div class="stat-label">Pending</div><div class="stat-value warn" id="statPending">—</div></div></article>
          <article class="card col-3"><div class="card-body stat-tile"><div class="stat-label">Success Rate</div><div class="stat-value" id="statSuccessRate">—</div></div></article>
        </div>

        <article class="card" style="margin-top:14px">
          <h3>Revenue Chart (30 Days)</h3>
          <div class="card-body"><div id="revenueChart"></div></div>
        </article>

        <article class="card" style="margin-top:14px">
          <h3>Recent Payments</h3>
          <div class="card-body">
            <table style="width:100%;border-collapse:collapse;font-size:13px">
              <thead><tr style="text-align:left;border-bottom:1px solid var(--line)"><th style="padding:6px">Transaction</th><th style="padding:6px">Customer</th><th style="padding:6px">Amount</th><th style="padding:6px">Status</th><th style="padding:6px">Date</th></tr></thead>
              <tbody id="recentPaymentsBody"><tr><td class="muted" style="padding:6px" colspan="5">Loading...</td></tr></tbody>
            </table>
          </div>
        </article>

        <div class="grid" style="margin-top:14px">
          <article class="card col-6">
            <h3>Pending Actions</h3>
            <div class="card-body" id="pendingActionsBody">Loading...</div>
          </article>
          <article class="card col-6">
            <h3>Gateway Status</h3>
            <div class="card-body" id="gatewayStatusBody">Loading...</div>
          </article>
        </div>

        <article class="card" style="margin-top:14px">
          <h3>Quick Actions</h3>
          <div class="card-body" style="display:flex;gap:10px;flex-wrap:wrap">
            <button class="btn primary" type="button" data-quick-nav="invoices-create">Create Invoice</button>
            <button class="btn" type="button" data-quick-nav="invoices-all">View All Invoices</button>
            <button class="btn" type="button" data-quick-nav="merchant-profile">Edit Merchant Profile</button>
            <button class="btn" type="button" data-quick-nav="account-password">Change Password</button>
          </div>
        </article>
      </section>

      <section class="section" id="merchant-profile">
        <div class="grid">
          <article class="card col-8">
            <h3>Merchant Profile</h3>
            <div class="card-body">
              <form id="merchantEditForm">
                <div class="kv"><div class="k"><label for="editMerchantName">Merchant Name</label></div><div><input id="editMerchantName" required /></div></div>
                <div class="kv"><div class="k">Logo</div><div>
                  <img id="editLogoPreview" class="logo" alt="Logo preview" style="display:none;margin-bottom:8px" />
                  <input id="editLogoFile" type="file" accept="image/*" />
                  <input id="editLogoUrl" placeholder="or paste an image https:// URL" style="margin-top:6px" />
                </div></div>
                <div class="kv"><div class="k"><label for="editAddress">Address</label></div><div><textarea id="editAddress" rows="3" placeholder="One line per address line"></textarea></div></div>
                <div class="kv"><div class="k"><label for="editEmail">Email Address</label></div><div><input id="editEmail" type="email" /></div></div>
                <div class="kv"><div class="k"><label for="editPhone">Phone Number</label></div><div><input id="editPhone" /></div></div>
                <div class="kv"><div class="k">Invoice Settings</div><div>
                  <label style="display:block;margin-bottom:4px;font-weight:400"><input type="checkbox" id="editUseCustomerNames" /> Use Customer Name in Invoice</label>
                  <label style="display:block;margin-bottom:4px;font-weight:400"><input type="checkbox" id="editSendInvoiceViaEmail" /> Send Invoice via Email</label>
                  <label style="display:block;font-weight:400"><input type="checkbox" id="editAllowExternalPayments" /> Accept External Payments</label>
                </div></div>
                <div class="kv"><div class="k"><label for="editPaymentMessage">Default Payment Message</label></div><div>
                  <textarea id="editPaymentMessage" rows="3"></textarea>
                  <div class="muted" style="font-size:11.5px;margin-top:3px">Shown to customer on payment page. Used when an invoice doesn't set its own message.</div>
                </div></div>
                <div class="kv"><div class="k"><label for="editSuccessMessage">Default Payment Success Message</label></div><div>
                  <textarea id="editSuccessMessage" rows="3"></textarea>
                  <div class="muted" style="font-size:11.5px;margin-top:3px">Shown to customer after a successful payment.</div>
                </div></div>
                <div class="kv"><div class="k"><label for="editTerms">Terms &amp; Conditions</label></div><div>
                  <textarea id="editTerms" rows="3"></textarea>
                  <div class="muted" style="font-size:11.5px;margin-top:3px">Shown on the payment page and linked from every invoice.</div>
                </div></div>
                <div class="form-actions"><button class="btn primary" type="submit">Save Merchant Profile</button><span id="merchantEditMsg" class="muted"></span></div>
              </form>
            </div>
          </article>

          <article class="card col-4">
            <h3>Gateway Mapping</h3>
            <div class="card-body">
              <div class="kv"><div class="k">USD Merchant ID</div><div id="usdMid"></div></div>
              <div class="kv"><div class="k">INR Merchant ID</div><div id="inrMid"></div></div>
              <div class="muted" style="margin-top:10px;font-size:12px">Gateway merchant IDs are managed by your developer/admin and shown here read-only.</div>
            </div>
          </article>
        </div>
      </section>

      <section class="section" id="invoices-create">
        <div class="grid">
          <article class="card col-8">
            <h3>Create Invoice</h3>
            <div class="card-body">
              <form id="invoiceForm">
                <div class="kv"><div class="k">Invoice No</div><div><input id="invNumberDisplay" readonly placeholder="Auto-generated" /></div></div>
                <div class="kv"><div class="k"><label for="invCustomerName">Customer Name</label></div><div><input id="invCustomerName" required /></div></div>
                <div class="kv" id="invCurrencyWrap" style="display:none"><div class="k"><label for="invCurrency">Currency</label></div><div><select id="invCurrency"></select></div></div>
                <div class="kv"><div class="k"><label for="invAmount">Amount</label></div><div><input id="invAmount" type="number" min="0.01" step="0.01" required /></div></div>
                <div class="kv"><div class="k"><label for="invCustomerMessage">Payment Message</label></div><div>
                  <textarea id="invCustomerMessage" rows="2"></textarea>
                  <div class="muted" style="font-size:11.5px;margin-top:3px">Shown to customer on payment page. Default message will be used if left blank.</div>
                </div></div>
                <div class="form-actions"><button class="btn primary" type="submit">Generate Payment Link</button><span id="invoiceMsg" class="muted"></span></div>
              </form>

              <div id="invoiceResult" style="display:none;margin-top:14px;padding:12px;border:1px solid var(--line);border-radius:8px;background:#f8fafc">
                <div class="muted" style="margin-bottom:6px">Invoice <strong id="invoiceResultNumber"></strong> created</div>
                <input id="invoiceResultLink" readonly style="width:100%;border:1px solid var(--line);border-radius:8px;padding:8px;font-size:12.5px;font-family:monospace" />
                <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
                  <button class="btn" type="button" id="copyInvoiceLinkBtn">Copy Payment Link</button>
                  <a id="downloadInvoicePdfLink" href="#" target="_blank"><button class="btn" type="button">Download PDF Invoice</button></a>
                  <button class="btn" type="button" id="emailInvoiceBtn">Email Invoice</button>
                </div>
              </div>

              <div id="emailInvoicePanel" style="display:none;margin-top:14px;border:1px solid var(--line);border-radius:8px;overflow:hidden">
                <h3 style="margin:0;padding:12px 14px;border-bottom:1px solid var(--line);font-size:15px">Send Invoice to Customer</h3>
                <div style="padding:12px 14px">
                  <div class="muted" style="font-weight:700;margin-bottom:6px">Invoice Details</div>
                  <div class="kv"><div class="k">Invoice No</div><div id="emailInvoiceNumberVal"></div></div>
                  <div class="kv"><div class="k">Customer Name</div><div id="emailInvoiceCustomerVal"></div></div>
                  <div class="kv"><div class="k">Amount</div><div id="emailInvoiceAmountVal"></div></div>
                  <div style="margin-top:14px"><label for="emailInvoiceTo" style="display:block;font-size:12.5px;font-weight:700;margin-bottom:6px">Email address to send invoice to</label><input id="emailInvoiceTo" type="email" /></div>
                  <div style="margin-top:10px"><label for="emailInvoiceMessage" style="display:block;font-size:12.5px;font-weight:700;margin-bottom:6px">Message (Optional)</label><textarea id="emailInvoiceMessage" rows="4"></textarea></div>
                  <div class="form-actions"><button class="btn primary" type="button" id="sendInvoiceEmailBtn">&#9993;&nbsp;Send Invoice</button><span id="emailInvoiceMsg" class="muted"></span></div>
                </div>
              </div>
            </div>
          </article>
        </div>
      </section>

      <section class="section" id="invoices-all">
        <div class="card">
          <h3>View All Invoices</h3>
          <div class="card-body">
            <table style="width:100%;border-collapse:collapse;font-size:13px">
              <thead><tr style="text-align:left;border-bottom:1px solid var(--line)"><th style="padding:6px">Invoice #</th><th style="padding:6px">Date Created</th><th style="padding:6px">Customer</th><th style="padding:6px">Currency</th><th style="padding:6px">Amount</th><th style="padding:6px">Payment Status</th><th style="padding:6px">Created By</th><th style="padding:6px">Actions</th></tr></thead>
              <tbody id="allInvoicesBody"><tr><td class="muted" style="padding:6px" colspan="8">Loading...</td></tr></tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="section" id="invoices-payments">
        <div class="card">
          <h3>View My Payments</h3>
          <div class="card-body">
            <table style="width:100%;border-collapse:collapse;font-size:13px">
              <thead><tr style="text-align:left;border-bottom:1px solid var(--line)"><th style="padding:6px">Transaction ID</th><th style="padding:6px">Customer</th><th style="padding:6px">Amount</th><th style="padding:6px">Status</th><th style="padding:6px">Date</th><th style="padding:6px">Actions</th></tr></thead>
              <tbody id="paymentsTableBody"><tr><td class="muted" style="padding:6px" colspan="6">Loading...</td></tr></tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="section" id="invoices-emails"><div class="card"><h3>View Emails Sent</h3><div class="card-body muted">Coming in the next phase.</div></div></section>

      <section class="section" id="account-password">
        <div class="card">
          <h3>Change Password</h3>
          <div class="card-body">
            <form id="passwordForm">
              <div class="kv"><div class="k"><label for="currentPassword">Current Password</label></div><div><input id="currentPassword" type="password" required /></div></div>
              <div class="kv"><div class="k"><label for="newPassword">New Password</label></div><div><input id="newPassword" type="password" required minlength="8" /></div></div>
              <div class="kv"><div class="k"><label for="confirmPassword">Confirm New Password</label></div><div><input id="confirmPassword" type="password" required minlength="8" /></div></div>
              <div class="form-actions"><button class="btn primary" type="submit">Update Password</button><span id="passwordMsg" class="muted"></span></div>
            </form>
          </div>
        </div>
      </section>

      <section class="section" id="account-edit">
        <div class="card">
          <h3>Edit Username</h3>
          <div class="card-body">
            <form id="usernameForm">
              <div class="kv"><div class="k">Current Username</div><div id="currentUsernameVal"></div></div>
              <div class="kv"><div class="k"><label for="newUsername">New Username</label></div><div><input id="newUsername" required minlength="3" maxlength="40" /></div></div>
              <div class="kv"><div class="k"><label for="usernameCurrentPassword">Current Password</label></div><div><input id="usernameCurrentPassword" type="password" required /></div></div>
              <div class="form-actions"><button class="btn primary" type="submit">Update Username</button><span id="usernameMsg" class="muted"></span></div>
            </form>
          </div>
        </div>
      </section>

      ${sessionView?.role === 'developer' ? `
      <section class="section" id="developer-add-merchant">
        <div class="card">
          <h3>Add New Merchant</h3>
          <div class="card-body">
            <form id="addMerchantForm">
              <div class="kv"><div class="k"><label for="newMerchantUsername">Username</label></div><div><input id="newMerchantUsername" required minlength="3" maxlength="40" /></div></div>
              <div class="kv"><div class="k"><label for="newMerchantDisplayName">Display Name</label></div><div><input id="newMerchantDisplayName" required /></div></div>
              <div class="kv"><div class="k"><label for="newMerchantCompanyName">Company Name</label></div><div><input id="newMerchantCompanyName" /></div></div>
              <div class="kv"><div class="k"><label for="newMerchantEmail">Email</label></div><div><input id="newMerchantEmail" type="email" /></div></div>
              <div class="kv"><div class="k"><label for="newMerchantPhone">Phone</label></div><div><input id="newMerchantPhone" /></div></div>
              <div class="kv"><div class="k">Logo</div><div>
                <img id="newMerchantLogoPreview" class="logo" alt="Logo preview" style="display:none;margin-bottom:8px" />
                <input id="newMerchantLogoFile" type="file" accept="image/*" />
                <input id="newMerchantLogoUrl" placeholder="or paste an image https:// URL" style="margin-top:6px" />
              </div></div>
              <div class="kv"><div class="k">Available Merchant IDs</div><div id="unassignedMidPicker" class="muted">Loading...</div></div>
              <div class="form-actions"><button class="btn primary" type="submit">Create Merchant</button><span id="addMerchantMsg" class="muted"></span></div>
            </form>
            <div id="generatedCredentials" class="credential-box">
              <strong>Save these credentials — shown only once:</strong>
              <div id="generatedCredentialsBody" class="credential-body"></div>
            </div>
          </div>
        </div>
      </section>

      <section class="section" id="developer-merchants-list">
        <div class="card">
          <h3>All Merchants</h3>
          <div class="card-body">
            <table style="width:100%;border-collapse:collapse;font-size:13px">
              <thead><tr style="text-align:left;border-bottom:1px solid var(--line)"><th style="padding:6px">Username</th><th style="padding:6px">Display Name</th><th style="padding:6px">USD MID</th><th style="padding:6px">INR MID</th></tr></thead>
              <tbody id="merchantsTableBody"><tr><td class="muted" style="padding:6px" colspan="4">Loading...</td></tr></tbody>
            </table>
          </div>
        </div>
      </section>
      ` : ''}
    </main>
  </div>

  <div id="detailModal" class="detail-modal" style="display:none">
    <div class="detail-modal-inner">
      <div class="detail-modal-head">
        <img id="detailModalLogo" class="logo" alt="Merchant Logo" style="display:none" />
        <h3 id="detailModalTitle"></h3>
      </div>
      <div id="detailModalBody" class="detail-modal-body"></div>
      <div class="detail-modal-actions">
        <a id="detailModalPdfLink" href="#" target="_blank" style="display:none"><button class="btn primary" type="button">Download PDF</button></a>
        <button class="btn" type="button" id="detailModalCloseBtn">Close</button>
      </div>
    </div>
  </div>

  <script>
    (function () {
      const session = ${safeSessionJson};
      const portal = ${safePortalJson};

      function setText(id, value) {
        const el = document.getElementById(id);
        if (el) el.textContent = value || '—';
      }

      var LOGO_MAX_FILE_BYTES = 1500000;

      function wireLogoUpload(fileInputId, urlInputId, previewId) {
        const fileInput = document.getElementById(fileInputId);
        const urlInput = document.getElementById(urlInputId);
        const preview = document.getElementById(previewId);
        let dataUrl = '';

        function updatePreview(src) {
          if (src) {
            preview.src = src;
            preview.style.display = '';
          } else {
            preview.style.display = 'none';
          }
        }

        fileInput.addEventListener('change', function () {
          const file = fileInput.files && fileInput.files[0];
          if (!file) return;
          if (file.size > LOGO_MAX_FILE_BYTES) {
            window.alert('Image is too large (max ~1.5MB). Please choose a smaller file.');
            fileInput.value = '';
            return;
          }
          const reader = new FileReader();
          reader.onload = function () {
            dataUrl = String(reader.result || '');
            urlInput.value = '';
            updatePreview(dataUrl);
          };
          reader.readAsDataURL(file);
        });

        urlInput.addEventListener('input', function () {
          dataUrl = '';
          updatePreview(urlInput.value.trim());
        });

        return {
          getValue: function () { return dataUrl || urlInput.value.trim(); },
          setInitial: function (url) { updatePreview(url); },
          reset: function () {
            dataUrl = '';
            fileInput.value = '';
            urlInput.value = '';
            updatePreview('');
          }
        };
      }

      document.getElementById('welcomeName').textContent = session.displayName || session.username || 'Merchant';
      document.getElementById('dashWelcome').textContent = 'Welcome, ' + (portal.merchantName || session.displayName || session.username || 'Merchant');
      if (portal.logoUrl) {
        document.getElementById('dashLogo').src = portal.logoUrl;
        document.getElementById('dashLogo').style.display = '';
      }
      setText('usdMid', portal.usdSettings && portal.usdSettings.merchantId);
      setText('inrMid', portal.inrSettings && portal.inrSettings.merchantId);

      function showSection(id) {
        document.querySelectorAll('.section').forEach(function (sec) {
          sec.classList.toggle('active', sec.id === id);
        });
        document.querySelectorAll('.menu-item,.menu-head.nav-btn').forEach(function (btn) {
          btn.classList.toggle('active', btn.getAttribute('data-target') === id);
        });
      }

      document.querySelectorAll('.nav-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          const target = btn.getAttribute('data-target');
          if (target) showSection(target);
        });
      });

      document.body.addEventListener('click', function (event) {
        const quickNavBtn = event.target.closest('[data-quick-nav]');
        if (quickNavBtn) showSection(quickNavBtn.getAttribute('data-quick-nav'));
      });

      async function performLogout() {
        try {
          await fetch('/api/logout', { method: 'POST', headers: { 'Accept': 'application/json' } });
        } finally {
          window.location.href = '/login';
        }
      }

      document.getElementById('logoutBtn').addEventListener('click', performLogout);
      document.getElementById('topbarLogoutBtn').addEventListener('click', performLogout);

      document.getElementById('editMerchantName').value = portal.merchantName || '';
      document.getElementById('editAddress').value = portal.address || '';
      document.getElementById('editEmail').value = portal.email || '';
      document.getElementById('editPhone').value = portal.phone || '';
      document.getElementById('currentUsernameVal').textContent = session.username || '';
      document.getElementById('editUseCustomerNames').checked = !!(portal.settings && portal.settings.useCustomerNames);
      document.getElementById('editSendInvoiceViaEmail').checked = !!(portal.settings && portal.settings.sendInvoiceViaEmail);
      document.getElementById('editAllowExternalPayments').checked = !!(portal.settings && portal.settings.allowExternalPayments);
      document.getElementById('editPaymentMessage').value = (portal.settings && portal.settings.paymentMessage) || '';
      document.getElementById('editSuccessMessage').value = (portal.settings && portal.settings.successfulPaymentMessage) || '';
      document.getElementById('editTerms').value = (portal.settings && portal.settings.termsAndConditions) || '';

      const editLogo = wireLogoUpload('editLogoFile', 'editLogoUrl', 'editLogoPreview');
      editLogo.setInitial(portal.logoUrl || '');

      document.getElementById('merchantEditForm').addEventListener('submit', async function (event) {
        event.preventDefault();
        const msg = document.getElementById('merchantEditMsg');
        msg.textContent = 'Saving...';
        try {
          const res = await fetch('/api/merchant/profile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({
              merchantName: document.getElementById('editMerchantName').value.trim(),
              logoUrl: editLogo.getValue(),
              address: document.getElementById('editAddress').value.trim(),
              email: document.getElementById('editEmail').value.trim(),
              phone: document.getElementById('editPhone').value.trim(),
              useCustomerNames: document.getElementById('editUseCustomerNames').checked,
              sendInvoiceViaEmail: document.getElementById('editSendInvoiceViaEmail').checked,
              allowExternalPayments: document.getElementById('editAllowExternalPayments').checked,
              paymentMessage: document.getElementById('editPaymentMessage').value.trim(),
              successfulPaymentMessage: document.getElementById('editSuccessMessage').value.trim(),
              termsAndConditions: document.getElementById('editTerms').value.trim()
            })
          });
          const data = await res.json().catch(function () { return {}; });
          if (!res.ok) throw new Error(data.error || 'Unable to save profile.');

          msg.textContent = 'Saved.';
          document.getElementById('dashWelcome').textContent = 'Welcome, ' + (data.profile.merchantName || session.username);
          if (data.profile.logoUrl) {
            document.getElementById('dashLogo').src = data.profile.logoUrl;
            document.getElementById('dashLogo').style.display = '';
          } else {
            document.getElementById('dashLogo').style.display = 'none';
          }
          editLogo.setInitial(data.profile.logoUrl || '');
          portal.settings = data.profile.settings;
        } catch (error) {
          msg.textContent = error.message || 'Error saving profile.';
        }
      });

      document.getElementById('passwordForm').addEventListener('submit', async function (event) {
        event.preventDefault();
        const msg = document.getElementById('passwordMsg');
        const newPassword = document.getElementById('newPassword').value;
        const confirmPassword = document.getElementById('confirmPassword').value;
        if (newPassword !== confirmPassword) {
          msg.textContent = 'New password and confirmation do not match.';
          return;
        }
        msg.textContent = 'Saving...';
        try {
          const res = await fetch('/api/account/password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({
              currentPassword: document.getElementById('currentPassword').value,
              newPassword: newPassword
            })
          });
          const data = await res.json().catch(function () { return {}; });
          if (!res.ok) throw new Error(data.error || 'Unable to update password.');
          msg.textContent = 'Password updated.';
          document.getElementById('passwordForm').reset();
        } catch (error) {
          msg.textContent = error.message || 'Error updating password.';
        }
      });

      document.getElementById('usernameForm').addEventListener('submit', async function (event) {
        event.preventDefault();
        const msg = document.getElementById('usernameMsg');
        msg.textContent = 'Saving...';
        try {
          const res = await fetch('/api/account/username', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({
              newUsername: document.getElementById('newUsername').value.trim(),
              currentPassword: document.getElementById('usernameCurrentPassword').value
            })
          });
          const data = await res.json().catch(function () { return {}; });
          if (!res.ok) throw new Error(data.error || 'Unable to update username.');
          msg.textContent = 'Username updated. Redirecting to login...';
          setTimeout(function () { window.location.href = '/login'; }, 1200);
        } catch (error) {
          msg.textContent = error.message || 'Error updating username.';
        }
      });

      (function () {
        const currencyNamesInv = { '840': 'USD', '356': 'INR', '064': 'BTN' };
        const invCurrencySelect = document.getElementById('invCurrency');
        const invCurrencyWrap = document.getElementById('invCurrencyWrap');
        const merchantIdsByCurrency = (session && session.merchantIdsByCurrency) ? session.merchantIdsByCurrency : {};

        function currentInvoiceCurrency() {
          return invCurrencySelect.value || session.defaultCurrency || '';
        }

        const currencies = Object.keys(merchantIdsByCurrency);
        if (currencies.length > 1) {
          invCurrencyWrap.style.display = '';
          invCurrencySelect.innerHTML = currencies.map(function (code) {
            const label = currencyNamesInv[code] || code;
            return '<option value="' + code + '">' + label + ' (' + code + ')</option>';
          }).join('');
          if (session.defaultCurrency && merchantIdsByCurrency[session.defaultCurrency]) {
            invCurrencySelect.value = session.defaultCurrency;
          }
        } else {
          invCurrencyWrap.style.display = 'none';
        }

        document.getElementById('invCustomerMessage').value = (portal.settings && portal.settings.paymentMessage) || '';

        let lastCreatedInvoice = null;

        document.getElementById('invoiceForm').addEventListener('submit', async function (event) {
          event.preventDefault();
          const msg = document.getElementById('invoiceMsg');
          msg.textContent = 'Generating...';
          try {
            const res = await fetch('/api/invoices', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
              body: JSON.stringify({
                currency: currentInvoiceCurrency(),
                amount: document.getElementById('invAmount').value.trim(),
                customerName: document.getElementById('invCustomerName').value.trim(),
                customerMessage: document.getElementById('invCustomerMessage').value.trim()
              })
            });
            const data = await res.json().catch(function () { return {}; });
            if (!res.ok) throw new Error(data.error || 'Unable to create invoice.');

            msg.textContent = 'Invoice created.';
            lastCreatedInvoice = data.invoice;
            document.getElementById('invNumberDisplay').value = data.invoice._id;
            document.getElementById('invoiceResultNumber').textContent = data.invoice._id;
            document.getElementById('invoiceResultLink').value = data.paymentUrl;
            document.getElementById('downloadInvoicePdfLink').href = '/api/invoices/' + encodeURIComponent(data.invoice._id) + '/pdf';
            document.getElementById('invoiceResult').style.display = 'block';
            document.getElementById('emailInvoicePanel').style.display = 'none';
          } catch (error) {
            msg.textContent = error.message || 'Error creating invoice.';
          }
        });

        document.getElementById('copyInvoiceLinkBtn').addEventListener('click', async function () {
          const btn = document.getElementById('copyInvoiceLinkBtn');
          try {
            await navigator.clipboard.writeText(document.getElementById('invoiceResultLink').value);
            const original = btn.textContent;
            btn.textContent = 'Copied!';
            setTimeout(function () { btn.textContent = original; }, 1500);
          } catch (error) {
            window.alert('Unable to copy. Please copy the link manually.');
          }
        });

        document.getElementById('emailInvoiceBtn').addEventListener('click', function () {
          if (!lastCreatedInvoice) return;
          const currencyLabel = currencyNamesInv[lastCreatedInvoice.currency] || lastCreatedInvoice.currency;
          document.getElementById('emailInvoiceNumberVal').textContent = lastCreatedInvoice._id;
          document.getElementById('emailInvoiceCustomerVal').textContent = lastCreatedInvoice.customerName || '';
          document.getElementById('emailInvoiceAmountVal').textContent = currencyLabel + ' ' + Number(lastCreatedInvoice.amount).toFixed(2);
          document.getElementById('emailInvoiceTo').value = lastCreatedInvoice.customerEmail || '';
          document.getElementById('emailInvoiceMessage').value = lastCreatedInvoice.customerMessage || '';
          document.getElementById('emailInvoiceMsg').textContent = '';
          document.getElementById('emailInvoicePanel').style.display = 'block';
        });

        document.getElementById('sendInvoiceEmailBtn').addEventListener('click', function () {
          document.getElementById('emailInvoiceMsg').textContent = 'Email sending is not connected yet — coming in a later phase.';
        });

        let invoicesCache = [];
        let paymentsCache = [];

        const detailModal = document.getElementById('detailModal');
        const detailModalTitle = document.getElementById('detailModalTitle');
        const detailModalBody = document.getElementById('detailModalBody');
        const detailModalLogo = document.getElementById('detailModalLogo');
        const detailModalPdfLink = document.getElementById('detailModalPdfLink');
        const detailModalCloseBtn = document.getElementById('detailModalCloseBtn');

        function escapeHtmlClient(value) {
          return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
          });
        }

        function showDetailModal(title, rows, logoUrl, pdfUrl) {
          detailModalTitle.textContent = title;
          detailModalBody.innerHTML = rows.map(function (row) {
            return '<div class="kv"><div class="k">' + row[0] + '</div><div>' + escapeHtmlClient(row[1] || '—') + '</div></div>';
          }).join('');
          if (logoUrl) {
            detailModalLogo.src = logoUrl;
            detailModalLogo.style.display = '';
          } else {
            detailModalLogo.style.display = 'none';
          }
          if (pdfUrl) {
            detailModalPdfLink.href = pdfUrl;
            detailModalPdfLink.style.display = '';
          } else {
            detailModalPdfLink.style.display = 'none';
          }
          detailModal.style.display = 'flex';
        }

        function hideDetailModal() {
          detailModal.style.display = 'none';
        }

        detailModalCloseBtn.addEventListener('click', hideDetailModal);
        detailModal.addEventListener('click', function (event) {
          if (event.target === detailModal) hideDetailModal();
        });

        function viewInvoiceDetails(invoiceNumber) {
          const inv = invoicesCache.find(function (i) { return i._id === invoiceNumber; });
          if (!inv) return;
          const currencyLabel = currencyNamesInv[inv.currency] || inv.currency;
          const rows = [
            ['Invoice Number', inv._id],
            ['Customer Name', inv.customerName || ''],
            ['Amount', currencyLabel + ' ' + Number(inv.amount).toFixed(2)],
            ['Status', String(inv.status || 'pending').toUpperCase()],
            ['Invoice Date', new Date(inv.invoiceDate).toLocaleString()],
            ['Due Date', new Date(inv.dueDate).toLocaleString()],
            ['Customer Message', inv.customerMessage || ''],
            ['Terms &amp; Conditions', inv.termsAndConditions || ''],
          ];
          showDetailModal('Invoice ' + inv._id, rows, portal.logoUrl, '/api/invoices/' + encodeURIComponent(inv._id) + '/pdf');
        }

        function viewPaymentDetails(txnId) {
          const tx = paymentsCache.find(function (t) { return t._id === txnId; });
          if (!tx) return;
          const currencyLabel = currencyNamesInv[tx.currency] || tx.currency;
          const rows = [
            ['Transaction ID', tx._id],
            ['Order Reference', tx.orderRef || ''],
            ['Amount', currencyLabel + ' ' + Number(tx.amountMajor || 0).toFixed(2)],
            ['Authorization Code', tx.authorizationCode || ''],
            ['Reference Number (RRN)', tx.referenceNumber || ''],
            ['Response Code', tx.responseCode || ''],
            ['Response Description', tx.responseReason || ''],
            ['Merchant ID', tx.merchantId || ''],
            ['Customer Name', tx.customerName || ''],
            ['Transaction Date &amp; Time', new Date(tx.resolvedAt).toLocaleString()],
            ['Payment Status', String(tx.status || '').toUpperCase()],
          ];
          showDetailModal('Transaction ' + tx._id, rows, portal.logoUrl, '/api/transactions/' + encodeURIComponent(tx._id) + '/pdf');
        }

        async function deleteInvoice(invoiceNumber) {
          if (!window.confirm('Delete invoice ' + invoiceNumber + '? This cannot be undone.')) return;
          try {
            const res = await fetch('/api/invoices/' + encodeURIComponent(invoiceNumber), { method: 'DELETE' });
            const data = await res.json().catch(function () { return {}; });
            if (!res.ok) throw new Error(data.error || 'Unable to delete invoice.');
            loadInvoices();
          } catch (error) {
            window.alert(error.message || 'Error deleting invoice.');
          }
        }

        function renderInvoicesTable(invoices) {
          const tbody = document.getElementById('allInvoicesBody');
          if (!invoices.length) {
            tbody.innerHTML = '<tr><td class="muted" style="padding:6px" colspan="8">No invoices yet.</td></tr>';
            return;
          }
          tbody.innerHTML = invoices.map(function (inv) {
            const currencyLabel = currencyNamesInv[inv.currency] || inv.currency;
            const amount = Number(inv.amount).toFixed(2);
            const created = new Date(inv.createdAt).toLocaleDateString();
            const status = String(inv.status || 'pending').toLowerCase();
            const statusLabel = status.charAt(0).toUpperCase() + status.slice(1);
            const deleteBtn = status === 'pending'
              ? '<button class="row-icon-btn" data-delete-invoice="' + inv._id + '" title="Delete invoice">🗑️</button>'
              : '';
            return '<tr style="border-top:1px solid #e2e8f0">' +
              '<td style="padding:6px">' + inv._id + '</td>' +
              '<td style="padding:6px">' + created + '</td>' +
              '<td style="padding:6px">' + (inv.customerName || '—') + '</td>' +
              '<td style="padding:6px">' + currencyLabel + '</td>' +
              '<td style="padding:6px">' + amount + '</td>' +
              '<td style="padding:6px"><span class="status-pill ' + status + '">' + statusLabel + '</span></td>' +
              '<td style="padding:6px">' + (inv.username || '—') + '</td>' +
              '<td style="padding:6px"><button class="row-icon-btn" data-view-invoice="' + inv._id + '" title="View details">👁️</button>' + deleteBtn + '</td>' +
              '</tr>';
          }).join('');
        }

        function renderPaymentsTable(transactions) {
          const tbody = document.getElementById('paymentsTableBody');
          if (!transactions.length) {
            tbody.innerHTML = '<tr><td class="muted" style="padding:6px" colspan="6">No payments yet.</td></tr>';
            return;
          }
          tbody.innerHTML = transactions.map(function (tx) {
            const currencyLabel = currencyNamesInv[tx.currency] || tx.currency;
            const amount = Number(tx.amountMajor || 0).toFixed(2);
            const when = new Date(tx.resolvedAt).toLocaleDateString();
            const status = String(tx.status || '').toLowerCase();
            const statusLabel = status.charAt(0).toUpperCase() + status.slice(1);
            return '<tr style="border-top:1px solid #e2e8f0">' +
              '<td style="padding:6px">' + tx._id + '</td>' +
              '<td style="padding:6px">' + (tx.customerName || '—') + '</td>' +
              '<td style="padding:6px">' + currencyLabel + ' ' + amount + '</td>' +
              '<td style="padding:6px"><span class="status-pill ' + status + '">' + statusLabel + '</span></td>' +
              '<td style="padding:6px">' + when + '</td>' +
              '<td style="padding:6px"><button class="row-icon-btn" data-view-txn="' + tx._id + '" title="View details">👁️</button></td>' +
              '</tr>';
          }).join('');
        }

        async function loadInvoices() {
          const tbody = document.getElementById('allInvoicesBody');
          try {
            const res = await fetch('/api/invoices', { headers: { 'Accept': 'application/json' } });
            const data = await res.json().catch(function () { return {}; });
            invoicesCache = data.invoices || [];
            renderInvoicesTable(invoicesCache);
          } catch (error) {
            tbody.innerHTML = '<tr><td class="muted" style="padding:6px" colspan="8">Unable to load invoices.</td></tr>';
          }
        }

        async function loadPayments() {
          const tbody = document.getElementById('paymentsTableBody');
          try {
            const res = await fetch('/api/transactions', { headers: { 'Accept': 'application/json' } });
            const data = await res.json().catch(function () { return {}; });
            paymentsCache = data.transactions || [];
            renderPaymentsTable(paymentsCache);
          } catch (error) {
            tbody.innerHTML = '<tr><td class="muted" style="padding:6px" colspan="6">Unable to load payments.</td></tr>';
          }
        }

        document.getElementById('allInvoicesBody').addEventListener('click', function (event) {
          const viewBtn = event.target.closest('[data-view-invoice]');
          if (viewBtn) return viewInvoiceDetails(viewBtn.getAttribute('data-view-invoice'));
          const deleteBtn = event.target.closest('[data-delete-invoice]');
          if (deleteBtn) return deleteInvoice(deleteBtn.getAttribute('data-delete-invoice'));
        });

        document.getElementById('paymentsTableBody').addEventListener('click', function (event) {
          const viewBtn = event.target.closest('[data-view-txn]');
          if (viewBtn) return viewPaymentDetails(viewBtn.getAttribute('data-view-txn'));
        });

        const allInvoicesBtn = document.querySelector('[data-target="invoices-all"]');
        const paidInvoicesBtn = document.querySelector('[data-target="invoices-payments"]');
        if (allInvoicesBtn) allInvoicesBtn.addEventListener('click', loadInvoices);
        if (paidInvoicesBtn) paidInvoicesBtn.addEventListener('click', loadPayments);
      })();

      (function () {
        const dashCurrencyNames = { '840': 'USD', '356': 'INR', '064': 'BTN' };

        function renderRevenueChart(containerId, series, currencyLabel) {
          const container = document.getElementById(containerId);
          const width = Math.max(container.clientWidth || 600, 280);
          const height = 180;
          const padLeft = 8, padRight = 8, padTop = 10, padBottom = 22;
          const plotW = width - padLeft - padRight;
          const plotH = height - padTop - padBottom;
          const maxVal = Math.max.apply(null, series.map(function (p) { return p.amount; }).concat([1]));
          const gap = 2;
          const barWidth = Math.max(2, (plotW / series.length) - gap);

          const gridLines = [0.25, 0.5, 0.75, 1].map(function (f) {
            const y = padTop + plotH * (1 - f);
            return '<line x1="' + padLeft + '" y1="' + y + '" x2="' + (width - padRight) + '" y2="' + y + '" stroke="#e1e0d9" stroke-width="1" />';
          }).join('');

          const bars = series.map(function (p, i) {
            const x = padLeft + i * (barWidth + gap);
            const barH = maxVal > 0 ? (p.amount / maxVal) * plotH : 0;
            const y = padTop + plotH - barH;
            return '<rect x="' + x + '" y="' + y + '" width="' + barWidth + '" height="' + Math.max(barH, 1) + '" rx="2" fill="#2a78d6">' +
              '<title>' + p.date + ': ' + currencyLabel + ' ' + p.amount.toFixed(2) + '</title></rect>';
          }).join('');

          const baseline = '<line x1="' + padLeft + '" y1="' + (padTop + plotH) + '" x2="' + (width - padRight) + '" y2="' + (padTop + plotH) + '" stroke="#c3c2b7" stroke-width="1" />';

          if (!series.length) {
            container.innerHTML = '<div class="muted" style="padding:20px 0;text-align:center">No payments in the last 30 days.</div>';
            return;
          }

          container.innerHTML = '<svg viewBox="0 0 ' + width + ' ' + height + '" style="width:100%;height:' + height + 'px" role="img" aria-label="Revenue over the last 30 days">' + gridLines + bars + baseline + '</svg>';
        }

        async function loadDashboardSummary() {
          try {
            const res = await fetch('/api/dashboard-summary', { headers: { 'Accept': 'application/json' } });
            const data = await res.json().catch(function () { return {}; });
            if (!res.ok) throw new Error(data.error || 'Unable to load dashboard.');

            const revenueEntries = Object.entries(data.totalRevenueByCurrency || {});
            document.getElementById('statRevenue').textContent = revenueEntries.length
              ? revenueEntries.map(function (e) { return (dashCurrencyNames[e[0]] || e[0]) + ' ' + Number(e[1]).toFixed(2); }).join(' · ')
              : (dashCurrencyNames[session.defaultCurrency] || session.defaultCurrency || '') + ' 0.00';
            document.getElementById('statPaid').textContent = String(data.paidCount || 0);
            document.getElementById('statPending').textContent = String(data.pendingCount || 0);
            document.getElementById('statSuccessRate').textContent = (data.successRate || 0) + '%';

            renderRevenueChart('revenueChart', data.revenueSeries || [], dashCurrencyNames[data.seriesCurrency] || data.seriesCurrency || '');

            const recentBody = document.getElementById('recentPaymentsBody');
            const payments = data.recentPayments || [];
            if (!payments.length) {
              recentBody.innerHTML = '<tr><td class="muted" style="padding:6px" colspan="5">No payments yet.</td></tr>';
            } else {
              recentBody.innerHTML = payments.map(function (p) {
                const currencyLabel = dashCurrencyNames[p.currency] || p.currency;
                const status = String(p.status || '').toLowerCase();
                const statusLabel = status.charAt(0).toUpperCase() + status.slice(1);
                return '<tr style="border-top:1px solid #e2e8f0">' +
                  '<td style="padding:6px">' + p.txnId + '</td>' +
                  '<td style="padding:6px">' + (p.customerName || '—') + '</td>' +
                  '<td style="padding:6px">' + currencyLabel + ' ' + Number(p.amountMajor || 0).toFixed(2) + '</td>' +
                  '<td style="padding:6px"><span class="status-pill ' + status + '">' + statusLabel + '</span></td>' +
                  '<td style="padding:6px">' + new Date(p.resolvedAt).toLocaleDateString() + '</td>' +
                  '</tr>';
              }).join('');
            }

            document.getElementById('pendingActionsBody').innerHTML = data.pendingCount
              ? '<p style="margin:0 0 10px">You have <strong>' + data.pendingCount + '</strong> invoice(s) awaiting payment.</p><button class="btn primary" type="button" data-quick-nav="invoices-all">View Pending Invoices</button>'
              : '<p class="muted" style="margin:0">No pending invoices right now.</p>';

            const merchantIdsByCurrency = (session && session.merchantIdsByCurrency) ? session.merchantIdsByCurrency : {};
            const gatewayRows = [
              ['USD Merchant ID', merchantIdsByCurrency['840'] || '—'],
              ['INR Merchant ID', merchantIdsByCurrency['356'] || '—'],
              ['Gateway', window.location.origin]
            ];
            document.getElementById('gatewayStatusBody').innerHTML = gatewayRows.map(function (row) {
              return '<div class="kv"><div class="k">' + row[0] + '</div><div>' + row[1] + '</div></div>';
            }).join('');
          } catch (error) {
            document.getElementById('statRevenue').textContent = 'Error loading dashboard';
          }
        }

        loadDashboardSummary();
      })();

      if (session.role === 'developer') {
        const currencyNames = { '840': 'USD', '356': 'INR', '064': 'BTN' };
        const unassignedMidPicker = document.getElementById('unassignedMidPicker');
        const merchantsTableBody = document.getElementById('merchantsTableBody');
        const newMerchantLogo = wireLogoUpload('newMerchantLogoFile', 'newMerchantLogoUrl', 'newMerchantLogoPreview');

        function renderUnassignedPicker(unassigned) {
          const byCurrency = {};
          unassigned.forEach(function (item) {
            if (!byCurrency[item.currency]) byCurrency[item.currency] = [];
            byCurrency[item.currency].push(item.merchantId);
          });
          const codes = Object.keys(byCurrency);
          if (!codes.length) {
            unassignedMidPicker.innerHTML = '<span class="muted">No unassigned merchant IDs available.</span>';
            return;
          }
          unassignedMidPicker.innerHTML = codes.map(function (code) {
            const label = currencyNames[code] || code;
            const options = byCurrency[code].map(function (mid) {
              return '<option value="' + mid + '">' + mid + '</option>';
            }).join('');
            return '<div style="margin-bottom:6px"><label style="display:inline-block;width:70px;font-weight:700">' + label + '</label>' +
              '<select data-currency="' + code + '" class="mid-select"><option value="">-- none --</option>' + options + '</select></div>';
          }).join('');
        }

        function renderMerchantsTable(merchants) {
          if (!merchants.length) {
            merchantsTableBody.innerHTML = '<tr><td class="muted" style="padding:6px" colspan="4">No merchants yet.</td></tr>';
            return;
          }
          merchantsTableBody.innerHTML = merchants.map(function (m) {
            const map = m.merchantIdsByCurrency || {};
            return '<tr style="border-top:1px solid #e2e8f0">' +
              '<td style="padding:6px">' + m.username + '</td>' +
              '<td style="padding:6px">' + m.displayName + '</td>' +
              '<td style="padding:6px">' + (map['840'] || '—') + '</td>' +
              '<td style="padding:6px">' + (map['356'] || '—') + '</td>' +
              '</tr>';
          }).join('');
        }

        async function loadDeveloperData() {
          try {
            const res = await fetch('/api/developer/merchants', { headers: { 'Accept': 'application/json' } });
            const data = await res.json().catch(function () { return {}; });
            renderUnassignedPicker(data.unassigned || []);
            renderMerchantsTable(data.merchants || []);
          } catch (error) {
            unassignedMidPicker.textContent = 'Unable to load available merchant IDs.';
          }
        }

        document.getElementById('addMerchantForm').addEventListener('submit', async function (event) {
          event.preventDefault();
          const msg = document.getElementById('addMerchantMsg');
          const credBox = document.getElementById('generatedCredentials');
          credBox.style.display = 'none';

          const selections = {};
          document.querySelectorAll('.mid-select').forEach(function (sel) {
            if (sel.value) selections[sel.getAttribute('data-currency')] = sel.value;
          });
          if (!Object.keys(selections).length) {
            msg.textContent = 'Select at least one merchant ID.';
            return;
          }

          msg.textContent = 'Creating...';
          try {
            const res = await fetch('/api/developer/merchants', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
              body: JSON.stringify({
                username: document.getElementById('newMerchantUsername').value.trim(),
                displayName: document.getElementById('newMerchantDisplayName').value.trim(),
                merchantName: document.getElementById('newMerchantCompanyName').value.trim(),
                email: document.getElementById('newMerchantEmail').value.trim(),
                phone: document.getElementById('newMerchantPhone').value.trim(),
                logoUrl: newMerchantLogo.getValue(),
                selections: selections
              })
            });
            const data = await res.json().catch(function () { return {}; });
            if (!res.ok) throw new Error(data.error || 'Unable to create merchant.');

            msg.textContent = 'Merchant created.';
            document.getElementById('generatedCredentialsBody').textContent =
              'Username: ' + data.username + '   Password: ' + data.generatedPassword;
            credBox.style.display = 'block';
            document.getElementById('addMerchantForm').reset();
            newMerchantLogo.reset();
            loadDeveloperData();
          } catch (error) {
            msg.textContent = error.message || 'Error creating merchant.';
          }
        });

        loadDeveloperData();
      }
    })();
  </script>
</body>
</html>`;
}


function appendResultParams(targetUrl, { txnId, status }) {
  try {
    const u = new URL(targetUrl);
    u.searchParams.set('txnId', txnId);
    u.searchParams.set('status', status);
    return u.toString();
  } catch {
    return '';
  }
}

async function handleLogin(req, res) {
  const raw = await parseBody(req);
  const contentType = (req.headers['content-type'] || '').toLowerCase();
  const input = parseRawPayload(raw, contentType);

  const usernameInput = String(input.username || '').trim();
  const passwordInput = String(input.password || '').trim();

  if (!usernameInput || !passwordInput) {
    return json(res, 400, { error: 'username and password are required' });
  }

  const users = await loadMerchantUserDb();
  const usernameKey = usernameInput.toLowerCase();
  const usernameAsMid = normalizeMerchantId(usernameInput);
  let user = users.get(usernameKey);

  if (!user) {
    for (const candidate of users.values()) {
      const displayKey = String(candidate.displayName || '').trim().toLowerCase();
      const candidateMid = normalizeMerchantId(candidate.merchantId);
      if (displayKey === usernameKey || (usernameAsMid && candidateMid === usernameAsMid)) {
        user = candidate;
        break;
      }
    }
  }

  if (!user || !verifyPassword(passwordInput, user.passwordHash, user.passwordSalt)) {
    return json(res, 401, { error: 'Invalid username or password' });
  }

  const token = crypto.randomBytes(24).toString('base64url');
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + SESSION_TTL_MS);
  sessionStore.set(token, {
    token,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    merchantId: user.merchantId,
    merchantIdsByCurrency: user.merchantIdsByCurrency,
    defaultCurrency: user.defaultCurrency,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });

  setSessionCookie(res, token, Math.floor(SESSION_TTL_MS / 1000));
  return json(res, 200, {
    ok: true,
    user: buildSessionClientView(sessionStore.get(token)),
    expiresAt: expiresAt.toISOString(),
  });
}

function handleLogout(req, res) {
  const token = getSessionTokenFromRequest(req);
  if (token) sessionStore.delete(token);
  clearSessionCookie(res);
  return json(res, 200, { ok: true });
}

function handleSessionInfo(req, res) {
  const session = getAuthenticatedSession(req);
  if (!session) {
    return json(res, 401, { authenticated: false });
  }

  return json(res, 200, {
    authenticated: true,
    user: buildSessionClientView(session),
    expiresAt: session.expiresAt,
  });
}

async function handleChangePassword(req, res) {
  const session = getAuthenticatedSession(req);
  if (!session) return json(res, 401, { error: 'Login required' });

  const raw = await parseBody(req);
  const contentType = (req.headers['content-type'] || '').toLowerCase();
  const input = parseRawPayload(raw, contentType);

  const currentPassword = String(input.currentPassword || '');
  const newPassword = String(input.newPassword || '');

  if (!currentPassword || !newPassword) {
    return json(res, 400, { error: 'currentPassword and newPassword are required' });
  }
  if (newPassword.length < 8) {
    return json(res, 400, { error: 'New password must be at least 8 characters' });
  }

  const users = await loadMerchantUserDbRaw();
  const usernameKey = findUsernameKey(users, session.username);
  if (!usernameKey) return json(res, 404, { error: 'Account not found' });

  const record = users[usernameKey];
  if (!verifyPassword(currentPassword, record.passwordHash, record.passwordSalt)) {
    return json(res, 401, { error: 'Current password is incorrect' });
  }

  const { hash, salt } = hashPassword(newPassword);
  record.passwordHash = hash;
  record.passwordSalt = salt;
  await saveMerchantUserDbRaw(users);

  return json(res, 200, { ok: true });
}

async function handleChangeUsername(req, res) {
  const session = getAuthenticatedSession(req);
  if (!session) return json(res, 401, { error: 'Login required' });

  const raw = await parseBody(req);
  const contentType = (req.headers['content-type'] || '').toLowerCase();
  const input = parseRawPayload(raw, contentType);

  const newUsername = String(input.newUsername || '').trim();
  const currentPassword = String(input.currentPassword || '');

  if (!newUsername || !currentPassword) {
    return json(res, 400, { error: 'newUsername and currentPassword are required' });
  }
  if (!/^[A-Za-z0-9_.-]{3,40}$/.test(newUsername)) {
    return json(res, 400, { error: 'Username must be 3-40 characters (letters, numbers, _ . -)' });
  }

  const users = await loadMerchantUserDbRaw();
  const oldUsernameKey = findUsernameKey(users, session.username);
  if (!oldUsernameKey) return json(res, 404, { error: 'Account not found' });

  const record = users[oldUsernameKey];
  if (!verifyPassword(currentPassword, record.passwordHash, record.passwordSalt)) {
    return json(res, 401, { error: 'Current password is incorrect' });
  }

  const collision = findUsernameKey(users, newUsername);
  if (collision && collision.toLowerCase() !== oldUsernameKey.toLowerCase()) {
    return json(res, 409, { error: 'Username already taken' });
  }

  if (newUsername.toLowerCase() !== oldUsernameKey.toLowerCase() || newUsername !== oldUsernameKey) {
    if (record.displayName === oldUsernameKey) record.displayName = newUsername;
    delete users[oldUsernameKey];
    users[newUsername] = record;
    await saveMerchantUserDbRaw(users);

    const portalDb = await loadMerchantPortalDb();
    if (portalDb[oldUsernameKey]) {
      portalDb[newUsername] = portalDb[oldUsernameKey];
      delete portalDb[oldUsernameKey];
      await saveMerchantPortalDb(portalDb);
    }
  }

  const token = getSessionTokenFromRequest(req);
  if (token) sessionStore.delete(token);
  clearSessionCookie(res);

  return json(res, 200, { ok: true, newUsername });
}

async function handleUpdateMerchantProfile(req, res) {
  const session = getAuthenticatedSession(req);
  if (!session) return json(res, 401, { error: 'Login required' });

  const raw = await parseBody(req);
  const contentType = (req.headers['content-type'] || '').toLowerCase();
  const input = parseRawPayload(raw, contentType);

  const merchantName = String(input.merchantName || '').trim();
  const address = String(input.address || '').trim();
  const email = String(input.email || '').trim();
  const phone = String(input.phone || '').trim();
  const logoUrl = String(input.logoUrl || '').trim();
  const useCustomerNames = !!input.useCustomerNames;
  const sendInvoiceViaEmail = !!input.sendInvoiceViaEmail;
  const allowExternalPayments = !!input.allowExternalPayments;
  const paymentMessage = String(input.paymentMessage || '').trim();
  const successfulPaymentMessage = String(input.successfulPaymentMessage || '').trim();
  const termsAndConditions = String(input.termsAndConditions || '').trim();

  if (!merchantName) {
    return json(res, 400, { error: 'Merchant name is required' });
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json(res, 400, { error: 'Invalid email address' });
  }
  const logoError = validateLogoUrl(logoUrl);
  if (logoError) {
    return json(res, 400, { error: logoError });
  }

  const sessionView = buildSessionClientView(session);
  const portalDb = await loadMerchantPortalDb();
  const usernameKey = session.username;
  const defaultModel = buildDefaultPortalModel(sessionView);
  const existing = mergePortalModel(defaultModel, portalDb[usernameKey] || null);

  const updated = {
    ...existing,
    merchantName,
    address,
    email,
    phone,
    logoUrl,
    settings: {
      ...existing.settings,
      useCustomerNames,
      sendInvoiceViaEmail,
      allowExternalPayments,
      paymentMessage,
      successfulPaymentMessage,
      termsAndConditions,
    },
  };

  portalDb[usernameKey] = updated;
  await saveMerchantPortalDb(portalDb);

  return json(res, 200, { ok: true, profile: updated });
}

async function getUnassignedMerchantIds() {
  const currencyDb = await loadMerchantCurrencyDb();
  const users = await loadMerchantUserDbRaw();
  const claimed = new Set();

  for (const rec of Object.values(users)) {
    const map = rec && typeof rec === 'object' ? rec.merchantIdsByCurrency : null;
    if (map && typeof map === 'object') {
      for (const mid of Object.values(map)) {
        const normalized = normalizeMerchantId(mid);
        if (normalized) claimed.add(normalized);
      }
    }
  }

  const unassigned = [];
  for (const [merchantId, currency] of currencyDb.entries()) {
    if (!claimed.has(merchantId)) unassigned.push({ merchantId, currency });
  }
  return unassigned;
}

async function handleListDeveloperMerchants(req, res) {
  const session = getAuthenticatedSession(req);
  if (!session || session.role !== 'developer') {
    return json(res, 403, { error: 'Developer access required' });
  }

  const users = await loadMerchantUserDbRaw();
  const merchants = Object.entries(users)
    .filter(([, rec]) => String(rec?.role || 'merchant').toLowerCase() !== 'developer')
    .map(([username, rec]) => ({
      username,
      displayName: String(rec?.displayName || username),
      merchantIdsByCurrency: rec?.merchantIdsByCurrency && typeof rec.merchantIdsByCurrency === 'object' ? rec.merchantIdsByCurrency : {},
    }));

  const unassigned = await getUnassignedMerchantIds();

  return json(res, 200, { merchants, unassigned });
}

async function handleCreateDeveloperMerchant(req, res) {
  const session = getAuthenticatedSession(req);
  if (!session || session.role !== 'developer') {
    return json(res, 403, { error: 'Developer access required' });
  }

  const raw = await parseBody(req);
  const contentType = (req.headers['content-type'] || '').toLowerCase();
  const input = parseRawPayload(raw, contentType);

  const username = String(input.username || '').trim();
  const displayName = String(input.displayName || username).trim() || username;
  const merchantName = String(input.merchantName || displayName).trim() || displayName;
  const email = String(input.email || '').trim();
  const phone = String(input.phone || '').trim();
  const logoUrl = String(input.logoUrl || '').trim();
  const selectionsInput = input.selections && typeof input.selections === 'object' ? input.selections : {};

  if (!username || !/^[A-Za-z0-9_.-]{3,40}$/.test(username)) {
    return json(res, 400, { error: 'Username must be 3-40 characters (letters, numbers, _ . -)' });
  }
  const logoError = validateLogoUrl(logoUrl);
  if (logoError) {
    return json(res, 400, { error: logoError });
  }

  const users = await loadMerchantUserDbRaw();
  if (findUsernameKey(users, username)) {
    return json(res, 409, { error: 'Username already taken' });
  }

  const unassigned = await getUnassignedMerchantIds();
  const unassignedByMid = new Map(unassigned.map(entry => [entry.merchantId, entry.currency]));

  const merchantIdsByCurrency = {};
  for (const [currencyRaw, midRaw] of Object.entries(selectionsInput)) {
    const currency = normalizeCurrency(currencyRaw);
    const merchantId = normalizeMerchantId(midRaw);
    if (!currency || !merchantId) continue;

    const actualCurrency = unassignedByMid.get(merchantId);
    if (!actualCurrency || actualCurrency !== currency) {
      return json(res, 400, { error: `Merchant ID ${merchantId} is not available for currency ${currency}` });
    }
    merchantIdsByCurrency[currency] = merchantId;
  }

  const selectedCount = Object.keys(merchantIdsByCurrency).length;
  if (selectedCount < 1 || selectedCount > 2) {
    return json(res, 400, { error: 'Select 1 or 2 merchant IDs for the new merchant' });
  }

  const generatedPassword = crypto.randomBytes(9).toString('base64url');
  const { hash, salt } = hashPassword(generatedPassword);
  const defaultCurrency = merchantIdsByCurrency['840'] ? '840' : Object.keys(merchantIdsByCurrency)[0];

  users[username] = {
    passwordHash: hash,
    passwordSalt: salt,
    displayName,
    role: 'merchant',
    defaultCurrency,
    merchantIdsByCurrency,
  };
  await saveMerchantUserDbRaw(users);

  const portalDb = await loadMerchantPortalDb();
  const defaultModel = buildDefaultPortalModel({ displayName, username, merchantIdsByCurrency });
  portalDb[username] = {
    ...defaultModel,
    merchantName,
    email,
    phone,
    logoUrl,
  };
  await saveMerchantPortalDb(portalDb);

  return json(res, 201, {
    ok: true,
    username,
    generatedPassword,
    merchantIdsByCurrency,
  });
}

async function handleInitiate(req, res) {
  const raw = await parseBody(req);
  const contentType = (req.headers['content-type'] || '').toLowerCase();
  const input = parseRawPayload(raw, contentType);

  const requestedCurrency = normalizeCurrency(input.currency);
  const session = getAuthenticatedSession(req);
  const amount = String(input.amount || '').trim();
  const orderRefInput = String(input.orderRef || '').trim();
  const customerRefInput = String(input.customerRef || '').trim();
  const customerName = String(input.customerName || '').trim();
  const email = String(input.email || '').trim();
  const mobilePhone = String(input.mobilePhone || '').trim();
  const paymentLinkToken = String(input.paymentLinkToken || '').trim();
  const initiationSource = paymentLinkToken ? 'payment-link' : 'direct';
  const successReturnUrl = String(input.successReturnUrl || '').trim();
  const failReturnUrl = String(input.failReturnUrl || '').trim();
  const txnId = String(input.txnId || generateTxnId()).trim();
  const orderRef = orderRefInput || `ORD-${txnId}`;
  const customerRef = customerRefInput || `CUST-${txnId.slice(-8)}`;

  let merchantId = '';
  let routingCurrency = requestedCurrency;

  let paymentLink = null;
  if (paymentLinkToken) {
    paymentLink = await getPaymentLink(paymentLinkToken);
    if (!paymentLink) {
      return html(res, 404, renderMessagePage('Payment link not found', 'This payment link is invalid or expired.'));
    }
    if (paymentLink.expiresAt && Date.parse(paymentLink.expiresAt) < Date.now()) {
      return html(res, 410, renderMessagePage('Payment link expired', 'This payment link has expired. Please request a new one.'));
    }
    merchantId = String(paymentLink.merchantId || '').trim();
    routingCurrency = normalizeCurrency(paymentLink.currency) || routingCurrency;
  } else if (session) {
    const routing = getSessionMerchantRouting(session, requestedCurrency);
    if (!routing || !routing.merchantId) {
      return html(
        res,
        403,
        renderMessagePage('Merchant mapping missing', 'No merchant ID is mapped for this login. Contact administrator.')
      );
    }
    merchantId = routing.merchantId;
    routingCurrency = routing.currency || routingCurrency;
  } else {
    return html(
      res,
      401,
      renderMessagePage('Login required', 'Please login first to access the payment portal.', { loginUrl: '/login' })
    );
  }

  const missing = [];
  if (!merchantId) missing.push('merchantId');
  if (!amount) missing.push('amount');
  if (!txnId) missing.push('txnId');

  if (missing.length) {
    return html(
      res,
      400,
      renderMessagePage('Validation error', 'Required fields are missing.', { missingFields: missing })
    );
  }

  const existing = await getTransaction(txnId);
  if (existing) {
    return html(
      res,
      409,
      renderMessagePage('Duplicate transaction ID', 'Use a new transaction ID.', { txnId })
    );
  }

  let amountMinor;
  try {
    amountMinor = amountToMinorUnits(amount);
  } catch (error) {
    return html(res, 400, renderMessagePage('Invalid amount', error.message, { amount }));
  }

  const currencyResolved = normalizeCurrency(routingCurrency)
    ? { currency: normalizeCurrency(routingCurrency), source: 'routing' }
    : await resolveMerchantCurrency(merchantId);
  const currency = currencyResolved.currency;

  if (!currency) {
    return html(
      res,
      400,
      renderMessagePage(
        'Currency not configured',
        'No currency is configured for this MID. Add the MID to the merchant currency database first.',
        { merchantId }
      )
    );
  }

  const requestBaseUrl = getRequestBaseUrl(req);
  const purchDate = formatPurchDate(new Date());
  const callbackUrl = `${requestBaseUrl}/api/callback`;

  const keys = createRsaKeyPair();

  let mkReq;
  try {
    mkReq = await doMkReq({
      merchantId,
      purchaseId: txnId,
      merchantPublicKeyBase64Url: keys.publicKeyBase64Url,
      merchantPrivateKeyPem: keys.privateKeyPem,
    });
  } catch (error) {
    console.error('[Cardzone][initiate] mkReq failed:', error.message, error.cause ? JSON.stringify(error.cause) : '');
    return html(res, 502, renderMessagePage('Unable to start payment', error.message, error.cause ? { cause: String(error.cause.code || error.cause.message || error.cause) } : undefined));
  }

  const mkReqRes = mkReq.responsePayload;
  if (String(mkReqRes.errorCode || '').trim() !== '000' || !mkReqRes.pubKey) {
    console.error('[Cardzone][initiate] mkReq error response:', JSON.stringify(mkReqRes));
    return html(
      res,
      400,
      renderMessagePage('mkReq failed', 'Cardzone did not provide a usable key exchange response.', mkReqRes)
    );
  }

  const mpiReq = {
    MPI_TRANS_TYPE: 'SALES',
    MPI_MERC_ID: merchantId,
    MPI_TRXN_ID: txnId,
    MPI_PURCH_DATE: purchDate,
    MPI_PURCH_CURR: currency,
    MPI_PURCH_AMT: amountMinor,
    MPI_RESPONSE_LINK: callbackUrl,
  };

  if (email) mpiReq.MPI_EMAIL = email;
  // NOTE: Phone fields (MPI_MOBILE_PHONE, MPI_HOME_PHONE, MPI_WORK_PHONE, etc.) 
  // are intentionally excluded to avoid MAC verification failures. 
  // Will be re-enabled once correct field order and null-handling is confirmed with Cardzone.

  const mpiReqSignInput = mpiReqSignString(mpiReq);
  const mpiMac = signSha256WithRsaBase64Url(mpiReqSignInput, keys.privateKeyPem);
  mpiReq.MPI_MAC = mpiMac;

  const mercReqUrl = CARDZONE_REDIRECT_URL;
  console.log('Returning auto-submit HTML to Cardzone');
  console.log('Cardzone URL:', mercReqUrl);
  console.log('[Cardzone][mercReq] endpoint=', mercReqUrl);
  console.log('[Cardzone][mercReq] flow=hosted-page html-form-post=true');
  logMpiReqSigningDetails(mpiReq, mpiReqSignInput, mpiMac);

  const tx = {
    txnId,
    orderRef,
    customerRef,
    customerName,
    merchantId,
    amountMinor,
    amountMajor: amount,
    currency,
    initiationSource,
    paymentLinkToken: paymentLinkToken || null,
    username: session?.username || null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    successReturnUrl,
    failReturnUrl,
    security: {
      merchantPrivateKeyPem: keys.privateKeyPem,
      merchantPublicKeyBase64Url: keys.publicKeyBase64Url,
      cardzonePublicKeyBase64Url: mkReqRes.pubKey,
    },
    mkReq: {
      request: mkReq.requestPayload,
      response: mkReqRes,
    },
    mercReq: {
      action: mercReqUrl,
      requestFields: mpiReq,
      signInput: mpiReqSignInput,
    },
    callback: null,
    inquiry: null,
    finalResult: null,
    macVerification: null,
    status: 'REDIRECTED_TO_HOSTED_PAGE',
  };

  await saveTransaction(tx);
  return html(res, 200, renderAutoPostPage(mercReqUrl, mpiReq));
}

async function finalizeTransactionOutcome(tx, effectiveStatus, finalResult) {
  if (effectiveStatus !== 'SUCCESS' && effectiveStatus !== 'FAILED') {
    return { customSuccessMessage: '', merchantProfile: null };
  }

  let invoice = null;
  let customSuccessMessage = '';
  try {
    if (tx.paymentLinkToken) {
      const paymentLink = await getPaymentLink(tx.paymentLinkToken);
      if (paymentLink?.invoiceNumber) {
        invoice = await getInvoice(paymentLink.invoiceNumber);
        if (invoice && invoice.status === 'pending') {
          const newStatus = effectiveStatus === 'SUCCESS' ? 'paid' : 'failed';
          await updateInvoiceStatus(invoice._id, newStatus);
        }
        if (invoice && effectiveStatus === 'SUCCESS') {
          customSuccessMessage = invoice.successMessage || '';
        }
      }
    }
  } catch (error) {
    console.error('[Cardzone][finalize] invoice status update failed for txn', tx.txnId, error.message);
  }

  try {
    await saveTransactionHistory({
      _id: tx.txnId,
      orderRef: tx.orderRef || null,
      customerRef: tx.customerRef || null,
      customerName: tx.customerName || null,
      merchantId: tx.merchantId || null,
      currency: tx.currency || null,
      amountMajor: tx.amountMajor || null,
      amountMinor: tx.amountMinor || null,
      status: effectiveStatus === 'SUCCESS' ? 'paid' : 'failed',
      responseCode: finalResult?.responseCode || null,
      responseReason: finalResult?.responseReason || null,
      authorizationCode: finalResult?.authorizationCode || null,
      referenceNumber: finalResult?.referenceNumber || null,
      bin: finalResult?.bin || null,
      referralCode: finalResult?.referralCode || null,
      resultSource: finalResult?.source || null,
      invoiceNumber: invoice?._id || null,
      username: invoice?.username || tx.username || null,
      initiationSource: tx.initiationSource || null,
      createdAt: tx.createdAt || null,
      resolvedAt: finalResult?.resolvedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Cardzone][finalize] saving transaction history failed for txn', tx.txnId, error.message);
  }

  let merchantProfile = null;
  const ownerUsername = invoice?.username || tx.username || null;
  if (ownerUsername) {
    try {
      const portalDb = await loadMerchantPortalDb();
      merchantProfile = portalDb[ownerUsername] || null;
    } catch (error) {
      console.error('[Cardzone][finalize] loading merchant profile failed for txn', tx.txnId, error.message);
    }
  }

  return { customSuccessMessage, merchantProfile };
}

async function handleCallback(req, res) {
  const raw = await parseBody(req);
  const contentType = (req.headers['content-type'] || '').toLowerCase();
  const fields = parseRawPayload(raw, contentType);

  const txnId = String(fields.MPI_TRXN_ID || fields.mpiTrxnId || fields.trxnId || fields.txnId || '').trim();
  if (!txnId) {
    return html(res, 400, renderMessagePage('Callback rejected', 'Missing MPI_TRXN_ID in callback payload.'));
  }

  const tx = await getTransaction(txnId);
  if (!tx) {
    return html(
      res,
      404,
      renderMessagePage('Transaction not found', 'No transaction exists for the callback reference.', { txnId })
    );
  }

  console.log('Callback received for txn:', txnId);

  const hasMac = !!fields.MPI_MAC;
  const verifyInput = mpiResVerifyString(fields);
  const macVerified =
    hasMac && !!tx.security?.cardzonePublicKeyBase64Url
      ? verifySha256WithRsaBase64Url(verifyInput, fields.MPI_MAC, tx.security.cardzonePublicKeyBase64Url)
      : false;

  console.log('MPI_ERROR_CODE:', fields.MPI_ERROR_CODE || '');
  console.log('MPI_ERROR_DESC:', fields.MPI_ERROR_DESC || '');
  console.log('MPI_APPR_CODE:', fields.MPI_APPR_CODE || '');
  console.log('MPI_RRN:', fields.MPI_RRN || '');
  console.log('MPI_REFERRAL_CODE:', fields.MPI_REFERRAL_CODE || '');
  console.log('MPI_BIN:', fields.MPI_BIN || '');
  console.log('MAC verified:', macVerified);

  tx.callback = {
    receivedAt: new Date().toISOString(),
    method: req.method,
    contentType,
    fields,
    rawResponseFields: { ...fields },
    rawPayload: raw,
  };
  tx.macVerification = {
    hasMac,
    macVerified,
    verifyInput,
    verifyNote: hasMac ? (macVerified ? 'MPIRes MAC verified successfully' : 'MPIRes MAC verification failed') : 'No MPI_MAC received',
  };
  const callbackResultTrusted = !hasMac || macVerified;
  let finalResult = callbackResultTrusted
    ? buildFinalResultRecord({
        fields,
        source: 'callback',
        resolvedAt: tx.callback.receivedAt,
      })
    : null;

  if (!callbackResultTrusted || !hasSufficientFinalResult(finalResult)) {
    try {
      const inquiry = await doInquiry(tx, txnId);
      tx.inquiry = inquiry;

      const inquiryResult = buildFinalResultRecord({
        fields: inquiry.responseFields,
        source: 'inquiry',
        resolvedAt: inquiry.requestedAt,
      });
      const inquiryResultTrusted = !inquiry.macVerification?.hasMac || inquiry.macVerification.macVerified;

      if (inquiryResultTrusted && hasSufficientFinalResult(inquiryResult)) {
        finalResult = inquiryResult;
      }
    } catch (error) {
      tx.inquiry = {
        requestedAt: new Date().toISOString(),
        endpoint: CARDZONE_INQUIRY_URL,
        error: error.message,
      };
      console.error('[Cardzone][inquiry] failed for txn', txnId, error.message);
    }
  }

  tx.finalResult = finalResult;
  const finalStatus = mapTransactionLifecycleStatus({
    callbackReceived: true,
    finalResult,
  });
  tx.status = finalStatus;
  tx.updatedAt = new Date().toISOString();

  await saveTransaction(tx);

  console.log('[Cardzone][callback] txnId=', txnId, 'status=', finalStatus, 'macVerified=', macVerified);

  if (finalStatus === 'PENDING') {
    return html(
      res,
      202,
      renderMessagePage(
        'Payment processing',
        'Payment is still processing. Please wait or refresh.',
        {
          txnId,
          status: finalStatus,
          callbackReceived: true,
        }
      )
    );
  }

  const { customSuccessMessage, merchantProfile } = await finalizeTransactionOutcome(tx, finalStatus, finalResult);
  return html(res, 200, renderResultPage(tx, finalStatus, finalResult, getRequestBaseUrl(req), customSuccessMessage, merchantProfile));
}

async function handleReturn(req, res) {
  const u = new URL(req.url, `http://${req.headers.host}`);
  let txnId = u.searchParams.get('txnId');

  if (req.method === 'POST' && !txnId) {
    const raw = await parseBody(req);
    const contentType = (req.headers['content-type'] || '').toLowerCase();
    const fields = parseRawPayload(raw, contentType);
    txnId = fields.MPI_TRXN_ID || fields.txnId || '';
  }

  if (!txnId) {
    return html(
      res,
      400,
      renderMessagePage('No transaction reference received', 'Provide txnId in query string or POST body.')
    );
  }

  const tx = await getTransaction(txnId);
  if (!tx) {
    return html(
      res,
      404,
      renderMessagePage('Transaction not found', 'No transaction record found for this reference.', { txnId })
    );
  }

  const callbackReceived = !!tx.callback;
  const callbackResultTrusted = !tx.macVerification?.hasMac || !!tx.macVerification?.macVerified;
  let finalResult = tx.finalResult;

  if (finalResult?.source === 'callback' && !callbackResultTrusted) {
    finalResult = null;
  }

  if (!finalResult && callbackResultTrusted) {
    finalResult = buildFinalResultRecord({
      fields: tx.callback?.fields,
      source: 'callback',
      resolvedAt: tx.callback?.receivedAt,
    });
  }

  if (!callbackReceived || !callbackResultTrusted || !hasSufficientFinalResult(finalResult)) {
    try {
      const inquiry = await doInquiry(tx, tx.txnId);
      tx.inquiry = inquiry;

      const inquiryResult = buildFinalResultRecord({
        fields: inquiry.responseFields,
        source: 'inquiry',
        resolvedAt: inquiry.requestedAt,
      });
      const inquiryResultTrusted = !inquiry.macVerification?.hasMac || inquiry.macVerification.macVerified;

      if (inquiryResultTrusted && hasSufficientFinalResult(inquiryResult)) {
        finalResult = inquiryResult;
        tx.finalResult = inquiryResult;
        tx.status = mapTransactionLifecycleStatus({
          callbackReceived,
          finalResult: inquiryResult,
        });
        tx.updatedAt = new Date().toISOString();
        await saveTransaction(tx);
      }
    } catch (error) {
      if (!tx.inquiry?.error) {
        tx.inquiry = {
          requestedAt: new Date().toISOString(),
          endpoint: CARDZONE_INQUIRY_URL,
          error: error.message,
        };
        tx.updatedAt = new Date().toISOString();
        await saveTransaction(tx);
      }
      console.error('[Cardzone][return][inquiry] failed for txn', tx.txnId, error.message);
    }
  }

  const effectiveStatus = mapTransactionLifecycleStatus({
    callbackReceived,
    finalResult,
  });
  const hasFinalState = effectiveStatus !== 'PENDING';

  if (!hasFinalState) {
    return html(
      res,
      202,
      renderMessagePage(
        'Payment processing',
        'Payment is still processing. Please wait or refresh.',
        {
          txnId: tx.txnId,
          status: effectiveStatus,
          callbackReceived,
        }
      )
    );
  }

  const { customSuccessMessage, merchantProfile } = await finalizeTransactionOutcome(tx, effectiveStatus, finalResult);

  if (effectiveStatus === 'SUCCESS' && tx.successReturnUrl) {
    const redirectUrl = appendResultParams(tx.successReturnUrl, { txnId: tx.txnId, status: effectiveStatus });
    if (redirectUrl) return redirect(res, redirectUrl);
  }
  if (effectiveStatus === 'FAILED' && tx.failReturnUrl) {
    const redirectUrl = appendResultParams(tx.failReturnUrl, { txnId: tx.txnId, status: effectiveStatus });
    if (redirectUrl) return redirect(res, redirectUrl);
  }

  return html(res, 200, renderResultPage(tx, effectiveStatus, finalResult, getRequestBaseUrl(req), customSuccessMessage, merchantProfile));
}

async function handleTxDebug(req, res, txnId) {
  const tx = await getTransaction(txnId);
  if (!tx) {
    return json(res, 404, {
      error: 'Transaction not found',
      txnId,
    });
  }

  return json(res, 200, {
    txnId: tx.txnId,
    status: tx.status,
    callbackReceived: !!tx.callback,
    mpiErrorCode: tx.finalResult?.responseCode || tx.callback?.fields?.MPI_ERROR_CODE || null,
    mpiApprovalCode: tx.finalResult?.authorizationCode || tx.callback?.fields?.MPI_APPR_CODE || null,
    mpiRrn: tx.finalResult?.referenceNumber || tx.callback?.fields?.MPI_RRN || null,
    finalResultSource: tx.finalResult?.source || null,
    macVerified: tx.macVerification?.macVerified ?? null,
  });
}

async function handleMerchantCurrency(req, res) {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const merchantId = String(u.searchParams.get('merchantId') || '').trim();

  if (!merchantId) {
    return json(res, 400, {
      error: 'merchantId is required',
    });
  }

  const resolved = await resolveMerchantCurrency(merchantId);
  if (!resolved.currency) {
    return json(res, 404, {
      merchantId,
      error: 'Currency not configured for this MID',
      source: resolved.source,
    });
  }

  return json(res, 200, {
    merchantId,
    currency: resolved.currency,
    source: resolved.source,
  });
}

async function handleCreatePaymentLink(req, res) {
  const session = getAuthenticatedSession(req);
  if (!session) {
    return json(res, 401, { error: 'Login required' });
  }

  const raw = await parseBody(req);
  const contentType = (req.headers['content-type'] || '').toLowerCase();
  const input = parseRawPayload(raw, contentType);

  const requestedCurrency = normalizeCurrency(input.currency);
  const routing = getSessionMerchantRouting(session, requestedCurrency);
  const merchantId = String(routing?.merchantId || '').trim();
  const amount = String(input.amount || '').trim();
  const customerName = String(input.customerName || '').trim();
  const email = String(input.email || '').trim();
  const mobilePhone = String(input.mobilePhone || '').trim();

  if (!merchantId || !amount) {
    return json(res, 400, { error: 'merchantId and amount are required' });
  }

  try {
    amountToMinorUnits(amount);
  } catch (error) {
    return json(res, 400, { error: error.message });
  }

  const currencyResolved = normalizeCurrency(routing?.currency)
    ? { currency: normalizeCurrency(routing.currency), source: 'session-routing' }
    : await resolveMerchantCurrency(merchantId);

  if (!currencyResolved.currency) {
    return json(res, 400, {
      error: 'Currency not configured for this MID',
      merchantId,
      source: currencyResolved.source,
    });
  }

  const token = generatePaymentLinkToken();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + PAYMENT_LINK_TTL_MS);
  const baseUrl = getRequestBaseUrl(req);

  await savePaymentLink({
    token,
    merchantId,
    amount,
    currency: currencyResolved.currency,
    customerName,
    email,
    mobilePhone,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });

  return json(res, 200, {
    token,
    paymentUrl: `${baseUrl}/pay/${encodeURIComponent(token)}`,
    currency: currencyResolved.currency,
    currencySource: currencyResolved.source,
    expiresAt: expiresAt.toISOString(),
  });
}

async function handleCreateInvoice(req, res) {
  const session = getAuthenticatedSession(req);
  if (!session) return json(res, 401, { error: 'Login required' });

  const raw = await parseBody(req);
  const contentType = (req.headers['content-type'] || '').toLowerCase();
  const input = parseRawPayload(raw, contentType);

  const requestedCurrency = normalizeCurrency(input.currency);
  const routing = getSessionMerchantRouting(session, requestedCurrency);
  const merchantId = String(routing?.merchantId || '').trim();
  const currency = normalizeCurrency(routing?.currency);
  const amount = String(input.amount || '').trim();
  const customerName = String(input.customerName || '').trim();
  const customerMessageInput = String(input.customerMessage || '').trim();

  if (!merchantId || !currency) {
    return json(res, 400, { error: 'No merchant mapping available for the selected currency' });
  }
  if (!amount) return json(res, 400, { error: 'Amount is required' });
  if (!customerName) return json(res, 400, { error: 'Customer name is required' });

  try {
    amountToMinorUnits(amount);
  } catch (error) {
    return json(res, 400, { error: error.message });
  }

  const sessionView = buildSessionClientView(session);
  const portalModel = await getPortalModelForSession(sessionView);
  const customerMessage = customerMessageInput || portalModel.settings?.paymentMessage || '';
  const termsAndConditions = portalModel.settings?.termsAndConditions || '';
  const successMessage = portalModel.settings?.successfulPaymentMessage || '';
  const dueDate = new Date(Date.now() + INVOICE_DEFAULT_DUE_MS);

  const invoiceNumber = await nextInvoiceNumber(session.username, portalModel.merchantName);
  const linkToken = generatePaymentLinkToken();
  const createdAt = new Date();
  const baseUrl = getRequestBaseUrl(req);

  await savePaymentLink({
    token: linkToken,
    merchantId,
    amount,
    currency,
    customerName,
    invoiceNumber,
    createdAt: createdAt.toISOString(),
    expiresAt: dueDate.toISOString(),
  });

  const invoice = {
    _id: invoiceNumber,
    username: session.username,
    merchantName: portalModel.merchantName || session.displayName || session.username,
    currency,
    merchantId,
    amount,
    customerName,
    customerMessage,
    termsAndConditions,
    successMessage,
    invoiceDate: createdAt.toISOString(),
    dueDate: dueDate.toISOString(),
    status: 'pending',
    paymentLinkToken: linkToken,
    txnId: null,
    createdAt: createdAt.toISOString(),
    updatedAt: createdAt.toISOString(),
  };

  await saveInvoice(invoice);

  return json(res, 201, {
    ok: true,
    invoice,
    paymentUrl: `${baseUrl}/pay/${encodeURIComponent(linkToken)}`,
  });
}

async function handleListInvoices(req, res) {
  const session = getAuthenticatedSession(req);
  if (!session) return json(res, 401, { error: 'Login required' });

  const u = new URL(req.url, `http://${req.headers.host}`);
  const statusFilter = String(u.searchParams.get('status') || '').trim().toLowerCase();

  const invoices = await listInvoicesForUsername(session.username, statusFilter || undefined);
  return json(res, 200, { invoices });
}

async function handleDeleteInvoice(req, res, invoiceNumber) {
  const session = getAuthenticatedSession(req);
  if (!session) return json(res, 401, { error: 'Login required' });

  const invoice = await getInvoice(invoiceNumber);
  if (!invoice || invoice.username !== session.username) {
    return json(res, 404, { error: 'Invoice not found' });
  }
  if (invoice.status !== 'pending') {
    return json(res, 400, { error: 'Only unpaid invoices can be deleted' });
  }

  if (invoice.paymentLinkToken) {
    await expirePaymentLink(invoice.paymentLinkToken);
  }
  await deleteInvoiceById(invoiceNumber);

  return json(res, 200, { ok: true });
}

async function handleListTransactions(req, res) {
  const session = getAuthenticatedSession(req);
  if (!session) return json(res, 401, { error: 'Login required' });

  const transactions = await listTransactionsForUsername(session.username);
  return json(res, 200, { transactions });
}

async function handleDownloadTransactionPdf(req, res, txnId) {
  const session = getAuthenticatedSession(req);
  if (!session) return json(res, 401, { error: 'Login required' });

  const db = await getMongoDb();
  const tx = await db.collection('transactions').findOne({ _id: txnId });
  if (!tx || tx.username !== session.username) {
    return json(res, 404, { error: 'Transaction not found' });
  }

  const portalDb = await loadMerchantPortalDb();
  const merchantProfile = portalDb[tx.username] || null;
  const pdfBuffer = await generateTransactionReceiptPdfBuffer(tx, merchantProfile);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="receipt-${tx._id}.pdf"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', String(pdfBuffer.length));
  return res.end(pdfBuffer);
}

async function handleDashboardSummary(req, res) {
  const session = getAuthenticatedSession(req);
  if (!session) return json(res, 401, { error: 'Login required' });

  const db = await getMongoDb();
  const username = session.username;

  const allTx = await listTransactionsForUsername(username);
  const paid = allTx.filter(t => t.status === 'paid');
  const failed = allTx.filter(t => t.status === 'failed');

  const totalRevenueByCurrency = {};
  for (const t of paid) {
    const cur = t.currency || '—';
    totalRevenueByCurrency[cur] = (totalRevenueByCurrency[cur] || 0) + Number(t.amountMajor || 0);
  }

  const successRate = (paid.length + failed.length) > 0
    ? Math.round((paid.length / (paid.length + failed.length)) * 1000) / 10
    : 0;

  const seriesCurrency = normalizeCurrency(session.defaultCurrency) || Object.keys(totalRevenueByCurrency)[0] || '';
  const now = new Date();
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  const dayTotals = {};
  days.forEach(d => { dayTotals[d] = 0; });
  for (const t of paid) {
    if ((t.currency || '') !== seriesCurrency) continue;
    const day = String(t.resolvedAt || '').slice(0, 10);
    if (day in dayTotals) dayTotals[day] += Number(t.amountMajor || 0);
  }
  const revenueSeries = days.map(d => ({ date: d, amount: Math.round(dayTotals[d] * 100) / 100 }));

  const pendingInvoicesCount = await db.collection('invoices').countDocuments({ username, status: 'pending' });

  const recentPayments = allTx.slice(0, 8).map(t => ({
    txnId: t._id,
    customerName: t.customerName,
    amountMajor: t.amountMajor,
    currency: t.currency,
    status: t.status,
    resolvedAt: t.resolvedAt,
  }));

  return json(res, 200, {
    totalRevenueByCurrency,
    paidCount: paid.length,
    pendingCount: pendingInvoicesCount,
    failedCount: failed.length,
    successRate,
    seriesCurrency,
    revenueSeries,
    recentPayments,
  });
}

async function handleDownloadInvoicePdf(req, res, invoiceNumber) {
  const session = getAuthenticatedSession(req);
  if (!session) return json(res, 401, { error: 'Login required' });

  const invoice = await getInvoice(invoiceNumber);
  if (!invoice || invoice.username !== session.username) {
    return json(res, 404, { error: 'Invoice not found' });
  }

  const portalDb = await loadMerchantPortalDb();
  const merchantProfile = portalDb[invoice.username] || null;
  const pdfBuffer = await generateInvoicePdfBuffer(invoice, merchantProfile);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${invoice._id}.pdf"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', String(pdfBuffer.length));
  return res.end(pdfBuffer);
}

function renderInvoiceReviewPage(invoice, merchantProfile, hiddenFields) {
  const CURRENCY_NAMES = { '840': 'USD', '356': 'INR', '064': 'BTN' };
  const currencyDisplay = CURRENCY_NAMES[invoice.currency] || invoice.currency || '';
  const amountFormatted = `${currencyDisplay ? `${currencyDisplay} ` : ''}${Number.parseFloat(invoice.amount || 0).toFixed(2)}`;
  const merchantName = invoice.merchantName || 'Merchant';
  const logoUrl = String(merchantProfile?.logoUrl || '').trim();
  const address = String(merchantProfile?.address || '').trim();
  const addressLines = address ? address.split('\n').filter(Boolean) : [];
  const hasTerms = !!invoice.termsAndConditions;

  const fmtDate = (iso) => {
    try {
      return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    } catch {
      return iso || '—';
    }
  };

  const inputs = Object.entries(hiddenFields)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join('\n');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Invoice ${escapeHtml(invoice._id)}</title>
  <style>
    :root{--bg:#eef1f2;--card:#ffffff;--text:#1f2937;--muted:#64748b;--brand:#2f7a3d;--accent:#22c55e;--accent-2:#16a34a;--border:#e5e7eb}
    *{box-sizing:border-box}
    body{margin:0;font-family:Segoe UI,Arial,sans-serif;color:var(--text);background:var(--bg);min-height:100vh;padding:28px 14px}
    .container{width:100%;max-width:640px;margin:0 auto}
    .card{background:var(--card);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 18px rgba(15,23,42,.06);overflow:hidden}
    .letterhead{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:24px 28px;border-bottom:1px solid var(--border)}
    .brand-logo{max-height:60px;max-width:220px;object-fit:contain}
    .brand-name{font-size:26px;font-weight:700;color:var(--brand);font-family:Georgia,'Times New Roman',serif}
    .brand-address{text-align:right;font-size:12.5px;color:#334155;line-height:1.5}
    .brand-address .addr-name{font-weight:700}
    .greeting{background:#f8fafc;padding:18px 28px;font-size:13.5px;color:#334155}
    .greeting p{margin:0 0 8px}
    .greeting p:last-child{margin-bottom:0}
    .body{padding:22px 28px}
    .section-title{font-size:13px;font-weight:700;color:#334155;margin-bottom:8px}
    .kv-plain{display:grid;grid-template-columns:160px 1fr;border-top:1px solid var(--border);font-size:13px}
    .kv-plain:first-of-type{border-top:0}
    .kv-plain div{padding:9px 0}
    .kv-plain .k{color:#64748b}
    .kv-plain .v{font-weight:700}
    .agree{display:flex;align-items:flex-start;gap:8px;margin-top:18px;font-size:13px;color:#334155}
    .agree input{margin-top:3px}
    .agree a{color:var(--brand);font-weight:700;text-decoration:underline;cursor:pointer}
    .continue-btn{width:100%;border:0;border-radius:8px;padding:13px 16px;background:var(--accent);color:#fff;font-weight:700;font-size:15px;cursor:pointer;margin-top:16px}
    .continue-btn:hover{background:var(--accent-2)}
    .continue-btn:disabled{opacity:.5;cursor:not-allowed}
    .disclaimer{margin-top:12px;font-size:11.5px;color:var(--muted);line-height:1.6}
    .terms-modal{position:fixed;inset:0;background:rgba(15,23,42,.5);display:flex;align-items:center;justify-content:center;padding:20px;z-index:10}
    .terms-modal-inner{background:#fff;border-radius:10px;max-width:520px;width:100%;max-height:70vh;display:flex;flex-direction:column;padding:20px}
    .terms-modal-inner h3{margin:0 0 12px;font-size:16px}
    .terms-modal-body{overflow:auto;font-size:13px;color:#334155;white-space:pre-wrap;flex:1}
    .terms-modal-inner button{margin-top:14px;align-self:flex-end;border:0;border-radius:8px;padding:8px 16px;background:var(--accent);color:#fff;font-weight:700;cursor:pointer}
  </style>
</head>
<body>
  <div class="container">
    <section class="card">
      <div class="letterhead">
        <div>
          ${logoUrl ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(merchantName)}" class="brand-logo" />` : `<div class="brand-name">${escapeHtml(merchantName)}</div>`}
        </div>
        <div class="brand-address">
          <div class="addr-name">${escapeHtml(merchantName)}</div>
          ${addressLines.map(line => `<div>${escapeHtml(line)}</div>`).join('')}
        </div>
      </div>

      <div class="greeting">
        <p>Dear ${escapeHtml(invoice.customerName || 'Customer')},</p>
        <p>${escapeHtml(merchantName)} has requested a payment from you.</p>
        ${invoice.customerMessage ? `<p>${escapeHtml(invoice.customerMessage)}</p>` : ''}
      </div>

      <div class="body">
        <div class="section-title">Payment Details</div>
        <div class="kv-plain"><div class="k">Dated</div><div class="v">${escapeHtml(fmtDate(invoice.invoiceDate))}</div></div>
        <div class="kv-plain"><div class="k">Invoice#</div><div class="v">${escapeHtml(invoice._id)}</div></div>
        <div class="kv-plain"><div class="k">Total Amount</div><div class="v">${escapeHtml(amountFormatted)}</div></div>

        <form id="payForm" method="post" action="/api/initiate">${inputs}
          <label class="agree">
            <input type="checkbox" id="agreeBox" ${hasTerms ? '' : 'checked style="display:none"'} />
            <span>I agree to the ${hasTerms ? `<a id="termsLink">Terms and Conditions</a>` : 'Terms and Conditions'} of ${escapeHtml(merchantName)}</span>
          </label>
          <button type="submit" id="proceedBtn" class="continue-btn" ${hasTerms ? 'disabled' : ''}>Continue</button>
        </form>
        <div class="disclaimer">
          <p>&#9888; Make sure you confirm that the payment details are correct before proceeding.</p>
          <p>After clicking &quot;Continue&quot; you will be redirected to a secure payment page.</p>
        </div>
      </div>
    </section>
  </div>

  ${hasTerms ? `
  <div id="termsModal" class="terms-modal" style="display:none">
    <div class="terms-modal-inner">
      <h3>Terms and Conditions of ${escapeHtml(merchantName)}</h3>
      <div class="terms-modal-body">${escapeHtml(invoice.termsAndConditions)}</div>
      <button type="button" id="closeTermsModal">Close</button>
    </div>
  </div>
  ` : ''}

  <script>
    (function () {
      const agreeBox = document.getElementById('agreeBox');
      const proceedBtn = document.getElementById('proceedBtn');
      if (agreeBox && proceedBtn) {
        agreeBox.addEventListener('change', function () {
          proceedBtn.disabled = !agreeBox.checked;
        });
      }

      const termsLink = document.getElementById('termsLink');
      const termsModal = document.getElementById('termsModal');
      const closeTermsModal = document.getElementById('closeTermsModal');
      if (termsLink && termsModal) {
        termsLink.addEventListener('click', function (event) {
          event.preventDefault();
          termsModal.style.display = 'flex';
        });
      }
      if (closeTermsModal && termsModal) {
        closeTermsModal.addEventListener('click', function () {
          termsModal.style.display = 'none';
        });
      }
    })();
  </script>
</body>
</html>`;
}

async function handlePaymentLinkLanding(req, res, token) {
  const paymentLink = await getPaymentLink(token);
  if (!paymentLink) {
    return html(res, 404, renderMessagePage('Payment link not found', 'This payment link does not exist or is no longer available.'));
  }

  if (paymentLink.expiresAt && Date.parse(paymentLink.expiresAt) < Date.now()) {
    return html(res, 410, renderMessagePage('Payment link expired', 'This payment link has expired. Please request a new one.'));
  }

  const hiddenFields = {
    merchantId: paymentLink.merchantId,
    amount: paymentLink.amount,
    currency: paymentLink.currency,
    customerName: paymentLink.customerName,
    email: paymentLink.email,
    mobilePhone: paymentLink.mobilePhone,
    paymentLinkToken: paymentLink.token || token,
  };

  if (paymentLink.invoiceNumber) {
    const invoice = await getInvoice(paymentLink.invoiceNumber);
    if (invoice) {
      const portalDb = await loadMerchantPortalDb();
      const merchantProfile = portalDb[invoice.username] || null;
      return html(res, 200, renderInvoiceReviewPage(invoice, merchantProfile, hiddenFields));
    }
  }

  return html(res, 200, renderAutoPostPage('/api/initiate', hiddenFields));
}

function handleHealth(req, res) {
  return json(res, 200, {
    ok: true,
    service: 'cardzone-payment-backend',
    timestamp: new Date().toISOString(),
  });
}

module.exports = async function handler(req, res) {
  try {
    res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      return res.end();
    }

    const u = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && (u.pathname === '/favicon.ico' || u.pathname === '/favicon.png')) {
      res.statusCode = 204;
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.end();
    }

    if (req.method === 'GET' && u.pathname === '/login') {
      const existingSession = getAuthenticatedSession(req);
      if (existingSession) {
        return redirect(res, '/portal');
      }
      return html(res, 200, renderLoginPage(getRequestBaseUrl(req)));
    }

    if (req.method === 'POST' && (u.pathname === '/api/login' || u.pathname === '/login')) {
      return await handleLogin(req, res);
    }

    if (req.method === 'POST' && (u.pathname === '/api/logout' || u.pathname === '/logout')) {
      return handleLogout(req, res);
    }

    if (req.method === 'GET' && (u.pathname === '/api/session' || u.pathname === '/session')) {
      return handleSessionInfo(req, res);
    }

    if (req.method === 'POST' && u.pathname === '/api/account/password') {
      return await handleChangePassword(req, res);
    }

    if (req.method === 'POST' && u.pathname === '/api/account/username') {
      return await handleChangeUsername(req, res);
    }

    if (req.method === 'POST' && u.pathname === '/api/merchant/profile') {
      return await handleUpdateMerchantProfile(req, res);
    }

    if (req.method === 'GET' && u.pathname === '/api/developer/merchants') {
      return await handleListDeveloperMerchants(req, res);
    }

    if (req.method === 'POST' && u.pathname === '/api/developer/merchants') {
      return await handleCreateDeveloperMerchant(req, res);
    }

    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/portal')) {
      const session = getAuthenticatedSession(req);
      if (!session) {
        return redirect(res, '/login');
      }
      const sessionView = buildSessionClientView(session);
      const portalModel = await getPortalModelForSession(sessionView);
      return html(res, 200, renderMerchantPortalPage(getRequestBaseUrl(req), sessionView, portalModel));
    }

    if (req.method === 'GET' && (u.pathname === '/api' || u.pathname === '/developer')) {
      return html(res, 200, renderDeveloperHome(getRequestBaseUrl(req)));
    }

    if (req.method === 'POST' && (u.pathname === '/api/initiate' || u.pathname === '/initiate')) {
      return await handleInitiate(req, res);
    }

    if (req.method === 'POST' && (u.pathname === '/api/payment-links' || u.pathname === '/payment-links')) {
      return await handleCreatePaymentLink(req, res);
    }

    if (req.method === 'POST' && u.pathname === '/api/invoices') {
      return await handleCreateInvoice(req, res);
    }

    if (req.method === 'GET' && u.pathname === '/api/invoices') {
      return await handleListInvoices(req, res);
    }

    if (req.method === 'GET' && /^\/api\/invoices\/[^/]+\/pdf$/.test(u.pathname)) {
      const parts = u.pathname.split('/').filter(Boolean);
      const invoiceNumber = decodeURIComponent(parts[2] || '');
      return await handleDownloadInvoicePdf(req, res, invoiceNumber);
    }

    if (req.method === 'DELETE' && /^\/api\/invoices\/[^/]+$/.test(u.pathname)) {
      const parts = u.pathname.split('/').filter(Boolean);
      const invoiceNumber = decodeURIComponent(parts[2] || '');
      return await handleDeleteInvoice(req, res, invoiceNumber);
    }

    if (req.method === 'GET' && u.pathname === '/api/transactions') {
      return await handleListTransactions(req, res);
    }

    if (req.method === 'GET' && /^\/api\/transactions\/[^/]+\/pdf$/.test(u.pathname)) {
      const parts = u.pathname.split('/').filter(Boolean);
      const txnId = decodeURIComponent(parts[2] || '');
      return await handleDownloadTransactionPdf(req, res, txnId);
    }

    if (req.method === 'GET' && u.pathname === '/api/dashboard-summary') {
      return await handleDashboardSummary(req, res);
    }

    if (req.method === 'GET' && (u.pathname === '/api/merchant-currency' || u.pathname === '/merchant-currency')) {
      return await handleMerchantCurrency(req, res);
    }

    if (req.method === 'GET' && u.pathname.startsWith('/pay/')) {
      const parts = u.pathname.split('/').filter(Boolean);
      const token = parts[parts.length - 1] || '';
      return await handlePaymentLinkLanding(req, res, token);
    }

    if (req.method === 'GET' && (u.pathname === '/callback' || u.pathname === '/api/callback')) {
      const txnId =
        u.searchParams.get('txnId') ||
        u.searchParams.get('MPI_TRXN_ID') ||
        u.searchParams.get('trxnId') ||
        '';
      const returnPath = txnId ? `/api/return?txnId=${encodeURIComponent(txnId)}` : '/api/return';
      return redirect(res, returnPath);
    }

    if (req.method === 'POST' && (u.pathname === '/callback' || u.pathname === '/api/callback')) {
      return await handleCallback(req, res);
    }

    if ((req.method === 'GET' || req.method === 'POST') && (u.pathname === '/return' || u.pathname === '/api/return')) {
      return await handleReturn(req, res);
    }

    if (req.method === 'GET' && (u.pathname === '/receipt.pdf' || u.pathname === '/api/receipt.pdf')) {
      return await handleReceiptPdf(req, res);
    }

    if (req.method === 'GET' && (u.pathname.startsWith('/api/tx/') || u.pathname.startsWith('/tx/'))) {
      const parts = u.pathname.split('/').filter(Boolean);
      const txnId = parts[parts.length - 1] || '';
      if (!txnId) {
        return json(res, 400, { error: 'txnId is required' });
      }
      return await handleTxDebug(req, res, txnId);
    }

    if (req.method === 'GET' && (u.pathname === '/health' || u.pathname === '/api/health')) {
      return handleHealth(req, res);
    }

    if (u.pathname === '/start-payment') {
      return html(
        res,
        410,
        renderMessagePage('Deprecated route', 'Use POST /api/initiate from merchant checkout page.')
      );
    }

    return html(res, 404, renderMessagePage('Not Found', 'The requested endpoint does not exist.'));
  } catch (err) {
    console.error('[Cardzone][server-error]', err);
    return html(res, 500, renderMessagePage('Server error', err.message));
  }
};
