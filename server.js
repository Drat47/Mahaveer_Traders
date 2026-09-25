const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { db, initDatabase } = require('./database.js');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Ensure directories exist
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

// Active in-memory token store: token -> user
const sessions = new Map();

// Helper: Get local network IPv4 addresses
function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        addresses.push({ interface: name, address: net.address });
      }
    }
  }
  return addresses;
}

// Helper: Get client IP address
function getClientIp(req) {
  return (
    req.headers['x-forwarded-for'] ||
    req.socket.remoteAddress ||
    '127.0.0.1'
  ).replace('::ffff:', '');
}

// Helper: Log audit action
function logAudit(actorName, actorRole, action, details, req) {
  try {
    const ip = req ? getClientIp(req) : 'system';
    const ua = req ? (req.headers['user-agent'] || 'Unknown Device') : 'internal';
    const stmt = db.prepare(`
      INSERT INTO audit_logs (actor_name, actor_role, action, details, ip_address, user_agent)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(actorName, actorRole, action, typeof details === 'string' ? details : JSON.stringify(details), ip, ua);
  } catch (err) {
    console.error('Failed to log audit:', err);
  }
}

// Helper: Add Notification
function addNotification(mechanicId, message) {
  try {
    db.prepare("INSERT INTO notifications (mechanic_id, message) VALUES (?, ?)").run(mechanicId, message);
  } catch (e) {
    console.error('Notification error:', e);
  }
}

// Helper: Points Ledger Transaction
function recordLedger(mechanicId, type, refId, points, desc, createdBy, reason) {
  const mech = db.prepare("SELECT available_points FROM mechanics WHERE id = ?").get(mechanicId);
  if (!mech) return;
  const newBal = mech.available_points + points;
  db.prepare("UPDATE mechanics SET available_points = ? WHERE id = ?").run(newBal, mechanicId);
  db.prepare(`
    INSERT INTO point_transactions (mechanic_id, type, reference_id, points, description, balance_after, created_by, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(mechanicId, type, refId, points, desc, newBal, createdBy, reason || null);
}

// Helper: Credit Points with automatic Pending Recovery adjustment
function creditPoints(mechanicId, points, type, refId, desc, actorName) {
  const mech = db.prepare("SELECT * FROM mechanics WHERE id = ?").get(mechanicId);
  if (!mech) return;

  // Add to lifetime points
  db.prepare("UPDATE mechanics SET lifetime_points = lifetime_points + ? WHERE id = ?").run(points, mechanicId);
  
  // Record the main credit in ledger
  recordLedger(mechanicId, type, refId, points, desc, actorName);

  // If there are recovery points pending from past returns, deduct them automatically
  if (mech.recovery_points > 0) {
    const recoverAmount = Math.min(mech.recovery_points, points);
    if (recoverAmount > 0) {
      db.prepare("UPDATE mechanics SET recovery_points = recovery_points - ? WHERE id = ?").run(recoverAmount, mechanicId);
      recordLedger(mechanicId, 'RECOVERY', refId, -recoverAmount, `Auto-recovery applied towards past returned product points`, 'System');
      addNotification(mechanicId, `System auto-recovered ${recoverAmount} pts against your pending recovery balance.`);
    }
  }
}

// Helper: Parse Request JSON Body
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 25 * 1024 * 1024) { // 25MB max limit for high-res bill photos
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Helper: Authenticate request via Bearer token
function authenticate(req) {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.substring(7).trim();
  return sessions.get(token) || null;
}

// MIME types
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.ico': 'image/x-icon',
  '.csv': 'text/csv; charset=utf-8'
};

// HTTP Server
const server = http.createServer(async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // JSON helper
  const sendJson = (data, statusCode = 200) => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  };

  const sendError = (message, statusCode = 400) => {
    sendJson({ error: message, success: false }, statusCode);
  };

  try {
    /* =========================================================================
       API ROUTES
       ========================================================================= */

    // 1. Network Information & Mobile Pairing Info
    if (pathname === '/api/system/network-info' && req.method === 'GET') {
      const ips = getLocalIpAddresses();
      const settings = {};
      const allSettings = db.prepare("SELECT key, value FROM settings").all();
      for (const s of allSettings) settings[s.key] = s.value;

      return sendJson({
        port: PORT,
        localIps: ips,
        mobileUrls: ips.map(i => `http://${i.address}:${PORT}`),
        primaryUrl: ips.length > 0 ? `http://${ips[0].address}:${PORT}` : `http://localhost:${PORT}`,
        settings
      });
    }

    // 2. Auth: Login
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      const { username, password } = body;

      if (!username || !password) {
        return sendError('Username and password are required', 400);
      }

      const user = db.prepare("SELECT * FROM users WHERE username = ? AND password = ? AND is_active = 1").get(username.trim(), password);
      if (!user) {
        return sendError('Invalid username or password', 401);
      }

      let mechanic = null;
      if (user.role === 'mechanic' && user.mechanic_id) {
        mechanic = db.prepare("SELECT * FROM mechanics WHERE id = ?").get(user.mechanic_id);
      }

      const token = crypto.randomBytes(32).toString('hex');
      const sessionUser = {
        id: user.id,
        username: user.username,
        role: user.role,
        name: user.name,
        phone: user.phone,
        mechanicId: user.mechanic_id,
        mechanic: mechanic
      };

      sessions.set(token, sessionUser);
      logAudit(user.name, user.role, 'User Login', `Logged in from ${getClientIp(req)}`, req);

      return sendJson({
        success: true,
        token,
        user: sessionUser
      });
    }

    // 3. Auth: Current User
    if (pathname === '/api/auth/me' && req.method === 'GET') {
      const user = authenticate(req);
      if (!user) return sendError('Unauthorized', 401);
      
      // Refresh mechanic points if role is mechanic
      if (user.role === 'mechanic' && user.mechanicId) {
        user.mechanic = db.prepare("SELECT * FROM mechanics WHERE id = ?").get(user.mechanicId);
      }
      return sendJson({ user });
    }

    // 4. Auth: Logout
    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      const authHeader = req.headers['authorization'] || '';
      if (authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7).trim();
        const user = sessions.get(token);
        if (user) {
          logAudit(user.name, user.role, 'User Logout', 'Logged out', req);
          sessions.delete(token);
        }
      }
      return sendJson({ success: true });
    }

    // 5. Dashboard Summary Metrics
    if (pathname === '/api/dashboard/stats' && req.method === 'GET') {
      const totalMechanics = db.prepare("SELECT COUNT(*) as count FROM mechanics").get().count;
      const activeMechanics = db.prepare("SELECT COUNT(*) as count FROM mechanics WHERE is_active = 1").get().count;
      
      const pendingBills = db.prepare("SELECT COUNT(*) as count FROM purchases WHERE status = 'PENDING'").get().count;
      const approvedBills = db.prepare("SELECT COUNT(*) as count FROM purchases WHERE status = 'APPROVED'").get().count;
      const rejectedBills = db.prepare("SELECT COUNT(*) as count FROM purchases WHERE status = 'REJECTED'").get().count;
      const correctionBills = db.prepare("SELECT COUNT(*) as count FROM purchases WHERE status = 'CORRECTION'").get().count;
      
      const purchaseValue = db.prepare("SELECT SUM(total_amount) as total FROM purchases WHERE status = 'APPROVED'").get().total || 0;
      const pointsIssued = db.prepare("SELECT SUM(points) as total FROM point_transactions WHERE points > 0").get().total || 0;
      const pointsRedeemed = db.prepare("SELECT SUM(points) as total FROM redemptions WHERE status = 'Approved'").get().total || 0;
      const pendingRedemptions = db.prepare("SELECT COUNT(*) as count FROM redemptions WHERE status = 'Pending'").get().count;
      
      const returnsCount = db.prepare("SELECT COUNT(*) as count FROM product_returns").get().count;
      const pointsReversed = db.prepare("SELECT SUM(points_reversed) as total FROM product_returns").get().total || 0;
      const pendingRecovery = db.prepare("SELECT SUM(recovery_points) as total FROM mechanics").get().total || 0;

      // Category / Trade Breakdown
      const tradeBreakdown = db.prepare(`
        SELECT 
          m.trade_type as type,
          COUNT(DISTINCT m.id) as mechanics_count,
          COUNT(p.id) as purchases_count,
          COALESCE(SUM(CASE WHEN p.status = 'APPROVED' THEN p.total_amount ELSE 0 END), 0) as approved_value,
          COALESCE(SUM(CASE WHEN p.status = 'PENDING' THEN 1 ELSE 0 END), 0) as pending_bills,
          COALESCE(SUM(m.lifetime_points), 0) as total_points
        FROM mechanics m
        LEFT JOIN purchases p ON m.id = p.mechanic_id
        GROUP BY m.trade_type
      `).all();

      return sendJson({
        totalMechanics,
        activeMechanics,
        pendingBills,
        approvedBills,
        rejectedBills,
        correctionBills,
        purchaseValue,
        pointsIssued,
        pointsRedeemed,
        pendingRedemptions,
        returnsCount,
        pointsReversed,
        pendingRecovery,
        tradeBreakdown
      });
    }

    // 6. Mechanics List & Add
    if (pathname === '/api/mechanics' && req.method === 'GET') {
      const type = parsedUrl.searchParams.get('type') || '';
      const search = (parsedUrl.searchParams.get('search') || '').toLowerCase().trim();

      let query = "SELECT * FROM mechanics WHERE 1=1";
      const params = [];
      if (type) {
        query += " AND trade_type = ?";
        params.push(type);
      }
      if (search) {
        query += " AND (LOWER(name) LIKE ? OR LOWER(phone) LIKE ? OR LOWER(address) LIKE ? OR LOWER(uid) LIKE ?)";
        const s = `%${search}%`;
        params.push(s, s, s, s);
      }
      query += " ORDER BY id DESC";

      const mechanics = db.prepare(query).all(...params);
      // Attach pending bills count to each mechanic
      for (const m of mechanics) {
        const pCount = db.prepare("SELECT COUNT(*) as count FROM purchases WHERE mechanic_id = ? AND status = 'PENDING'").get(m.id);
        m.pending_bills_count = pCount.count;
      }

      return sendJson({ mechanics });
    }

    if (pathname === '/api/mechanics' && req.method === 'POST') {
      const user = authenticate(req);
      if (!user || (user.role !== 'admin' && user.role !== 'auditor')) return sendError('Forbidden', 403);

      const body = await parseJsonBody(req);
      const { name, phone, address, trade_type, uid, password } = body;

      if (!name || !phone || !address || !trade_type || !uid || !password) {
        return sendError('All fields are required', 400);
      }

      const existing = db.prepare("SELECT id FROM mechanics WHERE uid = ? OR phone = ?").get(uid.trim(), phone.trim());
      if (existing) {
        return sendError('A mechanic with this User ID or Phone already exists', 400);
      }

      const stmt = db.prepare(`
        INSERT INTO mechanics (uid, name, phone, address, trade_type, password, available_points, lifetime_points, recovery_points, is_active)
        VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 1)
      `);
      const result = stmt.run(uid.trim(), name.trim(), phone.trim(), address.trim(), trade_type.trim(), password.trim());
      const mechId = Number(result.lastInsertRowid);

      // Create user login entry
      db.prepare("INSERT INTO users (username, password, role, name, phone, mechanic_id) VALUES (?, ?, 'mechanic', ?, ?, ?)")
        .run(uid.trim(), password.trim(), name.trim(), phone.trim(), mechId);

      logAudit(user.name, user.role, 'Add Mechanic', `Registered new mechanic ${name} (${uid})`, req);
      return sendJson({ success: true, id: mechId, message: 'Mechanic registered successfully' });
    }

    // Single Mechanic Details & Ledger
    const mechMatch = pathname.match(/^\/api\/mechanics\/(\d+)$/);
    if (mechMatch && req.method === 'GET') {
      const id = parseInt(mechMatch[1], 10);
      const mech = db.prepare("SELECT * FROM mechanics WHERE id = ?").get(id);
      if (!mech) return sendError('Mechanic not found', 404);

      const purchases = db.prepare("SELECT * FROM purchases WHERE mechanic_id = ? ORDER BY id DESC").all(id);
      for (const p of purchases) {
        p.items = db.prepare("SELECT * FROM purchase_items WHERE purchase_id = ?").all(p.id);
      }

      const ledger = db.prepare("SELECT * FROM point_transactions WHERE mechanic_id = ? ORDER BY id DESC").all(id);
      const pendingBillsCount = db.prepare("SELECT COUNT(*) as count FROM purchases WHERE mechanic_id = ? AND status = 'PENDING'").get(id).count;

      return sendJson({ mechanic: mech, purchases, ledger, pendingBillsCount });
    }

    // Toggle Mechanic Status
    const mechStatusMatch = pathname.match(/^\/api\/mechanics\/(\d+)\/status$/);
    if (mechStatusMatch && req.method === 'PATCH') {
      const user = authenticate(req);
      if (!user || user.role !== 'admin') return sendError('Forbidden', 403);
      const id = parseInt(mechStatusMatch[1], 10);
      const mech = db.prepare("SELECT * FROM mechanics WHERE id = ?").get(id);
      if (!mech) return sendError('Mechanic not found', 404);

      const newStatus = mech.is_active ? 0 : 1;
      db.prepare("UPDATE mechanics SET is_active = ? WHERE id = ?").run(newStatus, id);
      db.prepare("UPDATE users SET is_active = ? WHERE mechanic_id = ?").run(newStatus, id);
      logAudit(user.name, user.role, 'Toggle Mechanic Status', `${mech.name} set to ${newStatus ? 'Active' : 'Inactive'}`, req);

      return sendJson({ success: true, is_active: newStatus });
    }

    // Manual Adjust Points
    const mechAdjustMatch = pathname.match(/^\/api\/mechanics\/(\d+)\/adjust-points$/);
    if (mechAdjustMatch && req.method === 'POST') {
      const user = authenticate(req);
      if (!user || user.role !== 'admin') return sendError('Forbidden', 403);
      const id = parseInt(mechAdjustMatch[1], 10);
      const body = await parseJsonBody(req);
      const { points, reason } = body;

      const pts = parseInt(points, 10);
      if (isNaN(pts) || pts === 0) return sendError('Valid points amount required', 400);

      const mech = db.prepare("SELECT * FROM mechanics WHERE id = ?").get(id);
      if (!mech) return sendError('Mechanic not found', 404);

      if (pts < 0 && mech.available_points + pts < 0) {
        return sendError(`Insufficient points. Mechanic has ${mech.available_points} available.`, 400);
      }

      if (pts > 0) {
        creditPoints(id, pts, 'MANUAL_ADJUSTMENT', null, `Manual Adjustment: ${reason || 'Admin Adjustment'}`, user.name);
      } else {
        recordLedger(id, 'MANUAL_ADJUSTMENT', null, pts, `Manual Deduction: ${reason || 'Admin Adjustment'}`, user.name, reason);
      }

      addNotification(id, `Your points balance was manually adjusted by ${pts > 0 ? '+' : ''}${pts}. Reason: ${reason || 'Admin adjustment'}`);
      logAudit(user.name, user.role, 'Manual Point Adjustment', `Adjusted ${pts} pts for ${mech.name} (${mech.uid}). Reason: ${reason}`, req);

      const updated = db.prepare("SELECT * FROM mechanics WHERE id = ?").get(id);
      return sendJson({ success: true, mechanic: updated });
    }

    // 7. Purchases List & Submission
    if (pathname === '/api/purchases' && req.method === 'GET') {
      const user = authenticate(req);
      if (!user) return sendError('Unauthorized', 401);

      const status = parsedUrl.searchParams.get('status') || '';
      const mechanicId = parsedUrl.searchParams.get('mechanicId');
      const search = (parsedUrl.searchParams.get('search') || '').toLowerCase().trim();

      let query = `
        SELECT p.*, m.name as mechanic_name, m.phone as mechanic_phone, m.trade_type, m.uid as mechanic_uid
        FROM purchases p
        JOIN mechanics m ON p.mechanic_id = m.id
        WHERE 1=1
      `;
      const params = [];

      // If user is mechanic, only show their purchases
      if (user.role === 'mechanic') {
        query += " AND p.mechanic_id = ?";
        params.push(user.mechanicId);
      } else if (mechanicId) {
        query += " AND p.mechanic_id = ?";
        params.push(parseInt(mechanicId, 10));
      }

      if (status) {
        query += " AND p.status = ?";
        params.push(status);
      }

      if (search) {
        query += " AND (LOWER(m.name) LIKE ? OR LOWER(p.customer_name) LIKE ? OR LOWER(p.customer_phone) LIKE ? OR LOWER(p.customer_address) LIKE ? OR LOWER(m.uid) LIKE ?)";
        const s = `%${search}%`;
        params.push(s, s, s, s, s);
      }

      query += " ORDER BY p.id DESC";
      const purchases = db.prepare(query).all(...params);

      // Attach items to each purchase
      for (const p of purchases) {
        p.items = db.prepare("SELECT * FROM purchase_items WHERE purchase_id = ?").all(p.id);
      }

      return sendJson({ purchases });
    }

    // Submit Purchase (Mechanic self-submission OR Field Auditor on-site submission)
    if (pathname === '/api/purchases' && req.method === 'POST') {
      const user = authenticate(req);
      if (!user) return sendError('Unauthorized', 401);

      const body = await parseJsonBody(req);
      const {
        mechanicId,
        purchaseDate,
        customerName,
        customerPhone,
        customerAddress,
        totalAmount,
        billFileUrl,
        items
      } = body;

      const targetMechId = user.role === 'mechanic' ? user.mechanicId : parseInt(mechanicId, 10);
      if (!targetMechId) return sendError('Mechanic ID is required', 400);

      if (!purchaseDate || !customerName || !customerPhone || !customerAddress || !totalAmount) {
        return sendError('Please complete all customer and purchase details', 400);
      }

      if (!items || !Array.isArray(items) || items.length === 0) {
        return sendError('At least one product item is required', 400);
      }

      const amt = parseFloat(totalAmount);
      if (isNaN(amt) || amt <= 0) return sendError('Valid total amount is required', 400);

      // Duplicate check (same mechanic, date, phone, amount within last 30 days)
      const duplicate = db.prepare(`
        SELECT id FROM purchases 
        WHERE mechanic_id = ? AND purchase_date = ? AND customer_phone = ? AND total_amount = ? AND status != 'REJECTED'
      `).get(targetMechId, purchaseDate, customerPhone.trim(), amt);

      if (duplicate && !body.allowDuplicateConfirmation) {
        return sendJson({
          potentialDuplicate: true,
          duplicatePurchaseId: duplicate.id,
          message: 'A similar purchase was already submitted with this date, customer phone, and amount. Please verify if this is duplicate.'
        }, 409);
      }

      const insertPur = db.prepare(`
        INSERT INTO purchases (mechanic_id, purchase_date, customer_name, customer_phone, customer_address, total_amount, bill_file_url, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING')
      `);

      const result = insertPur.run(
        targetMechId,
        purchaseDate,
        customerName.trim(),
        customerPhone.trim(),
        customerAddress.trim(),
        amt,
        billFileUrl || ''
      );

      const purId = Number(result.lastInsertRowid);
      const insertItem = db.prepare(`
        INSERT INTO purchase_items (purchase_id, product_id, product_name, quantity, unit, points_allocated, returned_quantity)
        VALUES (?, ?, ?, ?, ?, 0, 0)
      `);

      for (const it of items) {
        insertItem.run(purId, it.productId || null, it.productName, parseFloat(it.quantity) || 1, it.unit || 'Unit');
      }

      const mech = db.prepare("SELECT name, uid FROM mechanics WHERE id = ?").get(targetMechId);
      addNotification(targetMechId, `Purchase submitted successfully on ${purchaseDate} for ₹${amt.toLocaleString('en-IN')}. Pending verification.`);
      addNotification(0, `New bill submitted by ${mech.name} (${mech.uid}) for ₹${amt.toLocaleString('en-IN')}. Awaiting audit verification.`);
      logAudit(user.name, user.role, 'Submit Purchase', `Submitted Bill #${purId} for Mechanic ${mech.name} (Amount: ₹${amt})`, req);

      return sendJson({ success: true, purchaseId: purId, message: 'Purchase submitted for verification' });
    }

    // Single Purchase Detail
    const purMatch = pathname.match(/^\/api\/purchases\/(\d+)$/);
    if (purMatch && req.method === 'GET') {
      const user = authenticate(req);
      if (!user) return sendError('Unauthorized', 401);

      const id = parseInt(purMatch[1], 10);
      const purchase = db.prepare(`
        SELECT p.*, m.name as mechanic_name, m.phone as mechanic_phone, m.trade_type, m.uid as mechanic_uid, m.available_points, m.recovery_points
        FROM purchases p
        JOIN mechanics m ON p.mechanic_id = m.id
        WHERE p.id = ?
      `).get(id);

      if (!purchase) return sendError('Purchase not found', 404);
      if (user.role === 'mechanic' && user.mechanicId !== purchase.mechanic_id) {
        return sendError('Forbidden', 403);
      }

      purchase.items = db.prepare("SELECT * FROM purchase_items WHERE purchase_id = ?").all(id);
      return sendJson({ purchase });
    }

    // 8. Purchase Verification / Auditing Action (Approve / Reject / Correction)
    const purVerifyMatch = pathname.match(/^\/api\/purchases\/(\d+)\/verify$/);
    if (purVerifyMatch && req.method === 'POST') {
      const user = authenticate(req);
      if (!user || (user.role !== 'admin' && user.role !== 'auditor')) return sendError('Forbidden', 403);

      const id = parseInt(purVerifyMatch[1], 10);
      const body = await parseJsonBody(req);
      const { action, points, reason, message } = body;

      const purchase = db.prepare("SELECT * FROM purchases WHERE id = ?").get(id);
      if (!purchase) return sendError('Purchase not found', 404);
      if (purchase.status === 'APPROVED') return sendError('This purchase is already approved', 400);

      const mech = db.prepare("SELECT * FROM mechanics WHERE id = ?").get(purchase.mechanic_id);

      if (action === 'APPROVE') {
        const pts = parseInt(points, 10);
        if (isNaN(pts) || pts < 0) return sendError('Valid points required for approval', 400);

        const items = db.prepare("SELECT * FROM purchase_items WHERE purchase_id = ?").all(id);
        const count = items.length;
        // Evenly allocate points across items for accurate return calculation later
        const updateItem = db.prepare("UPDATE purchase_items SET points_allocated = ? WHERE id = ?");
        items.forEach((item, idx) => {
          const allocated = Math.floor(pts / count) + (idx < pts % count ? 1 : 0);
          updateItem.run(allocated, item.id);
        });

        const today = new Date().toISOString().slice(0, 10);
        db.prepare(`
          UPDATE purchases 
          SET status = 'APPROVED', points_awarded = ?, approved_date = ?, verified_by = ?, rejection_reason = NULL, correction_message = NULL
          WHERE id = ?
        `).run(pts, today, user.name, id);

        creditPoints(purchase.mechanic_id, pts, 'PURCHASE_APPROVED', id, `Purchase Approved (Bill #${id}, ₹${purchase.total_amount.toLocaleString('en-IN')})`, user.name);

        addNotification(purchase.mechanic_id, `Your purchase (Bill #${id} - ₹${purchase.total_amount.toLocaleString('en-IN')}) was approved! You earned +${pts} points.`);
        logAudit(user.name, user.role, 'Approve Purchase', `Approved Bill #${id} for ${mech.name} (+${pts} pts)`, req);

        return sendJson({ success: true, status: 'APPROVED', points: pts });
      }

      if (action === 'REJECT') {
        if (!reason || !reason.trim()) return sendError('Rejection reason is required for audit trail', 400);

        db.prepare(`
          UPDATE purchases 
          SET status = 'REJECTED', rejection_reason = ?, verified_by = ?
          WHERE id = ?
        `).run(reason.trim(), user.name, id);

        addNotification(purchase.mechanic_id, `Purchase #${id} was rejected during audit. Reason: ${reason.trim()}`);
        logAudit(user.name, user.role, 'Reject Purchase', `Rejected Bill #${id} for ${mech.name}. Reason: ${reason.trim()}`, req);

        return sendJson({ success: true, status: 'REJECTED' });
      }

      if (action === 'CORRECTION') {
        if (!message || !message.trim()) return sendError('Correction message is required', 400);

        db.prepare(`
          UPDATE purchases 
          SET status = 'CORRECTION', correction_message = ?, verified_by = ?
          WHERE id = ?
        `).run(message.trim(), user.name, id);

        addNotification(purchase.mechanic_id, `Correction requested for Purchase #${id}: ${message.trim()}. Please update bill details.`);
        logAudit(user.name, user.role, 'Request Purchase Correction', `Correction requested for Bill #${id} (${mech.name}): ${message.trim()}`, req);

        return sendJson({ success: true, status: 'CORRECTION' });
      }

      return sendError('Invalid action. Use APPROVE, REJECT, or CORRECTION', 400);
    }

    // 9. Product Returns & Point Reversals
    const purReturnMatch = pathname.match(/^\/api\/purchases\/(\d+)\/return$/);
    if (purReturnMatch && req.method === 'POST') {
      const user = authenticate(req);
      if (!user || (user.role !== 'admin' && user.role !== 'auditor')) return sendError('Forbidden', 403);

      const id = parseInt(purReturnMatch[1], 10);
      const purchase = db.prepare("SELECT * FROM purchases WHERE id = ?").get(id);
      if (!purchase || purchase.status !== 'APPROVED') return sendError('Approved purchase required to process return', 400);

      const body = await parseJsonBody(req);
      const { returnedItems, reason } = body;

      if (!reason || !reason.trim()) return sendError('Return reason is mandatory for audit', 400);
      if (!returnedItems || !Array.isArray(returnedItems) || returnedItems.length === 0) {
        return sendError('Select items to return', 400);
      }

      const itemsInDb = db.prepare("SELECT * FROM purchase_items WHERE purchase_id = ?").all(id);
      let totalPointsToReverse = 0;
      const processedItemsSummary = [];

      for (const ret of returnedItems) {
        const item = itemsInDb.find(i => i.id === ret.itemId);
        if (!item) continue;
        const retQty = parseFloat(ret.returnedQuantity) || 0;
        if (retQty <= 0) continue;

        const maxAllowed = item.quantity - item.returned_quantity;
        if (retQty > maxAllowed) {
          return sendError(`Return quantity for ${item.product_name} exceeds remaining available quantity (${maxAllowed})`, 400);
        }

        // Calculate proportional points based on ORIGINAL allocated points for this line item
        const itemPointsToReverse = Math.round(item.points_allocated * (retQty / item.quantity));
        totalPointsToReverse += itemPointsToReverse;

        // Update returned quantity in DB
        db.prepare("UPDATE purchase_items SET returned_quantity = returned_quantity + ? WHERE id = ?").run(retQty, item.id);
        processedItemsSummary.push(`${item.product_name} (${retQty} ${item.unit})`);
      }

      if (processedItemsSummary.length === 0) {
        return sendError('No valid items returned', 400);
      }

      const mech = db.prepare("SELECT * FROM mechanics WHERE id = ?").get(purchase.mechanic_id);
      const prevBal = mech.available_points;
      const immediateDeduction = Math.min(prevBal, totalPointsToReverse);
      const pendingRecovery = totalPointsToReverse - immediateDeduction;

      // Update mechanic points
      db.prepare(`
        UPDATE mechanics 
        SET available_points = available_points - ?, recovery_points = recovery_points + ?
        WHERE id = ?
      `).run(immediateDeduction, pendingRecovery, mech.id);

      const newBal = prevBal - immediateDeduction;

      // Record point transaction
      db.prepare(`
        INSERT INTO point_transactions (mechanic_id, type, reference_id, points, description, balance_after, created_by, reason)
        VALUES (?, 'PRODUCT_RETURN', ?, ?, ?, ?, ?, ?)
      `).run(
        mech.id,
        purchase.id,
        -immediateDeduction,
        `Points reversed for returned items on Bill #${purchase.id}${pendingRecovery > 0 ? ` (${pendingRecovery} under recovery)` : ''}`,
        newBal,
        user.name,
        reason
      );

      // Check if there is an active pending redemption conflict
      const hasPendingRedemption = db.prepare("SELECT COUNT(*) as count FROM redemptions WHERE mechanic_id = ? AND status = 'Pending'").get(mech.id).count > 0;
      const auditFlag = pendingRecovery > 0 && hasPendingRedemption ? 1 : 0;

      // Insert product return record
      db.prepare(`
        INSERT INTO product_returns (mechanic_id, purchase_id, items_summary, points_reversed, points_under_recovery, prev_balance, new_balance, reason, status, processed_by, audit_flag)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        mech.id,
        purchase.id,
        processedItemsSummary.join(', '),
        totalPointsToReverse,
        pendingRecovery,
        prevBal,
        newBal,
        reason.trim(),
        pendingRecovery > 0 ? 'Partially Recovered' : 'Completed',
        user.name,
        auditFlag
      );

      addNotification(mech.id, `${immediateDeduction} points reversed due to returned items from Bill #${purchase.id}. Reason: ${reason}.` + (pendingRecovery > 0 ? ` Note: ${pendingRecovery} points pending recovery will be deducted from your next purchases.` : ''));
      if (auditFlag) {
        addNotification(0, `AUDIT WARNING: Reversal exceeds balance for ${mech.name} who has a pending redemption.`);
      }

      logAudit(user.name, user.role, 'Process Product Return', `Reversed ${totalPointsToReverse} pts on Bill #${purchase.id} for ${mech.name}. Items: ${processedItemsSummary.join(', ')}. Reason: ${reason}`, req);

      return sendJson({
        success: true,
        pointsReversed: totalPointsToReverse,
        immediateDeduction,
        pendingRecovery,
        newBalance: newBal
      });
    }

    // 10. Product Returns List
    if (pathname === '/api/returns' && req.method === 'GET') {
      const user = authenticate(req);
      if (!user) return sendError('Unauthorized', 401);

      const returns = db.prepare(`
        SELECT r.*, m.name as mechanic_name, m.phone as mechanic_phone, m.trade_type, p.customer_name, p.purchase_date
        FROM product_returns r
        JOIN mechanics m ON r.mechanic_id = m.id
        JOIN purchases p ON r.purchase_id = p.id
        ORDER BY r.id DESC
      `).all();

      return sendJson({ returns });
    }

    // 11. Products Catalog API
    if (pathname === '/api/products' && req.method === 'GET') {
      const products = db.prepare("SELECT * FROM products ORDER BY name ASC").all();
      return sendJson({ products });
    }

    if (pathname === '/api/products' && req.method === 'POST') {
      const user = authenticate(req);
      if (!user || user.role !== 'admin') return sendError('Forbidden', 403);
      const body = await parseJsonBody(req);
      const { name, category, unit } = body;
      if (!name || !unit) return sendError('Product name and unit are required', 400);

      const result = db.prepare("INSERT INTO products (name, category, unit, is_active) VALUES (?, ?, ?, 1)")
        .run(name.trim(), category ? category.trim() : 'General', unit.trim());
      
      logAudit(user.name, user.role, 'Add Product', `Added product ${name}`, req);
      return sendJson({ success: true, id: Number(result.lastInsertRowid) });
    }

    const prodToggleMatch = pathname.match(/^\/api\/products\/(\d+)\/toggle$/);
    if (prodToggleMatch && req.method === 'PATCH') {
      const user = authenticate(req);
      if (!user || user.role !== 'admin') return sendError('Forbidden', 403);
      const id = parseInt(prodToggleMatch[1], 10);
      const prod = db.prepare("SELECT * FROM products WHERE id = ?").get(id);
      if (!prod) return sendError('Product not found', 404);

      const newStatus = prod.is_active ? 0 : 1;
      db.prepare("UPDATE products SET is_active = ? WHERE id = ?").run(newStatus, id);
      return sendJson({ success: true, is_active: newStatus });
    }

    // 12. Rewards & Redemptions API
    if (pathname === '/api/rewards' && req.method === 'GET') {
      const rewards = db.prepare("SELECT * FROM rewards ORDER BY points_required ASC").all();
      for (const r of rewards) {
        try { r.eligible_types = JSON.parse(r.eligible_types); } catch (e) { r.eligible_types = ['all']; }
      }
      return sendJson({ rewards });
    }

    if (pathname === '/api/rewards' && req.method === 'POST') {
      const user = authenticate(req);
      if (!user || user.role !== 'admin') return sendError('Forbidden', 403);
      const body = await parseJsonBody(req);
      const { name, pointsRequired, stock, eligibleTypes } = body;

      if (!name || !pointsRequired) return sendError('Reward name and required points are required', 400);

      const typesJson = JSON.stringify(eligibleTypes && eligibleTypes.length ? eligibleTypes : ['all']);
      const result = db.prepare("INSERT INTO rewards (name, points_required, stock, eligible_types, is_active) VALUES (?, ?, ?, ?, 1)")
        .run(name.trim(), parseInt(pointsRequired, 10), parseInt(stock, 10) || 0, typesJson);

      logAudit(user.name, user.role, 'Add Reward', `Created reward ${name} for ${pointsRequired} pts`, req);
      return sendJson({ success: true, id: Number(result.lastInsertRowid) });
    }

    const rewToggleMatch = pathname.match(/^\/api\/rewards\/(\d+)\/toggle$/);
    if (rewToggleMatch && req.method === 'PATCH') {
      const user = authenticate(req);
      if (!user || user.role !== 'admin') return sendError('Forbidden', 403);
      const id = parseInt(rewToggleMatch[1], 10);
      const rew = db.prepare("SELECT * FROM rewards WHERE id = ?").get(id);
      if (!rew) return sendError('Reward not found', 404);

      const newStatus = rew.is_active ? 0 : 1;
      db.prepare("UPDATE rewards SET is_active = ? WHERE id = ?").run(newStatus, id);
      return sendJson({ success: true, is_active: newStatus });
    }

    // Redemptions List & Request
    if (pathname === '/api/redemptions' && req.method === 'GET') {
      const user = authenticate(req);
      if (!user) return sendError('Unauthorized', 401);

      let query = `
        SELECT r.*, m.name as mechanic_name, m.phone as mechanic_phone, m.trade_type, m.uid as mechanic_uid
        FROM redemptions r
        JOIN mechanics m ON r.mechanic_id = m.id
        WHERE 1=1
      `;
      const params = [];
      if (user.role === 'mechanic') {
        query += " AND r.mechanic_id = ?";
        params.push(user.mechanicId);
      }
      query += " ORDER BY r.id DESC";

      const redemptions = db.prepare(query).all(...params);
      return sendJson({ redemptions });
    }

    if (pathname === '/api/redemptions' && req.method === 'POST') {
      const user = authenticate(req);
      if (!user || user.role !== 'mechanic') return sendError('Only mechanics can redeem rewards', 403);

      const body = await parseJsonBody(req);
      const { rewardId } = body;
      const rid = parseInt(rewardId, 10);

      const rew = db.prepare("SELECT * FROM rewards WHERE id = ? AND is_active = 1").get(rid);
      if (!rew) return sendError('Reward not found or inactive', 404);
      if (rew.stock < 1) return sendError('Reward is currently out of stock', 400);

      const mech = db.prepare("SELECT * FROM mechanics WHERE id = ?").get(user.mechanicId);
      if (mech.available_points < rew.points_required) {
        return sendError(`Insufficient points. You need ${rew.points_required - mech.available_points} more points.`, 400);
      }

      // Check trade eligibility
      let el = ['all'];
      try { el = JSON.parse(rew.eligible_types); } catch (e) {}
      if (!el.includes('all') && !el.includes(mech.trade_type)) {
        return sendError('This reward is not available for your trade type', 400);
      }

      // Reserve points and decrement stock
      recordLedger(mech.id, 'REWARD_REDEMPTION', rid, -rew.points_required, `Points reserved for reward: ${rew.name}`, user.name);
      db.prepare("UPDATE rewards SET stock = stock - 1 WHERE id = ?").run(rid);

      const insertRed = db.prepare(`
        INSERT INTO redemptions (mechanic_id, reward_id, reward_name, points, status)
        VALUES (?, ?, ?, ?, 'Pending')
      `);
      const result = insertRed.run(mech.id, rid, rew.name, rew.points_required);

      addNotification(mech.id, `Redemption request submitted for "${rew.name}" (${rew.points_required} pts). Pending admin approval.`);
      addNotification(0, `New redemption request from ${mech.name}: ${rew.name}`);
      logAudit(user.name, user.role, 'Redemption Request', `Mechanic ${mech.name} requested ${rew.name} (${rew.points_required} pts)`, req);

      return sendJson({ success: true, redemptionId: Number(result.lastInsertRowid) });
    }

    const redDecideMatch = pathname.match(/^\/api\/redemptions\/(\d+)\/decide$/);
    if (redDecideMatch && req.method === 'POST') {
      const user = authenticate(req);
      if (!user || user.role !== 'admin') return sendError('Forbidden', 403);

      const id = parseInt(redDecideMatch[1], 10);
      const red = db.prepare("SELECT * FROM redemptions WHERE id = ?").get(id);
      if (!red || red.status !== 'Pending') return sendError('Pending redemption not found', 404);

      const body = await parseJsonBody(req);
      const { approve } = body;
      const today = new Date().toISOString().slice(0, 19).replace('T', ' ');

      if (approve) {
        db.prepare("UPDATE redemptions SET status = 'Approved', decided_by = ?, decided_at = ? WHERE id = ?")
          .run(user.name, today, id);
        addNotification(red.mechanic_id, `Your redemption for "${red.reward_name}" was approved! Prepare for delivery.`);
        logAudit(user.name, user.role, 'Approve Redemption', `Approved redemption #${id} (${red.reward_name})`, req);
      } else {
        // Refund reserved points and increment stock
        db.prepare("UPDATE redemptions SET status = 'Rejected', decided_by = ?, decided_at = ? WHERE id = ?")
          .run(user.name, today, id);
        recordLedger(red.mechanic_id, 'REFUND', id, red.points, `Reserved points refunded: ${red.reward_name}`, user.name);
        db.prepare("UPDATE rewards SET stock = stock + 1 WHERE id = ?").run(red.reward_id);
        addNotification(red.mechanic_id, `Your redemption for "${red.reward_name}" was rejected. ${red.points} points were refunded to your balance.`);
        logAudit(user.name, user.role, 'Reject Redemption', `Rejected redemption #${id} (${red.reward_name}) and refunded ${red.points} pts`, req);
      }

      return sendJson({ success: true, status: approve ? 'Approved' : 'Rejected' });
    }

    // 13. Audit Logs & CSV Export API
    if (pathname === '/api/audit-logs' && req.method === 'GET') {
      const user = authenticate(req);
      if (!user || (user.role !== 'admin' && user.role !== 'auditor')) return sendError('Forbidden', 403);

      const limit = parseInt(parsedUrl.searchParams.get('limit') || '100', 10);
      const logs = db.prepare("SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?").all(limit);
      return sendJson({ logs });
    }

    if (pathname === '/api/audit-logs/export-csv' && req.method === 'GET') {
      const logs = db.prepare("SELECT * FROM audit_logs ORDER BY id DESC").all();
      let csv = 'ID,Timestamp,Actor Name,Actor Role,Action,Details,IP Address,Device Info\n';
      for (const l of logs) {
        const row = [
          l.id,
          `"${(l.timestamp || '').replace(/"/g, '""')}"`,
          `"${(l.actor_name || '').replace(/"/g, '""')}"`,
          `"${(l.actor_role || '').replace(/"/g, '""')}"`,
          `"${(l.action || '').replace(/"/g, '""')}"`,
          `"${(l.details || '').replace(/"/g, '""')}"`,
          `"${(l.ip_address || '').replace(/"/g, '""')}"`,
          `"${(l.user_agent || '').replace(/"/g, '""')}"`
        ];
        csv += row.join(',') + '\n';
      }

      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="audit_logs_${Date.now()}.csv"`
      });
      res.end(csv);
      return;
    }

    if (pathname === '/api/reports/export-purchases-csv' && req.method === 'GET') {
      const purchases = db.prepare(`
        SELECT p.*, m.name as mechanic_name, m.phone as mechanic_phone, m.trade_type, m.uid as mechanic_uid
        FROM purchases p
        JOIN mechanics m ON p.mechanic_id = m.id
        ORDER BY p.id DESC
      `).all();

      let csv = 'Bill ID,Purchase Date,Mechanic UID,Mechanic Name,Trade Type,Customer Name,Customer Phone,Address,Total Amount,Status,Points Awarded,Verified By,Approved Date\n';
      for (const p of purchases) {
        const row = [
          p.id,
          `"${p.purchase_date}"`,
          `"${p.mechanic_uid}"`,
          `"${(p.mechanic_name || '').replace(/"/g, '""')}"`,
          `"${p.trade_type}"`,
          `"${(p.customer_name || '').replace(/"/g, '""')}"`,
          `"${p.customer_phone}"`,
          `"${(p.customer_address || '').replace(/"/g, '""')}"`,
          p.total_amount,
          p.status,
          p.points_awarded || 0,
          `"${(p.verified_by || '').replace(/"/g, '""')}"`,
          `"${p.approved_date || ''}"`
        ];
        csv += row.join(',') + '\n';
      }

      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="purchases_audit_report_${Date.now()}.csv"`
      });
      res.end(csv);
      return;
    }

    // 14. Notifications API
    if (pathname === '/api/notifications' && req.method === 'GET') {
      const user = authenticate(req);
      if (!user) return sendError('Unauthorized', 401);

      const targetId = user.role === 'mechanic' ? user.mechanicId : 0;
      const notifs = db.prepare("SELECT * FROM notifications WHERE mechanic_id = ? ORDER BY id DESC LIMIT 50").all(targetId);
      return sendJson({ notifications: notifs });
    }

    // 15. File Upload Handler (Mobile Camera Bill Photos / Receipts)
    if (pathname === '/api/upload' && req.method === 'POST') {
      const user = authenticate(req);
      if (!user) return sendError('Unauthorized', 401);

      const body = await parseJsonBody(req);
      const { dataUrl, filename } = body;

      if (!dataUrl || !dataUrl.includes(';base64,')) {
        return sendError('Valid Base64 image data URL required', 400);
      }

      const parts = dataUrl.split(';base64,');
      const mimeType = parts[0].replace('data:', '');
      const buffer = Buffer.from(parts[1], 'base64');

      let ext = '.jpg';
      if (mimeType.includes('png')) ext = '.png';
      else if (mimeType.includes('webp')) ext = '.webp';
      else if (mimeType.includes('pdf')) ext = '.pdf';

      const uniqueFilename = `bill_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
      const filePath = path.join(UPLOADS_DIR, uniqueFilename);

      fs.writeFileSync(filePath, buffer);
      const fileUrl = `/uploads/${uniqueFilename}`;

      return sendJson({
        success: true,
        fileUrl,
        filename: uniqueFilename,
        size: buffer.length
      });
    }

    // 16. Settings API
    if (pathname === '/api/settings' && req.method === 'GET') {
      const settings = {};
      const all = db.prepare("SELECT key, value FROM settings").all();
      for (const s of all) settings[s.key] = s.value;
      return sendJson({ settings });
    }

    if (pathname === '/api/settings' && req.method === 'POST') {
      const user = authenticate(req);
      if (!user || user.role !== 'admin') return sendError('Forbidden', 403);
      const body = await parseJsonBody(req);

      for (const [k, v] of Object.entries(body)) {
        db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, String(v));
      }

      logAudit(user.name, user.role, 'Update Settings', JSON.stringify(body), req);
      return sendJson({ success: true });
    }

    /* =========================================================================
       STATIC FILE SERVING (uploads and public SPA)
       ========================================================================= */

    // Serve uploaded files
    if (pathname.startsWith('/uploads/')) {
      const fileName = path.basename(pathname);
      const filePath = path.join(UPLOADS_DIR, fileName);

      if (fs.existsSync(filePath)) {
        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=86400'
        });
        fs.createReadStream(filePath).pipe(res);
        return;
      }
      return sendError('Uploaded file not found', 404);
    }

    // Serve public frontend assets
    let safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
    if (safePath === '/' || safePath === '\\') safePath = '/index.html';

    let filePath = path.join(PUBLIC_DIR, safePath);

    // If file doesn't exist in public, check if index.html is requested or fallback to SPA index.html
    if (!fs.existsSync(filePath)) {
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }

    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'text/html; charset=utf-8';
      res.writeHead(200, { 'Content-Type': contentType });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  } catch (err) {
    console.error('Server error on', req.method, pathname, err);
    sendError(err.message || 'Internal Server Error', 500);
  }
});

// Start Server
server.listen(PORT, HOST, () => {
  const localIps = getLocalIpAddresses();
  console.log('================================================================');
  console.log('  🚀 MECHANIC LOYALTY & AUDITING SYSTEM (MULTI-DEVICE READY)');
  console.log('================================================================');
  console.log(`  💻 PC Access: http://localhost:${PORT}`);
  console.log('');
  console.log('  📱 MOBILE PHONE ACCESS (Connect 5-6 phones on the same Wi-Fi):');
  if (localIps.length === 0) {
    console.log(`     👉 http://<YOUR_COMPUTER_IP>:${PORT}`);
  } else {
    for (const item of localIps) {
      console.log(`     👉 http://${item.address}:${PORT}  (${item.interface})`);
    }
  }
  console.log('');
  console.log('  🔑 DEFAULT LOGINS:');
  console.log('     Admin:   Username: admin    | Password: admin123');
  console.log('     Auditor: Username: audit1   | Password: audit123');
  console.log('     Auditor: Username: audit2   | Password: audit123');
  console.log('     Mechanic:Username: MEC1001  | Password: mechanic123');
  console.log('================================================================');
});
