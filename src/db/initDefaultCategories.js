import { TransactionCategory } from '../modules/transactionCategories/transactionCategory.model.js';

export const initDefaultCategories = async () => {
  try {
    // 1. Categoría de Ventas (Ingreso)
    const salesCategory = await TransactionCategory.findOne({
      name: 'Ventas POS',
      type: 0 
    });

    if (!salesCategory) {
      await TransactionCategory.create({
        name: 'Ventas POS',
        type: 0,
        isSystem: true,
        description: 'Categoría por defecto para los ingresos generados por ventas del POS'
      });
      console.log('✅ Categoría por defecto "Ventas POS" creada exitosamente.');
    }

    // 2. Categoría de Compras (Gasto)
    const purchasesCategory = await TransactionCategory.findOne({
      name: 'Compra de Insumos',
      type: 1
    });

    if (!purchasesCategory) {
      await TransactionCategory.create({
        name: 'Compra de Insumos',
        type: 1,
        isSystem: true,
        description: 'Categoría por defecto para los gastos generados por compras de insumos'
      });
      console.log('✅ Categoría por defecto "Compra de Insumos" creada exitosamente.');
    }
  } catch (error) {
    console.error('❌ Error al inicializar categorías por defecto:', error);
  }
};
