# Provisioning a new store

One store is one MongoDB database plus one entry in the central registry. This
runbook takes an empty cluster to a store that can log in and sell.

Every script is idempotent: re-running a step updates what exists instead of
duplicating it. Run any of them with `--dry-run` to see the plan first.

---

## 0. Prerequisites

The `.env` at the repository root must define:

| Variable | Purpose |
| --- | --- |
| `MONGODB_URI` | Atlas connection string, without the database name |
| `DB_NAME` | Central database, `financeDB` |
| `FIREBASE_SERVICE_ACCOUNT_BASE64` | Base64 service account JSON, used to create Firebase users |
| `MAIL_ENCRYPTION_KEY` | Passphrase used to derive the AES-256-GCM key that encrypts each store's SMTP password |

`DB_NAME` is currently hardcoded to `financeDB` in `src/constants.js`; the table
keeps the documented name for compatibility with older runbooks.

The Atlas cluster itself must already exist. MongoDB has no `CREATE DATABASE`:
a database starts existing when it holds a collection.

### Mail notifications

Each store keeps its own SMTP credentials in its `StoreConfig` document. Once
the store is provisioned, an ADMIN saves them with:

```
PUT /api/v1/store-config/mail
{ "smtpUser": "store@gmail.com", "smtpPassword": "gmail-app-password", "adminBccEmail": "owner@gmail.com" }
```

The password is encrypted with `MAIL_ENCRYPTION_KEY` and never returned by any
API. A Gmail account needs an **App Password**, not the regular account
password. Rotating `MAIL_ENCRYPTION_KEY` makes every stored password
undecryptable, so all stores must re-save their credentials afterwards. If a
store has not configured mail, order confirmations and rejections simply skip
the email and log a warning — the order flow is never blocked.

---

## The four steps

| # | Command | Writes | Required |
| --- | --- | --- | --- |
| 0 | `db:create` | Central collections and indexes | Once per cluster |
| 1 | `provision:store` | Store database, `StoreConfig`, first `ADMIN`, `TenantMapping`, `Store` registry | Yes |
| 2 | `create:store-superadmin` | Internal support account in the store database | Recommended |
| 3 | `seed:reference` | Units, transaction categories, product categories | Recommended |

Steps 1–3 only touch the store database and the central registries. They never
copy business data between stores.

---

## Step 0 — initialize the central database

```bash
npm run db:create
npm run db:create -- --dry-run
```

Creates every collection declared by the models and builds its indexes. When
`--db` is not `financeDB` the two central-only collections (`tenantmappings`,
`stores`) are skipped, so the same script can initialize a store database.

| Option | Meaning |
| --- | --- |
| `--uri <s>` | Connection string (default `MONGODB_URI`) |
| `--db <s>` | Database name (default `DB_NAME`, `financeDB`) |
| `--dry-run` | Print the plan without writing |

---

## Step 1 — create the store and its first admin

```bash
npm run provision:store -- \
  --db-name tienda_norte \
  --name "Tienda Norte" \
  --slug tienda-norte \
  --admin-email admin@tiendanorte.com \
  --admin-password "unaClaveSegura123" \
  --admin-name "Ana Perez"
```

In one run this writes:

1. The `StoreConfig` document the app reads from `GET /api/v1/store-config`.
2. The first `ADMIN` user in the store database, linked by `firebaseUid`.
3. The central `TenantMapping` (`email -> dbName`), so every later request from
   that admin is routed to this store.
4. The central `Store` registry (`slug -> dbName`), so public clients can name
   the store with the `X-Store` header.

The admin is created in Firebase Auth. No password is stored in MongoDB.

### Options

| Option | Default | Notes |
| --- | --- | --- |
| `--db-name <s>` | `financeDB` | Store database. Pick a new name; see the guards below |
| `--name <s>` | required | Store display name |
| `--slug <s>` | `slugify(name)` | Public slug: `a-z`, `0-9`, dashes |
| `--admin-email <s>` | required on first run | Becomes the first admin |
| `--admin-password <s>` | required on first run | Firebase password, min 6 chars |
| `--admin-name <s>` | `Administrador` | `fullName` shown in the app |
| `--razon-social`, `--nit`, `--phone`, `--whatsapp`, `--address` | `""` | Ticket and profile data |
| `--currency <s>` | `Bs.` | Currency label |
| `--ticket-footer <s>` | `¡Gracias por su preferencia!` | Printed on tickets |
| `--logo-url <s>` | `""` | Logo URL |
| `--reset-password` | off | Rotate the Firebase password of an existing admin |
| `--force` | off | Promote an existing non-admin user with that email |
| `--dry-run` | off | Print the plan without writing |

Every option also reads an environment variable (`TENANT_DB_NAME`, `STORE_NAME`,
`STORE_SLUG`, `STORE_ADMIN_EMAIL`, `STORE_ADMIN_PASSWORD`, `STORE_ADMIN_NAME`,
`STORE_RAZON_SOCIAL`, `STORE_NIT`, `STORE_PHONE`, `STORE_WHATSAPP`,
`STORE_ADDRESS`, `STORE_CURRENCY`, `STORE_TICKET_FOOTER`, `STORE_LOGO_URL`), so
the whole store can be provisioned from a CI environment.

### Guards

| Situation | Result |
| --- | --- |
| `--db-name` already registered with another slug | Keeps the registered slug, never renames |
| `--slug` already owned by another database | Refused |
| Admin email is the global superadmin | Refused: the global superadmin never enters a store |
| Admin email is an internal `SUPERADMIN` account | Refused: an internal account is never converted |
| Admin email already mapped to another store | Refused: an email is never moved between stores |
| Existing non-admin user with that email | Refused unless `--force` |
| An `ADMIN` already exists in the database | Admin creation is skipped, the rest is updated |

---

## Step 2 — create the store support superadmin (recommended)

```bash
npm run create:store-superadmin -- \
  --store tienda-norte \
  --email soporte@tiendanorte.com \
  --name "Soporte Tienda Norte" \
  --password "otraClaveSegura123"
```

This is the account the operator uses when a user reports a problem. It has
every admin privilege, but it is **invisible**: `visibleUserFilter` excludes it
from user listings and `isAssignableRole` refuses to assign it, so it never
shows up in the Android app.

`--password` creates (or reuses) the Firebase user and binds its `firebaseUid`
to the store account in the same run, so the person can sign in immediately with
email and password. Without `--password` the account is written in Mongo only
and claimed by the first Google login with that email — that flow is for a real
person who owns the mailbox with Google, not for a shared support account.

### Options

| Option | Notes |
| --- | --- |
| `--store <slug>` | Registry slug, e.g. `tienda-norte` (or `STORE_SLUG`) |
| `--db-name <s>` | Alternative to `--store` (or `TENANT_DB_NAME`) |
| `--email <s>` | Required (or `STORE_SUPERADMIN_EMAIL`) |
| `--name <s>` | Required (or `STORE_SUPERADMIN_NAME`) |
| `--password <s>` | Firebase password, min 6 chars (or `STORE_SUPERADMIN_PASSWORD`) |
| `--reset-password` | Rotate the Firebase password of an existing account |
| `--dry-run` | Print the plan without writing |

Exactly one of `--store` / `--db-name` must be given. The store must already be
registered by step 1, otherwise the script tells you to run `provision:store`
first.

### Guards

| Situation | Result |
| --- | --- |
| Store not in the central registry | Refused: run `provision:store` first |
| `--db-name financeDB` | Refused: use `create:superadmin` for the central database |
| Email is the global superadmin | Refused: it is never duplicated inside a store |
| Email mapped to another store | Refused: an email is never moved automatically |
| Account already bound to a different `firebaseUid` | Refused before writing: no account is hijacked |
| Second run | Idempotent: `actualizado` + `sin cambios` |

### The global superadmin is not per store

`npm run create:superadmin` creates the single global `SUPERADMIN` in the
central database. It is a deployment-level account, not a store one, and the
store scripts refuse to duplicate it. A new store needs steps 1–3 only.

---

## Step 3 — seed the reference data (recommended)

A store with no units and no categories cannot sell: `Product.unit` is required
and a sale without a transaction category falls back to `Ventas POS`.

```bash
npm run seed:reference -- --db-name tienda_norte
npm run seed:reference -- --db-name tienda_norte --from financeDB
npm run seed:reference -- --db-name tienda_norte --from-file data/reference-data.json
```

Handles exactly three collections:

| Collection | Typical count |
| --- | --- |
| `Unit` | 15 |
| `TransactionCategory` | 11 |
| `ProductCategory` | 10 |

Documents are matched by `name` and inserted with `$setOnInsert`, so a re-run
only fills the gaps and never overwrites what the store already edited.

| Option | Meaning |
| --- | --- |
| `--db-name <s>` | Target store database (required to import) |
| `--from <s>` | Source database (default `financeDB`) |
| `--from-file <s>` | Import from a JSON pack instead of a database |
| `--export <s>` | Write a portable pack and exit |
| `--dry-run` | Print the plan without writing |

To refresh the portable pack from the current central database:

```bash
npm run reference:export
```

### What this step does NOT copy

Only reference data. **Products, sales, purchases, orders, reservations, combos,
users and settings are business data and are never copied between stores.** A
new store starts with 0 products and an empty catalog on purpose; load its
products through the app or an import of its own.

---

## Step 4 — a first product (optional)

To prove the store can sell before loading the real catalog, create the soda:
one product whose stock is kept in units and whose purchase unit is the box.

```bash
npm run seed:gaseosa -- --store tienda-norte --price 5 --cost-price 36
```

It resolves `Unidad` and `Caja` and the `Bebidas y Gaseosas` category from the
store database, so step 3 must have run first. The product is created with
`unit: Unidad`, `purchaseUnit: Caja` and `conversionFactor: 12`, which is what
makes a purchase of one box add 12 units and a sale of one soda subtract 1.

| Option | Default | Notes |
| --- | --- | --- |
| `--store <slug>` / `--db-name <s>` | `financeDB` | Target store |
| `--name <s>` | `Gaseosa` | Product name |
| `--sku <s>` | `GASEOSA` | Unique per database; this is the upsert key |
| `--units-per-box <n>` | `12` | Must be a positive integer |
| `--price <n>` | `0` | Sale price per unit |
| `--cost-price <n>` | `0` | Cost per box |
| `--opening-stock <n>` | `0` | One-time count on create only, never reset |
| `--category-name <s>` | `Bebidas y Gaseosas` | Must already exist |
| `--dry-run` | off | Print the plan without writing |

The purchase that adds stock carries the box unit and the factor:

```json
{ "product": "<id>", "unit": "<Caja id>", "quantity": 1, "conversionFactor": 12, "unitPrice": 36, "subtotal": 36 }
```

The server fills `conversionFactor` from the product when the item omits it and
the product declares a purchase unit, so an app that only sends `quantity: 1`
still adds 12. An explicit factor always wins, which is how you buy loose units
of the same product.

---

## Full run, copy-paste

```bash
# once per cluster
npm run db:create

# the store, its admin, and the central registry entries
npm run provision:store -- \
  --db-name tienda_norte \
  --name "Tienda Norte" \
  --slug tienda-norte \
  --admin-email admin@tiendanorte.com \
  --admin-password "unaClaveSegura123" \
  --admin-name "Ana Perez"

# the internal support account
npm run create:store-superadmin -- \
  --store tienda-norte \
  --email soporte@tiendanorte.com \
  --name "Soporte Tienda Norte" \
  --password "otraClaveSegura123"

# units and categories
npm run seed:reference -- --db-name tienda_norte
```

Add `--dry-run` to any of them to inspect the plan without writing.

---

## Verify the result

```bash
# the store is registered
npm run create:store-superadmin -- --store tienda-norte \
  --email soporte@tiendanorte.com --name "Soporte Tienda Norte" --dry-run

# the reference data is there
npm run seed:reference -- --db-name tienda_norte --dry-run
```

A dry-run that reports `usuario: actualizado` and `0 a crear` means the store is
fully provisioned.

The public storefront must name its store, or the catalog answers `400`:

```bash
# finance-store/.env (and the deployment environment)
VITE_STORE_SLUG=tienda-norte
```

```bash
curl -H "X-Store: tienda-norte" http://localhost:8000/api/v1/catalog
```

Unknown slug answers `404`, a missing header answers `400`.

---

## Order matters

```
db:create  ->  provision:store  ->  create:store-superadmin
                                 ->  seed:reference
```

`provision:store` must run first: it is what registers the slug that step 2
resolves and what creates the database step 3 fills. Steps 2 and 3 are
independent of each other and can run in either order.
