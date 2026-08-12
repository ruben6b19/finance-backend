import mongoose, {Schema} from "mongoose";
import jwt from "jsonwebtoken"
import bcrypt from "bcrypt"
import { validateEmail, validateName } from '../../utils/regex.js';
import mongoosePaginate from 'mongoose-paginate-v2';
import { ROLES, STATUS } from '../../constants/roles.js';

const userSchema = new Schema(
    {
        email: {
            type: String,
            validate: {
                validator: function(v) {
                return validateEmail.test(v);
                },
                message: props => `${props.value} `
            },
            required: true,
            unique: true,
            lowecase: true,
            trim: true, 
        },
        fullName: {
            type: String,
            validate: {
                validator: function(v) {
                return validateName.test(v);
                },
                message: props => `${props.value} aaa `
            },
            required: true,
            trim: true, 
            index: true
        },
        firebaseUid: {
            type: String, 
            unique: true, 
            sparse: true // Permite valores nulos si no todos los usuarios son de Firebase
        },
        role: {
            type: [Number],
            required: true,
            default: [ROLES.SELLER]
        },
        status: {
            type: Number,
            required: true,
            default: STATUS.ACTIVE
        },
        createdBy: {
            type: Schema.Types.ObjectId,
            ref: 'User', // Asumiendo un modelo 'User' para auditoría
            required: false,
        }
    },
    {
        timestamps: true
    }
)


userSchema.methods.generateAccessToken2 = function(){
    return jwt.sign(
        {
            _id: this._id,
            email: this.email,
            //username: this.username,
            fullName: this.fullName
        },
        process.env.ACCESS_TOKEN_SECRET,
        {
            expiresIn: process.env.ACCESS_TOKEN_EXPIRY
        }
    )
}

userSchema.methods.generateAccessToken = function() {
    // Calculamos el idioma del instituto (como hacías en verifyIdToken)
    const instLang = this.role.includes(ROLES.SELLER) ? null : (this.institute?.language || 'es');
    //console.log("generateAccessToken - user:", this);
    return jwt.sign(
        {
            // Claims básicos
            _id: this._id,
            email: this.email,
            fullName: this.fullName,
            
            // --- ESTRUCTURA COMPATIBLE CON TU APP (Custom Claims) ---
            mongoDbId: this._id.toString(),
            role: this.role,
            instituteId: this.institute?._id ? this.institute._id.toString() : null,
            instituteLang: instLang
        },
        process.env.ACCESS_TOKEN_SECRET,
        {
            expiresIn: process.env.ACCESS_TOKEN_EXPIRY // Asegúrate que sea ej: "1h"
        }
    );
};

// userSchema.pre("save", async function (next) {
//     if(!this.isModified("password")) return next();

//     this.password = await bcrypt.hash(this.password, 10)
//     next()
// })

// userSchema.methods.isPasswordCorrect = async function(password){
//     return await bcrypt.compare(password, this.password)
//     //return true
// }

userSchema.plugin(mongoosePaginate);
export const User = mongoose.model("User", userSchema)