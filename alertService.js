const { Op, fn, col, literal } = require('sequelize');
const { Inventory, Product, Warehouse, Supplier, SalesOrderItem, ProductSupplier } = require('../models');
const moment = require('moment');

// Business rule: "recent" means within the last 30 days.
const RECENT_SALES_PERIOD_DAYS = 30;

exports.generateLowStockAlerts = async (companyId) => {
    const recentSalesStartDate = moment().subtract(RECENT_SALES_PERIOD_DAYS, 'days').toDate();

    // --- Main Query: Find Low-Stock Items ---
    // This query is complex, so it's built step-by-step with clear comments.
    const inventoryItems = await Inventory.findAll({
        // Specify which columns to include from the Inventory model.
        attributes: [
            ['quantity', 'current_stock'] // Alias 'quantity' to 'current_stock'
        ],
        // Use `include` to perform JOINs across associated models.
        include: [
            {
                model: Warehouse,
                attributes: ['id', 'name'],
                // Filter to only include warehouses belonging to the specified company.
                where: { companyId: companyId },
                required: true, // Makes this an INNER JOIN
            },
            {
                model: Product,
                attributes: [
                    'id',
                    'name',
                    'sku',
                    ['low_stock_threshold', 'threshold'], // Alias for clarity
                    // --- Subquery: Calculate Recent Sales ---
                    // This literal expression injects a subquery to get the sum of sales
                    // for this product within the recent period. COALESCE handles cases with no sales.
                    [
                        literal(`(
                            SELECT COALESCE(SUM(quantity), 0)
                            FROM "SalesOrderItems"
                            WHERE "SalesOrderItems"."productId" = "Product"."id"
                            AND "SalesOrderItems"."createdAt" >= '${recentSalesStartDate.toISOString()}'
                        )`),
                        'recent_sales_total'
                    ]
                ],
                required: true, // INNER JOIN
                include: [{
                    // Join to find the primary supplier.
                    model: Supplier,
                    attributes: ['id', 'name', 'contact_email'],
                    through: {
                        // Specify the junction table and filter for the primary.
                        model: ProductSupplier,
                        where: { is_primary: true },
                        attributes: [] // Don't include columns from the junction table.
                    },
                    required: false // LEFT JOIN, as a product might not have a primary supplier.
                }]
            }
        ],
        // --- Core Filtering Logic ---
        where: {
            // The main low-stock condition: current stock is below the product's threshold.
            [Op.and]: [
                literal('"Product"."low_stock_threshold" > "Inventory"."quantity"'),
                { quantity: { [Op.gt]: 0 } } // Only alert for items that are still in stock.
            ],
            // Business Rule: Only include products with recent sales activity.
            // This literal subquery ensures that the product exists in a recent sales order.
            [Op.exists]: literal(`
                SELECT 1
                FROM "SalesOrderItems"
                WHERE "SalesOrderItems"."productId" = "Product"."id"
                AND "SalesOrderItems"."createdAt" >= '${recentSalesStartDate.toISOString()}'
            `)
        }
    });

    // --- 4. Format the Response ---
    // Transform the flat data from Sequelize into the nested JSON structure required.
    return inventoryItems.map(item => {
        const recentSales = parseFloat(item.Product.get('recent_sales_total'));
        const avgDailySales = recentSales / RECENT_SALES_PERIOD_DAYS;

        // Edge Case: Calculate days_until_stockout, avoiding division by zero.
        const days_until_stockout = avgDailySales > 0
            ? Math.round(item.get('current_stock') / avgDailySales)
            : null;

        return {
            product_id: item.Product.id,
            product_name: item.Product.name,
            sku: item.Product.sku,
            warehouse_id: item.Warehouse.id,
            warehouse_name: item.Warehouse.name,
            current_stock: item.get('current_stock'),
            threshold: item.Product.get('threshold'),
            days_until_stockout: days_until_stockout,
            // Edge Case: Handle products with no primary supplier.
            supplier: item.Product.Suppliers.length > 0 ? {
                id: item.Product.Suppliers[0].id,
                name: item.Product.Suppliers[0].name,
                contact_email: item.Product.Suppliers[0].contact_email
            } : null
        };
    });
};