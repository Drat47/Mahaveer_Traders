const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DB_PATH = path.join(__dirname, 'data.sqlite');
const db = new DatabaseSync(DB_PATH);

// Enable WAL mode for high concurrency across multiple devices
db.exec(`PRAGMA journal_mode = WAL;`);
db.exec(`PRAGMA foreign_keys = ON;`);

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'auditor', 'mechanic')),
      name TEXT NOT NULL,
      phone TEXT,
      mechanic_id INTEGER,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS mechanics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      address TEXT NOT NULL,
      trade_type TEXT NOT NULL,
      password TEXT NOT NULL DEFAULT 'mechanic123',
      available_points INTEGER DEFAULT 0,
      lifetime_points INTEGER DEFAULT 0,
      recovery_points INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      unit TEXT NOT NULL,
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mechanic_id INTEGER NOT NULL,
      purchase_date TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      customer_address TEXT NOT NULL,
      total_amount REAL NOT NULL,
      bill_file_url TEXT,
      status TEXT DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'APPROVED', 'REJECTED', 'CORRECTION')),
      points_awarded INTEGER,
      approved_date TEXT,
      verified_by TEXT,
      rejection_reason TEXT,
      correction_message TEXT,
      submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(mechanic_id) REFERENCES mechanics(id)
    );

    CREATE TABLE IF NOT EXISTS purchase_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_id INTEGER NOT NULL,
      product_id INTEGER,
      product_name TEXT NOT NULL,
      quantity REAL NOT NULL,
      unit TEXT NOT NULL,
      points_allocated INTEGER DEFAULT 0,
      returned_quantity REAL DEFAULT 0,
      FOREIGN KEY(purchase_id) REFERENCES purchases(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS rewards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      points_required INTEGER NOT NULL,
      stock INTEGER NOT NULL DEFAULT 0,
      eligible_types TEXT NOT NULL, -- JSON array string e.g. ["Plumber","Painters"] or ["all"]
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS redemptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mechanic_id INTEGER NOT NULL,
      reward_id INTEGER NOT NULL,
      reward_name TEXT NOT NULL,
      points INTEGER NOT NULL,
      status TEXT DEFAULT 'Pending' CHECK(status IN ('Pending', 'Approved', 'Rejected')),
      requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      decided_by TEXT,
      decided_at DATETIME,
      FOREIGN KEY(mechanic_id) REFERENCES mechanics(id),
      FOREIGN KEY(reward_id) REFERENCES rewards(id)
    );

    CREATE TABLE IF NOT EXISTS product_returns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mechanic_id INTEGER NOT NULL,
      purchase_id INTEGER NOT NULL,
      return_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      items_summary TEXT NOT NULL,
      points_reversed INTEGER NOT NULL,
      points_under_recovery INTEGER NOT NULL DEFAULT 0,
      prev_balance INTEGER NOT NULL,
      new_balance INTEGER NOT NULL,
      reason TEXT NOT NULL,
      status TEXT DEFAULT 'Completed',
      processed_by TEXT NOT NULL,
      audit_flag INTEGER DEFAULT 0,
      FOREIGN KEY(mechanic_id) REFERENCES mechanics(id),
      FOREIGN KEY(purchase_id) REFERENCES purchases(id)
    );

    CREATE TABLE IF NOT EXISTS point_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mechanic_id INTEGER NOT NULL,
      type TEXT NOT NULL, -- PURCHASE_APPROVED, MANUAL_ADJUSTMENT, REWARD_REDEMPTION, PRODUCT_RETURN, RECOVERY, REFUND
      reference_id INTEGER,
      points INTEGER NOT NULL,
      description TEXT NOT NULL,
      balance_after INTEGER NOT NULL,
      created_by TEXT DEFAULT 'System',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      reason TEXT,
      FOREIGN KEY(mechanic_id) REFERENCES mechanics(id)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      actor_name TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT,
      ip_address TEXT,
      user_agent TEXT
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mechanic_id INTEGER NOT NULL DEFAULT 0, -- 0 for Admin / All Auditors
      message TEXT NOT NULL,
      is_read INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Safe schema migration for product_returns extra columns
  const migrationCols = [
    'replacement_summary TEXT',
    'original_amount REAL',
    'returned_value REAL',
    'replacement_value REAL',
    'updated_net_amount REAL',
    'points_change INTEGER'
  ];
  for (const col of migrationCols) {
    try {
      db.exec(`ALTER TABLE product_returns ADD COLUMN ${col};`);
    } catch (e) {
      // Column already exists
    }
  }

  // Insert default settings if not exists
  const checkSettings = db.prepare("SELECT COUNT(*) as count FROM settings").get();
  if (checkSettings.count === 0) {
    const insertSetting = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
    insertSetting.run('points_rate_per_hundred', '3'); // 3 points per ₹100
    insertSetting.run('business_name', 'Mahaveer Traders');
    insertSetting.run('currency_symbol', '₹');
    insertSetting.run('allow_auditor_approval', '1');
  }

  // Seed default Users (Admin & Field Auditors)
  const checkUsers = db.prepare("SELECT COUNT(*) as count FROM users").get();
  if (checkUsers.count === 0) {
    const insertUser = db.prepare("INSERT INTO users (username, password, role, name, phone) VALUES (?, ?, ?, ?, ?)");
    insertUser.run('admin', 'admin123', 'admin', 'System Administrator', '9876500000');
    insertUser.run('audit1', 'audit123', 'auditor', 'Rohan (Mobile Auditor 1)', '9876500001');
    insertUser.run('audit2', 'audit123', 'auditor', 'Priya (Mobile Auditor 2)', '9876500002');
  }

  // Seed initial Mechanics if table is empty
  const checkMech = db.prepare("SELECT COUNT(*) as count FROM mechanics").get();
  if (checkMech.count === 0) {
    const insertMech = db.prepare(`
      INSERT INTO mechanics (uid, name, phone, address, trade_type, password, available_points, lifetime_points, recovery_points, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);

    const initialMechanics = [
      ['MEC1001', 'Rajesh Kumar', '9876510001', 'Gandhi Maidan, Patna', 'Plumber', 'mechanic123', 2450, 8750, 0],
      ['MEC1002', 'Amit Kumar', '9876510002', 'Boring Road, Patna', 'Carpenters', 'mechanic123', 3500, 5200, 0],
      ['MEC1003', 'Sunil Yadav', '9876510003', 'Kankarbagh, Patna', 'Painters', 'mechanic123', 900, 2100, 0],
      ['MEC1004', 'Manoj Singh', '9876510004', 'Bailey Road, Patna', 'Raj Mistri', 'mechanic123', 1200, 3300, 0],
      ['MEC1005', 'Deepak Rai', '9876510005', 'Station Road, Gaya', 'Tiles Mistri', 'mechanic123', 300, 700, 0],
      ['MEC1006', 'Vikash Jha', '9876510006', 'Zero Mile, Muzaffarpur', 'Others', 'mechanic123', 150, 400, 0]
    ];

    for (const m of initialMechanics) {
      const info = insertMech.run(...m);
      // Also register login user for mechanic
      const insertUser = db.prepare("INSERT INTO users (username, password, role, name, phone, mechanic_id) VALUES (?, ?, ?, ?, ?, ?)");
      insertUser.run(m[0], m[5], 'mechanic', m[1], m[2], Number(info.lastInsertRowid));
    }
  }

  // Seed Products
  const checkProd = db.prepare("SELECT COUNT(*) as count FROM products").get();
  if (checkProd.count === 0) {
    const insertProd = db.prepare("INSERT INTO products (name, category, unit, is_active) VALUES (?, ?, ?, 1)");
    const prods = [
      ['Cement 50kg', 'Building Materials', 'Bag'],
      ['PVC Pipe 4-inch', 'Plumbing', 'Piece'],
      ['Wall Putty 40kg', 'Paint & Finishes', 'KG'],
      ['Exterior Acrylic Paint', 'Paint & Finishes', 'Litre'],
      ['Vitrified Floor Tiles (2x2)', 'Flooring', 'Box'],
      ['Commercial Plywood 18mm', 'Wood & Carpentry', 'Piece'],
      ['Brass Basin Tap Set', 'Plumbing', 'Set'],
      ['Waterproofing Chemical', 'Chemicals', 'Litre']
    ];
    for (const p of prods) {
      insertProd.run(...p);
    }
  }

  // Seed Rewards
  const checkRew = db.prepare("SELECT COUNT(*) as count FROM rewards").get();
  if (checkRew.count === 0) {
    const insertRew = db.prepare("INSERT INTO rewards (name, points_required, stock, eligible_types, is_active) VALUES (?, ?, ?, ?, 1)");
    const rewards = [
      ['Professional Plumbing Toolkit (35 Pcs)', 3000, 8, JSON.stringify(['Plumber'])],
      ['Heavy Duty Airless Paint Sprayer', 2500, 6, JSON.stringify(['Painters'])],
      ['Electric Wood Planer & Cutter Kit', 3000, 5, JSON.stringify(['Carpenters'])],
      ['Laser Tile Leveling Tool Kit', 2800, 4, JSON.stringify(['Tiles Mistri'])],
      ['Instant Digital Shopping Voucher ₹1,000', 1500, 25, JSON.stringify(['all'])],
      ['Branded Safety Gear & Work Uniform', 800, 40, JSON.stringify(['all'])]
    ];
    for (const r of rewards) {
      insertRew.run(...r);
    }
  }

  // Seed sample purchases if empty
  const checkPur = db.prepare("SELECT COUNT(*) as count FROM purchases").get();
  if (checkPur.count === 0) {
    const insertPur = db.prepare(`
      INSERT INTO purchases (mechanic_id, purchase_date, customer_name, customer_phone, customer_address, total_amount, bill_file_url, status, points_awarded, approved_date, verified_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertItem = db.prepare(`
      INSERT INTO purchase_items (purchase_id, product_id, product_name, quantity, unit, points_allocated, returned_quantity)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    // Sample 1: Pending verification
    const p1 = insertPur.run(1, '2026-09-22', 'Amit Verma', '9900000001', 'Flat 402, Shanti Vihar, Patna', 5000, '', 'PENDING', null, null, null);
    insertItem.run(Number(p1.lastInsertRowid), 2, 'PVC Pipe 4-inch', 8, 'Piece', 0, 0);

    // Sample 2: Pending verification
    const p2 = insertPur.run(1, '2026-09-23', 'Ravi Das', '9900000002', 'Bypass Road, Gaya', 3200, '', 'PENDING', null, null, null);
    insertItem.run(Number(p2.lastInsertRowid), 7, 'Brass Basin Tap Set', 4, 'Set', 0, 0);

    // Sample 3: Approved purchase
    const p3 = insertPur.run(1, '2026-09-15', 'Amit Kumar', '9900000003', 'Sector 3, Danapur, Patna', 12500, '', 'APPROVED', 250, '2026-09-15', 'System Administrator');
    insertItem.run(Number(p3.lastInsertRowid), 1, 'Cement 50kg', 10, 'Bag', 100, 0);
    insertItem.run(Number(p3.lastInsertRowid), 2, 'PVC Pipe 4-inch', 5, 'Piece', 50, 0);
    insertItem.run(Number(p3.lastInsertRowid), 3, 'Wall Putty 40kg', 20, 'KG', 100, 0);

    // Log transaction
    db.prepare(`
      INSERT INTO point_transactions (mechanic_id, type, reference_id, points, description, balance_after, created_by)
      VALUES (1, 'PURCHASE_APPROVED', ?, 250, 'Purchase Approved (12,500 INR)', 2450, 'Admin')
    `).run(Number(p3.lastInsertRowid));

    // Sample 4: Pending from another mechanic
    const p4 = insertPur.run(3, '2026-09-24', 'Suresh Pal', '9900000004', 'Near Hanuman Mandir, Patna', 6000, '', 'PENDING', null, null, null);
    insertItem.run(Number(p4.lastInsertRowid), 4, 'Exterior Acrylic Paint', 12, 'Litre', 0, 0);
  }
}

initDatabase();

module.exports = {
  db,
  initDatabase
};
