import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import { DB_NAME } from "../../constants.js";
import { getTenantModel, resetTenantConnections } from "../tenants/tenantConnection.js";
import {
    expireComboVouchers,
    expireReservations,
    runExpirySweep
} from "./expiry.service.js";

const TENANT_DB = "tenant_expiry";

let mongoServer;

const oid = () => new mongoose.Types.ObjectId();

const reservation = ({ code, status = 0, expiresAt }) => ({
    code,
    customerName: "Cliente Prueba",
    customerPhone: "70000000",
    items: [
        {
            product: oid(),
            quantity: 1,
            unitPrice: "10.00",
            subtotal: "10.00"
        }
    ],
    totalAmount: "10.00",
    paidAmount: "10.00",
    paymentMethod: 0,
    pickupAt: new Date(expiresAt),
    expiresAt: new Date(expiresAt),
    status,
    saleId: oid()
});

const voucher = ({ code, status = 0, expiresAt, graceDays = 0 }) => ({
    code,
    comboProduct: oid(),
    comboDefinition: oid(),
    sale: oid(),
    customerName: "Cliente Prueba",
    customerPhone: "70000000",
    purchasedAt: new Date("2026-01-01T00:00:00Z"),
    expiresAt: expiresAt === null ? null : new Date(expiresAt),
    graceDays,
    pricePaid: "20.00",
    totalUnits: 1,
    status
});

const getModelFor = (dbName) => (modelName) => getTenantModel(dbName, modelName);

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri(), { dbName: DB_NAME });
    await mongoose.model("Reservation").init();
    await getTenantModel(TENANT_DB, "Reservation").init();
}, 20000);

afterAll(async () => {
    resetTenantConnections();

    const client = mongoose.connection.getClient();
    await mongoose.connection.dropDatabase();
    await client.db(TENANT_DB).dropDatabase();

    await mongoose.connection.close();
    await mongoServer.stop();
}, 120000);

beforeEach(async () => {
    for (const dbName of [DB_NAME, TENANT_DB]) {
        await getTenantModel(dbName, "Reservation").deleteMany({});
        await getTenantModel(dbName, "ComboPurchase").deleteMany({});
    }
});

describe("expiry sweep", () => {
    it("expires only active reservations whose deadline passed", async () => {
        const now = new Date("2026-06-01T12:00:00Z");
        const Reservation = getTenantModel(TENANT_DB, "Reservation");

        await Reservation.create([
            reservation({ code: "R-EXPIRED", expiresAt: new Date("2026-06-01T11:00:00Z") }),
            reservation({ code: "R-FUTURE", expiresAt: new Date("2026-06-01T13:00:00Z") }),
            reservation({ code: "R-FULFILLED", status: 1, expiresAt: new Date("2026-06-01T10:00:00Z") })
        ]);

        const result = await runExpirySweep({ now, getModel: getModelFor(TENANT_DB) });

        expect(result.reservations).toEqual({ matched: 1, modified: 1 });

        const statuses = Object.fromEntries(
            (await Reservation.find().select("code status").lean()).map((doc) => [doc.code, doc.status])
        );
        expect(statuses).toEqual({
            "R-EXPIRED": 2,
            "R-FUTURE": 0,
            "R-FULFILLED": 1
        });
    });

    it("expires vouchers only strictly past expiresAt + graceDays", async () => {
        const now = new Date("2026-06-10T12:00:00Z");
        const ComboPurchase = getTenantModel(TENANT_DB, "ComboPurchase");

        await ComboPurchase.create([
            voucher({ code: "V-PAST", expiresAt: new Date("2026-06-05T11:59:59Z"), graceDays: 5 }),
            voucher({ code: "V-BOUNDARY", expiresAt: new Date("2026-06-05T12:00:00Z"), graceDays: 5 }),
            voucher({ code: "V-NO-EXPIRY", expiresAt: null }),
            voucher({ code: "V-FUTURE", expiresAt: new Date("2026-07-01T00:00:00Z"), graceDays: 0 })
        ]);

        const result = await runExpirySweep({ now, getModel: getModelFor(TENANT_DB) });

        expect(result.vouchers).toEqual({ matched: 1, modified: 1 });

        const byCode = Object.fromEntries(
            (await ComboPurchase.find().select("code status closedAt").lean()).map((doc) => [doc.code, doc])
        );

        expect(byCode["V-PAST"].status).toBe(2);
        expect(byCode["V-PAST"].closedAt).toBeInstanceOf(Date);
        expect(byCode["V-BOUNDARY"].status).toBe(0);
        expect(byCode["V-NO-EXPIRY"].status).toBe(0);
        expect(byCode["V-FUTURE"].status).toBe(0);
    });

    it("only touches the database of the injected resolver", async () => {
        const now = new Date("2026-06-01T12:00:00Z");
        const expired = new Date("2026-06-01T11:00:00Z");

        await mongoose.model("Reservation").create(
            reservation({ code: "R-CENTRAL", expiresAt: expired })
        );
        await getTenantModel(TENANT_DB, "Reservation").create(
            reservation({ code: "R-TENANT", expiresAt: expired })
        );

        const result = await runExpirySweep({ now, getModel: getModelFor(TENANT_DB) });

        expect(result.reservations).toEqual({ matched: 1, modified: 1 });

        const central = await mongoose.model("Reservation").findOne({ code: "R-CENTRAL" }).lean();
        const tenant = await getTenantModel(TENANT_DB, "Reservation")
            .findOne({ code: "R-TENANT" })
            .lean();

        expect(central.status).toBe(0);
        expect(tenant.status).toBe(2);
    });

    it("reports matches without writing on dry-run", async () => {
        const now = new Date("2026-06-01T12:00:00Z");
        const Reservation = getTenantModel(TENANT_DB, "Reservation");

        await Reservation.create(
            reservation({ code: "R-DRY", expiresAt: new Date("2026-06-01T11:00:00Z") })
        );

        const result = await runExpirySweep({
            now,
            dryRun: true,
            getModel: getModelFor(TENANT_DB)
        });

        expect(result.reservations).toEqual({ matched: 1, modified: 0 });
        expect((await Reservation.findOne({ code: "R-DRY" }).lean()).status).toBe(0);
    });

    it("requires a model resolver", async () => {
        await expect(runExpirySweep({ now: new Date() })).rejects.toThrow(/model resolver/);
        await expect(expireReservations({})).rejects.toThrow(/model resolver/);
        await expect(expireComboVouchers({})).rejects.toThrow(/model resolver/);
    });
});
