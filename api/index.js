const crypto = require('crypto');
const { URL } = require('url');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const PDFDocument = require('pdfkit');

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
const MERCHANT_CURRENCY_DB_PATH =
  process.env.MERCHANT_CURRENCY_DB_PATH || path.join(process.cwd(), 'data', 'merchant-currency.json');
const ENABLE_MKREQ_MAC = process.env.ENABLE_MKREQ_MAC === 'true';
const TEMP_DIR = process.env.VERCEL ? '/tmp' : path.join(os.tmpdir(), 'cardzone-backend');
const PAYMENT_LINK_TTL_MS = Number(process.env.PAYMENT_LINK_TTL_MS || 30 * 60 * 1000);

const txStore = new Map();

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

async function loadMerchantCurrencyDb() {
  try {
    const raw = await fs.readFile(MERCHANT_CURRENCY_DB_PATH, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    const map = new Map();

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [mid, curr] of Object.entries(parsed)) {
        const id = normalizeMerchantId(mid);
        const code = normalizeCurrency(curr);
        if (id && code) map.set(id, code);
      }
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

function renderResultPage(tx, paymentStatus, finalResult, homeUrl = '/') {
  const isSuccess = paymentStatus === 'SUCCESS';
  const isPaymentLinkFlow = tx?.initiationSource === 'payment-link' || !!tx?.paymentLinkToken;
  const responseCode = finalResult?.responseCode || '';
  const responseReason = getResponseReasonFromCode(responseCode, finalResult?.responseReason || '');

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

  const accentColor  = isSuccess ? '#059669' : '#dc2626';
  const statusColor  = isSuccess ? '#065f46' : '#7f1d1d';
  const statusBg     = isSuccess ? '#ecfdf5' : '#fef2f2';
  const statusBorder = isSuccess ? '#6ee7b7' : '#fca5a5';
  const iconBg       = isSuccess ? '#10b981' : '#ef4444';
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
    /* ── Bank header ── */
    .hdr{background:linear-gradient(135deg,#0f2d5e 0%,#1a4a8a 100%);border-radius:16px 16px 0 0;padding:20px 28px;
      display:flex;align-items:center;gap:14px;}
    .hdr-icon{width:48px;height:48px;border-radius:50%;background:rgba(255,255,255,.18);
      display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0;}
    .hdr-title{font-size:17px;font-weight:700;color:#fff;letter-spacing:.2px;}
    .hdr-sub{font-size:11.5px;color:rgba(255,255,255,.6);margin-top:2px;}
    /* ── Card ── */
    .card{background:#fff;border-radius:0 0 16px 16px;box-shadow:0 20px 60px rgba(15,45,94,.15);overflow:hidden;}
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
    .btn-home{background:#0f2d5e;color:#fff;}
    .btn-home:hover{background:#1a3f70;}
    /* ── Footer ── */
    .ftr{padding:14px 28px 18px;background:#f8fafc;border-top:1px solid #e2e8f0;
      font-size:11px;color:#94a3b8;text-align:center;line-height:1.7;}
    /* ── Print styles ── */
    @media print{
      body{background:#fff;padding:0;}
      .wrap{max-width:100%;}
      .hdr{background:#0f2d5e!important;-webkit-print-color-adjust:exact;print-color-adjust:exact;border-radius:0;}
      .card{box-shadow:none;border-radius:0;}
      .actions{display:none!important;}
      .ftr{font-size:9px;}
      @page{margin:12mm;}
    }
    @media(max-width:580px){
      .hdr,.body,.actions,.ftr{padding-left:16px;padding-right:16px;}
      .sbanner{padding-left:16px;padding-right:16px;}
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hdr">
      <div class="hdr-icon">&#127974;</div>
      <div>
        <div class="hdr-title">Secure Payment Gateway</div>
        <div class="hdr-sub">Official Electronic Payment Receipt</div>
      </div>
    </div>
    <div class="card">
      <div class="sbanner">
        <div class="sicon">${isSuccess ? '&#10004;' : '&#10008;'}</div>
        <div>
          <div class="slabel">${escapeHtml(statusLabel)}</div>
          <div class="stxn">Transaction ID: ${escapeHtml(tx.txnId)}</div>
        </div>
      </div>
      <div class="body">
        <div class="sec-title">Transaction Details</div>
        <table>${tableRows}</table>
      </div>
      <div class="actions">
        <button class="btn btn-dl" onclick="downloadReceiptPdf()">&#8659;&nbsp;Download PDF Receipt</button>
        <button class="btn btn-print" onclick="window.print()">&#128438;&nbsp;Print Receipt</button>
        ${homeButtonHtml}
      </div>
      <div class="ftr">
        This is an official electronic receipt issued by the Secure Payment Gateway.<br>
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

function renderPublicCheckoutPage(baseUrl) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Secure Payment Portal</title>
  <style>
    :root{
      --bg:#eef3fb;
      --card:#ffffff;
      --text:#10213a;
      --muted:#5f6f86;
      --brand:#0f2d5e;
      --brand-2:#1a4a8a;
      --accent:#165dff;
      --accent-2:#0e4bd4;
      --border:#d9e3f3;
      --ok:#0f9b63;
      --warn:#c27a00;
    }
    *{box-sizing:border-box}
    body{
      margin:0;
      font-family:Segoe UI,Arial,sans-serif;
      color:var(--text);
      background:linear-gradient(180deg,#f8fbff 0%, var(--bg) 100%);
      min-height:100vh;
      padding:28px 14px;
    }
    .container{width:100%;max-width:940px;margin:0 auto}
    .layout{display:grid;grid-template-columns:1.2fr .8fr;gap:18px}
    .card{
      background:var(--card);
      border:1px solid var(--border);
      border-radius:18px;
      box-shadow:0 16px 40px rgba(16,33,58,.10);
      overflow:hidden;
    }
    .bank-head{
      background:linear-gradient(135deg,var(--brand) 0%,var(--brand-2) 100%);
      padding:18px 22px;
      color:#fff;
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:12px;
    }
    .bank-brand{display:flex;align-items:center;gap:10px}
    .bank-icon{
      width:42px;height:42px;border-radius:999px;
      background:rgba(255,255,255,.16);
      display:flex;align-items:center;justify-content:center;
      font-size:20px;
    }
    .bank-title{font-size:17px;font-weight:700;letter-spacing:.2px}
    .bank-sub{font-size:11.5px;opacity:.78;margin-top:2px}
    .bank-badge{
      font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;
      padding:7px 10px;border-radius:999px;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.28)
    }
    .panel-body{padding:20px 22px 22px}
    .heading{margin-bottom:14px}
    .title{margin:0 0 5px;font-size:24px;line-height:1.2}
    .subtitle{margin:0;color:var(--muted);font-size:13.5px}
    .form-grid{display:grid;grid-template-columns:1fr 1fr;gap:13px;margin-top:12px}
    .field{display:flex;flex-direction:column;gap:6px}
    .field.full{grid-column:1 / -1}
    label{font-size:12.5px;color:#2c3f5f;font-weight:700}
    input,textarea{
      width:100%;
      border:1px solid #cfdced;
      background:#fff;
      color:#10213a;
      border-radius:10px;
      padding:11px 12px;
      outline:none;
      transition:border-color .2s,box-shadow .2s;
      font-size:13.5px;
    }
    textarea{resize:vertical;min-height:88px}
    input:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(22,93,255,.12)}
    .section-label{
      grid-column:1 / -1;
      margin-top:4px;
      font-size:11px;
      font-weight:700;
      color:#60708c;
      text-transform:uppercase;
      letter-spacing:.8px;
      padding-bottom:7px;
      border-bottom:1px solid #e6edf8;
    }
    .currency-pill{
      display:inline-flex;align-items:center;gap:6px;
      border:1px solid #d6e2f2;background:#f6f9ff;color:#26446d;
      border-radius:999px;padding:5px 9px;font-size:11px;font-weight:700;
    }
    .button-row{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}
    .submit{
      flex:1;
      min-width:240px;
      background:linear-gradient(180deg,var(--accent),var(--accent-2));
      color:white;
      border:0;
      border-radius:10px;
      padding:12px 16px;
      font-weight:700;
      cursor:pointer;
    }
    .submit:hover{filter:brightness(.98)}
    .secondary{
      flex:1;
      min-width:210px;
      background:#f0f4f9;
      color:var(--text);
      border:1px solid var(--border);
      border-radius:10px;
      padding:12px 16px;
      font-weight:600;
      cursor:pointer;
      font-size:13.5px;
    }
    .secondary:hover{background:#e8ecf4}
    .link-panel{display:none;margin-top:12px;border:1px solid #dbe6f5;border-radius:12px;padding:12px;background:#f8fbff}
    .link-panel.active{display:block}
    .link-panel h3{margin:2px 0 8px;font-size:15px}
    .link-panel p{margin:6px 0;color:var(--muted);font-size:13px}
    .link-output{display:flex;gap:8px;margin:10px 0}
    .link-output input{flex:1;font-size:12px;padding:10px;border-radius:8px}
    .link-output button{flex:0 0 auto;width:auto;margin-top:0;min-width:100px}
    .tiny{font-size:12px;color:#8a9aad}

    .side{
      background:#fff;
      border:1px solid var(--border);
      border-radius:18px;
      box-shadow:0 16px 40px rgba(16,33,58,.08);
      padding:16px;
      height:fit-content;
    }
    .side h3{margin:0 0 8px;font-size:15px;color:#17345f}
    .side p{margin:0;color:#60708c;font-size:12.8px;line-height:1.55}
    .trust{
      margin-top:12px;
      padding:12px;
      border:1px solid #dde8f6;
      border-radius:10px;
      background:#f8fbff;
    }
    .trust ul{margin:0;padding:0;list-style:none;display:grid;gap:8px}
    .trust li{display:flex;align-items:center;gap:8px;color:#3c4f6e;font-size:12.8px}
    .dot{height:8px;width:8px;border-radius:999px;background:var(--ok);flex:none}

    .notice{
      margin-top:10px;
      border:1px solid #fde6b7;
      background:#fffbf0;
      color:#7a5b1d;
      padding:10px 11px;
      border-radius:10px;
      font-size:12px;
      line-height:1.45;
    }
    .footnote{margin-top:12px;color:#8fa0ba;font-size:11px;line-height:1.45}

    @media (max-width:980px){
      .layout{grid-template-columns:1fr}
      .side{order:2}
    }
    @media (max-width:900px){
      .form-grid{grid-template-columns:1fr}
      .button-row{flex-direction:column}
      .submit,.secondary{min-width:0;width:100%}
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="layout">
      <section class="card">
        <div class="bank-head">
          <div class="bank-brand">
            <div class="bank-icon">&#127974;</div>
            <div>
              <div class="bank-title">Secure Payment Gateway</div>
              <div class="bank-sub">Bank-grade card processing portal</div>
            </div>
          </div>
          <div class="bank-badge">3D Secure</div>
        </div>

        <div class="panel-body">
          <div class="heading">
            <h1 class="title">Business Payment Portal</h1>
            <p class="subtitle">Initiate card transactions through a secure hosted banking flow and receive professional digital receipts.</p>
          </div>

          <form id="checkoutForm" method="post" action="/api/initiate" autocomplete="on">
            <div class="form-grid">
              <div class="section-label">Payment Details</div>

              <div class="field">
                <label for="merchantId">Merchant ID</label>
                <input id="merchantId" name="merchantId" required placeholder="Enter registered MID" />
              </div>

              <div class="field" style="position:relative">
                <label for="amount">Amount <span id="currencyPill" class="currency-pill" style="display:none">Currency: <span id="currencyLabel"></span></span></label>
                <input id="amount" name="amount" type="number" required min="0.01" step="0.01" placeholder="0.00" />
              </div>

              <div class="section-label">Customer Details</div>

              <div class="field">
                <label for="customerName">Customer Name</label>
                <input id="customerName" name="customerName" placeholder="Enter customer full name" />
              </div>

              <div class="field">
                <label for="email">Customer Email</label>
                <input id="email" name="email" type="email" placeholder="Enter customer email" />
              </div>

              <div class="field full">
                <label for="paymentDescription">Payment Description</label>
                <textarea id="paymentDescription" name="paymentDescription" placeholder="Describe service or purpose of payment"></textarea>
              </div>
            </div>

            <input id="currency" name="currency" type="hidden" value="" />

            <div class="button-row">
              <button class="submit" type="submit" id="proceedButton">Proceed to Secure Payment</button>
              <button class="secondary" type="button" id="generateLinkButton">Generate Payment Link</button>
            </div>

            <div class="link-panel" id="paymentLinkPanel">
              <h3>Shareable payment link</h3>
              <p>Send this link to the cardholder. Opening it will start the secure Cardzone payment flow.</p>
              <div class="link-output">
                <input id="paymentLinkOutput" readonly value="" />
                <button class="secondary" type="button" id="copyLinkButton">Copy Link</button>
              </div>
              <p class="tiny" id="paymentLinkMeta"></p>
            </div>
          </form>

          <div class="notice">
            Use only registered merchant details. After payment completion, a professional receipt with downloadable PDF is available for customer support and dispute handling.
          </div>

          <div class="footnote">
            Gateway: ${escapeHtml(baseUrl)} • End-to-end hosted transaction flow.
          </div>
        </div>
      </section>

      <aside class="side">
        <h3>Security & Compliance</h3>
        <div class="trust">
          <ul>
            <li><span class="dot"></span><span>Hosted redirection to secure card entry</span></li>
            <li><span class="dot"></span><span>3D Secure cardholder authentication</span></li>
            <li><span class="dot"></span><span>Response-code based transaction validation</span></li>
            <li><span class="dot"></span><span>Downloadable PDF receipt for support sharing</span></li>
          </ul>
        </div>
        <div class="notice" style="margin-top:12px;border-color:#d8e7ff;background:#f4f8ff;color:#2c4f83">
          Recommended: verify MID and amount before submission. For callback troubleshooting, share the receipt and transaction ID with the portal owner.
        </div>
      </aside>
    </div>
  </div>
  <script>
    (function () {
      const form = document.getElementById('checkoutForm');
      const midInput = document.getElementById('merchantId');
      const amountInput = document.getElementById('amount');
      const customerNameInput = document.getElementById('customerName');
      const emailInput = document.getElementById('email');
      const currencyLabel = document.getElementById('currencyLabel');
      const currencyPill = document.getElementById('currencyPill');
      const currencyInput = document.getElementById('currency');
      const proceedButton = document.getElementById('proceedButton');
      const generateLinkButton = document.getElementById('generateLinkButton');
      const copyLinkButton = document.getElementById('copyLinkButton');
      const paymentLinkPanel = document.getElementById('paymentLinkPanel');
      const paymentLinkOutput = document.getElementById('paymentLinkOutput');
      const paymentLinkMeta = document.getElementById('paymentLinkMeta');

      const currencyCodeToName = {
        '840': 'USD',
        '356': 'INR',
        '064': 'BTN',
        '524': 'NPR',
        '144': 'LKR',
        '586': 'PKR',
        '050': 'BDT',
        '702': 'SGD',
        '978': 'EUR',
        '826': 'GBP',
        '036': 'AUD',
        '124': 'CAD',
        '392': 'JPY',
        '156': 'CNY',
        '410': 'KRW'
      };

      async function updateCurrency() {
        const merchantId = (midInput.value || '').trim();
        if (!merchantId) {
          currencyInput.value = '';
          currencyLabel.textContent = '';
          currencyPill.style.display = 'none';
          return;
        }

        try {
          const res = await fetch('/api/merchant-currency?merchantId=' + encodeURIComponent(merchantId), {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
          });

          if (!res.ok) {
            currencyInput.value = '';
            currencyLabel.textContent = '';
            currencyPill.style.display = 'none';
            return;
          }

          const data = await res.json();
          const code = (data && data.currency) ? String(data.currency) : '';
          currencyInput.value = code;
          const displayName = currencyCodeToName[code] || code;
          currencyLabel.textContent = displayName || '';
          currencyPill.style.display = displayName ? 'inline-flex' : 'none';
        } catch {
          currencyInput.value = '';
          currencyLabel.textContent = '';
          currencyPill.style.display = 'none';
        }
      }

      async function generatePaymentLink() {
        const merchantId = (midInput.value || '').trim();
        const amount = (amountInput.value || '').trim();

        if (!merchantId || !amount) {
          window.alert('Enter MID and amount first.');
          return;
        }

        generateLinkButton.disabled = true;
        generateLinkButton.textContent = 'Generating...';

        try {
          await updateCurrency();

          const res = await fetch('/api/payment-links', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            },
            body: JSON.stringify({
              merchantId,
              amount,
              currency: currencyInput.value,
              customerName: (customerNameInput.value || '').trim(),
              email: (emailInput.value || '').trim()
            })
          });

          const data = await res.json();
          if (!res.ok || !data.paymentUrl) {
            throw new Error(data.error || 'Unable to generate payment link.');
          }

          paymentLinkOutput.value = data.paymentUrl;
          paymentLinkMeta.textContent = 'Currency: ' + data.currency + ' • Expires: ' + new Date(data.expiresAt).toLocaleString();
          paymentLinkPanel.classList.add('active');
        } catch (error) {
          window.alert(error.message || 'Unable to generate payment link.');
        } finally {
          generateLinkButton.disabled = false;
          generateLinkButton.textContent = 'Generate Payment Link';
        }
      }

      async function copyPaymentLink() {
        const value = paymentLinkOutput.value || '';
        if (!value) return;

        try {
          await navigator.clipboard.writeText(value);
          copyLinkButton.textContent = 'Copied';
          setTimeout(() => {
            copyLinkButton.textContent = 'Copy Link';
          }, 1500);
        } catch {
          paymentLinkOutput.focus();
          paymentLinkOutput.select();
        }
      }

      function handleSubmit() {
        proceedButton.disabled = true;
        proceedButton.textContent = 'Redirecting to Bank Gateway...';
      }

      midInput.addEventListener('input', updateCurrency);
      generateLinkButton.addEventListener('click', generatePaymentLink);
      copyLinkButton.addEventListener('click', copyPaymentLink);
      form.addEventListener('submit', handleSubmit);
      updateCurrency();
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

async function handleInitiate(req, res) {
  const raw = await parseBody(req);
  const contentType = (req.headers['content-type'] || '').toLowerCase();
  const input = parseRawPayload(raw, contentType);

  const merchantId = String(input.merchantId || MERCHANT_ID_DEFAULT || '').trim();
  const amount = String(input.amount || '').trim();
  const currencyInput = String(input.currency || '').trim();
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

  const currencyResolved = normalizeCurrency(currencyInput)
    ? { currency: normalizeCurrency(currencyInput), source: 'request' }
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
    console.error('[Cardzone][initiate] mkReq failed:', error.message);
    return html(res, 502, renderMessagePage('Unable to start payment', error.message));
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

  return html(res, 200, renderResultPage(tx, finalStatus, finalResult));
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

  if (callbackReceived && (!callbackResultTrusted || !hasSufficientFinalResult(finalResult))) {
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

  return html(res, 200, renderResultPage(tx, effectiveStatus, finalResult, getRequestBaseUrl(req)));
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
  const raw = await parseBody(req);
  const contentType = (req.headers['content-type'] || '').toLowerCase();
  const input = parseRawPayload(raw, contentType);

  const merchantId = String(input.merchantId || '').trim();
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

  const currencyInput = String(input.currency || '').trim();
  const currencyResolved = normalizeCurrency(currencyInput)
    ? { currency: normalizeCurrency(currencyInput), source: 'request' }
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

async function handlePaymentLinkLanding(req, res, token) {
  const paymentLink = await getPaymentLink(token);
  if (!paymentLink) {
    return html(res, 404, renderMessagePage('Payment link not found', 'This payment link does not exist or is no longer available.'));
  }

  if (paymentLink.expiresAt && Date.parse(paymentLink.expiresAt) < Date.now()) {
    return html(res, 410, renderMessagePage('Payment link expired', 'This payment link has expired. Please request a new one.'));
  }

  return html(
    res,
    200,
    renderAutoPostPage('/api/initiate', {
      merchantId: paymentLink.merchantId,
      amount: paymentLink.amount,
      currency: paymentLink.currency,
      customerName: paymentLink.customerName,
      email: paymentLink.email,
      mobilePhone: paymentLink.mobilePhone,
      paymentLinkToken: paymentLink.token || token,
    })
  );
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

    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/checkout')) {
      return html(res, 200, renderPublicCheckoutPage(getRequestBaseUrl(req)));
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
