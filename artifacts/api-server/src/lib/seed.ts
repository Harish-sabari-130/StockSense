import bcrypt from "bcryptjs";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  activityLogs,
  categories,
  ledgerEntries,
  locations,
  products,
  stocks,
  users,
  warehouses,
} from "@workspace/db/schema";
import { logger } from "./logger";

export async function seedDemoData() {
  const [existing] = await db.select({ id: users.id }).from(users).limit(1);
  if (existing) return;

  const passwordHash = await bcrypt.hash("StockSense2026!", 10);
  const [admin] = await db
    .insert(users)
    .values({
      name: "Avery Morgan",
      email: "admin@stocksense.local",
      passwordHash,
      role: "ADMIN",
    })
    .returning();
  if (!admin) return;

  const seededCategories = await db
    .insert(categories)
    .values([
      { name: "Raw Materials" },
      { name: "Workplace" },
      { name: "Safety Equipment" },
    ])
    .returning();
  const raw = seededCategories.find((item) => item.name === "Raw Materials")!;
  const workplace = seededCategories.find((item) => item.name === "Workplace")!;
  const safety = seededCategories.find((item) => item.name === "Safety Equipment")!;

  const seededWarehouses = await db
    .insert(warehouses)
    .values([
      { name: "Main Warehouse", code: "MAIN", address: "12 Foundry Road" },
      { name: "Production Warehouse", code: "PROD", address: "48 Assembly Avenue" },
    ])
    .returning();
  const main = seededWarehouses.find((item) => item.code === "MAIN")!;
  const production = seededWarehouses.find((item) => item.code === "PROD")!;
  const seededLocations = await db
    .insert(locations)
    .values([
      { name: "Rack A", warehouseId: main.id },
      { name: "Rack B", warehouseId: main.id },
      { name: "Production Floor", warehouseId: production.id },
      { name: "Dispatch Area", warehouseId: production.id },
    ])
    .returning();
  const rackA = seededLocations.find((item) => item.name === "Rack A")!;
  const rackB = seededLocations.find((item) => item.name === "Rack B")!;
  const productionFloor = seededLocations.find((item) => item.name === "Production Floor")!;
  const dispatch = seededLocations.find((item) => item.name === "Dispatch Area")!;

  const seededProducts = await db
    .insert(products)
    .values([
      { name: "Steel Rods", sku: "STL-ROD-001", categoryId: raw.id, uom: "kg", reorderLevel: "40" },
      { name: "Office Chairs", sku: "OFF-CHR-014", categoryId: workplace.id, uom: "units", reorderLevel: "12" },
      { name: "Bolts", sku: "BLT-M8-100", categoryId: raw.id, uom: "boxes", reorderLevel: "18" },
      { name: "Aluminum Sheets", sku: "ALU-SHT-020", categoryId: raw.id, uom: "sheets", reorderLevel: "25" },
      { name: "Safety Helmets", sku: "SAFE-HLM-010", categoryId: safety.id, uom: "units", reorderLevel: "20" },
    ])
    .returning();

  const steel = seededProducts.find((item) => item.sku === "STL-ROD-001")!;
  const chairs = seededProducts.find((item) => item.sku === "OFF-CHR-014")!;
  const bolts = seededProducts.find((item) => item.sku === "BLT-M8-100")!;
  const sheets = seededProducts.find((item) => item.sku === "ALU-SHT-020")!;
  const helmets = seededProducts.find((item) => item.sku === "SAFE-HLM-010")!;
  await db.insert(stocks).values([
    { productId: steel.id, locationId: rackA.id, quantity: "100" },
    { productId: chairs.id, locationId: dispatch.id, quantity: "8" },
    { productId: bolts.id, locationId: rackB.id, quantity: "42" },
    { productId: sheets.id, locationId: rackA.id, quantity: "14" },
    { productId: helmets.id, locationId: productionFloor.id, quantity: "58" },
  ]);

  await db.insert(ledgerEntries).values([
    {
      productId: steel.id,
      movementType: "RECEIPT",
      reference: "RCV-0001",
      warehouseId: main.id,
      destinationLocationId: rackA.id,
      quantityChange: "100",
      beforeQuantity: "0",
      afterQuantity: "100",
      userId: admin.id,
    },
    {
      productId: chairs.id,
      movementType: "ADJUSTMENT",
      reference: "ADJ-0001",
      warehouseId: production.id,
      destinationLocationId: dispatch.id,
      quantityChange: "8",
      beforeQuantity: "0",
      afterQuantity: "8",
      userId: admin.id,
    },
  ]);
  await db.insert(activityLogs).values([
    { action: "Seeded demo inventory", entity: "System", reference: "SEED-0001", userId: admin.id },
  ]);

  logger.info(
    { products: seededProducts.length, warehouses: seededWarehouses.length },
    "StockSense demo data seeded",
  );
}