import { Router, type IRouter } from "express";
import { and, asc, count, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  CreateCategoryBody,
  CreateLocationBody,
  CreateProductBody,
  CreateReorderRuleBody,
  CreateWarehouseBody,
  ListCategoriesQueryParams,
  ListLocationsQueryParams,
  ListProductsQueryParams,
  UpdateCategoryBody,
  UpdateCategoryParams,
  UpdateLocationBody,
  UpdateLocationParams,
  UpdateProductBody,
  UpdateProductParams,
  UpdateWarehouseBody,
  UpdateWarehouseParams,
  DeleteCategoryParams,
  DeleteReorderRuleParams,
  DeactivateProductParams,
} from "@workspace/api-zod";
import { db } from "@workspace/db";
import {
  activityLogs,
  categories,
  ledgerEntries,
  locations,
  products,
  reorderRules,
  stocks,
  warehouses,
  users,
} from "@workspace/db/schema";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth";

const router: IRouter = Router();
router.use(requireAuth);

const number = (value: unknown) => Number(value ?? 0);
const sourceLocations = alias(locations, "ledger_source_location");
const destinationLocations = alias(locations, "ledger_destination_location");
const ledgerUsers = alias(users, "ledger_user");
const parsePage = (value: unknown) => Math.max(1, Number(value ?? 1));
const parsePageSize = (value: unknown) => Math.min(100, Math.max(1, Number(value ?? 20)));

async function logActivity(userId: number, action: string, entity: string, reference: string) {
  await db.insert(activityLogs).values({ action, entity, reference, userId });
}

async function categoryView(id: number) {
  const [row] = await db
    .select({ id: categories.id, name: categories.name, productCount: count(products.id) })
    .from(categories)
    .leftJoin(products, eq(products.categoryId, categories.id))
    .where(eq(categories.id, id))
    .groupBy(categories.id);
  return row ? { ...row, productCount: Number(row.productCount) } : null;
}

async function productView(id: number) {
  const [row] = await db
    .select({
      id: products.id,
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
    .where(eq(products.id, id))
    .groupBy(products.id, categories.name);
  if (!row) return null;
  const totalStock = number(row.totalStock);
  return {
    ...row,
    reorderLevel: number(row.reorderLevel),
    totalStock,
    status: totalStock === 0 ? "OUT_OF_STOCK" : totalStock <= number(row.reorderLevel) ? "LOW_STOCK" : "IN_STOCK",
  };
}

router.get("/categories", async (req, res) => {
  const query = ListCategoriesQueryParams.parse(req.query);
  const rows = await db
    .select({ id: categories.id, name: categories.name, productCount: count(products.id) })
    .from(categories)
    .leftJoin(products, eq(products.categoryId, categories.id))
    .where(query.search ? ilike(categories.name, `%${query.search}%`) : undefined)
    .groupBy(categories.id)
    .orderBy(asc(categories.name));
  return res.json(rows.map((row) => ({ ...row, productCount: Number(row.productCount) })));
});

router.post("/categories", async (req: AuthenticatedRequest, res) => {
  try {
    const input = CreateCategoryBody.parse(req.body);
    const [category] = await db.insert(categories).values({ name: input.name.trim() }).returning();
    if (!category) return res.status(400).json({ error: "Unable to create category" });
    await logActivity(req.user!.id, "Created category", "Category", category.name);
    return res.status(201).json(await categoryView(category.id));
  } catch {
    return res.status(400).json({ error: "Category name must be unique" });
  }
});

router.patch("/categories/:id", async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = UpdateCategoryParams.parse(req.params);
    const input = UpdateCategoryBody.parse(req.body);
    const [category] = await db.update(categories).set({ name: input.name.trim() }).where(eq(categories.id, id)).returning();
    if (!category) return res.status(404).json({ error: "Category not found" });
    await logActivity(req.user!.id, "Updated category", "Category", category.name);
    return res.json(await categoryView(category.id));
  } catch {
    return res.status(400).json({ error: "Unable to update category" });
  }
});

router.delete("/categories/:id", async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = DeleteCategoryParams.parse(req.params);
    const [used] = await db.select({ id: products.id }).from(products).where(eq(products.categoryId, id)).limit(1);
    if (used) return res.status(400).json({ error: "This category is in use by products" });
    await db.delete(categories).where(eq(categories.id, id));
    await logActivity(req.user!.id, "Deleted category", "Category", String(id));
    return res.status(204).send();
  } catch {
    return res.status(400).json({ error: "Unable to delete category" });
  }
});

router.get("/warehouses", async (_req, res) => {
  const rows = await db
    .select({ id: warehouses.id, name: warehouses.name, code: warehouses.code, address: warehouses.address, active: warehouses.active, locationCount: count(locations.id) })
    .from(warehouses)
    .leftJoin(locations, eq(locations.warehouseId, warehouses.id))
    .groupBy(warehouses.id)
    .orderBy(asc(warehouses.name));
  return res.json(rows.map((row) => ({ ...row, locationCount: Number(row.locationCount) })));
});

router.post("/warehouses", async (req: AuthenticatedRequest, res) => {
  try {
    const input = CreateWarehouseBody.parse(req.body);
    const [warehouse] = await db.insert(warehouses).values({
      name: input.name.trim(),
      code: input.code.trim().toUpperCase(),
      address: input.address ?? "",
      active: input.active ?? true,
    }).returning();
    if (!warehouse) return res.status(400).json({ error: "Unable to create warehouse" });
    await logActivity(req.user!.id, "Created warehouse", "Warehouse", warehouse.code);
    return res.status(201).json({ ...warehouse, locationCount: 0 });
  } catch {
    return res.status(400).json({ error: "Warehouse code must be unique" });
  }
});

router.patch("/warehouses/:id", async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = UpdateWarehouseParams.parse(req.params);
    const input = UpdateWarehouseBody.parse(req.body);
    const [warehouse] = await db.update(warehouses).set({
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
      ...(input.code === undefined ? {} : { code: input.code.trim().toUpperCase() }),
      ...(input.address === undefined ? {} : { address: input.address }),
      ...(input.active === undefined ? {} : { active: input.active }),
    }).where(eq(warehouses.id, id)).returning();
    if (!warehouse) return res.status(404).json({ error: "Warehouse not found" });
    await logActivity(req.user!.id, "Updated warehouse", "Warehouse", warehouse.code);
    return res.json({ ...warehouse, locationCount: 0 });
  } catch {
    return res.status(400).json({ error: "Unable to update warehouse" });
  }
});

router.get("/locations", async (req, res) => {
  const query = ListLocationsQueryParams.parse(req.query);
  const rows = await db
    .select({
      id: locations.id,
      name: locations.name,
      warehouseId: locations.warehouseId,
      warehouseName: warehouses.name,
      active: locations.active,
      currentStock: sql<string>`coalesce(sum(${stocks.quantity}), 0)`,
    })
    .from(locations)
    .innerJoin(warehouses, eq(locations.warehouseId, warehouses.id))
    .leftJoin(stocks, eq(stocks.locationId, locations.id))
    .where(query.warehouseId ? eq(locations.warehouseId, query.warehouseId) : undefined)
    .groupBy(locations.id, warehouses.name)
    .orderBy(asc(warehouses.name), asc(locations.name));
  return res.json(rows.map((row) => ({ ...row, currentStock: number(row.currentStock) })));
});

router.post("/locations", async (req: AuthenticatedRequest, res) => {
  try {
    const input = CreateLocationBody.parse(req.body);
    const [location] = await db.insert(locations).values({
      name: input.name.trim(),
      warehouseId: input.warehouseId,
      active: input.active ?? true,
    }).returning();
    if (!location) return res.status(400).json({ error: "Unable to create location" });
    const [warehouse] = await db.select().from(warehouses).where(eq(warehouses.id, location.warehouseId)).limit(1);
    await logActivity(req.user!.id, "Created location", "Location", location.name);
    return res.status(201).json({ ...location, warehouseName: warehouse?.name ?? "", currentStock: 0 });
  } catch {
    return res.status(400).json({ error: "Location must belong to a valid warehouse" });
  }
});

router.patch("/locations/:id", async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = UpdateLocationParams.parse(req.params);
    const input = UpdateLocationBody.parse(req.body);
    const [location] = await db.update(locations).set({
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
      ...(input.warehouseId === undefined ? {} : { warehouseId: input.warehouseId }),
      ...(input.active === undefined ? {} : { active: input.active }),
    }).where(eq(locations.id, id)).returning();
    if (!location) return res.status(404).json({ error: "Location not found" });
    const [warehouse] = await db.select().from(warehouses).where(eq(warehouses.id, location.warehouseId)).limit(1);
    await logActivity(req.user!.id, "Updated location", "Location", location.name);
    return res.json({ ...location, warehouseName: warehouse?.name ?? "", currentStock: 0 });
  } catch {
    return res.status(400).json({ error: "Unable to update location" });
  }
});

router.get("/products", async (req, res) => {
  const query = ListProductsQueryParams.parse(req.query);
  const page = parsePage(query.page);
  const pageSize = parsePageSize(query.pageSize);
  const where = and(
    query.search ? or(ilike(products.name, `%${query.search}%`), ilike(products.sku, `%${query.search}%`)) : undefined,
    query.categoryId ? eq(products.categoryId, query.categoryId) : undefined,
    query.active === undefined ? undefined : eq(products.active, query.active),
  );
  const [totalRow] = await db.select({ total: count(products.id) }).from(products).where(where);
  const rows = await db
    .select({
      id: products.id,
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
    .where(where)
    .groupBy(products.id, categories.name)
    .orderBy(query.sort === "stock" ? desc(sql`sum(${stocks.quantity})`) : asc(products.name))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const items = rows.map((row) => {
    const totalStock = number(row.totalStock);
    return {
      ...row,
      reorderLevel: number(row.reorderLevel),
      totalStock,
      status: totalStock === 0 ? "OUT_OF_STOCK" : totalStock <= number(row.reorderLevel) ? "LOW_STOCK" : "IN_STOCK",
    };
  });
  return res.json({ items, page, pageSize, total: Number(totalRow?.total ?? 0) });
});

router.post("/products", async (req: AuthenticatedRequest, res) => {
  try {
    const input = CreateProductBody.parse(req.body);
    const result = await db.transaction(async (tx) => {
      const [product] = await tx.insert(products).values({
        name: input.name.trim(),
        sku: input.sku.trim().toUpperCase(),
        categoryId: input.categoryId,
        uom: input.uom.trim(),
        reorderLevel: String(input.reorderLevel),
        active: input.active ?? true,
      }).returning();
      if (!product) throw new Error("product");
      if (input.initialStock && input.initialStock > 0 && input.initialLocationId) {
        await tx.insert(stocks).values({ productId: product.id, locationId: input.initialLocationId, quantity: String(input.initialStock) });
      }
      return product;
    });
    await logActivity(req.user!.id, "Created product", "Product", result.sku);
    return res.status(201).json(await productView(result.id));
  } catch {
    return res.status(400).json({ error: "SKU must be unique and the category/location must be valid" });
  }
});

router.get("/products/:id", async (req, res) => {
  const id = Number(req.params.id);
  const product = await productView(id);
  if (!product) return res.status(404).json({ error: "Product not found" });
  const stockByLocation = await db
    .select({
      productId: products.id,
      productName: products.name,
      sku: products.sku,
      categoryName: categories.name,
      warehouseId: warehouses.id,
      warehouseName: warehouses.name,
      locationId: locations.id,
      locationName: locations.name,
      quantity: stocks.quantity,
      uom: products.uom,
    })
    .from(stocks)
    .innerJoin(products, eq(stocks.productId, products.id))
    .innerJoin(categories, eq(products.categoryId, categories.id))
    .innerJoin(locations, eq(stocks.locationId, locations.id))
    .innerJoin(warehouses, eq(locations.warehouseId, warehouses.id))
    .where(eq(stocks.productId, id))
    .orderBy(desc(stocks.quantity));
  const movements = await db
    .select({
      id: ledgerEntries.id,
      timestamp: ledgerEntries.timestamp,
      productId: products.id,
      productName: products.name,
      sku: products.sku,
      movementType: ledgerEntries.movementType,
      reference: ledgerEntries.reference,
      warehouseName: warehouses.name,
      sourceLocationName: sourceLocations.name,
      destinationLocationName: destinationLocations.name,
      quantityChange: ledgerEntries.quantityChange,
      beforeQuantity: ledgerEntries.beforeQuantity,
      afterQuantity: ledgerEntries.afterQuantity,
      user: sql<string>`ledger_user.name`,
    })
    .from(ledgerEntries)
    .innerJoin(products, eq(ledgerEntries.productId, products.id))
    .leftJoin(warehouses, eq(ledgerEntries.warehouseId, warehouses.id))
    .leftJoin(sourceLocations, eq(ledgerEntries.sourceLocationId, sourceLocations.id))
    .leftJoin(destinationLocations, eq(ledgerEntries.destinationLocationId, destinationLocations.id))
    .innerJoin(ledgerUsers, eq(ledgerEntries.userId, ledgerUsers.id))
    .where(eq(ledgerEntries.productId, id))
    .orderBy(desc(ledgerEntries.timestamp))
    .limit(25);
  return res.json({
    ...product,
    stockByLocation: stockByLocation.map((row) => ({ ...row, quantity: number(row.quantity) })),
    movementHistory: movements.map((row) => ({
      ...row,
      quantityChange: number(row.quantityChange),
      beforeQuantity: number(row.beforeQuantity),
      afterQuantity: number(row.afterQuantity),
    })),
  });
});

router.patch("/products/:id", async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = UpdateProductParams.parse(req.params);
    const input = UpdateProductBody.parse(req.body);
    const [product] = await db.update(products).set({
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
      ...(input.sku === undefined ? {} : { sku: input.sku.trim().toUpperCase() }),
      ...(input.categoryId === undefined ? {} : { categoryId: input.categoryId }),
      ...(input.uom === undefined ? {} : { uom: input.uom.trim() }),
      ...(input.reorderLevel === undefined ? {} : { reorderLevel: String(input.reorderLevel) }),
      ...(input.active === undefined ? {} : { active: input.active }),
      updatedAt: new Date(),
    }).where(eq(products.id, id)).returning();
    if (!product) return res.status(404).json({ error: "Product not found" });
    await logActivity(req.user!.id, "Updated product", "Product", product.sku);
    return res.json(await productView(product.id));
  } catch {
    return res.status(400).json({ error: "Unable to update product" });
  }
});

router.delete("/products/:id", async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = DeactivateProductParams.parse(req.params);
    const [product] = await db.update(products).set({ active: false, updatedAt: new Date() }).where(eq(products.id, id)).returning();
    if (!product) return res.status(404).json({ error: "Product not found" });
    await logActivity(req.user!.id, "Deactivated product", "Product", product.sku);
    return res.status(204).send();
  } catch {
    return res.status(400).json({ error: "Unable to deactivate product" });
  }
});

router.get("/stock", async (req, res) => {
  const search = typeof req.query.search === "string" ? req.query.search : undefined;
  const warehouseId = req.query.warehouseId ? Number(req.query.warehouseId) : undefined;
  const categoryId = req.query.categoryId ? Number(req.query.categoryId) : undefined;
  const rows = await db
    .select({
      productId: products.id,
      productName: products.name,
      sku: products.sku,
      categoryName: categories.name,
      warehouseId: warehouses.id,
      warehouseName: warehouses.name,
      locationId: locations.id,
      locationName: locations.name,
      quantity: stocks.quantity,
      uom: products.uom,
    })
    .from(stocks)
    .innerJoin(products, eq(stocks.productId, products.id))
    .innerJoin(categories, eq(products.categoryId, categories.id))
    .innerJoin(locations, eq(stocks.locationId, locations.id))
    .innerJoin(warehouses, eq(locations.warehouseId, warehouses.id))
    .where(and(
      search ? or(ilike(products.name, `%${search}%`), ilike(products.sku, `%${search}%`)) : undefined,
      warehouseId ? eq(warehouses.id, warehouseId) : undefined,
      categoryId ? eq(products.categoryId, categoryId) : undefined,
    ))
    .orderBy(asc(products.name), asc(locations.name));
  return res.json(rows.map((row) => ({ ...row, quantity: number(row.quantity) })));
});

router.get("/reorder-rules", async (_req, res) => {
  const rows = await db
    .select({
      id: reorderRules.id,
      productId: products.id,
      productName: products.name,
      locationId: locations.id,
      locationName: locations.name,
      minimumQuantity: reorderRules.minimumQuantity,
      maximumQuantity: reorderRules.maximumQuantity,
      reorderQuantity: reorderRules.reorderQuantity,
      currentQuantity: sql<string>`coalesce(${stocks.quantity}, 0)`,
    })
    .from(reorderRules)
    .innerJoin(products, eq(reorderRules.productId, products.id))
    .innerJoin(locations, eq(reorderRules.locationId, locations.id))
    .leftJoin(stocks, and(eq(stocks.productId, reorderRules.productId), eq(stocks.locationId, reorderRules.locationId)))
    .orderBy(asc(products.name));
  return res.json(rows.map((row) => {
    const currentQuantity = number(row.currentQuantity);
    return {
      ...row,
      minimumQuantity: number(row.minimumQuantity),
      maximumQuantity: number(row.maximumQuantity),
      reorderQuantity: number(row.reorderQuantity),
      currentQuantity,
      needsReorder: currentQuantity <= number(row.minimumQuantity),
    };
  }));
});

router.post("/reorder-rules", async (req: AuthenticatedRequest, res) => {
  try {
    const input = CreateReorderRuleBody.parse(req.body);
    const [rule] = await db.insert(reorderRules).values({
      productId: input.productId,
      locationId: input.locationId,
      minimumQuantity: String(input.minimumQuantity),
      maximumQuantity: String(input.maximumQuantity),
      reorderQuantity: String(input.reorderQuantity),
    }).returning();
    if (!rule) return res.status(400).json({ error: "Unable to create reorder rule" });
    await logActivity(req.user!.id, "Created reorder rule", "ReorderRule", String(rule.id));
    return res.status(201).json({ ...rule, currentQuantity: 0, needsReorder: true });
  } catch {
    return res.status(400).json({ error: "A rule already exists for this product and location" });
  }
});

router.delete("/reorder-rules/:id", async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = DeleteReorderRuleParams.parse(req.params);
    await db.delete(reorderRules).where(eq(reorderRules.id, id));
    await logActivity(req.user!.id, "Deleted reorder rule", "ReorderRule", String(id));
    return res.status(204).send();
  } catch {
    return res.status(400).json({ error: "Unable to delete reorder rule" });
  }
});

export default router;