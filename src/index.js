// src/index.js
import dotenv from "dotenv";
import connectDB from "./db/index.js";
import { app } from './app.js';

dotenv.config({ path: './.env' });


const PORT = process.env.PORT || 8000;

// Conectar a la base de datos y levantar el servidor
connectDB()
    .then(async() => {

        //await initializeForestAdmin(app);

        app.listen(PORT, () => {
            console.log(`⚙️ Server is running at port : ${PORT}`);
        });
        
    })
    .catch((err) => {
        console.log("❌ MONGO db connection failed !!! ", err);
    });

// Exportación requerida para el entorno Serverless de Vercel
export default app;