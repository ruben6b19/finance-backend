# Design: Reservations & Combo Vouchers

Status: **v1 complete** — D1, D1a, D2, D4, D5, D8 resolved; D3, D6 and D7 deferred beyond v1. Section 13 tracks the build order.
Scope: data model plus the modules that implement build-order steps 1–7.

---

## 1. Why these are separate entities

`Sale` means **money and goods already exchanged**. Both reservations and combo
vouchers are **promises about the future**, so neither belongs inside `Sale`.

Reusing `Sale` with an extra status field was evaluated and rejected:

| Blocker | Evidence |
| --- | --- |
| Same-day mutation lock | `updateSale` (sale.controller.js:306-318), `deleteSale` (349-363), `cancelSale` (486-500) reject any sale whose `saleDate` is not the current Bolivia day. A reservation made today for tomorrow cannot be cancelled tomorrow. |
| Stock moves at creation | `createSale` decrements stock immediately (89-98). |
| Income moves at creation | `createSale` creates the `Transaction` immediately (100-110), and `getSaleSummary` (415-444) counts it. |
| No temporal fields | Nothing maps pickup date or expiry. |
| Status collision | `saleStatus: 1` already means `Pending`. |

Reservations and combos share a *shape* (`code`, `status`, `expiresAt`,
`createdBy`) but not a *lifecycle*: a reservation is fulfilled once, a voucher is
consumed in installments. They stay in separate collections.

---

## 2. Entity map

```
                          ┌──────────────┐
                          │   Product    │  stock lives ONLY here
                          │  (existing)  │  productType 0|1|2|3
                          └──────┬───────┘
              ┌──────────────────┼──────────────────┬────────────────────┐
              │                  │                  │                    │
      ┌───────▼──────┐   ┌───────▼───────┐  ┌───────▼───────┐   ┌────────▼────────┐
      │ ComboDefini- │   │  Reservation  │  │     Sale      │   │ StockAdjustment │
      │     tion     │   │   (promise)   │  │ (money+goods) │   │   (audit only)  │
      └───────┬──────┘   └───────┬───────┘  └───────┬───────┘   └─────────────────┘
              │                  │                  │
      ┌───────▼──────┐           │                  │
      │ComboComponent│           │ saleId (on fulfil)│
      └───────┬──────┘           └──────────────────┘
              │
      ┌───────▼───────┐
      │ ComboPurchase │  the voucher (created by a Sale)
      │   (promise)   │
      └───────┬───────┘
              │
      ┌───────▼────────┐
      │ ComboRedemption│  append-only operator marks
      └────────────────┘
```

Money moves **only** through `Transaction`. Goods move **only** through `Sale`
(sales) and `Purchase` (purchases). `Reservation` and `ComboPurchase` never move
stock by themselves; they only instruct what a later `Sale`/redemption must do.

---

## 3. Product (existing — changes)

Implemented in build-order step 3.

| Change | Detail |
| --- | --- |
| `productType` enum | `[0, 1, 2]` → `[0, 1, 2, 3]`. `3 = Combo`. |
| `isSellable` / `isPurchasable` | `createProduct` and `updateProduct` force type 3 → sellable `true`, purchasable `false`. |
| Stock | A combo product holds **no stock of its own**. Its availability is its components'. `applyStockMovement` skips decrement for type 3 unless the item explicitly sets `stockProduct`. |

`0 = input/raw`, `1 = final/menu`, `2 = direct resale`, `3 = combo/bundle`.

---

## 4. Reservation (new)

One document per promise. Written when the operator takes the booking.

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `code` | String | yes | unique, 6-8 chars, operator-facing |
| `customerName` | String | yes | |
| `customerPhone` | String | yes | `Sale` has no phone field; this is the operational key |
| `customerId` | ObjectId → User | no | only if registered |
| `items` | [ReservationItem] | yes | |
| `totalAmount` | Decimal128 | yes | |
| `paidAmount` | Decimal128 | yes | equals `totalAmount`; full prepayment, no partial deposit |
| `paymentMethod` | Number | yes | `0 cash`, `1 transfer`, `2 card`, `3 other` |
| `paymentReference` | String | no | QR/transfer receipt number |
| `pickupAt` | Date | yes | when the customer will collect |
| `expiresAt` | Date | yes | no-show cutoff |
| `status` | Number | yes | `0 active`, `1 fulfilled`, `2 expired`, `3 voided` |
| `saleId` | ObjectId → Sale | yes | set at booking; that sale is paid in full |
| `fulfilledAt` | Date | no | |
| `fulfilledBy` | ObjectId → User | no | |
| `voidedAt` / `voidedBy` / `voidReason` | Date / ObjectId / String | no | operator-error reversal only |
| `notes` | String | no | |
| `createdBy` | ObjectId → User | yes | |

**ReservationItem** (embedded)

| Field | Type | Notes |
| --- | --- | --- |
| `product` | ObjectId → Product | the presentation SKU the customer asked for |
| `quantity` | Number | integer units of the presentation (a "1/4 pollo" line has `quantity: 1`) |
| `unitPrice` | Decimal128 | frozen at booking |
| `subtotal` | Decimal128 | |
| `stockProduct` | ObjectId → Product | accumulator to decrement at booking (`null` = no stock) |
| `conversionFactor` | Number | units consumed per `quantity`, default `1` |

Prices and conversion factors are **frozen at booking**. If the menu changes
before pickup, the customer keeps the agreed price.

A fully prepaid booking **wraps a real `Sale`**: money and stock move at booking,
and the `Reservation` only tracks the outstanding delivery. It is no longer a
"future sale".

### Lifecycle

```
POST   /reservations        status 0   Sale + Transaction (full amount) + conditional
                                      stock decrement, all in one session.
                                      saleId is set immediately.
POST   /reservations/:id/fulfill      status 1, fulfilledAt/By. No money, no stock move.
POST   /reservations/:id/void         operator error only, role-restricted: reverse
                                      stock, cancel the Sale, cancel the Transaction.
                                      status 3. Must bypass the same-day lock.
sweep  expiresAt < now                status 2 (no-show). Money stays.
                                      Stock is NOT restored.
```

---

## 5. ComboDefinition (new)

Rules for a combo. One per combo `Product`.

| Field | Type | Notes |
| --- | --- | --- |
| `product` | ObjectId → Product | **unique**; the sellable combo SKU (`productType: 3`) |
| `referencePrice` | Decimal128 | sum of components at normal price — display only |
| `validityDays` | Number | `0` = never expires |
| `graceDays` | Number | extra days after expiry before auto-close, default `0` |
| `allowSubstitution` | Boolean | default `false` |
| `terms` | String | display text |
| `status` | Number | `0 inactive`, `1 active` |
| `createdBy` | ObjectId → User | |

### ComboComponent (new)

What the combo includes. One row per included product.

| Field | Type | Notes |
| --- | --- | --- |
| `combo` | ObjectId → ComboDefinition | |
| `product` | ObjectId → Product | the component as the customer knows it (`"Pollo entero"`) |
| `quantity` | Number | decimals allowed (`5` chickens, `0.25` for a quarter) |
| `label` | String | display text |
| `stockProduct` | ObjectId → Product | stock accumulator this component draws from |
| `conversionFactor` | Number | stock units consumed per component unit (e.g. `8` presas per chicken) |

Chicken components are **not** stockless. A combo that includes `1 pollo entero`
sets `product: "Pollo entero"` (the presentation the customer sees) with
`stockProduct: "Pollo (presa)"` and `conversionFactor: 8`, so redeeming it draws
8 presas from the accumulator. `stockProduct: null` is reserved for components
that genuinely do not touch inventory.

Constraints enforced by the catalogue:

- `{ combo, product }` is **unique**: a product cannot appear twice in one combo,
  otherwise per-product balances would be ambiguous.
- A component cannot itself have `productType: 3` (no nested combos): recursion
  would make both pricing and stock consumption undefined.
- `referencePrice` is `Σ(quantity × component price)` from the catalogue at write
  time; it is informative only and never charged.

---

## 6. ComboPurchase (new) — the voucher

Implemented in build-order step 4. Created by the sale that paid for it.
Holds the **live balance**.

| Field | Type | Notes |
| --- | --- | --- |
| `code` | String | **unique**, operator-facing |
| `comboProduct` | ObjectId → Product | |
| `comboDefinition` | ObjectId → ComboDefinition | |
| `sale` | ObjectId → Sale | **not unique** — one sale can emit N vouchers |
| `customerName` | String | |
| `customerPhone` | String | |
| `customerId` | ObjectId → User | no |
| `purchasedAt` | Date | |
| `expiresAt` | Date | `null` = never |
| `graceDays` | Number | frozen copy of the definition's grace window |
| `pricePaid` | Decimal128 | frozen |
| `balances` | [ComboBalance] | live, authoritative |
| `totalUnits` | Number | denormalised sum of `includedQty` |
| `usedUnits` | Number | denormalised sum of `usedQty` |
| `status` | Number | `0 active`, `1 exhausted`, `2 expired`, `3 cancelled`, `4 refunded` |
| `closedAt` | Date | set on 1/2/3/4 |
| `createdBy` | ObjectId → User | |

**ComboBalance** (embedded) — one entry per component

| Field | Type | Notes |
| --- | --- | --- |
| `product` | ObjectId → Product | component product |
| `includedQty` | Number | e.g. `5` chickens |
| `usedQty` | Number | e.g. `0.25` after one quarter is taken |
| `stockProduct` | ObjectId → Product | copied from the component at purchase time |
| `conversionFactor` | Number | copied at purchase time |

Copying `stockProduct`/`conversionFactor` **freezes the terms**: editing a combo
later never rewrites an already-sold voucher.

### Issuance rules (implemented)

`createSale` is the only issuance path, and it issues automatically:

- One voucher per sold unit of a `productType 3` item. Selling 2 combos emits 2
  vouchers, each with its own `code`.
- `code` is the last 8 hex characters of the voucher `_id`, uppercased — unique
  by construction, like reservation codes.
- `pricePaid` is the **charged unit price** of the sale item, not
  `referencePrice`. A voucher is never repriced later.
- `purchasedAt` is the sale's effective date; `expiresAt` is
  `purchasedAt + validityDays`, or `null` when `validityDays` is `0`.
- `customerPhone` is required on the sale request whenever it contains a combo
  item: an operator-facing voucher cannot be issued without a contact. All
  vouchers in one sale share the sale's `customerName`, `customerPhone` and
  `customerId`.
- The sale must be fully paid (`paymentStatus 1`); pending payment never emits
  an entitlement. Cancelled sales (`saleStatus 2`) emit nothing.
- The combo definition must exist and be `status 1`. Selling a withdrawn combo
  is rejected rather than issuing vouchers under an offer no longer honoured.
- Combo quantities are integers. Fractional combo units are rejected.
- Any failure aborts the whole transaction: no Sale, no Transaction, no stock
  movement and no voucher survive a rejected issuance.

Cancelling or deleting such a sale sets its vouchers to `status 3` with
`closedAt`. If any voucher already has `usedUnits > 0`, the cancellation is
rejected: the goods already left inventory, so the sale can no longer be
reversed cleanly.

Known v1 limits: vouchers are not reconciled when `updateSale` rewrites items,
and there are no voucher read/redeem endpoints until step 5. One sale is one
customer for voucher purposes; selling combos to several customers requires
separate sales.

### Suggested denomination

The voucher balance uses the **commercial unit the customer bought**, not the
inventory unit:

- `combo de 5 pollos` → `includedQty: 5` (chickens, decimal)
- `1/4 pollo` redemption → `quantity: 0.25`
- stock impact → `0.25 × conversionFactor(8) = 2 presas`

This decouples the customer's contract from batch yield variance.

---

## 7. ComboRedemption (new) — append-only

One row per operator mark. Never updated, never deleted.

| Field | Type | Notes |
| --- | --- | --- |
| `comboPurchase` | ObjectId → ComboPurchase | |
| `items` | [RedemptionItem] | what was actually handed over |
| `operator` | ObjectId → User | **who** marked it |
| `redeemedAt` | Date | |
| `idempotencyKey` | String | **unique together with `comboPurchase`** |
| `voidedAt` / `voidedBy` / `voidReason` | Date / ObjectId / String | reversal, not deletion |
| `notes` | String | |

**RedemptionItem** (embedded)

| Field | Type | Notes |
| --- | --- | --- |
| `product` | ObjectId → Product | must match a `ComboBalance.product` |
| `quantity` | Number | consumed from that balance, in balance units |

The `idempotencyKey` is not optional. Without it a double-tap on the operator's
screen hands out free product with no trace.

### Redemption rules (implemented)

Endpoints live under `/api/v1/combo-purchases`:

- `GET /` (paginated), `GET /:idOrCode`, `GET /:idOrCode/redemptions`
- `POST /:idOrCode/redemptions`
- `POST /:idOrCode/redemptions/:redemptionId/void`

`POST /redemptions` body:
`{ idempotencyKey, items: [{ product, quantity }], notes? }`.

- **Exact components only.** Each item must match a `balances[].product`. No
  substitution (D3 stays "no" for v1).
- **Idempotency is resolved first.** If a redemption with the same
  `{comboPurchase, idempotencyKey}` exists and its items are equivalent, the
  stored row is returned with `200` — even if that redemption exhausted the
  voucher. Different content under the same key is `409`.
- **Stock moves only when `balances[].stockProduct` is set**, by
  `quantity × conversionFactor`, conditional on `stock >= amount`. Components
  with `stockProduct: null` never touch inventory.
- **Expiry** uses the frozen `expiresAt` and `graceDays`: redemption is allowed
  until `expiresAt + graceDays`, then rejected. The sweep in step 7 only closes
  what is already past that window.
- **Balances are authoritative and CAS-guarded.** The update filters on the
  previously read `usedUnits`, so two concurrent redemptions cannot both apply;
  the loser gets `409` and no partial write survives.
- Exhaustion sets `status 1` and `closedAt`; a cancelled (`3`) or expired (`2`)
  voucher cannot be redeemed.
- Redemption rows are append-only: voiding marks `voidedAt`, `voidedBy` and
  `voidReason`, never deletes.
- **Void is admin/supervisor only** (D4). It restores the stock the redemption
  took, returns the balance, and reopens an exhausted voucher to active. It
  keeps `expired`/`cancelled` status untouched and rejects a second void.

---

## 8. Existing collections to extend

### SaleItem

| Field | Type | Notes |
| --- | --- | --- |
| `stockProduct` | ObjectId → Product | `null` → falls back to `product` |
| `conversionFactor` | Number | default `1` |

Used by: normal sales (presentation SKUs consuming from an accumulator),
reservation fulfilment, and the combo sale.

### Transaction

| Field | Type | Notes |
| --- | --- | --- |
| `reservationId` | ObjectId → Reservation | `null` by default; mandatory on booking income so its reversal is traceable |

`comboPurchaseId` is **not** needed: a combo purchase always goes through a
`Sale`, so `saleId` already links it.

### StockAdjustment (new — recommended, can ship later)

Fixes today's unaudited `PUT /products/:id { stock }` overwrite.

| Field | Type | Notes |
| --- | --- | --- |
| `product` | ObjectId → Product | |
| `previousStock` | Number | |
| `newStock` | Number | |
| `delta` | Number | |
| `reason` | Number | `0 opening count`, `1 recount`, `2 waste`, `3 breakage`, `4 other` |
| `note` | String | |
| `operator` | ObjectId → User | |
| `createdAt` | Date | via `timestamps` |

**Rules (implemented)**

- Creation is restricted to admin (`0`) and supervisor (`1`); sellers get `403`.
- The request carries exactly one of `newStock` (absolute) or `delta` (signed);
  the resulting stock may never be negative.
- The update is CAS-guarded on the previously read stock, so concurrent
  adjustments cannot overwrite each other.
- Combo products (`productType 3`) are rejected: they have no stock of their own.
- `PUT|PATCH /products/:id` no longer accepts `stock`; it returns `400` and points
  the caller at a stock adjustment.
- Endpoints: `POST|GET /api/v1/stock-adjustments` and
  `GET /api/v1/combo-purchases/reconciliation` (read-only drift report).

---

## 9. What moves what

| Event | Sale | Transaction | Stock | Voucher / Reservation |
| --- | --- | --- | --- | --- |
| Create reservation | **yes**, full amount at booking | **yes**, full amount | **yes**, blocked at booking | `Reservation` status 0, `saleId` set |
| Fulfil reservation | — | — | **no** | status 1 |
| Void reservation (operator error) | reversal | reversal | reversal | status 3 |
| Expire reservation (no-show) | — | — | **no** — goods already left inventory | status 2 |
| Buy a combo | **yes**, via `createSale` | **yes**, full price | **no** (combo has no stock) | `ComboPurchase` status 0 |
| Redeem a combo | — | — | **only if** component has `stockProduct` | balance +, `ComboRedemption` |
| Void a redemption | — | — | restored | balance −, redemption voided |
| Cancel a combo sale | reversal | reversal | reversal | `ComboPurchase` → 3 |

Cancelling a combo sale is refused when any of its vouchers has already been
redeemed (`usedUnits > 0`). Redemptions move component stock, and silently
reversing a partially consumed voucher would fabricate inventory.

---

## 10. Indexes

```
Product           { sku } unique
                  { productType, status }

Reservation       { code } unique
                  { status, pickupAt }
                  { status, expiresAt }
                  { customerPhone }

ComboDefinition   { product } unique

ComboComponent    { combo, product } unique

ComboPurchase     { code } unique
                  { status, expiresAt }
                  { customerPhone }
                  { sale }
                  { comboProduct, purchasedAt }

ComboRedemption   { comboPurchase, idempotencyKey } unique
                  { comboPurchase, redeemedAt }
                  { operator, redeemedAt }
                  { voidedAt } sparse

StockAdjustment   { product, createdAt }
```

---

## 11. Invariants

1. `Product.stock` is the **only** stock number. Never derive a second one.
2. For every `ComboPurchase`, `usedQty[i] == Σ(non-voided redemptions of balance[i])`.
   A reconciliation check must exist to detect drift.
3. `status 1 (exhausted)` **iff** `usedUnits >= totalUnits`.
4. `usedUnits == Σ balances[].usedQty`; `totalUnits == Σ balances[].includedQty`.
5. A redemption may only target a `ComboPurchase` in status `0`.
6. Money never exists outside `Transaction`.
7. Goods never leave outside `Sale` / `Purchase`.
8. Reservation and combo writes that touch more than one document run in a single
   Mongo session.
9. Nothing is deleted. Reversals set `voided*` / `cancelled*` fields.
10. One `Sale` may produce several `ComboPurchase` documents (one per combo unit sold).
11. Every `Reservation` has a `saleId` from creation, and that `Sale` is paid in full.
12. A no-show expiry never restores stock and never reverses money.
13. A `Reservation` void is the only path that reverses a booking's money and stock.

---

## 12. Decisions

### Resolved

**D1 — No partial deposit. Full prepayment at booking (QR/transfer).**

| Consequence | Detail |
| --- | --- |
| Fields | `depositAmount` replaced by `paidAmount`, `paymentMethod`, `paymentReference` |
| Sale timing | The `Sale` and its `Transaction` are created **at booking**, not at fulfilment |
| `Transaction.reservationId` | Now mandatory for this flow, not optional |
| Phantom income | Gone — the money really was received, so `getSaleSummary` counting it is correct |
| Refunds | Ruled out by policy. A paid booking is non-refundable |

**D1a — Void for operator error (approved).**

"No refunds" is not "no reversal". A mistaken booking must be undoable. The
distinction is explicit: a **void** corrects an administrative error and is
internal; a **refund** returns money to the customer and does not exist.

- `POST /reservations/:id/void`, role-restricted.
- Reverses stock, cancels the `Sale`, cancels the `Transaction`. Sets status 3.
- Bypasses the same-day lock, guarded by: allow reversal when the `Sale` is
  linked to a `Reservation` in status 0, regardless of `saleDate`.

**D2 — A reservation blocks real stock at booking (approved).**

| Consequence | Detail |
| --- | --- |
| Conditional decrement | `stock >= amount` in the sale-item path is now a hard prerequisite |
| No `reservedStock` | `Product.stock` remains the only stock number (invariant 1) |
| Walk-in availability | Drops as soon as a booking is paid — intended |
| No-show | Stock stays decremented: the goods already left inventory |
| Resold or discarded | Corrected with `StockAdjustment` (`recount` or `waste`), never by rewriting stock |

**D8 — "Stock for the day" means the real stock pool (approved).**

No `DailyProduction` table and no planned production quotas. Reservations consume
the existing `Product.stock`. Production planning is out of scope.

**D4 — Who can void a redemption (approved: admin and supervisor only).**

A redemption hands over product; reversing it fabricates inventory. It is an
administrative correction, not an operator action, so it mirrors reservation void:
**admin (`0`) and supervisor (`1`) only**. A seller (`2`) gets `403`. The reason
is mandatory and recorded on the append-only row (`voidedAt`, `voidedBy`,
`voidReason`).

**D5 — Voucher expiry policy (resolved: per-combo fixed days with a grace window).**

Each combo sets its own `validityDays` (`0` = never expires) plus `graceDays`.
The grace window is frozen on the voucher at purchase time, so editing the
definition later never rewrites an already-sold voucher. The step-7 sweep closes
only vouchers strictly past `expiresAt + graceDays`, matching the redemption
window. The fiscal-period-end option is out of scope.

### Deferred beyond v1

These were evaluated and explicitly postponed to keep the v1 MVP small and
stable. Nothing implemented depends on them, and no schema field anticipates
them, so revisiting a decision later does not require a migration.

| # | Decision | Options | Impact if revisited |
| --- | --- | --- | --- |
| D3 | Can a combo item be substituted | no / within same category | `allowSubstitution` becomes real logic; v1 keeps exact component matches |
| D6 | Can a voucher be transferred to another person | no / yes | `customerPhone` becomes mutable and needs a transfer history |
| D7 | No-show courtesy | none / credit toward a future purchase | D1 rules out cash refunds; a credit needs a linked voucher |

---

## 13. Build order

Status: **1–7 implemented and runtime-verified** against a scratch database.

1. ✅ **SaleItem `stockProduct` + `conversionFactor`** and the reversal-filter fix.
   Nothing else works before this, and it is useful on its own.
   - Shared movement helper lives in `src/modules/sales/sale.service.js`.
   - Conditional decrement applies to `productType` `0` and `2`, and to any item
     that points at a `stockProduct`. Type `1` keeps the legacy unguarded path.
2. ✅ **Reservation** (schema + booking that creates the `Sale`) and the shared
   `createSaleRecord` service, so POS sales, bookings and combo sales all go
   through one path. `fulfil` is a status flip; `void` reverses stock, `Sale` and
   `Transaction` without the same-day lock. Endpoints: `POST /reservations`,
   `GET /reservations`, `GET /reservations/:id`, `POST /reservations/:id/fulfill`,
   `POST /reservations/:id/void`.
   - Prices come from `Product.price`, never from the client.
   - `code` is derived from the reservation `_id`, so it is unique without retries.
3. ✅ **ComboDefinition + ComboComponent** (catalogue; nothing to sell yet).
   Endpoints: `POST /combos`, `GET /combos`, `GET /combos/:comboId`,
   `PUT|PATCH /combos/:comboId`.
   - A combo product is `productType: 3` and holds no stock of its own; selling
     one moves no inventory until redemptions exist.
   - Components are validated and their `referencePrice` recomputed on every
     write. Replacing components never rewrites vouchers already sold.
   - One definition per combo product, no nested combos, no duplicate components.
4. ✅ **ComboPurchase creation inside `createSale`**.
   - Issued automatically by `createSale` through
     `issueComboVouchers`, inside the same Mongo session as the Sale and the
     Transaction; the response exposes the vouchers as `data.comboVouchers`.
   - `customerPhone` is required on the request for any sale containing a combo
     item, and the sale must be fully paid.
   - Cancelling or deleting the sale cancels its vouchers, unless one was
     already redeemed.
5. ✅ **ComboRedemption** with idempotency and conditional decrement.
   Endpoints under `/api/v1/combo-purchases`:
   `GET /`, `GET /:idOrCode`, `GET /:idOrCode/redemptions`,
   `POST /:idOrCode/redemptions`, `POST /:idOrCode/redemptions/:redemptionId/void`.
   - Exact components only (no substitution), balances are authoritative and
     CAS-guarded, and `usedUnits` is the optimistic-lock token.
   - An identical replay of the same `idempotencyKey` returns the stored row with
     `200`, even after the voucher was exhausted by that redemption.
   - Stock moves only for balances carrying `stockProduct`; `null` touches nothing.
   - Expiry honours the frozen `expiresAt` and `graceDays`.
   - Void is admin/supervisor only, requires a reason, restores stock and reopens
     an exhausted voucher.
6. ✅ **StockAdjustment** + reconciliation check.
   - `POST /api/v1/stock-adjustments` records an audited manual stock change
     (admin/supervisor only) using `newStock` or `delta`, CAS-guarded on the
     previous stock; combo products are rejected.
   - `GET /api/v1/stock-adjustments` lists adjustments with product and operator
     populated, filtered by product and reason.
   - `PUT|PATCH /api/v1/products/:id` rejects any `stock` field with `400`; stock
     only changes through sales, purchases, redemptions and adjustments.
   - `GET /api/v1/combo-purchases/reconciliation` is a read-only report that
     compares each voucher balance with its non-voided redemptions and checks the
     denormalized totals and the exhausted/active status. It never repairs.
7. ✅ **Expiry sweeps for both reservations and vouchers.**
   - `expireReservations` and `expireComboVouchers` live in
     `src/modules/maintenance/expiry.service.js`; both only move `status 0` → `2`
     and never touch stock, `Transaction` or `Sale`.
   - `POST /api/v1/maintenance/expiry-sweep` is admin/supervisor only (sellers get
     `403`) and accepts `dryRun` to report what would expire without writing.
   - Vouchers expire only strictly past `expiresAt + graceDays`, matching the
     redemption window, and set `closedAt`.
   - Sweeps are idempotent: a second run expires nothing.
   - `scripts/expire-stale.js` (`npm run expire:stale`) exposes the same sweep to
     cron, with `--dry-run`.

---

## 14. Out of scope for v1

Partial refunds and cash refunds (ruled out by D1), voucher transfer,
multi-branch inventory, price-list versions, customer-facing self-service,
notifications/reminders, daily production quotas (ruled out by D8).
