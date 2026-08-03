import express from "express"
import cors from "cors"
import cookieParser from "cookie-parser"
import path from "path"
import { fileURLToPath } from 'url';
import fs from 'fs'

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express()

// const isBundled = !import.meta.url.includes('file://');

// const baseDir = isBundled 
//     ? path.dirname(process.execPath) 
//     : process.cwd();

// export const UPLOADS_PATH = path.join(baseDir, 'src', 'public', 'uploads');

// if (!fs.existsSync(UPLOADS_PATH)) {
//     fs.mkdirSync(UPLOADS_PATH, { recursive: true });
// }

// app.use(cors({
//     origin: '*', 
//     methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
//     allowedHeaders: ['Content-Type', 'Authorization', 'No-Auth']
// }))

app.use(cors({
    // Permite cualquier origen dinámicamente, lo cual es compatible con credentials: true
    origin: function (origin, callback) {
        callback(null, true);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    // Se agregan un par de headers extra que Forest Admin a veces solicita en el preflight
    allowedHeaders: ['Content-Type', 'Authorization', 'No-Auth', 
    //    'X-Requested-With', 'forest-context-url', 'stripe-signature'
    ],
    credentials: true
}))

// app.use(express.json({limit: "16kb"}))
// app.use(express.urlencoded({extended: true, limit: "16kb"}))
app.use('/api', express.json({limit: "16kb"}));
app.use('/api', express.urlencoded({extended: true, limit: "16kb"}));

app.use(cookieParser())

//app.use('/uploads', express.static(UPLOADS_PATH));
//app.use(express.static("public"))

// Importación de rutas de la API
import userRouter from './modules/users/user.routes.js'
import transactionRouter from './modules/transactions/transaction.routes.js';
import saleRouter from './modules/sales/sale.routes.js';
import productRouter from './modules/products/product.routes.js';
import productCategoryRouter from './modules/productCategories/productCategory.routes.js';
import transactionCategoryRouter from './modules/transactionCategories/transactionCategory.routes.js';
import purchaseRouter from './modules/purchases/purchase.routes.js';
import unitRouter from './modules/units/unit.routes.js';
//import profileRouter from './modules/profiles/profile.routes.js';
//import accountRouter from './modules/accounts/account.routes.js';
//import netflixRouter from './modules/netflix/netflix.routes.js';


// Declaración de rutas de la API
app.use("/api/v1/users", userRouter)
app.use("/api/v1/transactions", transactionRouter)
app.use("/api/v1/sales", saleRouter)
app.use("/api/v1/products", productRouter)
app.use("/api/v1/product-categories", productCategoryRouter)
app.use("/api/v1/transaction-categories", transactionCategoryRouter)
app.use("/api/v1/purchases", purchaseRouter)
app.use("/api/v1/units", unitRouter)
//app.use("/api/v1/profiles", profileRouter);
//app.use("/api/v1/accounts", accountRouter);
//app.use("/api/v1/netflix", netflixRouter)

export { app }