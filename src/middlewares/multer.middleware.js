import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// En ESM no existen __dirname ni __filename por defecto, los recreamos:
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. Configuración del almacenamiento
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadPath = path.join(__dirname, '../public/uploads');
        if (!fs.existsSync(uploadPath)) {
            fs.mkdirSync(uploadPath, { recursive: true });
        }
        cb(null, uploadPath);
    },
    filename: function (req, file, cb) {
        // Generamos solo el ID numérico
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        // Obtenemos la extensión original (ej: .md)
        const extension = path.extname(file.originalname);
        
        // El archivo se guardará como: 1776549417838-117041108.md
        cb(null, `${uniqueSuffix}${extension}`);
    }
});

// 2. Filtro de archivos (opcional, para asegurar que solo suban imágenes)
const fileFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    // Permitimos imágenes y archivos Markdown
    if (file.mimetype.startsWith('image/') || ext === '.md') {
        cb(null, true);
    } else {
        cb(new Error('Solo se permiten imágenes o archivos .md'), false);
    }
};

export const upload = multer({ 
    storage: storage,
    fileFilter: fileFilter,
    limits: { fileSize: 10 * 1024 * 1024 } // Aumentamos a 10MB por si el MD es largo
});