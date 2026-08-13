import { Router } from "express";
import { 
    loginUser,
    logoutUser, 
    registerUser, 
    refreshAccessToken, 
    refreshAccessToken2,
    updateUserAvatar,
    updateUserCoverImage, 
    getUserChannelProfile, 
    getWatchHistory, 
    
    verifyIdToken,
    getAllUsers,
    getUsersByInstitute,
    updateUser,
    deleteUser,
    changePassword
} from "./user.controller.js";
//import {upload} from "../../middlewares/multer.middleware.js"
import { verifyFirebaseToken, verifyJWT } from "../../middlewares/auth.middleware.js";
import { get } from "mongoose";


const router = Router()

router.route("/").post(verifyFirebaseToken, registerUser)

router.route("/login").post(loginUser)
router.route("/verify-token").post(verifyIdToken)
router.route("/change-password").post(verifyFirebaseToken, changePassword)

router.route("/institute/:instituteId/all/:page").get(verifyFirebaseToken, getUsersByInstitute)
//secured routes
router.route("/logout").post(verifyFirebaseToken,  logoutUser)
router.route("/refresh-token").post(refreshAccessToken2)

router.route("/all/:page").get(verifyFirebaseToken, getAllUsers);

router.route("/:userId").patch(verifyFirebaseToken, updateUser)
                        .delete(verifyFirebaseToken, deleteUser);
//institute/{instituteId}/all/{page}
//router.route("/institute/{instituteId}/all/{page}").get(verifyFirebaseToken, getCurrentUser)


//router.route("/avatar").patch(verifyJWT, upload.single("avatar"), updateUserAvatar)
//router.route("/cover-image").patch(verifyJWT, upload.single("coverImage"), updateUserCoverImage)

//router.route("/c/:username").get(verifyJWT, getUserChannelProfile)
//router.route("/history").get(verifyJWT, getWatchHistory)

export default router