import { ApiError } from "../utils/ApiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import jwt from "jsonwebtoken"
import { User } from "../modules/users/user.model.js";
//import admin from "firebase-admin";
import { getAuth } from "firebase-admin/auth";
import { getTenantDbNameByEmail } from "../modules/tenants/tenantMapping.service.js";
import { getTenantConnection, getTenantModel } from "../modules/tenants/tenantConnection.js";
import { DB_NAME } from "../constants.js";

export const verifyJWT = asyncHandler(async(req, _, next) => {
    try {
        const token = req.cookies?.accessToken || req.header("Authorization")?.replace("Bearer ", "")
        
        console.log("token");
        console.log(token);
        if (!token) {
            throw new ApiError(401, "Unauthorized request")
        }
    
        const decodedToken = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET)
    
        console.log("decodedToken")
        console.log(decodedToken)
        const user = await User.findById(decodedToken?._id).select("-password -refreshToken")
    
        if (!user) {
            
            throw new ApiError(401, "Invalid Access Token")
        }
    
        req.user = user;
        next()
    } catch (error) {
        throw new ApiError(401, error?.message || "Invalid access token")
    }
    
})

export const verifyFirebaseToken2 = asyncHandler(async(req, _, next) => {
    try {
        const token = req.cookies?.accessToken || req.header("Authorization")?.replace("Bearer ", "")
        
        console.log("token");
        console.log(token);
        if (!token) {
            throw new ApiError(401, "Unauthorized request")
        }
    
        const decodedToken = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET)
    
        console.log("decodedToken")
        console.log(decodedToken)
        req.user = {
            firebaseUid: decodedToken.uid,
            mongoDbId: decodedToken.mongoDbId, // Tu _id de Mongoose (si está en claims)
            role: decodedToken.role,           // Tus roles (si están en claims)
            //email: decodedToken.email
            instituteLang: decodedToken.instituteLang
        };
        //const user = await User.findById(decodedToken?._id).select("-password -refreshToken")
    
        //if (!user) {
            
        //    throw new ApiError(401, "Invalid Access Token")
        //}
    
        //req.user = user;
        next()
    } catch (error) {
        throw new ApiError(401, error?.message || "Invalid access token")
    }
    
})

export const verifyFirebaseToken = async (req, res, next) => {
    // 1. Obtener el token del encabezado
    const authHeader = req.headers.authorization;
    //console.log("authHeader:", authHeader);

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        // Usamos ApiError para un manejo consistente
        return next(new ApiError(401, "Acceso denegado. Token no proporcionado o formato incorrecto."));
    }

    const idToken = authHeader.split(' ')[1]; // El token es la segunda parte después de 'Bearer '

    try {
        // 2. Verificar el token usando Firebase Admin SDK
        //console.log("Verifying Firebase Token:", idToken);
        const decodedToken = await getAuth().verifyIdToken(idToken);
        
        //console.log("decodedToken:", decodedToken);
        // El token ya contiene los Custom Claims (mongoDbId y role) si los configuraste.
        // Si no los contiene, el usuario aún no ha pasado por el endpoint de claims,
        // pero la autenticación básica de Firebase es exitosa.

        // 3. Opcional: Adjuntar información del usuario a la solicitud
        // Esto permite que tus controladores accedan a req.user._id y req.user.role
        req.user = {
            firebaseUid: decodedToken.uid,
            mongoDbId: decodedToken.mongoDbId, // Tu _id de Mongoose (si está en claims)
            role: decodedToken.role,           // Tus roles (si están en claims)
            email: decodedToken.email,
            name: decodedToken.name,
            picture: decodedToken.picture,
            instituteLang: decodedToken.instituteLang
        };

        // Resolve which tenant database owns this request. Precedence:
        // - a mapped staff email wins over a conflicting header, so a user can
        //   never be silently routed into another store (403 instead);
        // - an anonymous/customer request is identified by the X-Store header;
        // - no header and no mapping falls back to the central database, so
        //   existing users keep working while stores are provisioned.
        try {
            const headerDbName = req.store?.dbName ?? null;
            const mappedDbName = await getTenantDbNameByEmail(req.user.email);

            if (headerDbName && mappedDbName && headerDbName !== mappedDbName) {
                return next(new ApiError(403, "El usuario pertenece a otra tienda."));
            }

            const dbName = headerDbName || mappedDbName || DB_NAME;
            req.user.dbName = dbName;

            // resolveStore already built a tenant context for this header. Keep
            // it when it points at the same database instead of replacing it.
            if (req.tenant?.dbName === dbName) {
                req.tenant = { ...req.tenant, storeSlug: req.store?.slug ?? null };
            } else {
                req.tenant = {
                    email: req.user.email,
                    dbName,
                    storeSlug: req.store?.slug ?? null,
                    getConnection: () => getTenantConnection(dbName),
                    getModel: (modelName) => getTenantModel(dbName, modelName)
                };
            }
        } catch (error) {
            console.error("Tenant resolution failed:", error);
            return next(new ApiError(503, "No se pudo resolver la tienda del usuario."));
        }

        //console.log("Decoded Firebase Token:", decodedToken);    
        //console.log("authHeader:", req.headers);
        // 4. Continuar con la siguiente función del controlador
        next();
        
    } catch (error) {
        // 5. Manejar errores de verificación (token expirado, inválido, etc.)
        console.error("Firebase Token Verification Failed:", error);

        // Mensaje de error más descriptivo
        let message = "Token de autenticación inválido o expirado.";
        if (error.code === 'auth/id-token-expired') {
            message = "Su sesión ha expirado. Por favor, vuelva a iniciar sesión.";
        }
        
        return next(new ApiError(401, message));
    }
};