# Complete IPG Integration with 3DS Server Flow

## Overview
This is a **Cardzone 3D Secure (3DS) payment gateway integration** that implements a secure, multi-step payment flow with cryptographic key exchange, transaction authentication, and result verification. The system uses RSA-2048 encryption for security and follows the Cardzone MPI (Merchant Plug-in) protocol.

---

## Architecture Components

### 1. **Frontend (Merchant's Website)**
- Customer-facing checkout page
- Collects payment request details (amount, merchant ID, customer info)
- Submits to backend API

### 2. **Backend Server (Node.js API)**
- Initiates payment transactions
- Handles key exchanges with Cardzone
- Manages callbacks from Cardzone
- Verifies cryptographic signatures (MAC)
- Performs inquiry/reconciliation if needed

### 3. **Cardzone 3DS Server (External Payment Gateway)**
- Hosts the secure 3DS payment page
- Authenticates cardholder
- Returns transaction result via callback

---

## Detailed Transaction Flow

### **Phase 1: Key Exchange (mkReq)**

#### Step 1.1: Merchant Generates RSA Key Pair
```
Location: handleInitiate() → createRsaKeyPair()
Output: 
- RSA 2048-bit public/private key pair
- Public key exported as Base64URL (SPKI format)
```

**Why?** 
- Merchant's public key sent to Cardzone for signing responses
- Merchant's private key used to sign outgoing requests
- Ensures only legitimate communication between merchant and Cardzone

#### Step 1.2: Merchant Calls mkReq Endpoint
```
POST https://3dsecure.bob.bt/3dss/mkReq
Content-Type: application/json

{
  "merchantId": "863990030700270",
  "purchaseId": "20260512145230abc12",      // Unique transaction ID
  "pubKey": "base64url_encoded_public_key",  // Merchant's public key
  "mac": "optional_rsa_sha256_signature"     // If ENABLE_MKREQ_MAC is true
}
```

**Process:**
- Function: `doMkReq()`
- Merchant generates unique `purchaseId` (transaction ID)
- Includes merchant's public key (SPKI format, Base64URL)
- Optional: Sign the request with merchant's private key
- Sends via HTTPS POST to Cardzone

#### Step 1.3: Receive Cardzone Public Key
```
Response from Cardzone:
{
  "errorCode": "000",
  "pubKey": "base64url_encoded_cardzone_public_key"
}
```

**Processing:**
- Validate response: `errorCode === "000"` and `pubKey` exists
- Store Cardzone's public key for future MAC verification
- If response fails, transaction aborts with error page

---

### **Phase 2: Transaction Initialization (MercReq)**

#### Step 2.1: Prepare MPI Request
```
Transaction data collected:
- merchantId: Registered merchant identifier
- txnId: Unique transaction reference
- amount: Payment amount in minor units (cents)
- currency: ISO 4217 currency code (e.g., "840" for USD)
- customerName, email: Customer information
- purchDate: Transaction timestamp (YYYYMMDDhhmmss format)
```

#### Step 2.2: Build MPI Request Fields
```javascript
MPI_TRANS_TYPE: "SALES"
MPI_MERC_ID: "863990030700270"
MPI_TRXN_ID: "20260512145230abc12"
MPI_PURCH_DATE: "20260512141530"
MPI_PURCH_CURR: "840"               // Currency code
MPI_PURCH_AMT: "29999"              // Amount in minor units
MPI_RESPONSE_LINK: "https://merchant.com/api/callback"
MPI_EMAIL: "customer@example.com"
```

**Optional Fields (excluded if not provided):**
- Billing address fields (MPI_BILL_ADDR_*)
- Shipping address fields (MPI_SHIP_ADDR_*)
- Phone fields (MPI_MOBILE_PHONE, etc.)
- Line items (MPI_LINE_ITEM)

#### Step 2.3: Sign the MPI Request (MAC Calculation)
```
Process:
1. Concatenate ALL fields in specific order (defined by getMpiReqMacFieldSequence)
2. Create RSA-SHA256 signature using merchant's PRIVATE key
3. Encode signature as Base64URL (no padding)
4. Add as MPI_MAC field to request

Field Sequence for MAC:
MPI_TRANS_TYPE | MPI_MERC_ID | MPI_PAN | MPI_CARD_HOLDER_NAME | 
MPI_PAN_EXP | MPI_CVV2 | MPI_TRXN_ID | MPI_ORI_TRXN_ID | 
MPI_PURCH_DATE | MPI_PURCH_CURR | MPI_PURCH_AMT | MPI_ADDR_MATCH | 
[BILLING ADDRESS] | [SHIPPING ADDRESS] | MPI_EMAIL | 
[LINE ITEMS FLATTENED] | MPI_RESPONSE_TYPE
```

#### Step 2.4: Redirect to Cardzone Hosted Payment Page
```
1. Create auto-submit HTML form with MPI fields
2. Set action to Cardzone URL: https://3dsecure.bob.bt/3dss/mercReq
3. Browser redirects customer to Cardzone's secure page
4. Customer enters card details and completes 3DS authentication

Rendering: renderAutoPostPage()
```

**HTML Form Structure:**
```html
<form method="post" action="https://3dsecure.bob.bt/3dss/mercReq">
  <input name="MPI_TRANS_TYPE" value="SALES" />
  <input name="MPI_MERC_ID" value="863990030700270" />
  <input name="MPI_TRXN_ID" value="20260512145230abc12" />
  <!-- ... all MPI fields ... -->
  <input name="MPI_MAC" value="base64url_signature" />
</form>
<!-- Auto-submits on page load -->
```

---

### **Phase 3: 3DS Authentication (Cardholder Journey)**

#### Step 3.1: Cardholder at Cardzone
```
- Cardzone displays secure payment form
- Cardholder enters card details, completes 3DS verification
- Cardzone processes the transaction with issuing bank
- Transaction approved/declined
```

#### Step 3.2: Cardzone Sends Result Back to Merchant
```
POST https://merchant.com/api/callback
Content-Type: application/x-www-form-urlencoded

MPI_MERC_ID=863990030700270&
MPI_TRXN_ID=20260512145230abc12&
MPI_ERROR_CODE=000&
MPI_APPR_CODE=AUTH123456&
MPI_RRN=991234567890&
MPI_BIN=512345&
MPI_REFERRAL_CODE=&
MPI_CARDHOLDER_INFO=&
MPI_MAC=base64url_signature
```

**Response Fields:**
| Field | Meaning |
|-------|---------|
| MPI_ERROR_CODE | "000" = Success, other = failure |
| MPI_APPR_CODE | Authorization/approval code |
| MPI_RRN | Reference number from bank |
| MPI_BIN | First 6 digits of card |
| MPI_CARDHOLDER_INFO | Additional cardholder response info |
| MPI_MAC | Cryptographic signature for verification |

---

### **Phase 4: Callback Processing**

#### Step 4.1: Receive and Parse Callback
```
Function: handleCallback()

1. Extract transaction ID from MPI_TRXN_ID field
2. Load stored transaction from file system
3. Parse callback payload (form-encoded or JSON)
```

#### Step 4.2: MAC Verification (Security Check)
```
Process:
1. Concatenate fields in specific order (mpiResVerifyString):
   MPI_MERC_ID | MPI_TRXN_ID | MPI_ERROR_CODE | MPI_APPR_CODE |
   MPI_RRN | MPI_BIN | MPI_REFERRAL_CODE | MPI_CARDHOLDER_INFO

2. Verify RSA-SHA256 signature using Cardzone's PUBLIC key
3. If MAC doesn't verify → attempt inquiry to confirm result

Security Logic:
- If MAC present and valid → Trust callback result
- If MAC missing or invalid → Query Cardzone via Inquiry
- Only mark as SUCCESS if response code == "000" and has auth code
```

**MAC Verification Code:**
```javascript
const verifyInput = mpiResVerifyString(fields);
const macVerified = verifySha256WithRsaBase64Url(
  verifyInput,
  fields.MPI_MAC,
  tx.security.cardzonePublicKeyBase64Url
);
```

#### Step 4.3: Build Final Result
```javascript
finalResult = {
  source: "callback",        // or "inquiry"
  resolvedAt: timestamp,
  authorizationCode: "AUTH123456",
  referenceNumber: "991234567890",
  responseCode: "000",
  responseReason: "APPROVED",
  referralCode: "",
  bin: "512345"
}
```

#### Step 4.4: Map Payment Status
```
Status Mapping:
- responseCode === "000" + authorizationCode exists → "SUCCESS"
- Other response codes → "FAILED"
- No result data → "PENDING"
```

---

### **Phase 5: Inquiry/Reconciliation (If Needed)**

#### Step 5.1: When Inquiry is Triggered
```
Inquiry is called when:
1. MAC verification failed (untrusted callback)
2. No MPI_MAC in callback (incomplete data)
3. Callback has no result fields (no auth code/error)
4. Payment status cannot be determined from callback
```

#### Step 5.2: Send Inquiry Request
```
Function: doInquiry()

POST https://3dsecure.bob.bt/3dss/mercReq  (Inquiry URL)
Content-Type: application/x-www-form-urlencoded

MPI_TRANS_TYPE=INQ&
MPI_MERC_ID=863990030700270&
MPI_ORI_TRXN_ID=20260512145230abc12&
MPI_MAC=signature_of_above_fields
```

**Inquiry Fields:**
- `MPI_TRANS_TYPE`: "INQ" (inquiry, not "SALES")
- `MPI_MERC_ID`: Merchant ID
- `MPI_ORI_TRXN_ID`: Original transaction ID to inquire about

#### Step 5.3: Parse Inquiry Response
```
Response contains same fields as callback:
- MPI_ERROR_CODE
- MPI_APPR_CODE
- MPI_RRN
- MPI_MAC (for verification)
```

#### Step 5.4: Verify and Use Inquiry Result
```
1. Verify inquiry response MAC (same as callback MAC verification)
2. If verification succeeds and has result → use as final result
3. If verification fails → log error, keep callback result
4. Update transaction with inquiry result
```

---

### **Phase 6: Return to Merchant**

#### Step 6.1: Customer Returns to Merchant
```
Scenarios:
1. Auto-redirect from Cardzone after payment
2. Browser back button
3. Follow return URL link
4. Timeout redirect

Endpoint: GET/POST /api/return?txnId=20260512145230abc12
```

#### Step 6.2: Retrieve Transaction State
```
Function: handleReturn()

1. Load transaction from file system by txnId
2. Check if callback was received
3. If callback not received → perform inquiry
4. Return final result page with payment status
```

#### Step 6.3: Display Result Page
```
renderResultPage() shows:
- Payment Status (SUCCESS/FAILED/PENDING)
- Reference Number (RRN)
- Authorization Code
- Response Code and Reason
- Transaction ID

Example Response Codes:
- "000" = APPROVED
- "51" = INSUFFICIENT FUNDS
- "54" = EXPIRED CARD
- "55" = INCORRECT PIN
```

---

## Payment Link Feature

### Overview
Merchants can generate shareable payment links that expire after a fixed time (default: 7 days).

### Flow

#### Step 1: Generate Payment Link
```
POST /api/payment-links
{
  "merchantId": "863990030700270",
  "amount": "299.99",
  "currency": "840",
  "customerName": "John Doe",
  "email": "john@example.com"
}

Response:
{
  "token": "random_base64url_token",
  "paymentUrl": "https://merchant.com/pay/random_base64url_token",
  "expiresAt": "2026-05-19T14:15:30Z"
}
```

#### Step 2: Share Payment Link
- Customer receives link via email
- Opens link in browser

#### Step 3: Landing Page
```
GET /pay/{token}

1. Validate token exists
2. Check if link expired
3. Render auto-submit form with payment details
4. Auto-redirect to /api/initiate → Cardzone hosted page
```

---

## Data Storage

### Transaction File Storage
```
Location: /tmp/cardzone-backend/ (or $TEMP_DIR)
File: txn_{txnId}.json

Structure:
{
  "txnId": "20260512145230abc12",
  "orderRef": "ORD-20260512145230abc12",
  "customerRef": "CUST-145230ab",
  "merchantId": "863990030700270",
  "amountMinor": "29999",
  "amountMajor": "299.99",
  "currency": "840",
  "createdAt": "2026-05-12T14:15:30Z",
  
  "security": {
    "merchantPrivateKeyPem": "-----BEGIN PRIVATE KEY-----...",
    "merchantPublicKeyBase64Url": "MIIBIjANBgkq...",
    "cardzonePublicKeyBase64Url": "MIIBIjANBgkq..."
  },
  
  "mkReq": {
    "request": { ... },
    "response": { ... }
  },
  
  "mercReq": {
    "action": "https://3dsecure.bob.bt/3dss/mercReq",
    "requestFields": { ... },
    "signInput": "..."
  },
  
  "callback": {
    "receivedAt": "2026-05-12T14:16:45Z",
    "method": "POST",
    "contentType": "application/x-www-form-urlencoded",
    "fields": { MPI_ERROR_CODE, MPI_APPR_CODE, ... },
    "rawPayload": "..."
  },
  
  "inquiry": {
    "requestedAt": "...",
    "endpoint": "...",
    "requestFields": { ... },
    "responseFields": { ... },
    "macVerification": { ... }
  },
  
  "finalResult": {
    "source": "callback",
    "resolvedAt": "2026-05-12T14:16:45Z",
    "authorizationCode": "AUTH123456",
    "referenceNumber": "991234567890",
    "responseCode": "000",
    "responseReason": "APPROVED"
  },
  
  "status": "SUCCESS",
  "updatedAt": "2026-05-12T14:16:50Z"
}
```

### Payment Link Storage
```
Location: /tmp/cardzone-backend/
File: paylink_{token}.json

{
  "token": "random_token",
  "merchantId": "863990030700270",
  "amount": "299.99",
  "currency": "840",
  "customerName": "John Doe",
  "email": "john@example.com",
  "createdAt": "2026-05-12T14:15:30Z",
  "expiresAt": "2026-05-19T14:15:30Z"
}
```

### Merchant Currency Database
```
Location: /data/merchant-currency.json

{
  "863990030700270": "840",    // MID → Currency Code
  "863990030700271": "356"
}
```

---

## Cryptography & Security

### RSA-2048 Key Pair
- **Purpose**: Sign and verify transaction data integrity
- **Algorithm**: RSA with 2048-bit modulus
- **Format**: 
  - Private key: PKCS#8 PEM format
  - Public key: SPKI format, exported as Base64URL (no padding)

### Signing Process (MAC Generation)
```javascript
function signSha256WithRsaBase64Url(message, privateKeyPem) {
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(message, 'utf8');
  signer.end();
  return base64Url(signer.sign(privateKeyPem));
}
```

### Verification Process
```javascript
function verifySha256WithRsaBase64Url(message, signatureBase64Url, publicKeyPemOrDerBase64Url) {
  // Convert Base64URL signature back to binary
  // Create public key from PEM or Base64URL DER
  // Verify RSA-SHA256 signature
  // Return boolean
}
```

### MAC Field Order
Critical for security - fields must be concatenated in exact order:
1. MPI_TRANS_TYPE
2. MPI_MERC_ID
3. MPI_PAN (card number, if provided)
4. MPI_CARD_HOLDER_NAME
5. ... (30+ more fields)
6. MPI_RESPONSE_TYPE

**Note**: Incorrect field order will cause MAC verification to fail.

---

## Environment Configuration

```bash
# Merchant
MERCHANT_ID=863990030700270

# Cardzone Endpoints
CARDZONE_MKREQ_URL=https://3dsecure.bob.bt/3dss/mkReq
CARDZONE_REDIRECT_URL=https://3dsecure.bob.bt/3dss/mercReq
CARDZONE_INQUIRY_URL=https://3dsecure.bob.bt/3dss/mercReq

# Security
ENABLE_MKREQ_MAC=false              # MAC on mkReq (if Cardzone requires)

# Callback
CALLBACK_BASE_URL=https://merchant.com

# Storage
MERCHANT_CURRENCY_DB_PATH=./data/merchant-currency.json
PAYMENT_LINK_TTL_MS=604800000       # 7 days

# Server
PORT=3000
HOST=0.0.0.0
```

---

## Error Handling

### Validation Errors
- Missing required fields (merchantId, amount)
- Invalid amount format
- Duplicate transaction ID
- Currency not configured

### Network Errors
- mkReq endpoint unreachable
- Inquiry endpoint timeout
- Callback delivery failure

### Security Errors
- MAC verification failed
- Invalid public key format
- Signature generation error

### Response Codes
- "000" → SUCCESS (Approved)
- Non-zero codes → Various failure reasons (insufficient funds, expired card, etc.)

---

## API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/` | Public checkout form |
| POST | `/api/initiate` | Start payment process |
| POST | `/api/callback` | Receive result from Cardzone |
| GET/POST | `/api/return` | Display result page |
| POST | `/api/payment-links` | Create shareable payment link |
| GET | `/pay/{token}` | Payment link landing page |
| GET | `/api/merchant-currency` | Get currency for MID |
| GET | `/api/tx/{txnId}` | Debug transaction state |
| GET | `/health` | Health check |

---

## Summary: Complete Payment Journey

```
CARDHOLDER (Browser)
        ↓
    [1] Fills checkout form on merchant website
        ↓
[2] Browser POST to /api/initiate
        ↓
    BACKEND (Node.js)
        ↓
[3] Generate RSA key pair
[4] Exchange keys with Cardzone (mkReq)
[5] Get Cardzone public key
[6] Build & sign MPI request
[7] Render auto-submit form
        ↓
[8] Browser auto-submits to Cardzone hosted page
        ↓
    CARDHOLDER + CARDZONE
        ↓
[9] Cardholder completes 3DS authentication
[10] Cardzone processes transaction with bank
        ↓
[11] Cardzone POSTs result to /api/callback
        ↓
    BACKEND
        ↓
[12] Receive callback
[13] Verify MAC signature (trust verification)
[14] If verification fails, query via Inquiry
[15] Save final result
        ↓
[16] Browser navigates to /api/return
        ↓
    CARDHOLDER
        ↓
[17] Sees payment result (SUCCESS/FAILED/PENDING)
```

---

## Key Security Principles

1. **Cryptographic Verification**: Every transaction signed with RSA-SHA256
2. **Public Key Infrastructure**: Merchant and Cardzone exchange public keys upfront
3. **HTTPS Only**: All communication encrypted in transit
4. **MAC Validation**: Callback results verified before trusting
5. **Inquiry Fallback**: If callback untrusted, confirm via direct query
6. **Immutable Transaction Log**: Complete transaction history stored
7. **Merchant Isolation**: Each transaction has unique keys and IDs

---

## Notes on MAC Calculation

The MAC (Message Authentication Code) is the **fingerprint** of the transaction:
- If even one field changes, MAC becomes invalid
- Cardzone signs response using Cardzone's private key
- Merchant verifies using Cardzone's public key
- Ensures no tampering of callback data

**Field concatenation is STRICT** - no separators, exact order, empty fields included as empty strings.

