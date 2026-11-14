export const ROLES = {
  // Internal system/support account. Has every admin privilege, but must never
  // be listed or assignable through the public API or the Android app.
  SUPERADMIN: -1,
  ADMIN: 0,
  SUPERVISOR: 1,
  SELLER: 2,
  CLIENT: 3
};

export const STATUS = {
  INACTIVE: 0,
  ACTIVE: 1,
  BANNED: 2
};
