import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export type Db = ReturnType<typeof drizzlePg<typeof schema>>;

const { Pool } = pg;

let _db: Db | null = null;
let pool: InstanceType<typeof Pool> | null = null;

function createPgDb() {
  const connectionString = process.env.DATABASE_URL!;
  pool = new Pool({ connectionString });
  return drizzlePg(pool, { schema });
}

async function createPgliteDb() {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");

  // Use in-memory PGlite for local demo (no file system dependencies)
  const client = new PGlite();

  // Wait for the client to be ready
  await client.waitReady;

  const db = drizzle(client, { schema });

  // Run schema migrations inline (create tables if not exist)
  await client.exec(`
    DO $$ BEGIN
      CREATE TYPE user_role AS ENUM ('USER', 'ADMIN');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE operation_kind AS ENUM ('RECEIPT', 'DELIVERY', 'TRANSFER', 'ADJUSTMENT');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE operation_status AS ENUM ('DRAFT', 'WAITING', 'READY', 'DONE', 'CANCELED');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE movement_type AS ENUM ('RECEIPT', 'DELIVERY', 'TRANSFER_IN', 'TRANSFER_OUT', 'ADJUSTMENT');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role user_role NOT NULL DEFAULT 'USER',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users(email);

    CREATE TABLE IF NOT EXISTS product_categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS product_categories_name_idx ON product_categories(name);

    CREATE TABLE IF NOT EXISTS warehouses (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT NOT NULL,
      address TEXT NOT NULL DEFAULT '',
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS warehouses_code_idx ON warehouses(code);

    CREATE TABLE IF NOT EXISTS locations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS locations_warehouse_idx ON locations(warehouse_id);

    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      sku TEXT NOT NULL,
      category_id INTEGER NOT NULL REFERENCES product_categories(id),
      uom TEXT NOT NULL DEFAULT 'units',
      reorder_level NUMERIC(14, 2) NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS products_sku_idx ON products(sku);
    CREATE INDEX IF NOT EXISTS products_category_idx ON products(category_id);

    CREATE TABLE IF NOT EXISTS stocks (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id),
      location_id INTEGER NOT NULL REFERENCES locations(id),
      quantity NUMERIC(14, 2) NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS stocks_product_location_idx ON stocks(product_id, location_id);
    CREATE INDEX IF NOT EXISTS stocks_product_idx ON stocks(product_id);
    CREATE INDEX IF NOT EXISTS stocks_location_idx ON stocks(location_id);

    CREATE TABLE IF NOT EXISTS operations (
      id SERIAL PRIMARY KEY,
      number TEXT NOT NULL,
      kind operation_kind NOT NULL,
      status operation_status NOT NULL DEFAULT 'DRAFT',
      partner TEXT,
      warehouse_id INTEGER REFERENCES warehouses(id),
      source_location_id INTEGER REFERENCES locations(id),
      destination_warehouse_id INTEGER REFERENCES warehouses(id),
      destination_location_id INTEGER REFERENCES locations(id),
      reason TEXT,
      created_by_id INTEGER NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX IF NOT EXISTS operations_number_idx ON operations(number);
    CREATE INDEX IF NOT EXISTS operations_kind_status_idx ON operations(kind, status);

    CREATE TABLE IF NOT EXISTS operation_lines (
      id SERIAL PRIMARY KEY,
      operation_id INTEGER NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity NUMERIC(14, 2) NOT NULL,
      physical_quantity NUMERIC(14, 2)
    );
    CREATE INDEX IF NOT EXISTS operation_lines_operation_idx ON operation_lines(operation_id);

    CREATE TABLE IF NOT EXISTS stock_ledger_entries (
      id SERIAL PRIMARY KEY,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
      product_id INTEGER NOT NULL REFERENCES products(id),
      movement_type movement_type NOT NULL,
      reference TEXT NOT NULL,
      warehouse_id INTEGER REFERENCES warehouses(id),
      source_location_id INTEGER REFERENCES locations(id),
      destination_location_id INTEGER REFERENCES locations(id),
      quantity_change NUMERIC(14, 2) NOT NULL,
      before_quantity NUMERIC(14, 2) NOT NULL,
      after_quantity NUMERIC(14, 2) NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id),
      operation_id INTEGER REFERENCES operations(id)
    );
    CREATE INDEX IF NOT EXISTS ledger_timestamp_idx ON stock_ledger_entries(timestamp);
    CREATE INDEX IF NOT EXISTS ledger_product_idx ON stock_ledger_entries(product_id);
    CREATE INDEX IF NOT EXISTS ledger_movement_idx ON stock_ledger_entries(movement_type);

    CREATE TABLE IF NOT EXISTS reorder_rules (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id),
      location_id INTEGER NOT NULL REFERENCES locations(id),
      minimum_quantity NUMERIC(14, 2) NOT NULL,
      maximum_quantity NUMERIC(14, 2) NOT NULL,
      reorder_quantity NUMERIC(14, 2) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS reorder_product_location_idx ON reorder_rules(product_id, location_id);

    CREATE TABLE IF NOT EXISTS activity_logs (
      id SERIAL PRIMARY KEY,
      action TEXT NOT NULL,
      entity TEXT NOT NULL,
      reference TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id),
      timestamp TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS activity_timestamp_idx ON activity_logs(timestamp);

    CREATE TABLE IF NOT EXISTS password_reset_otps (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      otp TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS password_reset_user_idx ON password_reset_otps(user_id);
  `);

  return db as unknown as Db;
}

export async function getDb(): Promise<Db> {
  if (_db) return _db;

  if (process.env.DATABASE_URL) {
    _db = createPgDb();
  } else {
    _db = await createPgliteDb();
  }

  return _db;
}

// Synchronous export for routes that import directly
// This will be initialized on first use via getDb()
export let db: Db = null as unknown as Db;

export async function initDb() {
  db = await getDb();
  return db;
}

export { pool };
export * from "./schema";
