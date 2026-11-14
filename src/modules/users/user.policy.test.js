import { ROLES } from "../../constants/roles.js";
import {
    isHiddenUser,
    visibleUserFilter,
    isAssignableRole,
    isAssignableRoleList,
    toClientRole,
    toClientRoleList
} from "./user.policy.js";

describe("user visibility policy", () => {
    it("detects internal accounts", () => {
        expect(isHiddenUser({ role: [ROLES.SUPERADMIN] })).toBe(true);
        expect(isHiddenUser({ role: [ROLES.ADMIN, ROLES.SUPERADMIN] })).toBe(true);
        expect(isHiddenUser({ role: [ROLES.ADMIN] })).toBe(false);
        expect(isHiddenUser({})).toBe(false);
    });

    it("builds a filter that excludes internal accounts from listings", () => {
        expect(visibleUserFilter()).toEqual({ role: { $ne: ROLES.SUPERADMIN } });
    });

    it("only allows roles the app can assign", () => {
        expect(isAssignableRole(ROLES.ADMIN)).toBe(true);
        expect(isAssignableRole(String(ROLES.SELLER))).toBe(true);
        expect(isAssignableRole(ROLES.SUPERADMIN)).toBe(false);
        expect(isAssignableRoleList([ROLES.ADMIN, ROLES.SUPERVISOR])).toBe(true);
        expect(isAssignableRoleList([ROLES.SUPERADMIN])).toBe(false);
        expect(isAssignableRoleList([])).toBe(false);
        expect(isAssignableRoleList("0")).toBe(false);
    });

    it("presents the internal role as admin to the client", () => {
        expect(toClientRole(ROLES.SUPERADMIN)).toBe(ROLES.ADMIN);
        expect(toClientRole(ROLES.SELLER)).toBe(ROLES.SELLER);
        expect(toClientRoleList([ROLES.SUPERADMIN])).toEqual([ROLES.ADMIN]);
        expect(toClientRoleList([ROLES.ADMIN, ROLES.SELLER])).toEqual([ROLES.ADMIN, ROLES.SELLER]);
        expect(toClientRoleList(ROLES.SUPERVISOR)).toEqual([ROLES.SUPERVISOR]);
    });
});
