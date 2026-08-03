import { asyncHandler } from "../../utils/asyncHandler.js";
import {ApiError} from "../../utils/ApiError.js"
import { User} from "./user.model.js"
import {uploadOnCloudinary} from "../../utils/cloudinary.js"
import { ApiResponse } from "../../utils/ApiResponse.js";
import jwt from "jsonwebtoken"
import mongoose from "mongoose";
import { ROLES, STATUS } from "../../constants/roles.js";
//import admin from "firebase-admin";
import { getAuth } from "firebase-admin/auth";
//import { Course } from '../courses/course.model.js'; // Ajusta la ruta
//import { Enrollment } from '../enrollments/enrollment.model.js';
import esTranslations from './es.json' with { type: 'json' };
import enTranslations from './en.json' with { type: 'json' };
//import serviceAccount from "../../serviceAccountKey.json" assert { type: "json" };
//const serviceAccount = require("../../serviceAccountKey.json");
import { translateErrorResponse } from "../../utils/i18nErrorResponse.js";
//import { initializeApp, cert } from "firebase-admin/app";
import { initializeApp, getApps, cert } from 'firebase-admin/app';

const translations = {
    es: esTranslations,
    en: enTranslations
};

const rawBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;

if (!rawBase64) {
  throw new Error('Error: La variable FIREBASE_SERVICE_ACCOUNT_BASE64 no está definida en el archivo .env');
}

const serviceAccountBuffer = Buffer.from(rawBase64, 'base64');
const serviceAccount = JSON.parse(serviceAccountBuffer.toString('utf-8'));


// Verificar si ya fue inicializado usando getApps()
if (getApps().length === 0) {
  initializeApp({
    credential: cert(serviceAccount)
  });
}


const generateAccessAndRefereshTokens = async(userId) =>{
    try {
        const user = await User.findById(userId)
        const accessToken = user.generateAccessToken()
        const refreshToken = user.generateRefreshToken()
        
        user.refreshToken = refreshToken
        await user.save({ validateBeforeSave: false })

        return {accessToken, refreshToken}


    } catch (error) {
        throw new ApiError(500, "Something went wrong while generating referesh and access token")
    }
}

//todo borrar esto luego de probar la creación de usuario 
const registerUserFirebase = asyncHandler( async (req, res) => {
    const { fullName, email, password, role, institute } = req.body;
    const lang = req.headers['Accept-Language']?.split(',')[0].substring(0, 2) || 'es';
    const createdBy = req.user?.mongoDbId;
    console.log("sdfdsf", req.body)
    // 3. Validación - campos no vacíos (400)
    if (
        [fullName, email, password, institute, createdBy].some((field) => 
            !field || (typeof field === 'string' && field.trim() === "")
        )
    ) {
        const errorCode = "error_user_required_fields"; 
        return translateErrorResponse(res, lang, errorCode, 400, translations);
    }
    
    // Validación de roles (400)
    if (!role || !Array.isArray(role) || role.length === 0) {
        const errorCode = "error_user_invalid_role";
        return translateErrorResponse(res, lang, errorCode, 400, translations);
    }

    // 2. Validación del usuario creador (401)
    if (!createdBy) {
        const errorCode = "error_user_auth_required"; 
        return translateErrorResponse(res, lang, errorCode, 401, translations);
    }
    
    // 4. Chequear si el usuario ya existe (Pre-check - 409)
    const existedUser = await User.findOne({ email });
    console.log("existedUser", existedUser)
    if (existedUser) {
        const errorCode = "validation_error_unique"; // Reutilizamos el error de unicidad
        return translateErrorResponse(res, lang, errorCode, 409, translations);
    }
    
    let firebaseUser;
    
    // 5. Crear el usuario en Firebase Authentication (Manejo de 400 por Firebase)
    try {
        firebaseUser = await getAuth().createUser({
            email,
            password,
            displayName: fullName,
        });
    } catch (firebaseError) {
        console.error("Firebase Auth Error:", firebaseError.message);
        // Usamos un mensaje de error genérico para Firebase
        throw new ApiError(400, `Firebase Authentication failed: ${firebaseError.message}`);
    }
    console.log("creado", existedUser)
    let createdUser;
    
    // 6 & 7. CREACIÓN Y ROLLBACK DE MONGODB
    try {
        const user = await User.create({
            firebaseUid: firebaseUser.uid,
            fullName, email, role, institute, createdBy,
        });

        createdUser = await User.findById(user._id); 

        if (!createdUser) {
            throw new Error("error_institute_creation_failed_db"); // Reutilizamos el error de fallo de DB
        }

    } catch (mongoError) {
        await getAuth().deleteUser(firebaseUser.uid); 
        
        if (mongoError.code && mongoError.code === 11000) {
            const errorCode = "validation_error_unique";
            return translateErrorResponse(res, lang, errorCode, 409, translations);
        }
         console.log("mongoError", mongoError) 
        const genericErrorCode = "error_internal_server_generic";
        return translateErrorResponse(res, lang, genericErrorCode, 500, translations);
    }
    
    // 8. Devolver respuesta (201)
    return res.status(201).json(
        new ApiResponse(201, createdUser, "success_user_registered")
    );
});

const registerUser = asyncHandler(async (req, res) => {
    const { fullName, email, password, role } = req.body;
    const lang = req.headers['Accept-Language']?.split(',')[0].substring(0, 2) || 'es';
    console.log("registerUser - req.body:", req.body);
    
    // ID del usuario creador desde la sesión (Opcional)
    const createdBy = req.user?.mongoDbId;
    console.log("registerUser - createdBy:", createdBy);
    // 1. Validación de campos requeridos (se remueve createdBy de aquí)
    if (
        [fullName, email, password].some((field) => 
            !field || (typeof field === 'string' && field.trim() === "")
        )
    ) {
        const errorCode = "error_user_required_fields"; 
        return translateErrorResponse(res, lang, errorCode, 400, translations);
    }
    console.log("registerUser - role:", role);
    // 2. Validación de roles
    if (!role || !Array.isArray(role) || role.length === 0) {
        const errorCode = "error_user_invalid_role";
        return translateErrorResponse(res, lang, errorCode, 400, translations);
    }

    // 3. Chequear si el usuario ya existe en MongoDB antes de ir a Firebase
    const existedUser = await User.findOne({ email });
    if (existedUser) {
        const errorCode = "validation_error_unique";
        return translateErrorResponse(res, lang, errorCode, 409, translations);
    }

    let firebaseUser = null;

    try {
        // 4. Crear usuario en Firebase usando getAuth() directamente
        firebaseUser = await getAuth().createUser({
            email,
            password,
            displayName: fullName,
            disabled: false,
        });

        // 5. Guardar en MongoDB incluyendo el firebaseUid recién generado
        const user = await User.create({
            fullName,
            email,
            password, // El pre("save") del Schema se encargará del hash si lo tienes habilitado
            role,
            createdBy: createdBy || null, // Guarda el ID si existe, o null si es registro público
            firebaseUid: firebaseUser.uid
        });

        const createdUser = await User.findById(user._id).select("-password -refreshToken");

        if (!createdUser) {
            throw new Error("error_internal_server_generic");
        }
        console.log("registerUser - createdUser:", createdUser);
        // 6. Respuesta de éxito
        return res.status(201).json(
            new ApiResponse(201, createdUser, "success_user_registered")
        );

    } catch (error) {
        console.error("Error durante el registro:", error);

        // 🔄 ROLLBACK: Si Firebase creó el usuario pero falló Mongo, borramos de Firebase
        if (firebaseUser?.uid) {
            try {
                await getAuth().deleteUser(firebaseUser.uid);
                console.log(`Rollback ejecutado: Usuario ${firebaseUser.uid} eliminado de Firebase.`);
            } catch (cleanupError) {
                console.error("Error al limpiar usuario en Firebase:", cleanupError);
            }
        }

        // Control de duplicados en Firebase o Mongo
        if (error.code === 'auth/email-already-exists' || error.code === 11000) {
            const errorCode = "validation_error_unique";
            return translateErrorResponse(res, lang, errorCode, 409, translations);
        }

        const genericErrorCode = "error_internal_server_generic";
        return translateErrorResponse(res, lang, genericErrorCode, 500, translations);
    }
});

import bcrypt from "bcrypt";

const updateUser = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { fullName, email, password, role, status } = req.body;
    const lang = req.headers['Accept-Language']?.split(',')[0].substring(0, 2) || 'es';
    const updatedBy = req.user?.mongoDbId; // Usamos _id de la sesión actual
    console.log("updateUser - req.body:", req.body)
    console.log("updateUser - req.user:", req.user)
    // 1. Validación de IDs
    if (!userId) {
        const errorCode = "error_user_id_required";
        return translateErrorResponse(res, lang, errorCode, 400, translations);
    }
    if (!updatedBy) {
        const errorCode = "error_user_auth_required";
        return translateErrorResponse(res, lang, errorCode, 401, translations);
    }

    // 2. Verificar que al menos un campo venga para actualizar
    if (!fullName && !email && !role && !status && !password) {
        const errorCode = "error_user_no_fields_update";
        return translateErrorResponse(res, lang, errorCode, 400, translations);
    }

    // 3. Buscar el usuario existente
    const userToUpdate = await User.findById(userId);
    if (!userToUpdate) {
        const errorCode = "error_user_not_found";
        return translateErrorResponse(res, lang, errorCode, 404, translations);
    }

    let mongoUpdateFields = {};

    // --- Full Name ---
    if (fullName !== undefined && fullName.trim() !== "") {
        mongoUpdateFields.fullName = fullName;
    }

    // --- Email (Validar unicidad si cambia) ---
    if (email !== undefined && email.trim() !== "" && email !== userToUpdate.email) {
        const existedUserWithNewEmail = await User.findOne({ email, _id: { $ne: userId } });
        if (existedUserWithNewEmail) {
            const errorCode = "validation_error_unique";
            return translateErrorResponse(res, lang, errorCode, 409, translations);
        }
        mongoUpdateFields.email = email;
    }

    // --- Password (Encriptación manual para Update) ---
    if (password && password.trim() !== "") {
        // Como usamos findByIdAndUpdate, el pre-save no saltará, así que hasheamos aquí
        const salt = await bcrypt.genSalt(10);
        mongoUpdateFields.password = await bcrypt.hash(password, salt);
    }

    // --- Role y Status ---
    if (role !== undefined) {
        if (!Array.isArray(role) || role.length === 0) {
            const errorCode = "error_user_invalid_role";
            return translateErrorResponse(res, lang, errorCode, 400, translations);
        }
        mongoUpdateFields.role = role;
    }
    
    if (status !== undefined) {
        mongoUpdateFields.status = status;
    }

    // Auditoría
    mongoUpdateFields.updatedBy = updatedBy;

    // 4. Realizar la actualización en MongoDB
    const updatedUser = await User.findByIdAndUpdate(
        userId,
        { $set: mongoUpdateFields },
        { 
            new: true, // Devuelve el documento modificado
            runValidators: true, // Asegura que las reglas del Schema se apliquen
            select: "-password -refreshToken" // Protegemos datos sensibles
        }
    );

    if (!updatedUser) {
        const genericErrorCode = "error_internal_server_generic";
        return translateErrorResponse(res, lang, genericErrorCode, 500, translations);
    }

    // 5. Devolver respuesta
    return res.status(200).json(
        new ApiResponse(200, updatedUser, "success_user_updated")
    );
});

//todo este método es solo para pruebas, luego borrar 
const updateUserfirebase = asyncHandler( async (req, res) => {
    const { userId } = req.params; 
    const { fullName, email, password, role, status } = req.body;
    const lang = req.headers['Accept-Language']?.split(',')[0].substring(0, 2) || 'es';
    const updatedBy = req.user?.mongoDbId;
    console.log(req.body)

    // 4. Validación Inicial - Verificar ID del usuario y del actualizador
    if (!userId) {
        const errorCode = "error_user_id_required";
        return translateErrorResponse(res, lang, errorCode, 400, translations);
    }
    if (!updatedBy) {
        const errorCode = "error_user_auth_required";
        return translateErrorResponse(res, lang, errorCode, 401, translations);
    }

    // 5. Validar campos requeridos y tipos
    if (!fullName && !email && !role && !status && !password) {
        const errorCode = "error_user_no_fields_update";
        return translateErrorResponse(res, lang, errorCode, 400, translations);
    }

    // Validación de roles si se proporciona
    if (role !== undefined && (!Array.isArray(role) || role.length === 0)) {
        const errorCode = "error_user_invalid_role";
        return translateErrorResponse(res, lang, errorCode, 400, translations);
    }

    // 6. Buscar el usuario existente en MongoDB (404)
    const userToUpdate = await User.findById(userId);

    if (!userToUpdate) {
        const errorCode = "error_user_not_found";
        return translateErrorResponse(res, lang, errorCode, 404, translations);
    }

    let firebaseUpdateFields = {};
    let mongoUpdateFields = {};

    // 7. Preparar las actualizaciones
    
    if (fullName !== undefined && fullName.trim() !== "" && fullName !== userToUpdate.fullName) {
        mongoUpdateFields.fullName = fullName;
        firebaseUpdateFields.displayName = fullName;
    }

    // --- Email --- (Chequeo de unicidad)
    if (email !== undefined && email.trim() !== "" && email !== userToUpdate.email) {
        const existedUserWithNewEmail = await User.findOne({ email, _id: { $ne: userId } });
        if (existedUserWithNewEmail) {
            const errorCode = "validation_error_unique";
            return translateErrorResponse(res, lang, errorCode, 409, translations);
        }
        mongoUpdateFields.email = email;
        firebaseUpdateFields.email = email;
    }

    // --- Password (Opcional) ---
    if (password) {
        firebaseUpdateFields.password = password;
    }

    // --- Role y Status (Solo MongoDB) ---
    if (role !== undefined) { mongoUpdateFields.role = role; }
    if (status !== undefined) { mongoUpdateFields.status = status; }

    // 8. Actualizar en Firebase (si hay campos para Firebase)
    if (Object.keys(firebaseUpdateFields).length > 0) {
        try {
            await getAuth().updateUser(userToUpdate.firebaseUid, firebaseUpdateFields);
        } catch (firebaseError) {
            console.error("Firebase Auth Error on Update:", firebaseError.message);
            // El error de Firebase se devuelve en el mensaje, manteniendo el 400
            throw new ApiError(400, `Firebase update failed: ${firebaseError.message}`);
        }
    }
    
    // 9. Actualizar en MongoDB (si solo fue password)
    if (Object.keys(mongoUpdateFields).length === 0 && Object.keys(firebaseUpdateFields).length > 0) {
        return res.status(200).json(
            new ApiResponse(200, userToUpdate, "success_user_updated") // Reutilizamos el mensaje de éxito
        );
    }

    // Añadir el campo de registro de la última persona que modificó el usuario
    mongoUpdateFields.updatedBy = updatedBy;
    mongoUpdateFields.updatedAt = new Date(); 

    // 10. Realizar la actualización en MongoDB
    const updatedUser = await User.findByIdAndUpdate(
        userId,
        { $set: mongoUpdateFields },
        { new: true, runValidators: true }
    )
    //.populate([{ path: 'institute', select: 'name' }]); // Populamos el instituto para la respuesta

    if (!updatedUser) {
        const genericErrorCode = "error_internal_server_generic";
        return translateErrorResponse(res, lang, genericErrorCode, 500, translations);
    }

    // 11. Devolver respuesta (200)
    return res.status(200).json(
        new ApiResponse(200, updatedUser, "success_user_updated")
    );
});

const deleteUser = asyncHandler( async (req, res) => {
    const { userId } = req.params; 
    const lang = req.headers['Accept-Language']?.split(',')[0].substring(0, 2) || 'es';
    const deletedBy = req.user?.mongoDbId;

    // 3. Validación Inicial
    if (!userId) {
        const errorCode = "error_user_id_required";
        return translateErrorResponse(res, lang, errorCode, 400, translations);
    }
    if (!deletedBy) {
        const errorCode = "error_user_auth_required";
        return translateErrorResponse(res, lang, errorCode, 401, translations);
    }

    // 4. Buscar el usuario existente en MongoDB (404)
    const userToDelete = await User.findById(userId);

    if (!userToDelete) {
        const errorCode = "error_user_not_found";
        return translateErrorResponse(res, lang, errorCode, 404, translations);
    }

    // =======================================================
    // [NUEVA LÓGICA: VERIFICACIÓN DE INTEGRIDAD]
    // =======================================================

    // A. Verificar si el usuario es maestro en algún curso
    //const isTeaching = await Course.findOne({ teacher: userId, status: STATUS.ACTIVE });
    //if (isTeaching) {
        // Error: No se puede eliminar porque tiene cursos activos asignados
    //    return translateErrorResponse(res, lang, "error_user_cannot_delete_is_teaching", 400, translations);
    //}

    // B. Verificar si el usuario está enrolado en algún curso (como estudiante)
    // const isEnrolled = await Enrollment.findOne({ student: userId, status: STATUS.ACTIVE });
    // if (isEnrolled) {
    //     // Error: No se puede eliminar porque está inscrito en cursos
    //     return translateErrorResponse(res, lang, "error_user_cannot_delete_is_enrolled", 400, translations);
    // }

    // =======================================================
    // [PROCESO DE ELIMINACIÓN]
    // =======================================================
    
    const firebaseUid = userToDelete.firebaseUid;

    // 5. Eliminar el usuario de MongoDB (Fuente de datos principal)
    const deletedMongoUser = await User.findByIdAndDelete(userId);

    if (!deletedMongoUser) {
        const genericErrorCode = "error_internal_server_generic";
        return translateErrorResponse(res, lang, genericErrorCode, 500, translations);
    }

    // 6. Eliminar el usuario de Firebase Authentication (Rollback de la entidad)
    try {
        await getAuth().deleteUser(firebaseUid);
        console.log(`Firebase user ${firebaseUid} deleted successfully.`);
        
        // Respuesta 200
        return res.status(200).json(
            new ApiResponse(200, {}, "success_user_deleted")
        );
    } catch (firebaseError) {
        // En caso de fallo de Firebase, avisamos al cliente de la inconsistencia.
        console.error("Firebase Auth Error on Deletion:", firebaseError.message);
        throw new ApiError(500, `User deleted from MongoDB, but failed to delete from Firebase Auth. Firebase Error: ${firebaseError.message}`);
    }
});

const getUsersByInstitute = asyncHandler(async (req, res) => {
    console.log("getUsersByInstitute - req.params:", req.params);
    const { instituteId, page } = req.params;
    // 1. Extraemos 'search' (que viene del cliente) y 'role'
    const { limit = 50, query, search, role } = req.query; 
    const lang = req.headers['Accept-Language']?.split(',')[0].substring(0, 2) || 'es';

    if (!instituteId) {
        const errorCode = "error_invalid_institute_id";
        return translateErrorResponse(res, lang, errorCode, 400, translations);
    }
    
    const pageNumber = parseInt(page) || 1;
    const limitNumber = parseInt(limit) || 50;

    // 2. Construcción del Filtro Base
    const filter = { institute: instituteId };

    // 3. Filtro de Rol (Soporta el role=0 que envía tu cliente)
    if (role !== undefined && role !== "") {
        filter.role = parseInt(role);
    }

    // 4. Incorporación del Query de Búsqueda
    // Aceptamos tanto 'query' como 'search' para mayor compatibilidad
    const term = search || query; 
    console.log("Término de búsqueda recibido en getUsersByInstitute:", term);
    if (term && term.trim() !== "") {
        const searchRegex = { $regex: term.trim(), $options: 'i' };
        
        filter.$or = [
            { fullName: searchRegex },
            { email: searchRegex }
        ];
    }

    console.log("Filter construido para getUsersByInstitute:", filter);
    const options = {
        page: pageNumber,
        limit: limitNumber,
        sort: { fullName: 1 }, 
    };

    try {
        const results = await User.paginate(filter, options);
    
        return res.status(200).json(
            new ApiResponse(
                200, 
                results, 
                "success_users_fetched"
            )
        );
    } catch (error) {
         const errorCode = "error_internal_server_generic";
         return translateErrorResponse(res, lang, errorCode, 500, translations);
    }
});

const verifyIdToken = asyncHandler(async (req, res) => {
    // 1. Recibimos el idToken Y el refreshToken del frontend
    const { idToken, refreshToken } = req.body; 
    const lang = req.headers['Accept-Language']?.split(',')[0].substring(0, 2) || 'es';

    if (!idToken) {
        throw new ApiError(400, "Token missing");
    }

    try {
        const decodedToken = await getAuth().verifyIdToken(idToken);
        const firebaseUid = decodedToken.uid;
        console.log("decodedToken", decodedToken);

        const user = await User.findOne({ firebaseUid })
            .select('_id role email fullName');

        if (!user) throw new ApiError(404, "User not found");
        console.log("llega");

        const mongoDbId = user._id.toString();

        // 2. Seteamos los Custom Claims limpios
        const customClaims = {
            mongoDbId: mongoDbId,
            role: user.role
        };

        await getAuth().setCustomUserClaims(firebaseUid, customClaims);

        // 🎯 3. EL TRUCO: Refrescamos el token AQUÍ MISMO si nos enviaron el refreshToken
        let finalIdToken = idToken;
        let finalRefreshToken = refreshToken;
        let expiresIn = 3600;

        if (refreshToken) {
            const refreshResponse = await fetch(`https://securetoken.googleapis.com/v1/token?key=${process.env.FIREBASE_API_KEY}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    grant_type: 'refresh_token',
                    refresh_token: refreshToken
                })
            });
            
            const refreshData = await refreshResponse.json();
            console.log("refreshResponse", refreshData);
            if (!refreshData.error) {
                finalIdToken = refreshData.id_token;     // Este ya trae los Custom Claims nuevos
                finalRefreshToken = refreshData.refresh_token;
                expiresIn = parseInt(refreshData.expires_in);
            }
        }

        const expiresAt = Date.now() + (expiresIn * 1000);

        return res.status(200).json(
            new ApiResponse(
                200, 
                { 
                    user: {
                        _id: mongoDbId,
                        email: user.email,
                        fullName: user.fullName,
                        role: user.role
                    },
                    // Devolvemos los tokens actualizados
                    accessToken: finalIdToken,
                    refreshToken: finalRefreshToken,
                    expiresAt: expiresAt,
                    tokenRefreshed: true
                }, 
                "success_user_claims_updated"
            )
        );

    } catch (error) {
        throw new ApiError(401, "Auth failed");
    }
});

const verifyIdToken2 = asyncHandler(async (req, res) => {
    const idToken = req.body.idToken;
    const lang = req.headers['Accept-Language']?.split(',')[0].substring(0, 2) || 'es';

    if (!idToken) {
        const errorCode = "error_user_token_missing";
        return translateErrorResponse(res, lang, errorCode, 400, translations);
    }

    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        const firebaseUid = decodedToken.uid;
        
        // 1. Buscamos al usuario y traemos su instituto
        const user = await User.findOne({ firebaseUid })
            .select('_id role email fullName institute')
            .populate('institute', 'name language'); // Traemos solo lo necesario

        if (!user) {
            const errorCode = "error_user_not_found";
            return translateErrorResponse(res, lang, errorCode, 404, translations);
        }
        
        const mongoDbId = user._id.toString();
        const roles = user.role;
        const isAdmin = roles.includes(ROLES.SELLER);

        // Solo extraemos idioma si NO es admin o si el instituto existe
        // Si es Admin puro, instituteLang será undefined o null
        const instLang = isAdmin ? null : (user.institute?.language || 'es');
        const instId = user.institute?._id.toString() || null;

        // 2. Definir Custom Claims (Contexto Global)
        const customClaims = {
            mongoDbId: mongoDbId,
            role: user.role,
            instituteId: instId,
            instituteLang: instLang
        };

        await admin.auth().setCustomUserClaims(firebaseUid, customClaims);
        
        return res.status(200).json(
            new ApiResponse(
                200, 
                { 
                    user: {
                        _id: mongoDbId,
                        email: user.email,
                        fullName: user.fullName,
                        role: user.role,
                        // 3. Enviamos el objeto completo del instituto solo en la respuesta
                        // para que el frontend lo guarde en su Store (Redux/State)
                        institute: user.institute 
                    },
                    tokenRefreshed: true
                }, 
                "success_user_claims_updated"
            )
        );

    } catch (error) {
        console.error("Authentication Error:", error);
        
        let message = 'Error en la verificación del token de Firebase. Intente de nuevo.';
        
        if (error.code) {
             // Mantenemos el mensaje detallado de Firebase, ya que es información técnica clave
             message = `Firebase Auth Error: ${error.code}. Token inválido o expirado.`;
        } else if (error instanceof ApiError) {
             // Si el error es un ApiError (ej: 404), se lanza.
             throw error;
        }
        
        // Si no es un error conocido de Firebase, lanzamos el error 401
        throw new ApiError(401, message);
    }
});

const getExpiresInMilliseconds = (expiryString) => {
    const unit = expiryString.slice(-1); // s, m, h, d
    const value = parseInt(expiryString.slice(0, -1));
    
    switch (unit) {
        case 's': return value * 1000;
        case 'm': return value * 60 * 1000;
        case 'h': return value * 60 * 60 * 1000;
        case 'd': return value * 24 * 60 * 60 * 1000;
        default: return value; // Si ya es un número en ms
    }
};

const loginUser = asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    console.log("loginUser", req.body)
    // 1. Validación de campos
    if (!email || !password) {
        throw new ApiError(400, "Email and password are required");
    }

    // 2. Buscar al usuario por email
    const user = await User.findOne({ email }).populate('institute', 'name language');

    if (!user) {
        throw new ApiError(404, "User does not exist");
    }

    // 3. Verificar contraseña (usando el método del Schema)
    const isPasswordValid = await user.isPasswordCorrect(password);

    if (!isPasswordValid) {
        throw new ApiError(401, "Invalid user credentials");
    }

    // 4. Generar Tokens
    const accessToken = user.generateAccessToken();
    const refreshToken = user.generateRefreshToken();

    // 5. Guardar Refresh Token en la DB (para validación posterior)
    user.refreshToken = refreshToken;
    await user.save({ validateBeforeSave: false });


    const expiresInMs = getExpiresInMilliseconds(process.env.ACCESS_TOKEN_EXPIRY);
    const expiresAt = Date.now() + expiresInMs;
   
    //const expiresIn = 3600; 
    //const expiresAt = Date.now() + (expiresIn * 1000);

    console.log(Date.now(), "now")
    console.log(expiresAt, "expiresAt")
    // 7. Respuesta limpia (sin cookies)
    return res.status(200).json(
        new ApiResponse(
            200,
            {
                user: {
                    _id: user._id,
                    email: user.email,
                    fullName: user.fullName,
                    role: user.role,
                    institute: user.institute
                },
                accessToken,
                refreshToken,
                expiresAt,
                tokenRefreshed: false
            },
            "User logged In Successfully"
        )
    );
});

//todo fijarse como funciona la cokie despues borrar
const loginUser2 = asyncHandler(async (req, res) =>{
    // req body -> data
    // username or email
    //find the user
    //password check
    //access and referesh token
    //send cookie

    const {email, username, password} = req.body
    console.log(email);

    if (!username && !email) {
        throw new ApiError(400, "username or email is required")
    }
    
    // Here is an alternative of above code based on logic discussed in video:
    // if (!(username || email)) {
    //     throw new ApiError(400, "username or email is required")
        
    // }

    const user = await User.findOne({
        $or: [{username}, {email}]
    })

    if (!user) {
        throw new ApiError(404, "User does not exist")
    }

   const isPasswordValid = await user.isPasswordCorrect(password)

   if (!isPasswordValid) {
    throw new ApiError(401, "Invalid user credentials")
    }

   const {accessToken, refreshToken} = await generateAccessAndRefereshTokens(user._id)

    const loggedInUser = await User.findById(user._id).select("-password -refreshToken")

    const options = {
        httpOnly: true,
        secure: true
    }

    return res
    .status(200)
    .cookie("accessToken", accessToken, options)
    .cookie("refreshToken", refreshToken, options)
    .json(
        new ApiResponse(
            200, 
            {
                user: loggedInUser, accessToken, refreshToken
            },
            "User logged In Successfully"
        )
    )

})

const logoutUser = asyncHandler(async(req, res) => {
    await User.findByIdAndUpdate(
        req.user._id,
        {
            $unset: {
                refreshToken: 1 // this removes the field from document
            }
        },
        {
            new: true
        }
    )

    const options = {
        httpOnly: true,
        secure: true
    }

    return res
    .status(200)
    .clearCookie("accessToken", options)
    .clearCookie("refreshToken", options)
    .json(new ApiResponse(200, {}, "User logged Out"))
})


const refreshAccessToken2 = asyncHandler(async (req, res) => {
    const { refreshToken } = req.body;

    if (!refreshToken) {
        throw new ApiError(400, "Refresh token is required");
    }

    try {
        // Llamada a la API de Google para intercambiar el Refresh Token por un nuevo ID Token
        const response = await fetch(`https://securetoken.googleapis.com/v1/token?key=${process.env.FIREBASE_API_KEY}`, {
            method: 'POST',
            body: JSON.stringify({
                grant_type: 'refresh_token',
                refresh_token: refreshToken
            })
        });

        const data = await response.json();

        if (data.error) {
            throw new ApiError(401, "Invalid refresh token");
        }

        console.log("data refresh Token", data);
        return res.status(200).json(
            new ApiResponse(200, {
                accessToken: data.id_token, // El nuevo token de acceso
                refreshToken: data.refresh_token // Firebase a veces devuelve uno nuevo
            }, "Token refreshed successfully")
        );
    } catch (error) {
        throw new ApiError(401, "Token refresh failed");
    }
});

const refreshAccessToken = asyncHandler(async (req, res) => {
    const incomingRefreshToken = req.cookies.refreshToken || req.body.refreshToken

    console.log("incomingRefreshToken", incomingRefreshToken)
    if (!incomingRefreshToken) {
        throw new ApiError(401, "unauthorized request")
    }

    try {
        const decodedToken = jwt.verify(
            incomingRefreshToken,
            process.env.REFRESH_TOKEN_SECRET
        )
    
        console.log("decodedTokenRefresh:", decodedToken)
        const user = await User.findById(decodedToken?._id)
    
        console.log("userRefresh:", user)
        if (!user) {
            throw new ApiError(401, "Invalid refresh token")
        }
    
        if (incomingRefreshToken !== user?.refreshToken) {
            console.log("incomingRefreshToken Refresh token is expired or used" )
            throw new ApiError(401, "Refresh token is expired or used")
            
        }
    
        const options = {
            httpOnly: true,
            secure: true
        }
    
        const {accessToken, refreshToken} = await generateAccessAndRefereshTokens(user._id)
    
        return res
        .status(200)
        .cookie("accessToken", accessToken, options)
        .cookie("refreshToken", refreshToken, options)
        .json(
            new ApiResponse(
                200, 
                {
                    accessToken: accessToken, 
                    refreshToken: refreshToken},
                "Token refreshed successfully"
            )
        )
    } catch (error) {
        throw new ApiError(401, error?.message || "Invalid refresh token")
    }

})


const updateUserAvatar = asyncHandler(async(req, res) => {
    const avatarLocalPath = req.file?.path

    if (!avatarLocalPath) {
        throw new ApiError(400, "Avatar file is missing")
    }

    //TODO: delete old image - assignment

    const avatar = await uploadOnCloudinary(avatarLocalPath)

    if (!avatar.url) {
        throw new ApiError(400, "Error while uploading on avatar")
        
    }

    const user = await User.findByIdAndUpdate(
        req.user?._id,
        {
            $set:{
                avatar: avatar.url
            }
        },
        {new: true}
    ).select("-password")

    return res
    .status(200)
    .json(
        new ApiResponse(200, user, "Avatar image updated successfully")
    )
})

const updateUserCoverImage = asyncHandler(async(req, res) => {
    const coverImageLocalPath = req.file?.path

    if (!coverImageLocalPath) {
        throw new ApiError(400, "Cover image file is missing")
    }

    //TODO: delete old image - assignment


    const coverImage = await uploadOnCloudinary(coverImageLocalPath)

    if (!coverImage.url) {
        throw new ApiError(400, "Error while uploading on avatar")
        
    }

    const user = await User.findByIdAndUpdate(
        req.user?._id,
        {
            $set:{
                coverImage: coverImage.url
            }
        },
        {new: true}
    ).select("-password")

    return res
    .status(200)
    .json(
        new ApiResponse(200, user, "Cover image updated successfully")
    )
})


const getUserChannelProfile = asyncHandler(async(req, res) => {
    const {username} = req.params

    if (!username?.trim()) {
        throw new ApiError(400, "username is missing")
    }

    const channel = await User.aggregate([
        {
            $match: {
                username: username?.toLowerCase()
            }
        },
        {
            $lookup: {
                from: "subscriptions",
                localField: "_id",
                foreignField: "channel",
                as: "subscribers"
            }
        },
        {
            $lookup: {
                from: "subscriptions",
                localField: "_id",
                foreignField: "subscriber",
                as: "subscribedTo"
            }
        },
        {
            $addFields: {
                subscribersCount: {
                    $size: "$subscribers"
                },
                channelsSubscribedToCount: {
                    $size: "$subscribedTo"
                },
                isSubscribed: {
                    $cond: {
                        if: {$in: [req.user?._id, "$subscribers.subscriber"]},
                        then: true,
                        else: false
                    }
                }
            }
        },
        {
            $project: {
                fullName: 1,
                username: 1,
                subscribersCount: 1,
                channelsSubscribedToCount: 1,
                isSubscribed: 1,
                avatar: 1,
                coverImage: 1,
                email: 1

            }
        }
    ])

    if (!channel?.length) {
        throw new ApiError(404, "channel does not exists")
    }

    return res
    .status(200)
    .json(
        new ApiResponse(200, channel[0], "User channel fetched successfully")
    )
})

const getWatchHistory = asyncHandler(async(req, res) => {
    const user = await User.aggregate([
        {
            $match: {
                _id: new mongoose.Types.ObjectId(req.user._id)
            }
        },
        {
            $lookup: {
                from: "videos",
                localField: "watchHistory",
                foreignField: "_id",
                as: "watchHistory",
                pipeline: [
                    {
                        $lookup: {
                            from: "users",
                            localField: "owner",
                            foreignField: "_id",
                            as: "owner",
                            pipeline: [
                                {
                                    $project: {
                                        fullName: 1,
                                        username: 1,
                                        avatar: 1
                                    }
                                }
                            ]
                        }
                    },
                    {
                        $addFields:{
                            owner:{
                                $first: "$owner"
                            }
                        }
                    }
                ]
            }
        }
    ])

    return res
    .status(200)
    .json(
        new ApiResponse(
            200,
            user[0].watchHistory,
            "Watch history fetched successfully"
        )
    )
})


const getAllUsers = asyncHandler(async (req, res) => {
    // 1. Obtener parámetros de paginación
    const page = parseInt(req.params.page) || 1; 
    const limit = parseInt(req.query.limit) || 10;
    console.log("getAllUsers - page:", page, "limit:", limit);
    // 2. Definir el objeto de consulta (query) y opciones (options)
    const query = {}; 

    const options = {
        page: page,
        limit: limit,
        // Campos a seleccionar o excluir. Usamos '-' para excluir los sensibles.
        //select: '-password -refreshToken -watchHistory', 
        // Opcional: ordenar por fecha de creación (los más nuevos primero)
        sort: { createdAt: -1 },
        // customLabels está omitido, se usarán los valores por defecto: 
        // docs, totalDocs, limit, page, totalPages, hasPrevPage, hasNextPage, etc.
    };

    try {
        const results = await User.paginate(query, options);
        console.log("getAllUsers - results:", results);
        return res.status(200).json(
            new ApiResponse(200, results, "Users fetched successfully")
        );
    } catch (error) {
        console.error("Mongoose Paginate Error:", error);
        throw new ApiError(500, "Error fetching users with pagination");
    }
});

export {
    registerUser,
    updateUser,
    deleteUser,
    loginUser,
    verifyIdToken,
    logoutUser,
    refreshAccessToken,

    updateUserAvatar,
    updateUserCoverImage,
    getUserChannelProfile,
    getWatchHistory,
    getAllUsers,

    getUsersByInstitute
}