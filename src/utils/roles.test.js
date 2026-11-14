import { ROLES } from "../constants/roles.js";
import { normalizeRoles, hasRole, roleAtLeast, hasRoleAtLeast } from "./roles.js";

describe("normalizeRoles", () => {
    it("accepts a scalar, an array and numeric strings", () => {
        expect(normalizeRoles(ROLES.ADMIN)).toEqual([ROLES.ADMIN]);
        expect(normalizeRoles([ROLES.ADMIN, "2"])).toEqual([ROLES.ADMIN, ROLES.SELLER]);
    });

    it("drops empty and non-integer values", () => {
        expect(normalizeRoles(undefined)).toEqual([]);
        expect(normalizeRoles(null)).toEqual([]);
        expect(normalizeRoles(["x", 1.5, ROLES.SELLER])).toEqual([ROLES.SELLER]);
    });
});

describe("hasRole", () => {
    it("requires an explicit match", () => {
        expect(hasRole({ user: { role: [ROLES.ADMIN] } }, [ROLES.ADMIN])).toBe(true);
        expect(hasRole({ user: { role: [ROLES.SUPERADMIN] } }, [ROLES.ADMIN])).toBe(false);
        expect(hasRole({ user: {} }, [ROLES.ADMIN])).toBe(false);
    });
});

describe("role hierarchy", () => {
    it("treats lower numbers as more powerful", () => {
        expect(roleAtLeast([ROLES.SUPERADMIN], ROLES.SELLER)).toBe(true);
        expect(roleAtLeast([ROLES.ADMIN], ROLES.SELLER)).toBe(true);
        expect(roleAtLeast([ROLES.SUPERVISOR], ROLES.SELLER)).toBe(true);
        expect(roleAtLeast([ROLES.SELLER], ROLES.SELLER)).toBe(true);
        expect(roleAtLeast([ROLES.CLIENT], ROLES.SELLER)).toBe(false);
    });

    it("gives the superadmin every staff privilege", () => {
        expect(roleAtLeast([ROLES.SUPERADMIN], ROLES.ADMIN)).toBe(true);
        expect(roleAtLeast([ROLES.SUPERADMIN], ROLES.SUPERVISOR)).toBe(true);
        expect(roleAtLeast([ROLES.SUPERADMIN], ROLES.SELLER)).toBe(true);
    });

    it("accepts a scalar role", () => {
        expect(roleAtLeast(ROLES.ADMIN, ROLES.SUPERVISOR)).toBe(true);
        expect(roleAtLeast(ROLES.SELLER, ROLES.SUPERVISOR)).toBe(false);
    });

    it("uses the most powerful role of the list", () => {
        expect(roleAtLeast([ROLES.SELLER, ROLES.SUPERADMIN], ROLES.SUPERVISOR)).toBe(true);
    });

    it("rejects empty and invalid input", () => {
        expect(roleAtLeast([], ROLES.SELLER)).toBe(false);
        expect(roleAtLeast(null, ROLES.SELLER)).toBe(false);
        expect(roleAtLeast(ROLES.ADMIN, "x")).toBe(false);
    });

    it("reads the roles from the request", () => {
        expect(hasRoleAtLeast({ user: { role: [ROLES.SUPERADMIN] } }, ROLES.SUPERVISOR)).toBe(true);
        expect(hasRoleAtLeast({ user: { role: [ROLES.CLIENT] } }, ROLES.SUPERVISOR)).toBe(false);
        expect(hasRoleAtLeast({ user: {} }, ROLES.SUPERVISOR)).toBe(false);
    });
});
