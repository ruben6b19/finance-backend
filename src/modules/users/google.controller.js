import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { resolveFirebaseUser, toPublicUser } from "./user.service.js";

export const registerOrGetGoogleUser = asyncHandler(async (req, res) => {
  const result = await resolveFirebaseUser({
    firebaseUid: req.user?.firebaseUid,
    email: req.user?.email,
    name: req.user?.name,
  });

  if (result.error === "missing_uid") {
    return res.status(401).json(new ApiResponse(401, {}, "error_token_missing_uid"));
  }
  if (result.error === "missing_email") {
    return res.status(400).json(new ApiResponse(400, {}, "error_user_email_required"));
  }
  if (result.error) {
    return res.status(500).json(new ApiResponse(500, {}, "error_internal_server_generic"));
  }

  return res.status(200).json(new ApiResponse(200, toPublicUser(result.user), "success_user_google_session"));
});
