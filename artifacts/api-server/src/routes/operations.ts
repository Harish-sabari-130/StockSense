import { Router, type IRouter } from "express";
import { and, asc, count, desc, eq, ilike, or } from "drizzle-orm";
import {
  CreateOperationBody,
  GetOperationParams,
  UpdateOperationBody,
  UpdateOperationParams,
  ValidateOperationParams,
  CancelOperationParams,
} from "@workspace/api-zod";
import { db } from "@workspace/db";
import {
  activityLogs,
  categories,
  ledgerEntries,
  locations,
  operationLines,
  operations,
  products,
  stocks,
  users,
  warehouses,
} from "@workspace/db/schema";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth";

const router: IRouter = Router();
router.use(requireAuth);

const kinds = ["receipts", "deliveries", "transfers", "adjustments"] as const;
type RouteKind = (typeof kinds)[number];
const kindToEnum = (kind: string) =>
  ({ receipts: "RECEIPT", deliveries: "DELIVERY", transfers: "TRANSFER", adjustments: "ADJUSTMENT" } as const)[kind as RouteKind];
const enumToKind = (kind: string) =>
  ({ RECEIPT: "receipts", DELIVERY: "deliveries", TRANSFER: "transfers", ADJUSTMENT: "adjustments" } as const)[kind as keyof typeof kindToEnum];
const numeric = (value: unknown) => Number(value ?? 0);
const validKind = (kind: string): kind is RouteKind => kinds.includes(kind as RouteKind);

async function activity(userId: number, action: string, entity: string, reference: string) {
  await db.insert(activityLogs).values({ action, entity, reference, userId });
}

async function operationView(id: number) {
  const [row] = await db
    .select({
      id: operations.id,
      number: operations.number,
      kind: operations.kind,
      status: operations.status,
      partner: operations.partner,
      warehouseId: operations.warehouseId,
      warehouseName: warehouses.name,
      sourceLocationId: operations.sourceLocationId,
      sourceLocationName: locations.name,
      destinationWarehouseId: operations.destinationWarehouseId,
      destinationLocationId: operations.destinationLocationId,
      reason: operations.reason,
      createdAt: operations.createdAt,
      completedAt: operations.completedAt,
      createdBy: users.name,
    })
    .from(operations)
    .innerJoin(users, eq(operations.createdById, users.id))
    .leftJoin(warehouses, eq(operations.warehouseId, warehouses.id))
    .leftJoin(locations, eq(operations.sourceLocationId, locations.id))
    .where(eq(operations.id, id))
    .limit(1);
  if (!row) return null;
  const destination = row.destinationLocationId
    ? await db
        .select({ name: locations.name, warehouseId: locations.warehouseId, warehouseName: warehouses.name })
        .from(locations)
        .innerJoin(warehouses, eq(locations.warehouseId, warehouses.id))
        .where(eq(locations.id, row.destinationLocationId))
        .limit(1)
    : [];
  const lines = await db
    .select({
      id: operationLines.id,
      productId: products.id,
      productName: products.name,
      sku: products.sku,
      uom: products.uom,
      quantity: operationLines.quantity,
      physicalQuantity: operationLines.physicalQuantity,
    })
    .from(operationLines)
    .innerJoin(products, eq(operationLines.productId, products.id))
    .where(eq(operationLines.operationId, id))
    .orderBy(asc(operationLines.id));
  return {
    ...row,
    kind: row.kind,
    destinationWarehouseId: row.destinationWarehouseId ?? destination[0]?.warehouseId ?? null,
    destinationWarehouseName: destination[0]?.warehouseName ?? null,
    destinationLocationName: destination[0]?.name ?? null,
    lines: lines.map((line) => ({
      ...line,
      quantity: numeric(line.quantity),
      physicalQuantity: line.physicalQuantity == null ? null : numeric(line.physicalQuantity),
      difference:
        line.physicalQuantity == null ? null : numeric(line.physicalQuantity) - numeric(line.quantity),
    })),
  };
}

async function nextNumber(prefix: string) {
  const [row] = await db.select({ total: count(operations.id) }).from(operations).where(ilike(operations.number, `${prefix}-%`));
  return `${prefix}-${String(Number(row?.total ?? 0) + 1).padStart(4, "0")}`;
}

async function ensureStock(tx: any, productId: number, locationId: number) {
  const [row] = await tx.select().from(stocks).where(and(eq(stocks.productId, productId), eq(stocks.locationId, locationId))).limit(1);
  if (row) return row;
  const [created] = await tx.insert(stocks).values({ productId, locationId, quantity: "0" }).returning();
  return created;
}

async function applyStock(tx: any, productId: number, locationId: number, delta: number) {
  const row = await ensureStock(tx, productId, locationId);
  const before = numeric(row.quantity);
  const after = before + delta;
  if (after < 0) throw new Error(`Insufficient stock for product ${productId}`);
  await tx.update(stocks).set({ quantity: String(after), updatedAt: new Date() }).where(eq(stocks.id, row.id));
  return { before, after };
}

function bodyForKind(body: any, kind: RouteKind) {
  if (!Array.isArray(body.lines) || body.lines.length === 0) throw new Error("At least one product line is required");
  if (body.lines.some((line: any) => Number(line.quantity) <= 0)) throw new Error("Quantities must be greater than zero");
  if (kind === "receipts" && (!body.destinationLocationId || !body.warehouseId)) throw new Error("Receipt destination is required");
  if (kind === "deliveries" && (!body.sourceLocationId || !body.warehouseId)) throw new Error("Delivery source is required");
  if (kind === "transfers" && (!body.sourceLocationId || !body.destinationLocationId)) throw new Error("Transfer locations are required");
  if (kind === "adjustments" && (!body.destinationLocationId || !body.warehouseId)) throw new Error("Adjustment location is required");
}

router.get("/operations/:kind", async (req, res) => {
  const routeKind = String(req.params.kind);
  if (!validKind(routeKind)) return res.status(400).json({ error: "Unknown operation type" });
  const kind = kindToEnum(routeKind);
  const page = Math.max(1, Number(req.query.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 20)));
  const search = typeof req.query.search === "string" ? req.query.search : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const where = and(
    eq(operations.kind, kind),
    search ? ilike(operations.number, `%${search}%`) : undefined,
    status ? eq(operations.status, status as any) : undefined,
  );
  const [totalRow] = await db.select({ total: count(operations.id) }).from(operations).where(where);
  const baseRows = await db.select({ id: operations.id }).from(operations).where(where).orderBy(desc(operations.createdAt)).limit(pageSize).offset((page - 1) * pageSize);
  const items = (await Promise.all(baseRows.map((row) => operationView(row.id)))).filter(Boolean);
  return res.json({ items, page, pageSize, total: Number(totalRow?.total ?? 0) });
});

router.post("/operations/:kind", async (req: AuthenticatedRequest, res) => {
  const kind = String(req.params.kind);
  if (!validKind(kind)) return res.status(400).json({ error: "Unknown operation type" });
  try {
    const parsed = CreateOperationBody.parse(req.body);
    bodyForKind(parsed, kind);
    const operationKind = kindToEnum(kind);
    const prefix = operationKind === "RECEIPT" ? "RCV" : operationKind === "DELIVERY" ? "DEL" : operationKind === "TRANSFER" ? "TRF" : "ADJ";
    const [operation] = await db.insert(operations).values({
      number: await nextNumber(prefix),
      kind: operationKind,
      status: "DRAFT",
      partner: parsed.partner ?? null,
      warehouseId: parsed.warehouseId ?? null,
      sourceLocationId: parsed.sourceLocationId ?? null,
      destinationWarehouseId: parsed.destinationWarehouseId ?? null,
      destinationLocationId: parsed.destinationLocationId ?? null,
      reason: parsed.reason ?? null,
      createdById: req.user!.id,
    }).returning();
    if (!operation) return res.status(400).json({ error: "Unable to create operation" });
    await db.insert(operationLines).values(parsed.lines.map((line: any) => ({
      operationId: operation.id,
      productId: line.productId,
      quantity: String(line.quantity),
      physicalQuantity: line.physicalQuantity === undefined ? null : String(line.physicalQuantity),
    })));
    await activity(req.user!.id, `Created ${kind.slice(0, -1)}`, "Operation", operation.number);
    return res.status(201).json(await operationView(operation.id));
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : "Unable to create operation" });
  }
});

router.get("/operations/:kind/:id", async (req, res) => {
  const routeKind = String(req.params.kind);
  if (!validKind(routeKind)) return res.status(400).json({ error: "Unknown operation type" });
  try {
    const { id } = GetOperationParams.parse(req.params);
    const operation = await operationView(id);
    if (!operation) return res.status(404).json({ error: "Operation not found" });
    return res.json(operation);
  } catch {
    return res.status(400).json({ error: "Invalid operation" });
  }
});

router.patch("/operations/:kind/:id", async (req: AuthenticatedRequest, res) => {
  const routeKind = String(req.params.kind);
  if (!validKind(routeKind)) return res.status(400).json({ error: "Unknown operation type" });
  try {
    const { id } = UpdateOperationParams.parse(req.params);
    const input = UpdateOperationBody.parse(req.body);
    const [existing] = await db.select().from(operations).where(eq(operations.id, id)).limit(1);
    if (!existing) return res.status(404).json({ error: "Operation not found" });
    if (existing.status === "DONE" || existing.status === "CANCELED") return res.status(400).json({ error: "Only draft operations can be edited" });
    bodyForKind(input, routeKind);
    await db.transaction(async (tx) => {
      await tx.update(operations).set({
        partner: input.partner ?? null,
        warehouseId: input.warehouseId ?? null,
        sourceLocationId: input.sourceLocationId ?? null,
        destinationWarehouseId: input.destinationWarehouseId ?? null,
        destinationLocationId: input.destinationLocationId ?? null,
        reason: input.reason ?? null,
      }).where(eq(operations.id, id));
      await tx.delete(operationLines).where(eq(operationLines.operationId, id));
      await tx.insert(operationLines).values(input.lines.map((line: any) => ({
        operationId: id,
        productId: line.productId,
        quantity: String(line.quantity),
        physicalQuantity: line.physicalQuantity === undefined ? null : String(line.physicalQuantity),
      })));
    });
    await activity(req.user!.id, "Updated operation", "Operation", existing.number);
    return res.json(await operationView(id));
  } catch {
    return res.status(400).json({ error: "Unable to update operation" });
  }
});

router.post("/operations/:kind/:id/validate", async (req: AuthenticatedRequest, res) => {
  const routeKind = String(req.params.kind);
  if (!validKind(routeKind)) return res.status(400).json({ error: "Unknown operation type" });
  try {
    const { id } = ValidateOperationParams.parse(req.params);
    const [existing] = await db.select().from(operations).where(eq(operations.id, id)).limit(1);
    if (!existing) return res.status(404).json({ error: "Operation not found" });
    if (existing.status === "DONE") return res.status(400).json({ error: "This operation has already been validated" });
    if (existing.status === "CANCELED") return res.status(400).json({ error: "Canceled operations cannot be validated" });
    const lines = await db.select().from(operationLines).where(eq(operationLines.operationId, id));
    if (!lines.length) return res.status(400).json({ error: "Add at least one product line first" });
    await db.transaction(async (tx) => {
      for (const line of lines) {
        const quantity = numeric(line.quantity);
        if (existing.kind === "RECEIPT") {
          const locationId = existing.destinationLocationId!;
          const result = await applyStock(tx, line.productId, locationId, quantity);
          await tx.insert(ledgerEntries).values({
            productId: line.productId,
            movementType: "RECEIPT",
            reference: existing.number,
            warehouseId: existing.warehouseId,
            destinationLocationId: locationId,
            quantityChange: String(quantity),
            beforeQuantity: String(result.before),
            afterQuantity: String(result.after),
            userId: req.user!.id,
            operationId: existing.id,
          });
        } else if (existing.kind === "DELIVERY") {
          const locationId = existing.sourceLocationId!;
          const result = await applyStock(tx, line.productId, locationId, -quantity);
          await tx.insert(ledgerEntries).values({
            productId: line.productId,
            movementType: "DELIVERY",
            reference: existing.number,
            warehouseId: existing.warehouseId,
            sourceLocationId: locationId,
            quantityChange: String(-quantity),
            beforeQuantity: String(result.before),
            afterQuantity: String(result.after),
            userId: req.user!.id,
            operationId: existing.id,
          });
        } else if (existing.kind === "TRANSFER") {
          const sourceId = existing.sourceLocationId!;
          const destinationId = existing.destinationLocationId!;
          const source = await applyStock(tx, line.productId, sourceId, -quantity);
          const destination = await applyStock(tx, line.productId, destinationId, quantity);
          await tx.insert(ledgerEntries).values([
            {
              productId: line.productId,
              movementType: "TRANSFER_OUT",
              reference: existing.number,
              warehouseId: existing.warehouseId,
              sourceLocationId: sourceId,
              destinationLocationId: destinationId,
              quantityChange: String(-quantity),
              beforeQuantity: String(source.before),
              afterQuantity: String(source.after),
              userId: req.user!.id,
              operationId: existing.id,
            },
            {
              productId: line.productId,
              movementType: "TRANSFER_IN",
              reference: existing.number,
              warehouseId: existing.destinationWarehouseId,
              sourceLocationId: sourceId,
              destinationLocationId: destinationId,
              quantityChange: String(quantity),
              beforeQuantity: String(destination.before),
              afterQuantity: String(destination.after),
              userId: req.user!.id,
              operationId: existing.id,
            },
          ]);
        } else {
          const locationId = existing.destinationLocationId!;
          const target = line.physicalQuantity == null ? numeric(line.quantity) : numeric(line.physicalQuantity);
          const result = await applyStock(tx, line.productId, locationId, target - numeric((await ensureStock(tx, line.productId, locationId)).quantity));
          await tx.insert(ledgerEntries).values({
            productId: line.productId,
            movementType: "ADJUSTMENT",
            reference: existing.number,
            warehouseId: existing.warehouseId,
            destinationLocationId: locationId,
            quantityChange: String(target - result.before),
            beforeQuantity: String(result.before),
            afterQuantity: String(result.after),
            userId: req.user!.id,
            operationId: existing.id,
          });
        }
      }
      await tx.update(operations).set({ status: "DONE", completedAt: new Date() }).where(eq(operations.id, id));
    });
    await activity(req.user!.id, "Validated operation", "Operation", existing.number);
    return res.json(await operationView(id));
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : "Unable to validate operation" });
  }
});

router.post("/operations/:kind/:id/cancel", async (req: AuthenticatedRequest, res) => {
  const routeKind = String(req.params.kind);
  if (!validKind(routeKind)) return res.status(400).json({ error: "Unknown operation type" });
  try {
    const { id } = CancelOperationParams.parse(req.params);
    const [existing] = await db.select().from(operations).where(eq(operations.id, id)).limit(1);
    if (!existing) return res.status(404).json({ error: "Operation not found" });
    if (existing.status === "DONE") return res.status(400).json({ error: "Completed operations cannot be canceled" });
    await db.update(operations).set({ status: "CANCELED" }).where(eq(operations.id, id));
    await activity(req.user!.id, "Canceled operation", "Operation", existing.number);
    return res.json(await operationView(id));
  } catch {
    return res.status(400).json({ error: "Unable to cancel operation" });
  }
});

export default router;