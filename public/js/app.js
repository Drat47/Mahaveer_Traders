/* =========================================================================
   MECHANIC LOYALTY & AUDIT SYSTEM - CLIENT APPLICATION LOGIC (SPA)
   ========================================================================= */

const API = {
  get: (url) => apiFetch(url, { method: 'GET' }),
  post: (url, data) => apiFetch(url, { method: 'POST', body: JSON.stringify(data) }),
  patch: (url, data) => apiFetch(url, { method: 'PATCH', body: JSON.stringify(data) })
};

let AppState = {
  token: localStorage.getItem('mech_audit_token') || null,
  user: null,
  view: 'dash',
  subViewId: null,
  stats: {},
  mechanics: [],
  purchases: [],
  products: [],
  rewards: [],
  redemptions: [],
  returns: [],
  auditLogs: [],
  notifications: [],
  networkInfo: null,
  pollTimer: null,
  selectedFilter: 'ALL',
  searchQuery: ''
};

let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  const btn = document.getElementById('pwa-install-banner-btn');
  if (btn) btn.style.display = 'block';
});

async function triggerPwaInstall() {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') {
      showToast('App icon installed on your phone home screen!', 'success');
      const btn = document.getElementById('pwa-install-banner-btn');
      if (btn) btn.style.display = 'none';
    }
    deferredInstallPrompt = null;
  } else {
    // Instructions for iOS Safari or browsers without native prompt
    alert('To install this app on your phone:\n1. Tap the browser Menu (or Share button on iPhone)\n2. Tap "Add to Home Screen" / "Install App"\n3. The app icon will appear on your phone screen!');
  }
}

// Trade Types List
const TRADE_TYPES = ['Plumber', 'Painters', 'Tiles Mistri', 'Carpenters', 'Raj Mistri', 'Others'];

// Auth Fetch Helper
async function apiFetch(endpoint, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  if (AppState.token) {
    headers['Authorization'] = `Bearer ${AppState.token}`;
  }

  try {
    const res = await fetch(endpoint, { ...options, headers });
    if (res.status === 401) {
      logout(false);
      throw new Error('Session expired. Please log in again.');
    }
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Server error');
    }
    return data;
  } catch (err) {
    showToast(err.message, 'error');
    throw err;
  }
}

// Toast Notification
function showToast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${type === 'success' ? '✓' : type === 'error' ? '⚠' : 'ℹ'}</span> <span>${msg}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3200);
}

// Format Currency
function formatINR(val) {
  return '₹' + Number(val || 0).toLocaleString('en-IN');
}

// Initialize App
async function initApp() {
  renderShell();
  if (AppState.token) {
    try {
      const res = await API.get('/api/auth/me');
      AppState.user = res.user;
      startAutoSync();
      navigate(AppState.user.role === 'auditor' ? 'audit_feed' : 'dash');
    } catch (e) {
      logout(false);
    }
  } else {
    navigate('login');
  }
}

// Start Background Auto-Sync every 8 seconds for multi-device synchronization
function startAutoSync() {
  if (AppState.pollTimer) clearInterval(AppState.pollTimer);
  AppState.pollTimer = setInterval(async () => {
    if (!AppState.user) return;
    try {
      if (AppState.user.role === 'admin' || AppState.user.role === 'auditor') {
        const statsRes = await API.get('/api/dashboard/stats');
        AppState.stats = statsRes;
        if (AppState.view === 'dash') renderAdminDashboard();
        if (AppState.view === 'audit_feed') loadAuditorFeedData();
      }
    } catch (e) {
      // Background sync silently handles temporary glitches
    }
  }, 8000);
}

// Navigation Router
function navigate(view, subId = null) {
  AppState.view = view;
  AppState.subViewId = subId;
  renderView();
}

// Top-level HTML shell renderer
function renderShell() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div id="toast-container"></div>
    <div id="modal-root"></div>
    <div class="app-container" id="app-container">
      <div id="sidebar-slot"></div>
      <main class="main-content" id="main-content"></main>
      <nav class="bottom-nav" id="bottom-nav-slot"></nav>
    </div>
  `;
}

// Render the active view
async function renderView() {
  if (!AppState.user) {
    renderLoginView();
    return;
  }

  renderSidebar();
  renderBottomNav();

  const main = document.getElementById('main-content');
  main.innerHTML = `<div style="text-align:center;padding:40px;"><p>Loading data...</p></div>`;

  try {
    switch (AppState.view) {
      case 'dash':
        if (AppState.user.role === 'admin') await renderAdminDashboard();
        else if (AppState.user.role === 'auditor') await renderAuditorDashboard();
        else await renderMechanicDashboard();
        break;
      case 'category_workers':
        await renderCategoryWorkers(AppState.subViewId);
        break;
      case 'audit_feed':
      case 'verifications':
        await renderBillVerifications();
        break;
      case 'mechanics':
        await renderMechanicsList();
        break;
      case 'mechanic_detail':
        await renderMechanicDetail(AppState.subViewId);
        break;
      case 'purchases':
        await renderPurchasesList();
        break;
      case 'submit_purchase':
        await renderSubmitPurchase();
        break;
      case 'returns':
        await renderReturnsView();
        break;
      case 'process_return':
        await renderProcessReturn(AppState.subViewId);
        break;
      case 'rewards':
        await renderRewardsView();
        break;
      case 'redemptions':
        await renderRedemptionsView();
        break;
      case 'audit_logs':
        await renderAuditLogsView();
        break;
      case 'reports':
        await renderReportsView();
        break;
      case 'settings':
        await renderSettingsView();
        break;
      case 'notifications':
        await renderNotificationsView();
        break;
      default:
        navigate('dash');
    }
  } catch (err) {
    console.error('Render error:', err);
    main.innerHTML = `<div class="card"><p style="color:var(--danger)">Failed to load view: ${err.message}</p><button class="btn btn-primary" onclick="renderView()">Retry</button></div>`;
  }
}

// Sidebar Navigation
function renderSidebar() {
  const sidebar = document.getElementById('sidebar-slot');
  if (!AppState.user) {
    sidebar.innerHTML = '';
    return;
  }

  const role = AppState.user.role;
  let navItems = [];

  if (role === 'admin') {
    navItems = [
      { id: 'dash', label: '📊 Dashboard' },
      { id: 'verifications', label: '🔍 Bill Audits', count: AppState.stats.pendingBills || 0 },
      { id: 'mechanics', label: '👷 Mechanics' },
      { id: 'purchases', label: '🧾 Purchases' },
      { id: 'returns', label: '↩️ Returns & Reversals' },
      { id: 'rewards', label: '🎁 Rewards Catalog' },
      { id: 'redemptions', label: '🏆 Redemptions', count: AppState.stats.pendingRedemptions || 0 },
      { id: 'reports', label: '📈 Reports & Rankings' },
      { id: 'audit_logs', label: '📋 Audit Logs' },
      { id: 'settings', label: '⚙️ Settings & Mobile Pairing' }
    ];
  } else if (role === 'auditor') {
    navItems = [
      { id: 'dash', label: '📊 Field Overview' },
      { id: 'audit_feed', label: '🔍 Audit Queue', count: AppState.stats.pendingBills || 0 },
      { id: 'submit_purchase', label: '📸 Snap & Log Bill' },
      { id: 'mechanics', label: '👷 Mechanics Directory' },
      { id: 'purchases', label: '🧾 Audited Purchases' },
      { id: 'returns', label: '↩️ Returns & Reversals' },
      { id: 'audit_logs', label: '📋 My Audit Logs' }
    ];
  } else {
    navItems = [
      { id: 'dash', label: '🏠 My Dashboard' },
      { id: 'submit_purchase', label: '📸 Submit Purchase' },
      { id: 'purchases', label: '🧾 My Purchases' },
      { id: 'rewards', label: '🎁 Rewards & Redeem' },
      { id: 'redemptions', label: '🏆 Redemption History' },
      { id: 'notifications', label: '🔔 Notifications' }
    ];
  }

  sidebar.innerHTML = `
    <aside class="sidebar">
      <div class="sidebar-header">
        <div class="brand-title">🏪 Mahaveer Traders</div>
        <span class="user-badge role-${role}">${role}</span>
        <div style="font-size:12px;color:#cbd5e1;margin-top:4px;">${AppState.user.name}</div>
      </div>
      <nav class="nav-links">
        ${navItems.map(item => `
          <a class="nav-item ${AppState.view === item.id ? 'active' : ''}" onclick="navigate('${item.id}')">
            <span>${item.label}</span>
            ${item.count ? `<span class="badge-count">${item.count}</span>` : ''}
          </a>
        `).join('')}
      </nav>
      <div class="sidebar-footer">
        <button class="btn btn-secondary btn-sm" style="width:100%;margin-bottom:8px;" onclick="openMobilePairingModal()">📱 Connect Phones</button>
        <button class="btn btn-danger btn-sm" style="width:100%" onclick="logout(true)">Logout</button>
      </div>
    </aside>
  `;
}

// Mobile Bottom Navigation Bar
function renderBottomNav() {
  const bottomNav = document.getElementById('bottom-nav-slot');
  if (!AppState.user) {
    bottomNav.innerHTML = '';
    return;
  }

  const role = AppState.user.role;
  let items = [];

  if (role === 'admin' || role === 'auditor') {
    items = [
      { id: 'dash', icon: '📊', label: 'Overview' },
      { id: role === 'admin' ? 'verifications' : 'audit_feed', icon: '🔍', label: 'Audit Queue' },
      { id: 'submit_purchase', icon: '📸', label: 'Snap Bill' },
      { id: 'mechanics', icon: '👷', label: 'Mechanics' },
      { id: 'audit_logs', icon: '📋', label: 'Logs' }
    ];
  } else {
    items = [
      { id: 'dash', icon: '🏠', label: 'Home' },
      { id: 'submit_purchase', icon: '📸', label: 'Submit' },
      { id: 'purchases', icon: '🧾', label: 'Purchases' },
      { id: 'rewards', icon: '🎁', label: 'Rewards' }
    ];
  }

  bottomNav.innerHTML = items.map(it => `
    <a class="bottom-nav-item ${AppState.view === it.id ? 'active' : ''}" onclick="navigate('${it.id}')">
      <span class="bottom-nav-icon">${it.icon}</span>
      <span>${it.label}</span>
    </a>
  `).join('');
}

/* =========================================================================
   AUTH & LOGIN VIEW
   ========================================================================= */

function renderLoginView() {
  const main = document.getElementById('main-content');
  document.getElementById('sidebar-slot').innerHTML = '';
  document.getElementById('bottom-nav-slot').innerHTML = '';

  main.innerHTML = `
    <div style="max-width: 440px; margin: 4vh auto; padding: 12px;">
      <div class="card" style="padding: 28px; box-shadow: var(--shadow-lg);">
        <div style="text-align: center; margin-bottom: 24px;">
          <div style="font-size: 40px; margin-bottom: 8px;">🏪</div>
          <h2 style="font-size: 22px; font-weight: 700; color: var(--primary);">Mahaveer Traders</h2>
          <p style="font-size: 13px; color: var(--text-muted); margin-top: 4px;">Mechanic Loyalty & Field Audit System</p>
        </div>

        <button type="button" class="btn btn-success" id="pwa-install-banner-btn" style="width:100%;margin-bottom:14px;" onclick="triggerPwaInstall()">📲 Install App on Phone (1-Tap)</button>

        <form id="login-form" onsubmit="handleLoginSubmit(event)">
          <div class="form-group">
            <label>Username / User ID</label>
            <input type="text" id="login-username" placeholder="e.g. admin, audit1, MEC1001" required autocomplete="username">
          </div>
          <div class="form-group">
            <label>Password</label>
            <input type="password" id="login-password" placeholder="••••••••" required autocomplete="current-password">
          </div>
          <button type="submit" class="btn btn-primary btn-lg" id="login-btn">Secure Login</button>
        </form>
      </div>
      <div style="text-align: center; margin-top: 12px;">
        <button class="btn btn-secondary btn-sm" onclick="openMobilePairingModal()">📱 Connect Mobile Phones (QR Code)</button>
      </div>
    </div>
  `;
}

async function handleLoginSubmit(e) {
  e.preventDefault();
  const u = document.getElementById('login-username').value.trim();
  const p = document.getElementById('login-password').value;
  const btn = document.getElementById('login-btn');

  btn.disabled = true;
  btn.textContent = 'Authenticating...';

  try {
    const res = await API.post('/api/auth/login', { username: u, password: p });
    AppState.token = res.token;
    AppState.user = res.user;
    localStorage.setItem('mech_audit_token', res.token);
    showToast(`Welcome back, ${res.user.name}!`, 'success');
    startAutoSync();
    navigate(res.user.role === 'auditor' ? 'audit_feed' : 'dash');
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Secure Login';
  }
}

async function logout(callApi = true) {
  if (callApi && AppState.token) {
    try { await API.post('/api/auth/logout', {}); } catch (e) {}
  }
  AppState.token = null;
  AppState.user = null;
  localStorage.removeItem('mech_audit_token');
  if (AppState.pollTimer) clearInterval(AppState.pollTimer);
  navigate('login');
  showToast('Logged out successfully', 'info');
}

/* =========================================================================
   ADMIN DASHBOARD VIEW
   ========================================================================= */

async function renderAdminDashboard() {
  const main = document.getElementById('main-content');
  const stats = await API.get('/api/dashboard/stats');
  AppState.stats = stats;

  main.innerHTML = `
    <div class="top-bar">
      <div>
        <h1 class="page-title">Operations & Audit Dashboard</h1>
        <p style="font-size:13px;color:var(--text-muted)">Live business metrics and field audit oversight</p>
      </div>
      <div class="top-actions">
        <button class="btn btn-primary btn-sm" onclick="openMobilePairingModal()">📱 Mobile Pair (QR)</button>
        <button class="btn btn-secondary btn-sm" onclick="navigate('verifications')">🔍 Verify Bills (${stats.pendingBills})</button>
      </div>
    </div>

    <div class="stats-grid">
      <div class="stat-card interactive" onclick="navigate('mechanics')">
        <div class="stat-label">Total Mechanics</div>
        <div class="stat-value">${stats.totalMechanics}</div>
        <span style="font-size:11px;color:var(--success)">${stats.activeMechanics} Active in Field</span>
      </div>

      <div class="stat-card interactive highlight" onclick="navigate('verifications')">
        <div class="stat-label">Pending Verification</div>
        <div class="stat-value" style="color:var(--warning)">${stats.pendingBills}</div>
        <span style="font-size:11px;color:var(--text-muted)">Requires Auditor Action</span>
      </div>

      <div class="stat-card">
        <div class="stat-label">Approved Purchases</div>
        <div class="stat-value" style="color:var(--success)">${stats.approvedBills}</div>
        <span style="font-size:11px;color:var(--text-muted)">${formatINR(stats.purchaseValue)} Total Value</span>
      </div>

      <div class="stat-card">
        <div class="stat-label">Points Issued</div>
        <div class="stat-value">${stats.pointsIssued.toLocaleString()}</div>
        <span style="font-size:11px;color:var(--text-muted)">${stats.pointsRedeemed.toLocaleString()} Redeemed</span>
      </div>

      <div class="stat-card interactive" onclick="navigate('redemptions')">
        <div class="stat-label">Pending Claims</div>
        <div class="stat-value" style="color:${stats.pendingRedemptions > 0 ? 'var(--warning)' : 'var(--primary)'}">${stats.pendingRedemptions}</div>
        <span style="font-size:11px;color:var(--text-muted)">Reward Redemptions</span>
      </div>

      <div class="stat-card interactive" onclick="navigate('returns')">
        <div class="stat-label">Product Returns</div>
        <div class="stat-value">${stats.returnsCount}</div>
        <span style="font-size:11px;color:var(--danger)">${stats.pointsReversed} pts reversed</span>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px;">
      <div class="card">
        <div class="card-header">
          <div class="card-title">Trade Category Revenue Breakdown</div>
        </div>
        <div style="position:relative;height:240px;">
          <canvas id="trade-chart"></canvas>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Field Category Performance</div>
            <small style="color:var(--text-muted)">Click any trade category to view its workers and profiles</small>
          </div>
          <button class="btn btn-secondary btn-sm" onclick="navigate('reports')">Full Report</button>
        </div>
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>Trade Type (Click to Open)</th>
                <th>Workers</th>
                <th>Approved Sales</th>
                <th>Pending Bills</th>
              </tr>
            </thead>
            <tbody>
              ${(stats.tradeBreakdown || []).map(t => `
                <tr style="cursor:pointer;" onclick="navigate('category_workers', '${t.type}')" title="Click to view all ${t.type} workers">
                  <td><b style="color:var(--accent);">${t.type}</b> <span style="font-size:12px;color:var(--accent);">➔</span></td>
                  <td><b>${t.mechanics_count}</b></td>
                  <td>${formatINR(t.approved_value)}</td>
                  <td>${t.pending_bills > 0 ? `<span class="badge badge-pending">${t.pending_bills} pending</span>` : '<span style="color:var(--text-muted)">0</span>'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  // Render Chart.js
  if (window.Chart && document.getElementById('trade-chart')) {
    const ctx = document.getElementById('trade-chart').getContext('2d');
    const labels = (stats.tradeBreakdown || []).map(t => t.type);
    const data = (stats.tradeBreakdown || []).map(t => t.approved_value);

    new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: 'Approved Sales (₹)',
          data: data,
          backgroundColor: '#2563EB',
          borderRadius: 6
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              footer: () => '👉 Click bar to view category workers'
            }
          }
        },
        onClick: (event, elements) => {
          if (elements && elements.length > 0) {
            const index = elements[0].index;
            const selectedCategory = labels[index];
            if (selectedCategory) {
              navigate('category_workers', selectedCategory);
            }
          }
        },
        onHover: (event, chartElement) => {
          event.native.target.style.cursor = chartElement[0] ? 'pointer' : 'default';
        },
        scales: {
          y: { beginAtZero: true, ticks: { callback: v => '₹' + v.toLocaleString() } }
        }
      }
    });
  }
}

/* =========================================================================
   AUDITOR / FIELD AUDIT QUEUE VIEW (MOBILE-OPTIMIZED)
   ========================================================================= */

async function renderBillVerifications() {
  const main = document.getElementById('main-content');
  const res = await API.get('/api/purchases?status=PENDING');
  const purchases = res.purchases || [];

  main.innerHTML = `
    <div class="top-bar">
      <div>
        <h1 class="page-title">🔍 Mobile Audit & Verification Queue</h1>
        <p style="font-size:13px;color:var(--text-muted)">Verify customer authenticity, bill receipt photos, and award points</p>
      </div>
      <div class="top-actions">
        <button class="btn btn-secondary btn-sm" onclick="renderBillVerifications()">🔄 Refresh (${purchases.length})</button>
        <button class="btn btn-primary btn-sm" onclick="navigate('submit_purchase')">📸 Snap New Bill</button>
      </div>
    </div>

    ${purchases.length === 0 ? `
      <div class="card" style="text-align:center;padding:48px 16px;">
        <div style="font-size:48px;margin-bottom:8px;">✅</div>
        <h3>All Caught Up!</h3>
        <p style="color:var(--text-muted);margin-top:4px;">No pending bill submissions in the audit queue.</p>
      </div>
    ` : `
      <div style="display:flex;flex-direction:column;gap:12px;">
        ${purchases.map(p => `
          <div class="audit-card">
            <div class="audit-card-header">
              <div>
                <div class="audit-customer">Bill #${p.id} — ${p.customer_name}</div>
                <div class="audit-meta">
                  <b>Mechanic:</b> ${p.mechanic_name} (${p.trade_type} · ${p.mechanic_uid}) · <b>Phone:</b> ${p.mechanic_phone}
                </div>
                <div class="audit-meta">
                  <b>Date:</b> ${p.purchase_date} · <b>Amount:</b> <span style="font-size:15px;font-weight:700;color:var(--primary);">${formatINR(p.total_amount)}</span>
                </div>
              </div>
              <span class="badge badge-pending">Pending Verification</span>
            </div>

            <div style="background:#F8FAFC;padding:10px 12px;border-radius:var(--radius-sm);margin:8px 0;font-size:13px;">
              <b>Address:</b> ${p.customer_address}<br>
              <b>Items:</b> ${(p.items || []).map(i => `${i.product_name} (${i.quantity} ${i.unit})`).join(', ') || 'General purchase'}
            </div>

            <div class="audit-quick-actions">
              <a href="tel:${p.customer_phone}" class="audit-btn-call">📞 Call Customer (${p.customer_phone})</a>
              <a href="https://wa.me/91${p.customer_phone}?text=${encodeURIComponent(`Hello ${p.customer_name}, verifying your purchase of ${formatINR(p.total_amount)} on ${p.purchase_date}.`)}" target="_blank" class="audit-btn-whatsapp">💬 WhatsApp</a>
              ${p.bill_file_url ? `<button class="btn btn-secondary btn-sm" onclick="openBillViewerModal('${p.bill_file_url}', ${p.id})">🖼️ View Bill Photo</button>` : `<span style="font-size:12px;color:var(--danger)">No Bill Photo Attached</span>`}
            </div>

            <div style="display:flex;gap:8px;margin-top:14px;padding-top:12px;border-top:1px solid var(--border);flex-wrap:wrap;">
              <button class="btn btn-success" onclick="openAuditActionModal(${p.id}, 'APPROVE', ${p.total_amount})">✓ Approve & Credit Points</button>
              <button class="btn btn-danger btn-sm" onclick="openAuditActionModal(${p.id}, 'REJECT')">✕ Reject Bill</button>
              <button class="btn btn-warning btn-sm" onclick="openAuditActionModal(${p.id}, 'CORRECTION')">⚠️ Request Correction</button>
            </div>
          </div>
        `).join('')}
      </div>
    `}
  `;
}

// Modal: Bill Viewer with Zoom
function openBillViewerModal(fileUrl, billId) {
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="closeModal()">
      <div class="modal-content" onclick="event.stopPropagation()">
        <div class="modal-header">
          <div class="card-title">Bill Receipt #${billId}</div>
          <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        <div class="bill-preview-box">
          ${fileUrl.toLowerCase().endsWith('.pdf') ? `
            <a href="${fileUrl}" target="_blank" class="btn btn-primary">📄 Open Full PDF Document</a>
          ` : `
            <img src="${fileUrl}" class="bill-img" id="modal-bill-img" alt="Bill Photo">
          `}
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:12px;">
          <a href="${fileUrl}" target="_blank" class="btn btn-secondary btn-sm">Open in New Tab</a>
          <button class="btn btn-primary btn-sm" onclick="closeModal()">Close</button>
        </div>
      </div>
    </div>
  `;
}

// Modal: Audit Action (Approve with Points / Reject / Correction)
function openAuditActionModal(purchaseId, action, totalAmount = 0) {
  const modalRoot = document.getElementById('modal-root');
  const defaultPoints = Math.round((totalAmount * 3) / 100); // Default 3 pts per ₹100

  let bodyHtml = '';
  if (action === 'APPROVE') {
    bodyHtml = `
      <div class="form-group">
        <label>Points to Award (Calculated from ₹${totalAmount.toLocaleString('en-IN')})</label>
        <input type="number" id="audit-points" value="${defaultPoints}" min="0">
        <small style="color:var(--text-muted)">Standard rate: 3 points per ₹100 spent</small>
      </div>
      <div style="background:#DCFCE7;padding:10px;border-radius:var(--radius-sm);font-size:12px;color:#166534;margin-bottom:12px;">
        ✓ Customer purchase verified<br>
        ✓ Points will be credited directly to the mechanic's active ledger
      </div>
    `;
  } else if (action === 'REJECT') {
    bodyHtml = `
      <div class="form-group">
        <label>Rejection Reason (Required for Audit Trail)</label>
        <select id="audit-reason-select" onchange="document.getElementById('audit-reason-custom').style.display = this.value === 'Other' ? 'block' : 'none'">
          <option>Bill receipt unreadable / blurry photo</option>
          <option>Customer denied making this purchase</option>
          <option>Duplicate bill already processed</option>
          <option>Invalid / non-registered store bill</option>
          <option>Wrong product category billed</option>
          <option>Other</option>
        </select>
        <input type="text" id="audit-reason-custom" placeholder="Specify custom reason..." style="display:none;margin-top:6px;">
      </div>
    `;
  } else if (action === 'CORRECTION') {
    bodyHtml = `
      <div class="form-group">
        <label>Correction Message for Mechanic</label>
        <textarea id="audit-correction-msg" rows="3" placeholder="e.g. Please re-upload a clearer photo showing the customer phone number and date..."></textarea>
      </div>
    `;
  }

  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="closeModal()">
      <div class="modal-content" onclick="event.stopPropagation()">
        <div class="modal-header">
          <div class="card-title">${action === 'APPROVE' ? 'Approve Bill & Issue Points' : action === 'REJECT' ? 'Reject Bill Submission' : 'Request Correction'}</div>
          <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        ${bodyHtml}
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">
          <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
          <button class="btn ${action === 'APPROVE' ? 'btn-success' : action === 'REJECT' ? 'btn-danger' : 'btn-warning'}" onclick="submitAuditAction(${purchaseId}, '${action}')">Confirm ${action}</button>
        </div>
      </div>
    </div>
  `;
}

async function submitAuditAction(purchaseId, action) {
  try {
    let payload = { action };
    if (action === 'APPROVE') {
      const pts = parseInt(document.getElementById('audit-points').value, 10);
      if (isNaN(pts) || pts < 0) return showToast('Enter a valid points number', 'error');
      payload.points = pts;
    } else if (action === 'REJECT') {
      const sel = document.getElementById('audit-reason-select').value;
      const custom = document.getElementById('audit-reason-custom').value.trim();
      payload.reason = sel === 'Other' ? custom : sel;
      if (!payload.reason) return showToast('Rejection reason is required', 'error');
    } else if (action === 'CORRECTION') {
      const msg = document.getElementById('audit-correction-msg').value.trim();
      if (!msg) return showToast('Correction message is required', 'error');
      payload.message = msg;
    }

    const res = await API.post(`/api/purchases/${purchaseId}/verify`, payload);
    showToast(`Audit decision recorded: ${action}`, 'success');
    closeModal();

    if (action === 'APPROVE' && res.notification) {
      showWorkerNotificationModal(res.notification, () => {
        renderBillVerifications();
      });
    } else {
      renderBillVerifications();
    }
  } catch (err) {
    // Handled by apiFetch
  }
}

function showWorkerNotificationModal(notif, onClosed = null) {
  if (!notif) return;
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="closeModal(); if(typeof window._notifOnClose === 'function') window._notifOnClose();">
      <div class="modal-content" style="max-width:520px;" onclick="event.stopPropagation()">
        <div class="modal-header">
          <div class="card-title">📲 Send Alert to ${notif.workerName}</div>
          <button class="modal-close" onclick="closeModal(); if(typeof window._notifOnClose === 'function') window._notifOnClose();">✕</button>
        </div>

        <div style="background:#F0FDF4;border:1px solid #BBF7D0;padding:12px;border-radius:var(--radius-sm);margin-bottom:14px;">
          <div style="font-size:13px;font-weight:700;color:#166534;">✓ Bill Processed & Points Awarded!</div>
          <div style="font-size:12px;color:#166534;margin-top:2px;">
            Send an instant WhatsApp or Text SMS to <b>${notif.workerName}</b> (${notif.workerPhone}) with customer and points details.
          </div>
        </div>

        <div class="form-group">
          <label>Automated WhatsApp / SMS Message Preview</label>
          <div id="worker-notif-preview" style="background:#0F172A;color:#F8FAFC;padding:12px;border-radius:var(--radius-sm);font-family:monospace;font-size:12px;white-space:pre-wrap;max-height:200px;overflow-y:auto;border:1px solid #334155;line-height:1.4;">${notif.messageText}</div>
        </div>

        <div style="display:flex;flex-direction:column;gap:8px;margin-top:16px;">
          <a href="${notif.whatsappUrl}" target="_blank" class="btn btn-success btn-lg" style="text-decoration:none;">
            💬 Open WhatsApp & Send to ${notif.workerName}
          </a>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
            <a href="${notif.smsUrl}" class="btn btn-secondary" style="text-decoration:none;">📱 Send as Text SMS</a>
            <button class="btn btn-secondary" onclick="copyNotifText()">📋 Copy Text</button>
          </div>
          <button class="btn btn-secondary btn-sm" style="margin-top:4px;" onclick="closeModal(); if(typeof window._notifOnClose === 'function') window._notifOnClose();">Done</button>
        </div>
      </div>
    </div>
  `;
  window._notifOnClose = onClosed;
}

function copyNotifText() {
  const el = document.getElementById('worker-notif-preview');
  if (!el) return;
  navigator.clipboard.writeText(el.innerText).then(() => {
    showToast('Notification message copied to clipboard!', 'success');
  }).catch(() => {
    showToast('Failed to copy', 'error');
  });
}

async function triggerSendWorkerNotification(purchaseId) {
  try {
    const res = await API.get(`/api/purchases/${purchaseId}/notification-text`);
    if (res.notification) {
      showWorkerNotificationModal(res.notification);
    }
  } catch (e) {}
}

function closeModal() {
  const modalRoot = document.getElementById('modal-root');
  if (modalRoot) modalRoot.innerHTML = '';
}

/* =========================================================================
   SUBMIT PURCHASE / SNAP BILL (MOBILE CAMERA COMPATIBLE)
   ========================================================================= */

async function renderSubmitPurchase() {
  const main = document.getElementById('main-content');
  const prodsRes = await API.get('/api/products');
  const mechsRes = await API.get('/api/mechanics');
  const products = prodsRes.products || [];
  const mechanics = mechsRes.mechanics || [];

  const isAuditorOrAdmin = AppState.user.role === 'admin' || AppState.user.role === 'auditor';

  main.innerHTML = `
    <div class="top-bar">
      <div>
        <h1 class="page-title">📸 Submit Purchase & Bill</h1>
        <p style="font-size:13px;color:var(--text-muted)">Upload bill photo and record customer purchase details</p>
      </div>
    </div>

    <div style="max-width: 680px; margin: 0 auto;">
      <form id="purchase-form" onsubmit="handlePurchaseSubmit(event)">
        ${isAuditorOrAdmin ? `
          <div class="card">
            <div class="card-title" style="margin-bottom:12px;">👷 Select Mechanic <span style="color:var(--danger)">*</span></div>
            <div class="form-group">
              <label>Mechanic Account <span style="color:var(--danger)">*</span></label>
              <select id="pur-mechanic-id" required>
                <option value="">-- Choose Mechanic --</option>
                ${mechanics.filter(m => m.is_active).map(m => `
                  <option value="${m.id}">${m.name} (${m.uid} · ${m.trade_type} · ${m.phone})</option>
                `).join('')}
              </select>
            </div>
          </div>
        ` : ''}

        <div class="card">
          <div class="card-title" style="margin-bottom:12px;">👤 Customer & Date <span style="color:var(--danger)">*</span></div>
          <div class="form-row">
            <div class="form-group">
              <label>Purchase Date <span style="color:var(--danger)">*</span></label>
              <input type="date" id="pur-date" value="${new Date().toISOString().slice(0, 10)}" required>
            </div>
            <div class="form-group">
              <label>Customer Name <span style="color:var(--danger)">*</span></label>
              <input type="text" id="pur-cust-name" placeholder="Full name of customer" required>
            </div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label>Customer Phone Number (Optional)</label>
              <input type="tel" id="pur-cust-phone" placeholder="10-digit mobile number (Optional)">
            </div>
            <div class="form-group">
              <label>Customer Address / Area (Optional)</label>
              <input type="text" id="pur-cust-addr" placeholder="Location, Street, City (Optional)">
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-header" style="margin-bottom:8px;">
            <div class="card-title">📦 Products Purchased <span style="font-size:12px;color:var(--text-muted);font-weight:normal;">(Optional)</span></div>
          </div>
          <p style="font-size:12px;color:var(--text-muted);margin-bottom:10px;">Optional: You can add product line items or skip this section.</p>
          <div id="items-container">
            <!-- Dynamic item rows -->
          </div>
          <button type="button" class="btn btn-secondary btn-sm" style="margin-top:8px;" onclick="addPurchaseItemRow()">+ Add Product Line</button>
        </div>

        <div class="card">
          <div class="card-header" style="margin-bottom:8px;">
            <div class="card-title">💰 Amount & Bill Photo <span style="font-size:12px;color:var(--text-muted);font-weight:normal;">(Optional)</span></div>
          </div>
          <div class="form-group">
            <label>Total Bill Amount (₹) (Optional)</label>
            <input type="number" id="pur-amount" placeholder="e.g. 4500 (Optional)" min="0" step="any">
          </div>

          <div class="form-group">
            <label>Bill Photo / Receipt (Optional)</label>
            <input type="file" id="pur-file" accept="image/*,.pdf" capture="environment" onchange="handleBillFileSelected(this)">
            <small style="color:var(--text-muted)">Take a photo of the bill if available (Optional).</small>
            <div id="file-preview-slot" style="margin-top:10px;"></div>
          </div>
        </div>

        <button type="submit" class="btn btn-primary btn-lg" id="pur-submit-btn">Submit Purchase & Generate Bill</button>
      </form>
    </div>
  `;

  // Store products for dynamic rows
  window._availableProducts = products;
}

let uploadedBillUrl = '';

function addPurchaseItemRow() {
  const container = document.getElementById('items-container');
  if (!container) return;
  const rowId = 'row_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);

  const div = document.createElement('div');
  div.id = rowId;
  div.className = 'form-row';
  div.style.marginBottom = '8px';
  div.innerHTML = `
    <div style="flex:2;">
      <select class="item-prod-select" onchange="handleProductSelected(this, '${rowId}')">
        <option value="">-- Choose Product (Optional) --</option>
        ${(window._availableProducts || []).map(p => `
          <option value="${p.id}" data-unit="${p.unit}" data-name="${p.name}">${p.name} (${p.category})</option>
        `).join('')}
      </select>
    </div>
    <div style="flex:1;">
      <input type="number" class="item-qty" placeholder="Quantity" min="0" step="any">
    </div>
    <div style="flex:0.8;">
      <input type="text" class="item-unit" placeholder="Unit" readonly style="background:#F1F5F9;">
    </div>
    <div style="flex:0;">
      <button type="button" class="btn btn-danger btn-sm" onclick="document.getElementById('${rowId}').remove()">✕</button>
    </div>
  `;
  container.appendChild(div);
}

function handleProductSelected(selectEl, rowId) {
  const row = document.getElementById(rowId);
  if (!row) return;
  const opt = selectEl.options[selectEl.selectedIndex];
  const unitInput = row.querySelector('.item-unit');
  unitInput.value = opt.getAttribute('data-unit') || 'Piece';
}

function handleBillFileSelected(input) {
  const file = input.files[0];
  if (!file) return;

  const slot = document.getElementById('file-preview-slot');
  slot.innerHTML = `<p style="font-size:12px;color:var(--text-muted)">Processing and compressing photo...</p>`;

  const reader = new FileReader();
  reader.onload = async (e) => {
    const dataUrl = e.target.result;
    try {
      const res = await API.post('/api/upload', { dataUrl, filename: file.name });
      uploadedBillUrl = res.fileUrl;
      slot.innerHTML = `
        <div style="background:#F1F5F9;padding:8px;border-radius:var(--radius-sm);display:flex;align-items:center;gap:10px;">
          ${file.type.startsWith('image') ? `<img src="${uploadedBillUrl}" style="height:60px;width:60px;object-fit:cover;border-radius:4px;">` : '📄'}
          <div>
            <div style="font-size:12px;font-weight:600;color:var(--success)">✓ Photo uploaded securely</div>
            <div style="font-size:11px;color:var(--text-muted)">${file.name} (${Math.round(file.size / 1024)} KB)</div>
          </div>
        </div>
      `;
      showToast('Bill photo uploaded ready', 'success');
    } catch (err) {
      slot.innerHTML = `<p style="color:var(--danger)">Upload failed: ${err.message}</p>`;
    }
  };
  reader.readAsDataURL(file);
}

async function handlePurchaseSubmit(e) {
  e.preventDefault();
  const btn = document.getElementById('pur-submit-btn');

  const mechSelect = document.getElementById('pur-mechanic-id');
  const mechanicId = mechSelect ? mechSelect.value : (AppState.user ? AppState.user.mechanicId : null);

  if ((AppState.user.role === 'admin' || AppState.user.role === 'auditor') && !mechanicId) {
    return showToast('Please select a mechanic', 'error');
  }

  const purchaseDate = document.getElementById('pur-date').value;
  const customerName = document.getElementById('pur-cust-name').value.trim();
  const customerPhone = document.getElementById('pur-cust-phone').value.trim();
  const customerAddress = document.getElementById('pur-cust-addr').value.trim();
  const totalAmount = parseFloat(document.getElementById('pur-amount').value) || 0;

  if (!purchaseDate) {
    return showToast('Purchase Date is required', 'error');
  }
  if (!customerName) {
    return showToast('Customer Name is required', 'error');
  }

  // Collect item rows (optional)
  const itemRows = document.querySelectorAll('#items-container .form-row');
  const items = [];
  itemRows.forEach(row => {
    const sel = row.querySelector('.item-prod-select');
    const qty = parseFloat(row.querySelector('.item-qty').value) || 1;
    const unit = row.querySelector('.item-unit').value || 'Unit';
    if (sel && sel.value) {
      const opt = sel.options[sel.selectedIndex];
      items.push({
        productId: parseInt(sel.value, 10),
        productName: opt.getAttribute('data-name') || opt.text,
        quantity: qty,
        unit: unit
      });
    }
  });

  btn.disabled = true;
  btn.textContent = 'Submitting...';

  try {
    const payload = {
      mechanicId,
      purchaseDate,
      customerName,
      customerPhone,
      customerAddress,
      totalAmount,
      billFileUrl: uploadedBillUrl,
      items
    };

    const res = await API.post('/api/purchases', payload);
    showToast('Purchase submitted successfully!', 'success');
    uploadedBillUrl = '';

    if (res.notification && (AppState.user.role === 'admin' || AppState.user.role === 'auditor')) {
      showWorkerNotificationModal(res.notification, () => {
        navigate(AppState.user.role === 'mechanic' ? 'purchases' : 'verifications');
      });
    } else {
      navigate(AppState.user.role === 'mechanic' ? 'purchases' : 'verifications');
    }
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Submit Purchase & Generate Bill';
  }
}

/* =========================================================================
   MECHANICS DIRECTORY & PROFILE VIEW
   ========================================================================= */

async function renderMechanicsList() {
  const main = document.getElementById('main-content');
  const res = await API.get('/api/mechanics');
  const mechanics = res.mechanics || [];
  const isAdmin = AppState.user.role === 'admin';

  main.innerHTML = `
    <div class="top-bar">
      <div>
        <h1 class="page-title">👷 Mechanics Directory</h1>
        <p style="font-size:13px;color:var(--text-muted)">Manage accounts, points balance, and field profiles</p>
      </div>
      <div class="top-actions">
        ${isAdmin ? `<button class="btn btn-primary btn-sm" onclick="openAddMechanicModal()">+ Register Mechanic</button>` : ''}
      </div>
    </div>

    <div class="card" style="margin-bottom:12px;">
      <div class="form-row">
        <input type="text" id="mech-search" placeholder="Search by name, phone, user ID, or address..." oninput="filterMechanicsTable(this.value)">
      </div>
    </div>

    <div class="card" style="padding:0;">
      <div class="table-responsive">
        <table id="mechanics-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Name</th>
              <th>Trade</th>
              <th>Phone</th>
              <th>Available Points</th>
              <th>Lifetime Points</th>
              <th>Pending Bills</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${mechanics.map(m => `
              <tr data-search="${(m.name + m.phone + m.uid + m.trade_type + m.address).toLowerCase()}">
                <td><b>${m.uid}</b></td>
                <td><b>${m.name}</b><br><small style="color:var(--text-muted)">${m.address}</small></td>
                <td><span class="badge" style="background:#E2E8F0;">${m.trade_type}</span></td>
                <td>${m.phone}</td>
                <td><b style="color:var(--primary);font-size:15px;">${m.available_points}</b>${m.recovery_points > 0 ? `<br><small style="color:var(--danger)">Recovery: ${m.recovery_points}</small>` : ''}</td>
                <td>${m.lifetime_points}</td>
                <td>${m.pending_bills_count > 0 ? `<span class="badge badge-pending">${m.pending_bills_count}</span>` : '0'}</td>
                <td><span class="badge ${m.is_active ? 'badge-active' : 'badge-inactive'}">${m.is_active ? 'Active' : 'Inactive'}</span></td>
                <td>
                  <button class="btn btn-secondary btn-sm" onclick="navigate('mechanic_detail', ${m.id})">Profile</button>
                  ${isAdmin ? `<button class="btn btn-secondary btn-sm" onclick="toggleMechanicStatus(${m.id})">${m.is_active ? 'Deactivate' : 'Activate'}</button>` : ''}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function filterMechanicsTable(query) {
  const q = query.toLowerCase().trim();
  const rows = document.querySelectorAll('#mechanics-table tbody tr');
  rows.forEach(r => {
    const text = r.getAttribute('data-search') || '';
    r.style.display = text.includes(q) ? '' : 'none';
  });
}

// Modal: Add Mechanic
function openAddMechanicModal() {
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="closeModal()">
      <div class="modal-content" onclick="event.stopPropagation()">
        <div class="modal-header">
          <div class="card-title">Register New Mechanic</div>
          <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        <form onsubmit="handleAddMechanicSubmit(event)">
          <div class="form-group">
            <label>Full Name</label>
            <input type="text" id="new-m-name" required placeholder="e.g. Rajesh Kumar">
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Phone Number</label>
              <input type="tel" id="new-m-phone" required pattern="[0-9]{10}" placeholder="10-digit mobile number">
            </div>
            <div class="form-group">
              <label>Trade / Specialty</label>
              <select id="new-m-type" required>
                ${TRADE_TYPES.map(t => `<option>${t}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="form-group">
            <label>Address / Shop Location</label>
            <input type="text" id="new-m-addr" required placeholder="e.g. Gandhi Maidan, Patna">
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Login User ID</label>
              <input type="text" id="new-m-uid" required placeholder="e.g. MEC1007">
            </div>
            <div class="form-group">
              <label>Password</label>
              <input type="password" id="new-m-pw" required value="mechanic123">
            </div>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">
            <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
            <button type="submit" class="btn btn-primary">Save & Register</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

async function handleAddMechanicSubmit(e) {
  e.preventDefault();
  const payload = {
    name: document.getElementById('new-m-name').value.trim(),
    phone: document.getElementById('new-m-phone').value.trim(),
    trade_type: document.getElementById('new-m-type').value,
    address: document.getElementById('new-m-addr').value.trim(),
    uid: document.getElementById('new-m-uid').value.trim(),
    password: document.getElementById('new-m-pw').value
  };

  try {
    await API.post('/api/mechanics', payload);
    showToast('Mechanic registered successfully', 'success');
    closeModal();
    renderMechanicsList();
  } catch (err) {}
}

async function toggleMechanicStatus(id) {
  try {
    await API.patch(`/api/mechanics/${id}/status`, {});
    showToast('Status updated', 'success');
    renderMechanicsList();
  } catch (e) {}
}

/* =========================================================================
   CATEGORY WORKERS VIEW (NEW PAGE WHEN CLICKING TRADE CATEGORY)
   ========================================================================= */

async function renderCategoryWorkers(categoryType) {
  const main = document.getElementById('main-content');
  const type = categoryType || 'All';
  const res = await API.get(`/api/mechanics?type=${encodeURIComponent(type)}`);
  const mechanics = res.mechanics || [];
  const isAdmin = AppState.user.role === 'admin';

  // Compute category specific totals
  const totalWorkers = mechanics.length;
  const activeWorkers = mechanics.filter(m => m.is_active).length;
  const totalLifetimePoints = mechanics.reduce((sum, m) => sum + (m.lifetime_points || 0), 0);
  const totalAvailablePoints = mechanics.reduce((sum, m) => sum + (m.available_points || 0), 0);
  const totalPendingBills = mechanics.reduce((sum, m) => sum + (m.pending_bills_count || 0), 0);

  main.innerHTML = `
    <div class="top-bar">
      <div>
        <button class="btn btn-secondary btn-sm" onclick="navigate('dash')" style="margin-bottom:8px;">← Back to Dashboard</button>
        <h1 class="page-title">👷 ${type} Category Workers</h1>
        <p style="font-size:13px;color:var(--text-muted)">
          All registered ${type} professionals. Click any worker's name to view their complete profile, bills & transaction ledger.
        </p>
      </div>
      <div class="top-actions">
        ${isAdmin ? `<button class="btn btn-primary btn-sm" onclick="openAddMechanicModal()">+ Add ${type}</button>` : ''}
      </div>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Total ${type}s</div>
        <div class="stat-value">${totalWorkers}</div>
        <span style="font-size:11px;color:var(--success)">${activeWorkers} Active in Field</span>
      </div>

      <div class="stat-card">
        <div class="stat-label">Available Points</div>
        <div class="stat-value" style="color:var(--primary);">${totalAvailablePoints.toLocaleString()}</div>
        <span style="font-size:11px;color:var(--text-muted)">Across all ${type}s</span>
      </div>

      <div class="stat-card">
        <div class="stat-label">Lifetime Points</div>
        <div class="stat-value" style="color:var(--success);">${totalLifetimePoints.toLocaleString()}</div>
        <span style="font-size:11px;color:var(--text-muted)">Total earned to date</span>
      </div>

      <div class="stat-card ${totalPendingBills > 0 ? 'highlight' : ''}">
        <div class="stat-label">Pending Verifications</div>
        <div class="stat-value" style="color:${totalPendingBills > 0 ? 'var(--warning)' : 'var(--primary)'};">${totalPendingBills}</div>
        <span style="font-size:11px;color:var(--text-muted)">Awaiting bill audit</span>
      </div>
    </div>

    <div class="card" style="margin-bottom:12px;">
      <div class="form-row">
        <input type="text" id="cat-mech-search" placeholder="Search ${type}s by name, phone, user ID, or address..." oninput="filterCategoryMechanicsTable(this.value)">
      </div>
    </div>

    <div class="card" style="padding:0;">
      <div class="table-responsive">
        <table id="cat-mechanics-table">
          <thead>
            <tr>
              <th>User ID</th>
              <th>Worker Name (Click to View Details)</th>
              <th>Phone / Quick Contact</th>
              <th>Address / Shop</th>
              <th>Available Points</th>
              <th>Lifetime Points</th>
              <th>Pending Bills</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            ${mechanics.length === 0 ? `
              <tr><td colspan="9" style="text-align:center;padding:32px;color:var(--text-muted);">No workers found registered in ${type} category.</td></tr>
            ` : mechanics.map(m => `
              <tr data-search="${(m.name + m.phone + m.uid + m.trade_type + m.address).toLowerCase()}">
                <td><b>${m.uid}</b></td>
                <td>
                  <a onclick="navigate('mechanic_detail', ${m.id})" style="color:var(--accent);font-weight:700;font-size:14px;cursor:pointer;text-decoration:underline;">
                    ${m.name} ➔
                  </a>
                </td>
                <td>
                  <b>${m.phone}</b>
                  <div style="display:flex;gap:4px;margin-top:4px;">
                    <a href="tel:${m.phone}" class="btn btn-secondary btn-sm" style="padding:2px 6px;font-size:11px;" title="Call">📞 Call</a>
                    <a href="https://wa.me/91${m.phone}" target="_blank" class="btn btn-secondary btn-sm" style="padding:2px 6px;font-size:11px;background:#DCFCE7;color:#166534;" title="WhatsApp">💬 WA</a>
                  </div>
                </td>
                <td><small style="color:var(--text-muted)">${m.address}</small></td>
                <td>
                  <b style="color:var(--primary);font-size:15px;">${m.available_points}</b>
                  ${m.recovery_points > 0 ? `<br><small style="color:var(--danger)">Recovery: ${m.recovery_points}</small>` : ''}
                </td>
                <td><b style="color:var(--success);">${m.lifetime_points}</b></td>
                <td>${m.pending_bills_count > 0 ? `<span class="badge badge-pending">${m.pending_bills_count} pending</span>` : '<span style="color:var(--text-muted)">0</span>'}</td>
                <td><span class="badge ${m.is_active ? 'badge-active' : 'badge-inactive'}">${m.is_active ? 'Active' : 'Inactive'}</span></td>
                <td>
                  <button class="btn btn-primary btn-sm" onclick="navigate('mechanic_detail', ${m.id})">View Full Profile ➔</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function filterCategoryMechanicsTable(query) {
  const q = query.toLowerCase().trim();
  const rows = document.querySelectorAll('#cat-mechanics-table tbody tr');
  rows.forEach(r => {
    const text = r.getAttribute('data-search') || '';
    r.style.display = text.includes(q) ? '' : 'none';
  });
}

/* =========================================================================
   MECHANIC DETAIL & COMPLETE PROFILE VIEW
   ========================================================================= */

async function renderMechanicDetail(mechanicId) {
  const main = document.getElementById('main-content');
  const res = await API.get(`/api/mechanics/${mechanicId}`);
  const m = res.mechanic;
  const ledger = res.ledger || [];
  const purchases = res.purchases || [];
  const isAdmin = AppState.user.role === 'admin';

  const approvedPurchases = purchases.filter(p => p.status === 'APPROVED');
  const pendingPurchases = purchases.filter(p => p.status === 'PENDING');
  const totalApprovedSpend = approvedPurchases.reduce((sum, p) => sum + (p.total_amount || 0), 0);

  main.innerHTML = `
    <div class="top-bar">
      <div>
        <div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
          <button class="btn btn-secondary btn-sm" onclick="navigate('category_workers', '${m.trade_type}')">← Back to ${m.trade_type} Category</button>
          <button class="btn btn-secondary btn-sm" onclick="navigate('mechanics')">👷 All Mechanics</button>
          <button class="btn btn-secondary btn-sm" onclick="navigate('dash')">📊 Dashboard</button>
        </div>
        <div style="display:flex;align-items:center;gap:10px;margin-top:6px;flex-wrap:wrap;">
          <h1 class="page-title" style="margin:0;">${m.name}</h1>
          <span class="badge" style="background:#E0F2FE;color:#0284C7;font-size:13px;">${m.trade_type}</span>
          <span class="badge ${m.is_active ? 'badge-active' : 'badge-inactive'}">${m.is_active ? 'Active Account' : 'Inactive'}</span>
        </div>
        <p style="font-size:13px;color:var(--text-muted);margin-top:4px;">
          <b>User ID:</b> ${m.uid} · <b>Phone:</b> ${m.phone} · <b>Location:</b> ${m.address}
        </p>
      </div>
      <div class="top-actions">
        <a href="tel:${m.phone}" class="btn btn-secondary btn-sm">📞 Call Worker</a>
        <a href="https://wa.me/91${m.phone}" target="_blank" class="btn btn-secondary btn-sm" style="background:#DCFCE7;color:#166534;">💬 WhatsApp</a>
        ${isAdmin ? `
          <button class="btn btn-primary btn-sm" onclick="openAdjustPointsModal(${m.id}, '${m.name}')">± Adjust Points</button>
          <button class="btn btn-secondary btn-sm" onclick="toggleMechanicStatusDetail(${m.id})">${m.is_active ? 'Deactivate' : 'Activate'}</button>
        ` : ''}
      </div>
    </div>

    <!-- Overview KPI Grid -->
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Available Points</div>
        <div class="stat-value" style="color:var(--primary);">${m.available_points}</div>
        <span style="font-size:11px;color:var(--text-muted)">Ready for redemption</span>
      </div>

      <div class="stat-card">
        <div class="stat-label">Lifetime Earned</div>
        <div class="stat-value" style="color:var(--success);">${m.lifetime_points}</div>
        <span style="font-size:11px;color:var(--text-muted)">Total points earned</span>
      </div>

      <div class="stat-card ${m.recovery_points > 0 ? 'highlight' : ''}">
        <div class="stat-label">Recovery Pending</div>
        <div class="stat-value" style="color:${m.recovery_points > 0 ? 'var(--danger)' : 'var(--text-muted)'};">${m.recovery_points}</div>
        <span style="font-size:11px;color:var(--text-muted)">Deducted from future bills</span>
      </div>

      <div class="stat-card">
        <div class="stat-label">Approved Purchases</div>
        <div class="stat-value" style="color:var(--success);">${approvedPurchases.length}</div>
        <span style="font-size:11px;color:var(--text-muted)">${formatINR(totalApprovedSpend)} total value</span>
      </div>
    </div>

    <!-- Purchases History Table Card -->
    <div class="card" style="margin-bottom:16px;">
      <div class="card-header">
        <div>
          <div class="card-title">🧾 Purchase & Bill Submissions (${purchases.length})</div>
          <small style="color:var(--text-muted)">All historical bills submitted by ${m.name}</small>
        </div>
        ${pendingPurchases.length > 0 ? `<span class="badge badge-pending">${pendingPurchases.length} Pending Verification</span>` : ''}
      </div>
      <div class="table-responsive">
        <table>
          <thead>
            <tr>
              <th>Bill ID</th>
              <th>Date</th>
              <th>Customer Details</th>
              <th>Products / Items</th>
              <th>Total Amount</th>
              <th>Status</th>
              <th>Points Awarded</th>
              <th>Receipt</th>
              <th>Send Alert</th>
            </tr>
          </thead>
          <tbody>
            ${purchases.length === 0 ? `
              <tr><td colspan="9" style="text-align:center;padding:24px;color:var(--text-muted);">No purchases submitted yet.</td></tr>
            ` : purchases.map(p => `
              <tr>
                <td><b>#${p.id}</b></td>
                <td>${p.purchase_date}</td>
                <td>
                  <b>${p.customer_name}</b><br>
                  <small style="color:var(--text-muted)">${p.customer_phone}</small><br>
                  <small style="color:var(--text-muted)">${p.customer_address}</small>
                </td>
                <td>${(p.items || []).map(i => `${i.product_name} (${i.quantity} ${i.unit})`).join('<br>') || '-'}</td>
                <td><b style="font-size:14px;">${formatINR(p.total_amount)}</b></td>
                <td>
                  <span class="badge badge-${p.status.toLowerCase()}">${p.status}</span>
                  ${p.rejection_reason ? `<br><small style="color:var(--danger)">Reason: ${p.rejection_reason}</small>` : ''}
                  ${p.correction_message ? `<br><small style="color:var(--warning)">Msg: ${p.correction_message}</small>` : ''}
                </td>
                <td><b style="color:${p.points_awarded ? 'var(--success)' : 'inherit'};">${p.points_awarded !== null ? `+${p.points_awarded} pts` : '-'}</b></td>
                <td>
                  ${p.bill_file_url ? `
                    <button class="btn btn-secondary btn-sm" onclick="openBillViewerModal('${p.bill_file_url}', ${p.id})">🖼️ View Bill</button>
                  ` : '<span style="color:var(--text-muted);font-size:12px;">No photo</span>'}
                </td>
                <td>
                  <button class="btn btn-secondary btn-sm" style="background:#DCFCE7;color:#166534;" onclick="triggerSendWorkerNotification(${p.id})">
                    💬 WhatsApp
                  </button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Points Ledger & Audit Trail -->
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">📜 Points Transaction Ledger & History</div>
          <small style="color:var(--text-muted)">Complete chronological audit statement of credits, debits, reversals, and adjustments</small>
        </div>
      </div>
      <div class="table-responsive">
        <table>
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Transaction Type</th>
              <th>Description / Reason</th>
              <th>Points Change</th>
              <th>Balance After</th>
              <th>Auditor / System Actor</th>
            </tr>
          </thead>
          <tbody>
            ${ledger.length === 0 ? `
              <tr><td colspan="6" style="text-align:center;padding:24px;color:var(--text-muted);">No transaction records found.</td></tr>
            ` : ledger.map(t => `
              <tr>
                <td>${t.created_at}</td>
                <td><span class="badge" style="background:#E2E8F0;">${t.type}</span></td>
                <td>
                  ${t.description}
                  ${t.reason ? `<br><small style="color:var(--text-muted)">Reason: ${t.reason}</small>` : ''}
                </td>
                <td><b style="font-size:14px;color:${t.points >= 0 ? 'var(--success)' : 'var(--danger)'};">${t.points > 0 ? '+' : ''}${t.points} pts</b></td>
                <td><b>${t.balance_after} pts</b></td>
                <td>${t.created_by || 'System'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

async function toggleMechanicStatusDetail(id) {
  try {
    await API.patch(`/api/mechanics/${id}/status`, {});
    showToast('Mechanic status updated', 'success');
    renderMechanicDetail(id);
  } catch (e) {}
}

// Modal: Manual Point Adjustment
function openAdjustPointsModal(mechId, mechName) {
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="closeModal()">
      <div class="modal-content" onclick="event.stopPropagation()">
        <div class="modal-header">
          <div class="card-title">Adjust Points: ${mechName}</div>
          <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        <form onsubmit="handleAdjustPointsSubmit(event, ${mechId})">
          <div class="form-group">
            <label>Points to Add or Deduct</label>
            <input type="number" id="adj-points" required placeholder="e.g. +100 or -50">
            <small style="color:var(--text-muted)">Enter positive number to credit, negative to deduct.</small>
          </div>
          <div class="form-group">
            <label>Adjustment Reason</label>
            <select id="adj-reason">
              <option>Promotional Bonus</option>
              <option>Correction for Audit Discrepancy</option>
              <option>Customer Service Adjustment</option>
              <option>System Error Resolution</option>
              <option>Other</option>
            </select>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">
            <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
            <button type="submit" class="btn btn-primary">Apply Adjustment</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

async function handleAdjustPointsSubmit(e, mechId) {
  e.preventDefault();
  const pts = parseInt(document.getElementById('adj-points').value, 10);
  const reason = document.getElementById('adj-reason').value;

  try {
    await API.post(`/api/mechanics/${mechId}/adjust-points`, { points: pts, reason });
    showToast('Points adjusted successfully', 'success');
    closeModal();
    renderMechanicDetail(mechId);
  } catch (err) {}
}

/* =========================================================================
   PURCHASES AUDIT & LIST VIEW
   ========================================================================= */

async function renderPurchasesList() {
  const main = document.getElementById('main-content');
  const res = await API.get('/api/purchases');
  const purchases = res.purchases || [];

  main.innerHTML = `
    <div class="top-bar">
      <div>
        <h1 class="page-title">🧾 Purchases & Bill Records</h1>
        <p style="font-size:13px;color:var(--text-muted)">Historical bills, verified status, and reward allocation</p>
      </div>
      <div class="top-actions">
        <a href="/api/reports/export-purchases-csv" download class="btn btn-secondary btn-sm">📊 Export CSV</a>
        <button class="btn btn-primary btn-sm" onclick="navigate('submit_purchase')">+ Submit New Bill</button>
      </div>
    </div>

    <div class="card" style="padding:0;">
      <div class="table-responsive">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Date</th>
              <th>Mechanic</th>
              <th>Customer</th>
              <th>Items</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Points</th>
              <th>Bill</th>
              <th>Notify Worker</th>
            </tr>
          </thead>
          <tbody>
            ${purchases.length === 0 ? `<tr><td colspan="10">No purchase records found.</td></tr>` : purchases.map(p => `
              <tr>
                <td><b>#${p.id}</b></td>
                <td>${p.purchase_date}</td>
                <td><b>${p.mechanic_name}</b><br><small style="color:var(--text-muted)">${p.trade_type}</small></td>
                <td>${p.customer_name}<br><small style="color:var(--text-muted)">${p.customer_phone}</small></td>
                <td>${(p.items || []).map(i => `${i.product_name} (${i.quantity} ${i.unit})`).join('<br>') || '-'}</td>
                <td><b>${formatINR(p.total_amount)}</b></td>
                <td><span class="badge badge-${p.status.toLowerCase()}">${p.status}</span></td>
                <td><b>${p.points_awarded !== null ? p.points_awarded : '-'}</b></td>
                <td>
                  ${p.bill_file_url ? `<button class="btn btn-secondary btn-sm" onclick="openBillViewerModal('${p.bill_file_url}', ${p.id})">View</button>` : '-'}
                </td>
                <td>
                  <button class="btn btn-secondary btn-sm" style="background:#DCFCE7;color:#166534;" onclick="triggerSendWorkerNotification(${p.id})">
                    💬 WhatsApp
                  </button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

/* =========================================================================
   RETURNS & REVERSALS VIEW
   ========================================================================= */

/* =========================================================================
   RETURNS, REVERSALS & REPLACEMENTS VIEW & PROCESSOR
   ========================================================================= */

async function renderReturnsView() {
  const main = document.getElementById('main-content');
  
  // Fetch both processed returns and all purchases
  const [retRes, purRes] = await Promise.all([
    API.get('/api/returns'),
    API.get('/api/purchases')
  ]);

  const returns = retRes.returns || [];
  const purchases = (purRes.purchases || []).filter(p => p.status === 'APPROVED');
  const isAdminOrAuditor = AppState.user.role === 'admin' || AppState.user.role === 'auditor';

  main.innerHTML = `
    <div class="top-bar">
      <div>
        <h1 class="page-title">↩️ Product Returns, Reversals & Exchanges</h1>
        <p style="font-size:13px;color:var(--text-muted)">
          Search verified purchases to process customer item returns, product replacements, and automatic points adjustments for workers.
        </p>
      </div>
    </div>

    <!-- Section 1: Search Purchases to Process Return/Exchange -->
    <div class="card" style="margin-bottom:20px;border-left:4px solid var(--accent);">
      <div class="card-header" style="margin-bottom:12px;">
        <div>
          <div class="card-title">🔍 Search Customer Purchases for Return / Replacement</div>
          <small style="color:var(--text-muted)">Find any approved bill by Customer Name, Mechanic Name, Phone, Address, or Bill ID</small>
        </div>
      </div>

      <div class="form-group" style="margin-bottom:14px;">
        <input 
          type="text" 
          id="return-search-input" 
          placeholder="🔎 Type Customer Name, Mechanic Name, Phone Number, Bill ID (e.g. #102), or Product..." 
          style="font-size:15px;padding:12px 14px;border:2px solid var(--border-focus);"
          oninput="filterReturnsPurchases(this.value)"
          autofocus
        >
      </div>

      <div class="table-responsive">
        <table id="return-search-table">
          <thead>
            <tr>
              <th>Bill ID</th>
              <th>Date</th>
              <th>Customer Details</th>
              <th>Referenced Mechanic</th>
              <th>Items Billed</th>
              <th>Bill Amount</th>
              <th>Points</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            ${purchases.length === 0 ? `
              <tr><td colspan="8" style="text-align:center;padding:24px;color:var(--text-muted);">No approved purchases found to process returns.</td></tr>
            ` : purchases.map(p => {
              const itemSummary = (p.items || []).map(i => `${i.product_name} (${i.quantity} ${i.unit})`).join(', ') || 'General purchase';
              const searchKey = `${p.id} ${p.customer_name} ${p.customer_phone || ''} ${p.customer_address || ''} ${p.mechanic_name} ${p.mechanic_phone || ''} ${p.trade_type || ''} ${itemSummary}`.toLowerCase();
              return `
                <tr data-search="${searchKey}" class="return-purchase-row">
                  <td><b style="font-size:14px;color:var(--primary);">#${p.id}</b></td>
                  <td>${p.purchase_date}</td>
                  <td>
                    <b>${p.customer_name}</b><br>
                    <small style="color:var(--text-muted)">${p.customer_phone || 'No phone'}</small>
                    ${p.customer_address ? `<br><small style="color:var(--text-muted)">📍 ${p.customer_address}</small>` : ''}
                  </td>
                  <td>
                    <b>${p.mechanic_name}</b><br>
                    <span class="badge" style="background:#E0F2FE;color:#0284C7;font-size:11px;">${p.trade_type || 'Worker'}</span>
                    <small style="color:var(--text-muted);">${p.mechanic_phone ? ` · 📞 ${p.mechanic_phone}` : ''}</small>
                  </td>
                  <td><small>${itemSummary}</small></td>
                  <td><b style="font-size:14px;color:var(--primary);">${formatINR(p.total_amount)}</b></td>
                  <td><b style="color:var(--success);">+${p.points_awarded || 0} pts</b></td>
                  <td>
                    <button class="btn btn-primary btn-sm" onclick="navigate('process_return', ${p.id})" style="white-space:nowrap;">
                      ↩️ Process Return / Exchange ➔
                    </button>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Section 2: Processed Returns & Adjustments Audit Log -->
    <div class="card">
      <div class="card-header" style="margin-bottom:12px;">
        <div>
          <div class="card-title">📜 Processed Returns & Points Reversal History (${returns.length})</div>
          <small style="color:var(--text-muted)">Complete log of all customer returns, replacements, points debits/credits, and worker recovery</small>
        </div>
      </div>

      <div class="table-responsive">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Bill ID</th>
              <th>Referenced Worker</th>
              <th>Customer</th>
              <th>Returned Items</th>
              <th>Replacement Items</th>
              <th>Net Bill</th>
              <th>Points Change</th>
              <th>Recovery Pending</th>
              <th>Reason</th>
              <th>Processed By</th>
              <th>Worker Alert</th>
            </tr>
          </thead>
          <tbody>
            ${returns.length === 0 ? `
              <tr><td colspan="12" style="text-align:center;padding:24px;color:var(--text-muted);">No product returns recorded yet.</td></tr>
            ` : returns.map(r => `
              <tr>
                <td>${r.return_date}</td>
                <td>
                  <a onclick="navigate('process_return', ${r.purchase_id})" style="font-weight:700;color:var(--accent);cursor:pointer;text-decoration:underline;">
                    #${r.purchase_id}
                  </a>
                </td>
                <td>
                  <b>${r.mechanic_name}</b><br>
                  <small style="color:var(--text-muted)">${r.trade_type || ''}</small>
                </td>
                <td>${r.customer_name}</td>
                <td>
                  <span style="color:var(--danger);font-weight:600;">${r.items_summary || '-'}</span>
                  ${r.returned_value > 0 ? `<br><small style="color:var(--danger)">(-${formatINR(r.returned_value)})</small>` : ''}
                </td>
                <td>
                  <span style="color:var(--success);font-weight:600;">${r.replacement_summary || '-'}</span>
                  ${r.replacement_value > 0 ? `<br><small style="color:var(--success)">(+${formatINR(r.replacement_value)})</small>` : ''}
                </td>
                <td><b>${formatINR(r.updated_net_amount || (r.original_amount - (r.returned_value || 0) + (r.replacement_value || 0)))}</b></td>
                <td>
                  ${r.points_change !== undefined && r.points_change !== null ? `
                    <b style="font-size:14px;color:${r.points_change > 0 ? 'var(--success)' : r.points_change < 0 ? 'var(--danger)' : 'var(--text-muted)'};">
                      ${r.points_change > 0 ? `+${r.points_change}` : r.points_change} pts
                    </b>
                  ` : `
                    <b style="color:var(--danger)">-${r.points_reversed} pts</b>
                  `}
                </td>
                <td>${r.points_under_recovery > 0 ? `<b style="color:var(--danger)">${r.points_under_recovery} pts</b>` : '<span style="color:var(--text-muted)">None</span>'}</td>
                <td>${r.reason}</td>
                <td><small style="color:var(--text-muted)">${r.processed_by || 'Admin'}</small></td>
                <td>
                  <button class="btn btn-secondary btn-sm" style="background:#DCFCE7;color:#166534;font-size:11px;padding:3px 8px;" onclick="triggerSendWorkerNotification(${r.purchase_id})">
                    💬 WhatsApp
                  </button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function filterReturnsPurchases(query) {
  const q = query.toLowerCase().trim();
  const rows = document.querySelectorAll('#return-search-table tbody .return-purchase-row');
  let matchCount = 0;
  rows.forEach(r => {
    const text = r.getAttribute('data-search') || '';
    const match = text.includes(q);
    r.style.display = match ? '' : 'none';
    if (match) matchCount++;
  });
}

/* =========================================================================
   PROCESS RETURN & REPLACEMENT PAGE (DEDICATED DETAIL VIEW)
   ========================================================================= */

async function renderProcessReturn(purchaseId) {
  const main = document.getElementById('main-content');
  
  const [purRes, prodsRes] = await Promise.all([
    API.get(`/api/purchases/${purchaseId}`),
    API.get('/api/products')
  ]);

  const p = purRes.purchase;
  const products = prodsRes.products || [];
  window._availableProductsForReturn = products;
  window._currentPurchaseForReturn = p;

  const items = p.items || [];
  const origAmount = Number(p.total_amount || 0);
  const origPoints = p.points_awarded !== null ? p.points_awarded : Math.round(origAmount * 3 / 100);

  main.innerHTML = `
    <div class="top-bar">
      <div>
        <div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
          <button class="btn btn-secondary btn-sm" onclick="navigate('returns')">← Back to Returns & Reversals</button>
          <button class="btn btn-secondary btn-sm" onclick="navigate('purchases')">🧾 Purchases Directory</button>
        </div>
        <div style="display:flex;align-items:center;gap:10px;margin-top:4px;flex-wrap:wrap;">
          <h1 class="page-title" style="margin:0;">↩️ Process Return / Replacement for Bill #${p.id}</h1>
          <span class="badge badge-approved">VERIFIED & APPROVED</span>
        </div>
        <p style="font-size:13px;color:var(--text-muted);margin-top:4px;">
          Adjust customer items, record replacements, and automatically recalculate points for referenced worker <b>${p.mechanic_name}</b>.
        </p>
      </div>
      <div class="top-actions">
        <a href="tel:${p.mechanic_phone}" class="btn btn-secondary btn-sm">📞 Call ${p.mechanic_name}</a>
        <a href="https://wa.me/91${p.mechanic_phone}" target="_blank" class="btn btn-secondary btn-sm" style="background:#DCFCE7;color:#166534;">💬 WhatsApp Worker</a>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:340px 1fr;gap:20px;align-items:start;" class="return-layout-grid">
      
      <!-- Left Column: Bill & Worker Summary Card -->
      <div>
        <div class="card" style="margin-bottom:16px;">
          <div class="card-title" style="margin-bottom:12px;">👤 Customer Details</div>
          <div style="font-size:14px;line-height:1.6;">
            <b>Name:</b> ${p.customer_name}<br>
            <b>Phone:</b> ${p.customer_phone || '<span style="color:var(--text-muted)">Not provided</span>'}<br>
            <b>Address:</b> ${p.customer_address || '<span style="color:var(--text-muted)">Not provided</span>'}<br>
            <b>Purchase Date:</b> ${p.purchase_date}
          </div>
        </div>

        <div class="card" style="margin-bottom:16px;">
          <div class="card-title" style="margin-bottom:12px;">👷 Referenced Worker</div>
          <div style="font-size:14px;line-height:1.6;">
            <b>Name:</b> <a onclick="navigate('mechanic_detail', ${p.mechanic_id})" style="color:var(--accent);font-weight:700;cursor:pointer;">${p.mechanic_name} ➔</a><br>
            <b>Trade:</b> ${p.trade_type || 'Worker'}<br>
            <b>User ID:</b> ${p.mechanic_uid}<br>
            <b>Phone:</b> ${p.mechanic_phone}<br>
            <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);">
              <b>Available Points:</b> <span id="worker-curr-points" style="color:var(--primary);font-weight:700;font-size:15px;">${p.available_points} pts</span><br>
              ${p.recovery_points > 0 ? `<b>Recovery Pending:</b> <span style="color:var(--danger);font-weight:700;">${p.recovery_points} pts</span><br>` : ''}
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-title" style="margin-bottom:12px;">🧾 Original Bill Details</div>
          <div style="font-size:14px;line-height:1.6;">
            <b>Bill Number:</b> #${p.id}<br>
            <b>Original Bill Amount:</b> <span style="font-size:16px;font-weight:700;color:var(--primary);">${formatINR(origAmount)}</span><br>
            <b>Points Awarded:</b> <span style="color:var(--success);font-weight:700;">+${origPoints} pts</span><br>
            ${p.bill_file_url ? `
              <div style="margin-top:12px;">
                <button class="btn btn-secondary btn-sm" style="width:100%;" onclick="openBillViewerModal('${p.bill_file_url}', ${p.id})">🖼️ View Uploaded Receipt</button>
              </div>
            ` : '<small style="color:var(--text-muted);display:block;margin-top:8px;">No bill photo attached</small>'}
          </div>
        </div>
      </div>

      <!-- Right Column: Interactive Return & Replacement Form -->
      <div>
        <form id="process-return-form" onsubmit="handleProcessReturnSubmit(event, ${p.id})">
          
          <!-- Block 1: Items to Return / Reverse -->
          <div class="card" style="margin-bottom:16px;">
            <div class="card-header" style="margin-bottom:8px;">
              <div>
                <div class="card-title" style="color:var(--danger);">↩️ 1. Items to Return / Reverse</div>
                <small style="color:var(--text-muted)">Select original items being returned by the customer and enter returned monetary value</small>
              </div>
            </div>

            ${items.length === 0 ? `
              <p style="font-size:13px;color:var(--text-muted);margin-bottom:10px;">No individual line items registered. Enter the total returned monetary value below:</p>
              <div class="form-group">
                <label>Returned Items Monetary Value (₹)</label>
                <input type="number" id="manual-return-val" min="0" step="any" placeholder="e.g. 500" oninput="recalculateReturnMath()">
              </div>
            ` : `
              <div id="return-items-list">
                ${items.map((it, idx) => {
                  const maxReturn = Math.max(0, it.quantity - (it.returned_quantity || 0));
                  return `
                    <div class="return-item-card" data-item-id="${it.id}">
                      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                        <div>
                          <b style="font-size:14px;color:var(--primary);">${it.product_name}</b>
                          <div style="font-size:12px;color:var(--text-muted);">
                            Billed Qty: <b>${it.quantity} ${it.unit}</b>
                            ${it.returned_quantity > 0 ? `· Already Returned: <span style="color:var(--danger);">${it.returned_quantity} ${it.unit}</span>` : ''}
                            · Remaining: <b>${maxReturn} ${it.unit}</b>
                          </div>
                        </div>
                      </div>

                      <div class="form-row">
                        <div class="form-group" style="margin-bottom:0;">
                          <label style="font-size:12px;">Return Quantity (${it.unit})</label>
                          <input 
                            type="number" 
                            class="ret-line-qty" 
                            min="0" 
                            max="${maxReturn}" 
                            step="any" 
                            value="0" 
                            placeholder="0" 
                            oninput="recalculateReturnMath()"
                          >
                        </div>
                        <div class="form-group" style="margin-bottom:0;">
                          <label style="font-size:12px;">Returned Monetary Value (₹)</label>
                          <input 
                            type="number" 
                            class="ret-line-val" 
                            min="0" 
                            step="any" 
                            placeholder="Value to deduct ₹" 
                            oninput="recalculateReturnMath()"
                          >
                        </div>
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>

              <div class="form-group" style="margin-top:12px;">
                <label style="font-size:12px;color:var(--text-muted);">Additional / General Returned Value (₹) (If any)</label>
                <input type="number" id="manual-return-val" min="0" step="any" placeholder="0" oninput="recalculateReturnMath()">
              </div>
            `}
          </div>

          <!-- Block 2: Replacement / Exchange Items (New Items Added) -->
          <div class="card" style="margin-bottom:16px;">
            <div class="card-header" style="margin-bottom:8px;">
              <div>
                <div class="card-title" style="color:var(--success);">🔄 2. Replacement / Exchange Items (New Items Added)</div>
                <small style="color:var(--text-muted)">If the customer exchanged returned items for new products, add replacement items below</small>
              </div>
              <button type="button" class="btn btn-secondary btn-sm" onclick="addReplacementItemRow()">+ Add Replacement Item</button>
            </div>

            <div id="replacement-items-container">
              <!-- Dynamic replacement rows will appear here -->
            </div>
            
            <p id="no-rep-msg" style="font-size:12px;color:var(--text-muted);font-style:italic;margin-top:4px;">
              No replacement items added yet. Click "+ Add Replacement Item" above if this is an exchange.
            </p>
          </div>

          <!-- Block 3: Real-Time Dynamic Net Bill & Points Calculator -->
          <div class="calc-summary-card">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <span style="font-size:14px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;">📊 Real-Time Adjustment Breakdown</span>
              <span class="badge" style="background:rgba(255,255,255,0.2);color:#fff;font-size:11px;">Automatic Rate: 3 pts per ₹100</span>
            </div>

            <div class="calc-summary-grid">
              <div class="calc-summary-item">
                <span class="calc-summary-label">Original Bill</span>
                <span class="calc-summary-val neutral" id="calc-orig-amt">${formatINR(origAmount)}</span>
              </div>

              <div class="calc-summary-item">
                <span class="calc-summary-label">Returned Value (-)</span>
                <span class="calc-summary-val neg" id="calc-ret-val">- ₹0</span>
              </div>

              <div class="calc-summary-item">
                <span class="calc-summary-label">Replacement Value (+)</span>
                <span class="calc-summary-val pos" id="calc-rep-val">+ ₹0</span>
              </div>

              <div class="calc-summary-item">
                <span class="calc-summary-label">Updated Net Bill</span>
                <span class="calc-summary-val" id="calc-net-amt" style="color:#FBBF24;">${formatINR(origAmount)}</span>
              </div>
            </div>

            <div style="margin-top:14px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.15);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
              <div>
                <span style="font-size:12px;color:#94A3B8;">Worker Points Impact:</span>
                <div id="calc-points-change" style="font-size:20px;font-weight:800;color:#94A3B8;">0 Points</div>
              </div>
              <div style="text-align:right;">
                <span style="font-size:12px;color:#94A3B8;">Estimated New Worker Balance:</span>
                <div id="calc-new-balance" style="font-size:18px;font-weight:700;color:#38BDF8;">${p.available_points} Points</div>
              </div>
            </div>
            <div id="calc-recovery-notice" style="display:none;margin-top:8px;font-size:12px;color:#FCA5A5;background:rgba(220,38,38,0.2);padding:6px 10px;border-radius:4px;"></div>
          </div>

          <!-- Block 4: Reason & Confirmation Submit -->
          <div class="card" style="margin-top:16px;">
            <div class="form-group">
              <label>Reason for Return / Replacement / Point Adjustment <span style="color:var(--danger)">*</span></label>
              <textarea 
                id="return-reason" 
                rows="3" 
                required 
                placeholder="e.g. Customer returned 2 defective pipes, exchanged with heavy duty fittings, difference adjusted in bill..."
              ></textarea>
            </div>

            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:16px;flex-wrap:wrap;gap:12px;">
              <button type="button" class="btn btn-secondary" onclick="navigate('returns')">Cancel</button>
              <button type="submit" class="btn btn-primary btn-lg" id="submit-return-btn">
                💾 Process Return & Adjust Points
              </button>
            </div>
          </div>

        </form>
      </div>

    </div>
  `;
}

function addReplacementItemRow() {
  const container = document.getElementById('replacement-items-container');
  const noMsg = document.getElementById('no-rep-msg');
  if (noMsg) noMsg.style.display = 'none';
  if (!container) return;

  const rowId = 'rep_row_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
  const products = window._availableProductsForReturn || [];

  const div = document.createElement('div');
  div.id = rowId;
  div.className = 'rep-item-card';
  div.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <b style="font-size:13px;color:var(--success);">✨ New Replacement Item</b>
      <button type="button" class="btn btn-danger btn-sm" style="padding:2px 6px;font-size:11px;" onclick="removeReplacementRow('${rowId}')">✕ Remove</button>
    </div>
    
    <div class="form-row" style="margin-bottom:8px;">
      <div style="flex:2;">
        <label style="font-size:11px;font-weight:600;">Product Name / Item</label>
        <input type="text" class="rep-prod-name" placeholder="Item Name (e.g. 1-inch Brass Valve)" list="rep-prods-list" required oninput="recalculateReturnMath()">
        <datalist id="rep-prods-list">
          ${products.map(pr => `<option value="${pr.name}">${pr.category || ''} (${pr.unit})</option>`).join('')}
        </datalist>
      </div>
      <div style="flex:1;">
        <label style="font-size:11px;font-weight:600;">Quantity</label>
        <input type="number" class="rep-prod-qty" min="0" step="any" value="1" placeholder="Qty" oninput="recalculateReturnMath()">
      </div>
      <div style="flex:0.8;">
        <label style="font-size:11px;font-weight:600;">Unit</label>
        <input type="text" class="rep-prod-unit" value="Piece" placeholder="Unit">
      </div>
    </div>

    <div class="form-group" style="margin-bottom:0;">
      <label style="font-size:11px;font-weight:600;">Replacement Item Value (₹)</label>
      <input type="number" class="rep-prod-val" min="0" step="any" placeholder="Price of new item ₹" required oninput="recalculateReturnMath()">
    </div>
  `;

  container.appendChild(div);
  recalculateReturnMath();
}

function removeReplacementRow(rowId) {
  const el = document.getElementById(rowId);
  if (el) el.remove();
  const container = document.getElementById('replacement-items-container');
  const noMsg = document.getElementById('no-rep-msg');
  if (container && container.children.length === 0 && noMsg) {
    noMsg.style.display = 'block';
  }
  recalculateReturnMath();
}

function recalculateReturnMath() {
  const p = window._currentPurchaseForReturn;
  if (!p) return;

  const origAmount = Number(p.total_amount || 0);
  const currWorkerPts = Number(p.available_points || 0);

  // 1. Calculate Returned Monetary Value
  let totalReturnedVal = 0;
  const lineValInputs = document.querySelectorAll('.ret-line-val');
  lineValInputs.forEach(inp => {
    totalReturnedVal += parseFloat(inp.value) || 0;
  });
  const manualRet = parseFloat(document.getElementById('manual-return-val')?.value) || 0;
  totalReturnedVal += manualRet;

  // 2. Calculate Replacement Monetary Value
  let totalReplacementVal = 0;
  const repValInputs = document.querySelectorAll('.rep-prod-val');
  repValInputs.forEach(inp => {
    totalReplacementVal += parseFloat(inp.value) || 0;
  });

  // 3. Updated Net Bill Amount
  const updatedNetAmount = Math.max(0, origAmount - totalReturnedVal + totalReplacementVal);

  // 4. Net Points Change (Formula: net value difference * 3 points per ₹100)
  const netValueChange = totalReplacementVal - totalReturnedVal;
  let pointsChange = 0;
  if (totalReturnedVal > 0 || totalReplacementVal > 0) {
    pointsChange = Math.round(netValueChange * 3 / 100);
  }

  // 5. Worker points balance calculation
  let newBalance = currWorkerPts;
  let recoveryMsg = '';

  if (pointsChange < 0) {
    const toDeduct = Math.abs(pointsChange);
    if (toDeduct <= currWorkerPts) {
      newBalance = currWorkerPts - toDeduct;
    } else {
      newBalance = 0;
      const underRecovery = toDeduct - currWorkerPts;
      recoveryMsg = `⚠️ Deduction (${toDeduct} pts) exceeds available balance (${currWorkerPts} pts). Remaining ${underRecovery} pts will be marked for Recovery from future bills.`;
    }
  } else if (pointsChange > 0) {
    newBalance = currWorkerPts + pointsChange;
  }

  // Update UI Elements
  const elRet = document.getElementById('calc-ret-val');
  const elRep = document.getElementById('calc-rep-val');
  const elNet = document.getElementById('calc-net-amt');
  const elPts = document.getElementById('calc-points-change');
  const elBal = document.getElementById('calc-new-balance');
  const elRec = document.getElementById('calc-recovery-notice');

  if (elRet) elRet.textContent = `- ₹${totalReturnedVal.toLocaleString('en-IN')}`;
  if (elRep) elRep.textContent = `+ ₹${totalReplacementVal.toLocaleString('en-IN')}`;
  if (elNet) elNet.textContent = `₹${updatedNetAmount.toLocaleString('en-IN')}`;

  if (elPts) {
    if (pointsChange > 0) {
      elPts.textContent = `+${pointsChange} Points (Increment)`;
      elPts.style.color = '#4ADE80';
    } else if (pointsChange < 0) {
      elPts.textContent = `${pointsChange} Points (Decrement)`;
      elPts.style.color = '#F87171';
    } else {
      elPts.textContent = `0 Points (No change)`;
      elPts.style.color = '#94A3B8';
    }
  }

  if (elBal) {
    elBal.textContent = `${newBalance} Points`;
  }

  if (elRec) {
    if (recoveryMsg) {
      elRec.textContent = recoveryMsg;
      elRec.style.display = 'block';
    } else {
      elRec.style.display = 'none';
    }
  }
}

async function handleProcessReturnSubmit(e, purchaseId) {
  e.preventDefault();
  const btn = document.getElementById('submit-return-btn');

  // Collect returned line items
  const returnedItems = [];
  const retCards = document.querySelectorAll('.return-item-card');
  retCards.forEach(card => {
    const itemId = parseInt(card.getAttribute('data-item-id'), 10);
    const qty = parseFloat(card.querySelector('.ret-line-qty')?.value) || 0;
    const val = parseFloat(card.querySelector('.ret-line-val')?.value) || 0;
    if (qty > 0 || val > 0) {
      returnedItems.push({
        itemId,
        returnedQuantity: qty,
        returnedValue: val
      });
    }
  });

  // Collect replacement items
  const replacementItems = [];
  const repCards = document.querySelectorAll('.rep-item-card');
  repCards.forEach(card => {
    const name = card.querySelector('.rep-prod-name')?.value.trim();
    const qty = parseFloat(card.querySelector('.rep-prod-qty')?.value) || 1;
    const unit = card.querySelector('.rep-prod-unit')?.value.trim() || 'Piece';
    const price = parseFloat(card.querySelector('.rep-prod-val')?.value) || 0;
    if (name) {
      replacementItems.push({
        productName: name,
        quantity: qty,
        unit,
        price
      });
    }
  });

  // Calculate totals
  let returnedValue = 0;
  returnedItems.forEach(r => returnedValue += (r.returnedValue || 0));
  const manualRet = parseFloat(document.getElementById('manual-return-val')?.value) || 0;
  returnedValue += manualRet;

  let replacementValue = 0;
  replacementItems.forEach(r => replacementValue += (r.price || 0));

  const reason = document.getElementById('return-reason').value.trim();

  if (returnedItems.length === 0 && replacementItems.length === 0 && returnedValue <= 0 && replacementValue <= 0) {
    return showToast('Please enter return quantities/values or add replacement items', 'error');
  }

  if (!reason) {
    return showToast('Please provide a reason for the return / replacement', 'error');
  }

  btn.disabled = true;
  btn.textContent = 'Processing Return & Points Adjustment...';

  try {
    const payload = {
      returnedItems,
      replacementItems,
      returnedValue,
      replacementValue,
      reason
    };

    const res = await API.post(`/api/purchases/${purchaseId}/return`, payload);
    showToast('Return & points adjustment processed successfully!', 'success');

    // Automatically trigger WhatsApp and SMS notification popup for worker
    if (res.notification) {
      showWorkerNotificationModal(res.notification, () => {
        navigate('returns');
      });
    } else {
      navigate('returns');
    }
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '💾 Process Return & Adjust Points';
  }
}


/* =========================================================================
   REWARDS & REDEMPTIONS VIEW
   ========================================================================= */

/* =========================================================================
   REWARDS & REDEMPTIONS VIEW & MANAGEMENT
/* =========================================================================
   REWARDS & REDEMPTIONS VIEW & MANAGEMENT (TRADE-TARGETED VISIBILITY)
   ========================================================================= */

async function renderRewardsView() {
  const main = document.getElementById('main-content');
  const rewRes = await API.get('/api/rewards');
  const rewards = rewRes.rewards || [];
  const isMechanic = AppState.user.role === 'mechanic';
  const isAdmin = AppState.user.role === 'admin';

  let mechPoints = 0;
  let mechTrade = 'Worker';
  if (isMechanic && AppState.user.mechanic) {
    mechPoints = AppState.user.mechanic.available_points || 0;
    mechTrade = AppState.user.mechanic.trade_type || 'General';
  }

  // Store rewards globally for admin preview filtering
  window._adminCatalogRewards = rewards;

  main.innerHTML = `
    <div class="top-bar">
      <div>
        <h1 class="page-title">🎁 Rewards Catalog</h1>
        <p style="font-size:13px;color:var(--text-muted)">
          ${isMechanic ? `
            Your Available Balance: <b style="color:var(--primary);font-size:16px;">${mechPoints} pts</b> · Trade Category: <span class="badge" style="background:#E0F2FE;color:#0284C7;font-weight:700;">${mechTrade}</span>
          ` : 'Configure rewards catalog, point values, inventory, and category-targeted visibility'}
        </p>
      </div>
      <div class="top-actions">
        ${isAdmin ? `<button class="btn btn-primary btn-sm" onclick="openAddRewardModal()">+ Add Reward Item</button>` : ''}
      </div>
    </div>

    ${isAdmin ? `
      <!-- Admin Visibility Filter & Preview Bar -->
      <div class="card" style="margin-bottom:16px;padding:12px;">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
          <div style="font-size:13px;font-weight:700;color:var(--primary);display:flex;align-items:center;gap:6px;">
            <span>👁️ Filter View by Worker Category:</span>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;" id="reward-filter-pills">
            <button class="btn btn-sm btn-primary pill-filter active" data-filter="ALL" onclick="filterAdminRewards('ALL')">All Rewards (${rewards.length})</button>
            <button class="btn btn-sm btn-secondary pill-filter" data-filter="all_trades" onclick="filterAdminRewards('all_trades')">🌟 Visible to All</button>
            ${TRADE_TYPES.map(t => {
              const count = rewards.filter(r => (r.eligible_types || []).includes('all') || (r.eligible_types || []).includes(t)).length;
              return `<button class="btn btn-sm btn-secondary pill-filter" data-filter="${t}" onclick="filterAdminRewards('${t}')">${t} (${count})</button>`;
            }).join('')}
          </div>
        </div>
      </div>
    ` : ''}

    <div id="rewards-grid-container" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;">
      ${renderRewardsCardsHtml(rewards, isMechanic, isAdmin, mechPoints, mechTrade)}
    </div>
  `;
}

function renderRewardsCardsHtml(rewardsList, isMechanic, isAdmin, mechPoints, mechTrade) {
  if (!rewardsList || rewardsList.length === 0) {
    return `
      <div class="card" style="grid-column:1/-1;text-align:center;padding:48px;">
        <p style="font-size:15px;color:var(--text-muted);margin-bottom:12px;">
          ${isMechanic ? `No reward items are currently assigned to the "${mechTrade}" category.` : 'No rewards found matching this category filter.'}
        </p>
        ${isAdmin ? `<button class="btn btn-primary btn-sm" onclick="openAddRewardModal()">+ Add New Reward</button>` : ''}
      </div>
    `;
  }

  return rewardsList.map(r => {
    const isAll = (r.eligible_types || []).includes('all');
    const isEligible = isMechanic ? ((isAll || (r.eligible_types || []).includes(mechTrade)) && mechPoints >= r.points_required && r.stock > 0) : true;
    
    return `
      <div class="card reward-item-card" data-eligible='${JSON.stringify(r.eligible_types || ["all"])}' style="display:flex;flex-direction:column;justify-content:space-between;border-top:3px solid ${r.is_active ? 'var(--accent)' : 'var(--border)'};">
        <div>
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
            <h3 style="font-size:16px;font-weight:700;color:var(--primary);margin:0;">${r.name}</h3>
            <span class="badge ${r.stock > 0 ? (r.is_active ? 'badge-active' : 'badge-inactive') : 'badge-inactive'}">
              ${r.stock > 0 ? `${r.stock} in stock` : 'Out of Stock'}
            </span>
          </div>
          
          <div style="margin:14px 0;">
            <span style="font-size:24px;font-weight:800;color:var(--accent);">${r.points_required.toLocaleString()}</span>
            <span style="font-size:13px;color:var(--text-muted);font-weight:600;margin-left:4px;">Points</span>
          </div>

          ${isAdmin ? `
            <div style="margin-top:8px;">
              ${isAll ? `
                <div style="font-size:12px;background:#DCFCE7;color:#166534;padding:8px 10px;border-radius:var(--radius-sm);border:1px solid #BBF7D0;">
                  <b>👁️ Visibility:</b> Visible to <b>ALL Trade Categories</b>
                </div>
              ` : `
                <div style="font-size:12px;background:#EFF6FF;color:#1D4ED8;padding:8px 10px;border-radius:var(--radius-sm);border:1px solid #BFDBFE;">
                  <b>👁️ Visible ONLY to:</b> <b>${(r.eligible_types || []).join(', ')}</b>
                  <div style="font-size:11px;color:#DC2626;margin-top:2px;font-weight:600;">🚫 Hidden from other trade workers</div>
                </div>
              `}
            </div>
          ` : `
            <div style="font-size:12px;color:var(--text-muted);background:#F8FAFC;padding:8px 10px;border-radius:var(--radius-sm);">
              <b>Eligible:</b> ${isAll ? '🌟 All Trade Categories' : (r.eligible_types || []).join(', ')}
            </div>
          `}
        </div>

        <div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--border);">
          ${isMechanic ? `
            <button class="btn btn-primary" style="width:100%;" ${!isEligible ? 'disabled' : ''} onclick="handleRedeemRequest(${r.id}, '${r.name}')">
              ${r.stock < 1 ? 'Out of Stock' : mechPoints < r.points_required ? `Need ${r.points_required - mechPoints} more pts` : 'Claim Reward'}
            </button>
          ` : `
            <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;">
              <div style="display:flex;gap:6px;">
                <button class="btn btn-secondary btn-sm" onclick="openEditRewardModal(${r.id}, '${r.name.replace(/'/g, "\\'")}', ${r.points_required}, ${r.stock}, ${JSON.stringify(r.eligible_types).replace(/"/g, '&quot;')})">✏️ Edit Visibility</button>
                <button class="btn btn-secondary btn-sm" onclick="toggleRewardActive(${r.id})">${r.is_active ? 'Deactivate' : 'Activate'}</button>
              </div>
              <button class="btn btn-danger btn-sm" onclick="deleteReward(${r.id}, '${r.name.replace(/'/g, "\\'")}')" title="Delete reward">🗑️</button>
            </div>
          `}
        </div>
      </div>
    `;
  }).join('');
}

function filterAdminRewards(category) {
  const allRewards = window._adminCatalogRewards || [];
  const pills = document.querySelectorAll('#reward-filter-pills .pill-filter');
  pills.forEach(p => {
    if (p.getAttribute('data-filter') === category) {
      p.className = 'btn btn-sm btn-primary pill-filter active';
    } else {
      p.className = 'btn btn-sm btn-secondary pill-filter';
    }
  });

  let filtered = [];
  if (category === 'ALL') {
    filtered = allRewards;
  } else if (category === 'all_trades') {
    filtered = allRewards.filter(r => (r.eligible_types || []).includes('all'));
  } else {
    filtered = allRewards.filter(r => (r.eligible_types || []).includes('all') || (r.eligible_types || []).includes(category));
  }

  const container = document.getElementById('rewards-grid-container');
  if (container) {
    container.innerHTML = renderRewardsCardsHtml(filtered, false, true, 0, 'Admin');
  }
}

// Modal: Add Reward Item with Visibility Options
function openAddRewardModal() {
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="closeModal()">
      <div class="modal-content" onclick="event.stopPropagation()" style="max-width:540px;">
        <div class="modal-header">
          <div class="card-title">🎁 Add New Reward Item</div>
          <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        <form onsubmit="handleAddRewardSubmit(event)">
          <div class="form-group">
            <label>Reward Item Name <span style="color:var(--danger)">*</span></label>
            <input type="text" id="new-reward-name" required placeholder="e.g. Prestige Induction Cooktop, Professional Toolkit, Mixer Grinder...">
          </div>
          
          <div class="form-row">
            <div class="form-group">
              <label>Points Required <span style="color:var(--danger)">*</span></label>
              <input type="number" id="new-reward-points" required min="1" placeholder="e.g. 500">
            </div>
            <div class="form-group">
              <label>Stock Quantity <span style="color:var(--danger)">*</span></label>
              <input type="number" id="new-reward-stock" required min="0" value="5" placeholder="e.g. 10">
            </div>
          </div>

          <!-- Visibility & Category Targeting -->
          <div class="form-group" style="margin-top:12px;">
            <label style="font-weight:700;font-size:13px;color:var(--primary);">👁️ Worker Visibility & Trade Targeting</label>
            <p style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">Choose which workers will see this reward in their mobile app catalog:</p>
            
            <div style="background:#F8FAFC;padding:12px;border-radius:var(--radius-sm);border:1px solid var(--border);">
              <label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;cursor:pointer;margin-bottom:10px;">
                <input type="radio" name="add-reward-vis" value="all" checked onchange="toggleAddRewardVisMode('all')">
                <span>🌟 Visible to ALL Workers (Shown across all trade categories)</span>
              </label>
              
              <label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;cursor:pointer;margin-bottom:6px;">
                <input type="radio" name="add-reward-vis" value="custom" onchange="toggleAddRewardVisMode('custom')">
                <span>🎯 Visible to SPECIFIC Trade Categories Only</span>
              </label>
              
              <div id="add-vis-categories-box" style="display:none;padding-top:10px;border-top:1px dashed var(--border);margin-top:8px;">
                <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">
                  Check the categories that <b>CAN view</b> this reward. Unchecked categories will <b>NOT see it</b>:
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
                  ${TRADE_TYPES.map(t => `
                    <label style="font-size:12px;display:flex;align-items:center;gap:6px;cursor:pointer;background:#fff;padding:6px 8px;border-radius:4px;border:1px solid var(--border);">
                      <input type="checkbox" class="add-trade-check" value="${t}"> <span>${t}</span>
                    </label>
                  `).join('')}
                </div>
              </div>
            </div>
          </div>

          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:20px;">
            <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
            <button type="submit" class="btn btn-primary" id="save-reward-btn">Save Reward Item</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function toggleAddRewardVisMode(mode) {
  const box = document.getElementById('add-vis-categories-box');
  if (box) {
    box.style.display = mode === 'custom' ? 'block' : 'none';
  }
}

async function handleAddRewardSubmit(e) {
  e.preventDefault();
  const btn = document.getElementById('save-reward-btn');
  const name = document.getElementById('new-reward-name').value.trim();
  const pointsRequired = parseInt(document.getElementById('new-reward-points').value, 10);
  const stock = parseInt(document.getElementById('new-reward-stock').value, 10);

  const visMode = document.querySelector('input[name="add-reward-vis"]:checked')?.value || 'all';
  let eligibleTypes = ['all'];

  if (visMode === 'custom') {
    const checked = Array.from(document.querySelectorAll('.add-trade-check:checked')).map(c => c.value);
    if (checked.length === 0) {
      return showToast('Please select at least one trade category or choose "Visible to ALL"', 'error');
    }
    eligibleTypes = checked;
  }

  if (!name || isNaN(pointsRequired) || pointsRequired <= 0) {
    return showToast('Please enter a valid reward name and required points', 'error');
  }

  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    await API.post('/api/rewards', {
      name,
      pointsRequired,
      stock: isNaN(stock) ? 0 : stock,
      eligibleTypes
    });
    showToast(`Reward "${name}" added to catalog successfully!`, 'success');
    closeModal();
    renderRewardsView();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Save Reward Item';
  }
}

// Modal: Edit Reward Item with Visibility Options
function openEditRewardModal(id, currentName, currentPoints, currentStock, currentEligible) {
  const modalRoot = document.getElementById('modal-root');
  let elig = currentEligible || ['all'];
  if (typeof elig === 'string') {
    try { elig = JSON.parse(elig); } catch(e) { elig = ['all']; }
  }
  const isAll = elig.includes('all');

  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="closeModal()">
      <div class="modal-content" onclick="event.stopPropagation()" style="max-width:540px;">
        <div class="modal-header">
          <div class="card-title">✏️ Edit Reward & Visibility</div>
          <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        <form onsubmit="handleEditRewardSubmit(event, ${id})">
          <div class="form-group">
            <label>Reward Item Name <span style="color:var(--danger)">*</span></label>
            <input type="text" id="edit-reward-name" required value="${currentName}">
          </div>
          
          <div class="form-row">
            <div class="form-group">
              <label>Points Required <span style="color:var(--danger)">*</span></label>
              <input type="number" id="edit-reward-points" required min="1" value="${currentPoints}">
            </div>
            <div class="form-group">
              <label>Stock Quantity <span style="color:var(--danger)">*</span></label>
              <input type="number" id="edit-reward-stock" required min="0" value="${currentStock}">
            </div>
          </div>

          <!-- Visibility & Category Targeting -->
          <div class="form-group" style="margin-top:12px;">
            <label style="font-weight:700;font-size:13px;color:var(--primary);">👁️ Worker Visibility & Trade Targeting</label>
            <p style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">Choose which workers will see this reward in their mobile app catalog:</p>
            
            <div style="background:#F8FAFC;padding:12px;border-radius:var(--radius-sm);border:1px solid var(--border);">
              <label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;cursor:pointer;margin-bottom:10px;">
                <input type="radio" name="edit-reward-vis" value="all" ${isAll ? 'checked' : ''} onchange="toggleEditRewardVisMode('all')">
                <span>🌟 Visible to ALL Workers (Shown across all trade categories)</span>
              </label>
              
              <label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;cursor:pointer;margin-bottom:6px;">
                <input type="radio" name="edit-reward-vis" value="custom" ${!isAll ? 'checked' : ''} onchange="toggleEditRewardVisMode('custom')">
                <span>🎯 Visible to SPECIFIC Trade Categories Only</span>
              </label>
              
              <div id="edit-vis-categories-box" style="display:${!isAll ? 'block' : 'none'};padding-top:10px;border-top:1px dashed var(--border);margin-top:8px;">
                <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">
                  Check the categories that <b>CAN view</b> this reward. Unchecked categories will <b>NOT see it</b>:
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
                  ${TRADE_TYPES.map(t => `
                    <label style="font-size:12px;display:flex;align-items:center;gap:6px;cursor:pointer;background:#fff;padding:6px 8px;border-radius:4px;border:1px solid var(--border);">
                      <input type="checkbox" class="edit-trade-check" value="${t}" ${!isAll && elig.includes(t) ? 'checked' : ''}> <span>${t}</span>
                    </label>
                  `).join('')}
                </div>
              </div>
            </div>
          </div>

          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:20px;">
            <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
            <button type="submit" class="btn btn-primary" id="edit-reward-btn">Update Reward & Visibility</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function toggleEditRewardVisMode(mode) {
  const box = document.getElementById('edit-vis-categories-box');
  if (box) {
    box.style.display = mode === 'custom' ? 'block' : 'none';
  }
}

async function handleEditRewardSubmit(e, id) {
  e.preventDefault();
  const btn = document.getElementById('edit-reward-btn');
  const name = document.getElementById('edit-reward-name').value.trim();
  const pointsRequired = parseInt(document.getElementById('edit-reward-points').value, 10);
  const stock = parseInt(document.getElementById('edit-reward-stock').value, 10);

  const visMode = document.querySelector('input[name="edit-reward-vis"]:checked')?.value || 'all';
  let eligibleTypes = ['all'];

  if (visMode === 'custom') {
    const checked = Array.from(document.querySelectorAll('.edit-trade-check:checked')).map(c => c.value);
    if (checked.length === 0) {
      return showToast('Please select at least one trade category or choose "Visible to ALL"', 'error');
    }
    eligibleTypes = checked;
  }

  btn.disabled = true;
  btn.textContent = 'Updating...';

  try {
    await API.patch(`/api/rewards/${id}`, {
      name,
      pointsRequired,
      stock,
      eligibleTypes
    });
    showToast(`Reward "${name}" updated successfully!`, 'success');
    closeModal();
    renderRewardsView();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Update Reward & Visibility';
  }
}

async function deleteReward(rewardId, rewardName) {
  if (!confirm(`Are you sure you want to delete "${rewardName}" from the rewards catalog?`)) return;
  try {
    await apiFetch(`/api/rewards/${rewardId}`, { method: 'DELETE' });
    showToast(`Reward "${rewardName}" deleted`, 'success');
    renderRewardsView();
  } catch (err) {}
}

async function toggleRewardActive(rewardId) {
  try {
    const res = await API.patch(`/api/rewards/${rewardId}/toggle`, {});
    showToast(`Reward ${res.is_active ? 'activated' : 'deactivated'}`, 'success');
    renderRewardsView();
  } catch (err) {}
}

async function handleRedeemRequest(rewardId, rewardName) {
  if (!confirm(`Are you sure you want to claim "${rewardName}"? Points will be reserved immediately.`)) return;
  try {
    await API.post('/api/redemptions', { rewardId });
    showToast('Reward redemption requested!', 'success');
    navigate('redemptions');
  } catch (e) {}
}

/* =========================================================================
   AUDIT LOGS VIEW & CSV EXPORT
   ========================================================================= */

async function renderAuditLogsView() {
  const main = document.getElementById('main-content');
  const res = await API.get('/api/audit-logs');
  const logs = res.logs || [];

  main.innerHTML = `
    <div class="top-bar">
      <div>
        <h1 class="page-title">📋 Comprehensive Audit Trail</h1>
        <p style="font-size:13px;color:var(--text-muted)">Immutable log of all approvals, rejections, points adjustments, and logins</p>
      </div>
      <div class="top-actions">
        <a href="/api/audit-logs/export-csv" download class="btn btn-secondary btn-sm">📊 Download Audit CSV</a>
      </div>
    </div>

    <div class="card" style="padding:0;">
      <div class="table-responsive">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Timestamp</th>
              <th>Actor</th>
              <th>Role</th>
              <th>Action</th>
              <th>Details</th>
              <th>Client IP</th>
            </tr>
          </thead>
          <tbody>
            ${logs.length === 0 ? `<tr><td colspan="7">No audit logs recorded.</td></tr>` : logs.map(l => `
              <tr>
                <td>#${l.id}</td>
                <td>${l.timestamp}</td>
                <td><b>${l.actor_name}</b></td>
                <td><span class="user-badge role-${l.actor_role}">${l.actor_role}</span></td>
                <td><b>${l.action}</b></td>
                <td>${l.details}</td>
                <td><small style="color:var(--text-muted)">${l.ip_address}</small></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

/* =========================================================================
   MOBILE PAIRING MODAL (QR CODE GENERATOR FOR 5-6 PHONES)
   ========================================================================= */

async function openMobilePairingModal() {
  const modalRoot = document.getElementById('modal-root');
  let net = AppState.networkInfo;
  try {
    net = await API.get('/api/system/network-info');
    AppState.networkInfo = net;
  } catch (e) {
    net = { primaryUrl: window.location.origin, mobileUrls: [window.location.origin] };
  }

  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(net.primaryUrl)}`;

  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="closeModal()">
      <div class="modal-content" style="max-width:480px;text-align:center;" onclick="event.stopPropagation()">
        <div class="modal-header">
          <div class="card-title">📱 Connect Mobile Phones</div>
          <button class="modal-close" onclick="closeModal()">✕</button>
        </div>

        <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">
          Make sure your phone is connected to the <b>same Wi-Fi</b> network as this PC, then scan this QR code with the phone camera:
        </p>

        <div style="background:#fff;padding:14px;border:1px solid var(--border);border-radius:var(--radius-md);display:inline-block;margin-bottom:12px;">
          <img src="${qrUrl}" alt="Wi-Fi QR Code" style="width:200px;height:200px;display:block;">
        </div>

        <div class="qr-ip-box">
          👉 <b>${net.primaryUrl}</b>
        </div>

        <div style="font-size:12px;color:var(--text-muted);text-align:left;background:#F8FAFC;padding:12px;border-radius:var(--radius-sm);">
          <b>How to use on 5–6 phones:</b><br>
          1. Open camera on each mobile phone and scan the QR above.<br>
          2. Log in with Auditor accounts (<code>audit1 / audit123</code> or <code>audit2 / audit123</code>).<br>
          3. Tap "Add to Home Screen" in mobile browser to use as a full-screen app!
        </div>

        <div style="margin-top:16px;">
          <button class="btn btn-primary" style="width:100%;" onclick="closeModal()">Done</button>
        </div>
      </div>
    </div>
  `;
}

// Fallback views for redemptions, settings, reports, mechanic dash
async function renderRedemptionsView() {
  const main = document.getElementById('main-content');
  const res = await API.get('/api/redemptions');
  const list = res.redemptions || [];
  const isAdmin = AppState.user.role === 'admin';

  main.innerHTML = `
    <div class="top-bar">
      <div>
        <h1 class="page-title">🏆 Reward Redemptions</h1>
        <p style="font-size:13px;color:var(--text-muted)">Claims submitted by mechanics for rewards</p>
      </div>
    </div>

    <div class="card" style="padding:0;">
      <div class="table-responsive">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Mechanic</th>
              <th>Reward</th>
              <th>Points</th>
              <th>Status</th>
              ${isAdmin ? '<th>Action</th>' : ''}
            </tr>
          </thead>
          <tbody>
            ${list.length === 0 ? `<tr><td colspan="6">No redemptions requested.</td></tr>` : list.map(r => `
              <tr>
                <td>${r.requested_at}</td>
                <td><b>${r.mechanic_name}</b> (${r.trade_type})</td>
                <td>${r.reward_name}</td>
                <td><b>${r.points}</b></td>
                <td><span class="badge badge-${r.status.toLowerCase()}">${r.status}</span></td>
                ${isAdmin ? `
                  <td>
                    ${r.status === 'Pending' ? `
                      <button class="btn btn-success btn-sm" onclick="decideRedemption(${r.id}, true)">Approve</button>
                      <button class="btn btn-danger btn-sm" onclick="decideRedemption(${r.id}, false)">Reject</button>
                    ` : `Decided by ${r.decided_by || 'Admin'}`}
                  </td>
                ` : ''}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

async function decideRedemption(id, approve) {
  try {
    await API.post(`/api/redemptions/${id}/decide`, { approve });
    showToast(`Redemption ${approve ? 'approved' : 'rejected'}`, 'success');
    renderRedemptionsView();
  } catch (e) {}
}

async function renderMechanicDashboard() {
  const main = document.getElementById('main-content');
  const meRes = await API.get('/api/auth/me');
  const m = meRes.user.mechanic || {};
  const purRes = await API.get('/api/purchases');
  const purchases = purRes.purchases || [];

  main.innerHTML = `
    <div class="top-bar">
      <div>
        <h1 class="page-title">Welcome, ${AppState.user.name}</h1>
        <p style="font-size:13px;color:var(--text-muted)">${m.trade_type || 'Mechanic'} · User ID: ${m.uid || AppState.user.username}</p>
      </div>
      <div class="top-actions">
        <button class="btn btn-primary btn-sm" onclick="navigate('submit_purchase')">📸 Submit Purchase</button>
      </div>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Available Points</div>
        <div class="stat-value" style="color:var(--accent);">${m.available_points || 0}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Lifetime Points</div>
        <div class="stat-value" style="color:var(--success);">${m.lifetime_points || 0}</div>
      </div>
      ${m.recovery_points > 0 ? `
        <div class="stat-card">
          <div class="stat-label">Recovery Pending</div>
          <div class="stat-value" style="color:var(--danger);">${m.recovery_points}</div>
        </div>
      ` : ''}
      <div class="stat-card">
        <div class="stat-label">Approved Purchases</div>
        <div class="stat-value">${purchases.filter(p => p.status === 'APPROVED').length}</div>
      </div>
    </div>

    <div class="card">
      <div class="card-title" style="margin-bottom:12px;">Recent Purchases</div>
      <div class="table-responsive">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Customer</th>
              <th>Items</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Points</th>
            </tr>
          </thead>
          <tbody>
            ${purchases.slice(0, 5).map(p => `
              <tr>
                <td>${p.purchase_date}</td>
                <td>${p.customer_name}</td>
                <td>${(p.items || []).map(i => `${i.product_name} (${i.quantity} ${i.unit})`).join(', ')}</td>
                <td><b>${formatINR(p.total_amount)}</b></td>
                <td><span class="badge badge-${p.status.toLowerCase()}">${p.status}</span></td>
                <td><b>${p.points_awarded || '-'}</b></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

async function renderNotificationsView() {
  const main = document.getElementById('main-content');
  const res = await API.get('/api/notifications');
  const notifs = res.notifications || [];

  main.innerHTML = `
    <div class="top-bar">
      <h1 class="page-title">🔔 Notifications</h1>
    </div>
    <div class="card">
      ${notifs.length === 0 ? '<p>No new notifications.</p>' : notifs.map(n => `
        <div style="padding:10px 0;border-bottom:1px solid var(--border);">
          <div style="font-size:13px;">${n.message}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${n.created_at}</div>
        </div>
      `).join('')}
    </div>
  `;
}

async function renderReportsView() {
  const main = document.getElementById('main-content');
  const stats = await API.get('/api/dashboard/stats');
  const mechs = (await API.get('/api/mechanics')).mechanics || [];

  const leaderboard = [...mechs].sort((a, b) => b.lifetime_points - a.lifetime_points);

  main.innerHTML = `
    <div class="top-bar">
      <div>
        <h1 class="page-title">📈 Reports & Performance</h1>
      </div>
      <div class="top-actions">
        <a href="/api/reports/export-purchases-csv" download class="btn btn-secondary btn-sm">📊 Export All Purchases CSV</a>
      </div>
    </div>

    <div class="card">
      <div class="card-title" style="margin-bottom:12px;">🏆 Top Mechanics Leaderboard</div>
      <div class="table-responsive">
        <table>
          <thead>
            <tr>
              <th>Rank</th>
              <th>Mechanic Name</th>
              <th>Trade</th>
              <th>Available Points</th>
              <th>Lifetime Points</th>
            </tr>
          </thead>
          <tbody>
            ${leaderboard.map((m, i) => `
              <tr>
                <td><b>#${i + 1}</b></td>
                <td><b>${m.name}</b> (${m.uid})</td>
                <td>${m.trade_type}</td>
                <td>${m.available_points}</td>
                <td><b style="color:var(--success);">${m.lifetime_points}</b></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

async function renderSettingsView() {
  const main = document.getElementById('main-content');
  const net = await API.get('/api/system/network-info');

  main.innerHTML = `
    <div class="top-bar">
      <h1 class="page-title">⚙️ Settings & Mobile Setup</h1>
    </div>

    <div class="card">
      <div class="card-title" style="margin-bottom:12px;">📱 Multi-Device Wi-Fi Connectivity</div>
      <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">
        Connect up to 5–6 mobile phones on your local Wi-Fi network for simultaneous field auditing and bill submission.
      </p>
      <div class="qr-ip-box">
        Primary LAN Address: <b>${net.primaryUrl}</b>
      </div>
      <button class="btn btn-primary" onclick="openMobilePairingModal()">Display Fullscreen QR Code</button>
    </div>
  `;
}

// Global initialization
window.addEventListener('DOMContentLoaded', initApp);
