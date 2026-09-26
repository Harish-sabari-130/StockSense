import { Router, type IRouter } from "express";
import { and, asc, count, desc, eq, ilike, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@workspace/db";
import {
  activityLogs,
  categories,
  ledgerEntries,
  locations,
  operations,
  products,
  stocks,
  users,
  warehouses,
} from "@workspace/db/schema";
import { requireAuth } from "../lib/auth";

const router: IRouter = Router();
router.use(requireAuth);
const number = (value: unknown) => Number(value ?? 0);
const sourceLocations = alias(locations, "dashboard_source_location");

async function activityFeed(limit = 8) {
  const rows = await db
    .select({
      id: activityLogs.id,
      action: activityLogs.action,
      entity: activityLogs.entity,
      reference: activityLogs.reference,
      user: users.name,
      timestamp: activityLogs.timestamp,
    })
    .from(activityLogs)
    .innerJoin(users, eq(activityLogs.userId, users.id))
    .orderBy(desc(activityLogs.timestamp))
    .limit(limit);
  return rows;
}

async function operationSummary(kind: "RECEIPT" | "DELIVERY" | "TRANSFER" | "ADJUSTMENT", limit = 6) {
  const rows = await db
    .select({
      id: operations.id,
      number: operations.number,
      kind: operations.kind,
      status: operations.status,
      partner: operations.partner,
      warehouseId: operations.warehouseId,
      warehouseName: warehouses.name,
      sourceLocationId: operations.sourceLocationId,
      sourceLocationName: sourceLocations.name,
      destinationLocationId: operations.destinationLocationId,
      reason: operations.reason,
      createdAt: operations.createdAt,
      completedAt: operations.completedAt,
      createdBy: users.name,
    })
    .from(operations)
    .innerJoin(users, eq(operations.createdById, users.id))
    .leftJoin(warehouses, eq(operations.warehouseId, warehouses.id))
    .leftJoin(sourceLocations, eq(operations.sourceLocationId, sourceLocations.id))
    .where(and(eq(operations.kind, kind), sql`${operations.status} not in ('DONE', 'CANCELED')`))
    .orderBy(desc(operations.createdAt))
    .limit(limit);
  return rows.map((row) => ({
    ...row,
    destinationWarehouseId: null,
    destinationWarehouseName: null,
    destinationLocationName: null,
    lines: [],
  }));
}

router.get("/dashboard/summary", async (req, res) => {
  const warehouseId = req.query.warehouseId ? Number(req.query.warehouseId) : undefined;
  const categoryId = req.query.categoryId ? Number(req.query.categoryId) : undefined;
  const operationFilters = and(
    warehouseId ? eq(operations.warehouseId, warehouseId) : undefined,
    categoryId ? undefined : undefined,
  );
  const stockWhere = and(
    warehouseId ? eq(warehouses.id, warehouseId) : undefined,
    categoryId ? eq(products.categoryId, categoryId) : undefined,
  );
  const stockRows = await db
    .select({
      productId: products.id,
      name: products.name,
      sku: products.sku,
      categoryId: products.categoryId,
      categoryName: categories.name,
      uom: products.uom,
      reorderLevel: products.reorderLevel,
      active: products.active,
      totalStock: sql<string>`coalesce(sum(${stocks.quantity}), 0)`,
    })
    .from(products)
    .innerJoin(categories, eq(products.categoryId, categories.id))
    .leftJoin(stocks, eq(stocks.productId, products.id))
    .leftJoin(locations, eq(stocks.locationId, locations.id))
    .leftJoin(warehouses, eq(locations.warehouseId, warehouses.id))
    .where(and(stockWhere, eq(products.active, true)))
    .groupBy(products.id, categories.name);
  const productItems = stockRows.map((row) => {
    const totalStock = number(row.totalStock);
    const reorderLevel = number(row.reorderLevel);
    return {
      id: row.productId,
      name: row.name,
      sku: row.sku,
      categoryId: row.categoryId,
      categoryName: row.categoryName,
      uom: row.uom,
      reorderLevel,
      active: row.active,
      totalStock,
      status: totalStock === 0 ? "OUT_OF_STOCK" : totalStock <= reorderLevel ? "LOW_STOCK" : "IN_STOCK",
    };
  });
  const [pendingReceipt] = await db.select({ total: count(operations.id) }).from(operations).where(and(eq(operations.kind, "RECEIPT"), sql`${operations.status} not in ('DONE', 'CANCELED')`, operationFilters));
  const [pendingDelivery] = await db.select({ total: count(operations.id) }).from(operations).where(and(eq(operations.kind, "DELIVERY"), sql`${operations.status} not in ('DONE', 'CANCELED')`, operationFilters));
  const [pendingTransfer] = await db.select({ total: count(operations.id) }).from(operations).where(and(eq(operations.kind, "TRANSFER"), sql`${operations.status} not in ('DONE', 'CANCELED')`, operationFilters));
  const [pendingAdjustment] = await db.select({ total: count(operations.id) }).from(operations).where(and(eq(operations.kind, "ADJUSTMENT"), sql`${operations.status} not in ('DONE', 'CANCELED')`, operationFilters));
  const pendingOperations = [
    ...(await operationSummary("RECEIPT")),
    ...(await operationSummary("DELIVERY")),
    ...(await operationSummary("TRANSFER")),
    ...(await operationSummary("ADJUSTMENT")),
  ].slice(0, 8);
  return res.json({
    totalProducts: productItems.length,
    totalUnits: productItems.reduce((sum, item) => sum + item.totalStock, 0),
    lowStockCount: productItems.filter((item) => item.status === "LOW_STOCK").length,
    outOfStockCount: productItems.filter((item) => item.status === "OUT_OF_STOCK").length,
    pendingReceipts: Number(pendingReceipt?.total ?? 0),
    pendingDeliveries: Number(pendingDelivery?.total ?? 0),
    pendingTransfers: Number(pendingTransfer?.total ?? 0),
    pendingAdjustments: Number(pendingAdjustment?.total ?? 0),
    lowStockProducts: productItems.filter((item) => item.status !== "IN_STOCK").slice(0, 8),
    recentActivity: await activityFeed(),
    pendingOperations,
  });
});

router.get("/ledger", async (req, res) => {
  const page = Math.max(1, Number(req.query.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 20)));
  const search = typeof req.query.search === "string" ? req.query.search : undefined;
  const productId = req.query.productId ? Number(req.query.productId) : undefined;
  const warehouseId = req.query.warehouseId ? Number(req.query.warehouseId) : undefined;
  const movementType = typeof req.query.movementType === "string" ? req.query.movementType : undefined;
  const where = and(
    productId ? eq(ledgerEntries.productId, productId) : undefined,
    warehouseId ? eq(ledgerEntries.warehouseId, warehouseId) : undefined,
    movementType ? eq(ledgerEntries.movementType, movementType as any) : undefined,
    search ? or(ilike(products.name, `%${search}%`), ilike(products.sku, `%${search}%`), ilike(ledgerEntries.reference, `%${search}%`)) : undefined,
  );
  const [totalRow] = await db.select({ total: count(ledgerEntries.id) }).from(ledgerEntries).innerJoin(products, eq(ledgerEntries.productId, products.id)).where(where);
  const rows = await db
    .select({
      id: ledgerEntries.id,
      timestamp: ledgerEntries.timestamp,
      productId: products.id,
      productName: products.name,
      sku: products.sku,
      movementType: ledgerEntries.movementType,
      reference: ledgerEntries.reference,
      warehouseName: warehouses.name,
      quantityChange: ledgerEntries.quantityChange,
      beforeQuantity: ledgerEntries.beforeQuantity,
      afterQuantity: ledgerEntries.afterQuantity,
      user: users.name,
    })
    .from(ledgerEntries)
    .innerJoin(products, eq(ledgerEntries.productId, products.id))
    .leftJoin(warehouses, eq(ledgerEntries.warehouseId, warehouses.id))
    .innerJoin(users, eq(ledgerEntries.userId, users.id))
    .where(where)
    .orderBy(desc(ledgerEntries.timestamp))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return res.json({
    items: rows.map((row) => ({
      ...row,
      quantityChange: number(row.quantityChange),
      beforeQuantity: number(row.beforeQuantity),
      afterQuantity: number(row.afterQuantity),
      sourceLocationName: null,
      destinationLocationName: null,
    })),
    page,
    pageSize,
    total: Number(totalRow?.total ?? 0),
  });
});

router.get("/activity", async (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 20)));
  return res.json(await activityFeed(limit));
});

export default router;