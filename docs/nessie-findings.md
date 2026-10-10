# Nessie findings

Probed 2026-10-10T21:07:14.240Z against https://api.nessieisreal.com by `npm run nessie:probe`.
All objects created are fictional (customer "Probe Atlasdemo"). Nessie data is publicly visible, so Atlas never sends real names or phone numbers.

## Results
- ✅ create customer (POST /customers)
- ✅ create Checking account
- ✅ create Savings account
- ✅ create Credit Card account
- ✅ create merchant with category string
- ✅ create deposit 12.34
- ✅ read deposits back
- ✅ create withdrawal
- ✅ create purchase (completed)
- ✅ list purchases
- ✅ create bill (pending, one-off)
- ✅ create bill (recurring)
- ✅ list bills
- ❌ create transfer with medium + payee_id (P2P)
  `400 "2 validation errors for TransferCreate\nmedium\n  extra fields not permitted (type=value_error.extra)\npayee_id\n  extra fields not permitted (type=value_error.extra)"`
- ✅ create transfer without payee (payer side only)
- ✅ list transfers (may 404 when empty)
- ✅ read checking account
- ❌ DELETE /purchases/{id}
  `delete returned non-2xx`

## Capabilities the app uses
```json
{
  "probedAt": "2026-10-10T21:07:14.239Z",
  "transferWithPayee": false,
  "amountsKeepCents": false,
  "purchaseDelete": false,
  "merchantCategory": "string",
  "balanceUpdates": false,
  "notes": [
    "deposit 12.34 read back as 12",
    "checking balance after transactions: 1000 (opened at 1000)"
  ]
}
```

## How Atlas adapts
- Transfers: payer-side transfer plus a matching payee-side deposit, linked by the settlement's idempotency key.
- Amounts: sent as whole dollars; exact cents live in Atlas's ledger and the Nessie description.
- Balances: replayed from transactions (Nessie never updates balance).
- Disputed expenses: a correcting deposit offsets the original purchase.
