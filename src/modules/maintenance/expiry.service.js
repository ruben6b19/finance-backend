import { Reservation } from "../reservations/reservation.model.js";
import { ComboPurchase } from "../combos/comboPurchase.model.js";

const DAY_MS = 86400000;

const toDate = (value) => (value instanceof Date ? value : new Date(value));

// Vencimiento de reservas: solo las activas (0) pasan a expiradas (2).
// No mueve stock ni dinero: el no-show no revierte nada.
const expireReservations = async ({ now = new Date(), dryRun = false } = {}) => {
    const at = toDate(now);
    const filter = { status: 0, expiresAt: { $lte: at } };

    if (dryRun) {
        const matched = await Reservation.countDocuments(filter);
        return { matched, modified: 0 };
    }

    const result = await Reservation.updateMany(filter, { $set: { status: 2 } });
    return { matched: result.matchedCount, modified: result.modifiedCount };
};

// Vencimiento de vouchers: solo cierra activos (0) cuyo plazo con gracia ya
// pasó por completo. La comparación es estricta: el canje sigue permitido
// mientras now <= expiresAt + graceDays.
const expireComboVouchers = async ({ now = new Date(), dryRun = false } = {}) => {
    const at = toDate(now);
    const candidates = await ComboPurchase.find({
        status: 0,
        expiresAt: { $ne: null, $lte: at }
    }).select("_id expiresAt graceDays").lean();

    const ids = candidates
        .filter((voucher) => {
            const graceDays = Number(voucher.graceDays) || 0;
            const deadline = new Date(voucher.expiresAt).getTime() + graceDays * DAY_MS;
            return at.getTime() > deadline;
        })
        .map((voucher) => voucher._id);

    if (dryRun) {
        return { matched: ids.length, modified: 0 };
    }

    if (ids.length === 0) {
        return { matched: 0, modified: 0 };
    }

    const result = await ComboPurchase.updateMany(
        { _id: { $in: ids }, status: 0 },
        { $set: { status: 2, closedAt: at } }
    );

    return { matched: result.matchedCount, modified: result.modifiedCount };
};

const runExpirySweep = async ({ now = new Date(), dryRun = false } = {}) => {
    const ranAt = toDate(now);
    const reservations = await expireReservations({ now: ranAt, dryRun });
    const vouchers = await expireComboVouchers({ now: ranAt, dryRun });
    return { ranAt, reservations, vouchers };
};

export {
    expireReservations,
    expireComboVouchers,
    runExpirySweep
};
