import {
  boolean,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const userRoleEnum = pgEnum("user_role", ["USER", "ADMIN"]);
export const operationKindEnum = pgEnum("operation_kind", [
  "RECEIPT",
  "DELIVERY",
  "TRANSFER",
  "ADJUSTMENT",
]);
export const operationStatusEnum = pgEnum("operation_status", [
  "DRAFT",
  "WAITING",
  "READY",
  "DONE",
  "CANCELED",
]);
export const movementTypeEnum = pgEnum("movement_type", [
  "RECEIPT",
  "DELIVERY",
  "TRANSFER_IN",
  "TRANSFER_OUT",
  "ADJUSTMENT",
]);

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: userRoleEnum("role").notNull().default("USER"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("users_email_idx").on(table.email)],
);

export const categories = pgTable(
  "product_categories",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("product_categories_name_idx").on(table.name)],
);

export const warehouses = pgTable(
  "warehouses",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    code: text("code").notNull(),
    address: text("address").notNull().default(""),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("warehouses_code_idx").on(table.code)],
);

export const locations = pgTable(
  "locations",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    warehouseId: integer("warehouse_id").notNull().references(() => warehouses.id),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("locations_warehouse_idx").on(table.warehouseId)],
);

export const products = pgTable(
  "products",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    sku: text("sku").notNull(),
    categoryId: integer("category_id").notNull().references(() => categories.id),
    uom: text("uom").notNull().default("units"),
    reorderLevel: numeric("reorder_level", { precision: 14, scale: 2 }).notNull().default("0"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("products_sku_idx").on(table.sku),
    index("products_category_idx").on(table.categoryId),
  ],
);

export const stocks = pgTable(
  "stocks",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id").notNull().references(() => products.id),
    locationId: integer("location_id").notNull().references(() => locations.id),
    quantity: numeric("quantity", { precision: 14, scale: 2 }).notNull().default("0"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("stocks_product_location_idx").on(table.productId, table.locationId),
    index("stocks_product_idx").on(table.productId),
    index("stocks_location_idx").on(table.locationId),
  ],
);

export const operations = pgTable(
  "operations",
  {
    id: serial("id").primaryKey(),
    number: text("number").notNull(),
    kind: operationKindEnum("kind").notNull(),
    status: operationStatusEnum("status").notNull().default("DRAFT"),
    partner: text("partner"),
    warehouseId: integer("warehouse_id").references(() => warehouses.id),
    sourceLocationId: integer("source_location_id").references(() => locations.id),
    destinationWarehouseId: integer("destination_warehouse_id").references(() => warehouses.id),
    destinationLocationId: integer("destination_location_id").references(() => locations.id),
    reason: text("reason"),
    createdById: integer("created_by_id").notNull().references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("operations_number_idx").on(table.number),
    index("operations_kind_status_idx").on(table.kind, table.status),
  ],
);

export const operationLines = pgTable(
  "operation_lines",
  {
    id: serial("id").primaryKey(),
    operationId: integer("operation_id").notNull().references(() => operations.id, { onDelete: "cascade" }),
    productId: integer("product_id").notNull().references(() => products.id),
    quantity: numeric("quantity", { precision: 14, scale: 2 }).notNull(),
    physicalQuantity: numeric("physical_quantity", { precision: 14, scale: 2 }),
  },
  (table) => [index("operation_lines_operation_idx").on(table.operationId)],
);

export const ledgerEntries = pgTable(
  "stock_ledger_entries",
  {
    id: serial("id").primaryKey(),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
    productId: integer("product_id").notNull().references(() => products.id),
    movementType: movementTypeEnum("movement_type").notNull(),
    reference: text("reference").notNull(),
    warehouseId: integer("warehouse_id").references(() => warehouses.id),
    sourceLocationId: integer("source_location_id").references(() => locations.id),
    destinationLocationId: integer("destination_location_id").references(() => locations.id),
    quantityChange: numeric("quantity_change", { precision: 14, scale: 2 }).notNull(),
    beforeQuantity: numeric("before_quantity", { precision: 14, scale: 2 }).notNull(),
    afterQuantity: numeric("after_quantity", { precision: 14, scale: 2 }).notNull(),
    userId: integer("user_id").notNull().references(() => users.id),
    operationId: integer("operation_id").references(() => operations.id),
  },
  (table) => [
    index("ledger_timestamp_idx").on(table.timestamp),
    index("ledger_product_idx").on(table.productId),
    index("ledger_movement_idx").on(table.movementType),
  ],
);

export const reorderRules = pgTable(
  "reorder_rules",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id").notNull().references(() => products.id),
    locationId: integer("location_id").notNull().references(() => locations.id),
    minimumQuantity: numeric("minimum_quantity", { precision: 14, scale: 2 }).notNull(),
    maximumQuantity: numeric("maximum_quantity", { precision: 14, scale: 2 }).notNull(),
    reorderQuantity: numeric("reorder_quantity", { precision: 14, scale: 2 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("reorder_product_location_idx").on(table.productId, table.locationId)],
);

export const activityLogs = pgTable(
  "activity_logs",
  {
    id: serial("id").primaryKey(),
    action: text("action").notNull(),
    entity: text("entity").notNull(),
    reference: text("reference").notNull(),
    userId: integer("user_id").notNull().references(() => users.id),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("activity_timestamp_idx").on(table.timestamp)],
);

export const passwordResetOtps = pgTable(
  "password_reset_otps",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    otp: text("otp").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (table) => [index("password_reset_user_idx").on(table.userId)],
);

export const insertUserSchema = createInsertSchema(users);
export const insertProductSchema = createInsertSchema(products);
export const insertCategorySchema = createInsertSchema(categories);
export const insertWarehouseSchema = createInsertSchema(warehouses);
export const insertLocationSchema = createInsertSchema(locations);
export const insertOperationSchema = createInsertSchema(operations);
export const insertOperationLineSchema = createInsertSchema(operationLines);
export const insertLedgerEntrySchema = createInsertSchema(ledgerEntries);
export const insertReorderRuleSchema = createInsertSchema(reorderRules);

export type User = typeof users.$inferSelect;
export type Product = typeof products.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Warehouse = typeof warehouses.$inferSelect;
export type Location = typeof locations.$inferSelect;
export type Stock = typeof stocks.$inferSelect;
export type Operation = typeof operations.$inferSelect;
export type OperationLine = typeof operationLines.$inferSelect;
export type LedgerEntry = typeof ledgerEntries.$inferSelect;
export type ReorderRule = typeof reorderRules.$inferSelect;
export type ActivityLog = typeof activityLogs.$inferSelect;
export type DbSchema = typeof z;