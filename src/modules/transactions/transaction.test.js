import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Transaction } from './transaction.model.js';

describe('Transaction Balance Calculation Integration Test', () => {
    let mongoServer;

    beforeAll(async () => {
        mongoServer = await MongoMemoryServer.create();
        const uri = mongoServer.getUri();
        await mongoose.connect(uri);
    });

    afterAll(async () => {
        await mongoose.connection.dropDatabase();
        await mongoose.connection.close();
        await mongoServer.stop();
    });

    beforeEach(async () => {
        await Transaction.deleteMany({});
    });

    it('should correctly sum incomes and expenses to get the balance', async () => {
        // 1. Preparar datos de prueba
        const categoryId = new mongoose.Types.ObjectId();

        await Transaction.create([
            { type: 0, amount: 1000.00, concept: 'Venta POS 1', category: categoryId, status: 1 },
            { type: 0, amount: 500.50, concept: 'Venta POS 2', category: categoryId, status: 1 },
            { type: 1, amount: 200.00, concept: 'Compra Insumos', category: categoryId, status: 1 },
            { type: 1, amount: 50.50, concept: 'Gasto Limpieza', category: categoryId, status: 1 },
            { type: 1, amount: 1000.00, concept: 'Gasto Cancelado', category: categoryId, status: 0 } // No debería sumarse
        ]);

        // 2. Ejecutar la lógica de agregación (idéntica a la del controlador)
        const summaryResult = await Transaction.aggregate([
            { $match: { status: 1 } },
            {
                $group: {
                    _id: "$type",
                    totalAmount: { $sum: { $toDouble: "$amount" } },
                    count: { $sum: 1 }
                }
            }
        ]);

        let totalIncome = 0;
        let totalExpense = 0;

        summaryResult.forEach((item) => {
            if (item._id === 0) {
                totalIncome = item.totalAmount;
            } else if (item._id === 1) {
                totalExpense = item.totalAmount;
            }
        });

        const balance = totalIncome - totalExpense;

        // 3. Verificar resultados
        expect(totalIncome).toBe(1500.50);
        expect(totalExpense).toBe(250.50);
        expect(balance).toBe(1250.00);
    });
});
