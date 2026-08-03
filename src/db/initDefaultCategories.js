import { TransactionCategory } from '../modules/transactionCategories/transactionCategory.model.js';

export const initDefaultCategories = async () => {
  try {
    const salesCategory = await TransactionCategory.findOne({ 
      name: 'Ventas', 
      type: 0 
    });

    if (!salesCategory) {
      await TransactionCategory.create({
        name: 'Ventas',
        type: 0,
        description: 'Categoría por defecto para los ingresos generados por ventas del POS'
      });
      console.log('✅ Categoría por defecto "Ventas" creada exitosamente.');
    }
  } catch (error) {
    console.error('❌ Error al inicializar categorías por defecto:', error);
  }
};
