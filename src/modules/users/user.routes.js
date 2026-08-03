import { Router } from "express";
import { 
    loginUser,
    logoutUser, 
    registerUser, 
    refreshAccessToken, 
    updateUserAvatar, 
    updateUserCoverImage, 
    getUserChannelProfile, 
    getWatchHistory, 
    
    verifyIdToken,
    getAllUsers,
    getUsersByInstitute,
    updateUser,
    deleteUser
} from "./user.controller.js";
import {upload} from "../../middlewares/multer.middleware.js"
import { verifyFirebaseToken, verifyJWT } from "../../middlewares/auth.middleware.js";
import { get } from "mongoose";


const router = Router()

//todo ver como funciona esto luego borrar la parte que carga la imagen
router.route("/register2").post(
    upload.fields([
        {
            name: "avatar",
            maxCount: 1
        }, 
        {
            name: "coverImage",
            maxCount: 1
        }
    ]),
    registerUser
    )
router.route("/").post(verifyFirebaseToken, registerUser)

router.route("/login").post(loginUser)
router.route("/verify-token").post(verifyIdToken)

router.route("/institute/:instituteId/all/:page").get(verifyFirebaseToken, getUsersByInstitute)
//secured routes
router.route("/logout").post(verifyFirebaseToken,  logoutUser)
router.route("/refresh-token").post(refreshAccessToken)

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