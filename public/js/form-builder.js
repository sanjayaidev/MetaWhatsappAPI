// Node-canvas flow builder. Talks to the exact same backend as the classic
// dashboard (public/js/app.js) - /connections, /oauth/google/start,
// /flows - so anything built here is a real, runnable flow, not a mockup.
//
// Simplification (matches the linear flowRunner - see src/lib/flowRunner.js):
// execution order is a single chain. The canvas lets you draw and remove
// connectors freely (n8n-style drag from an output socket to an input
// socket), but under the hood we still serialize to the backend's linear
// `steps` array by walking the chain from the trigger node through its
// connectors. Real branching isn't implemented server-side yet, so this
// canvas enforces one outgoing + one incoming connector per node.

const API = '';
let apiKey = localStorage.getItem('sm_api_key') || null;
let modulesCache = [];       // [{name, provider, actions, triggers}]
let connectionsCache = [];   // [{id, provider, module, account_label, status}]
let flowsCache = [];
let canvasNodes = [];        // [{id, module, role, typeId, connectionId, config, x, y}]
let edges = [];              // [{from: nodeId, to: nodeId}]
let selectedNodeId = null;
let lastSavedFlowId = null;
let nodeSeq = 1;

// canvas view state
let zoom = 1;
let panX = 40;
let panY = 40;
const ZOOM_MIN = 0.35, ZOOM_MAX = 1.75;

const NODE_W = 190;
const NODE_H = 64; // approximate rendered height, used for socket + edge geometry

function headers() {
  return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey };
}

function showToast(msg, type) {
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ---------- bootstrap ----------

async function init() {
  wireStaticButtons();
  if (!apiKey) {
    document.getElementById('keyPill').textContent = 'no API key — log in on the classic dashboard';
    showToast('No API key found. Log in or paste a key on the classic dashboard first.', 'error');
    return;
  }
  document.getElementById('keyPill').textContent = apiKey.slice(0, 14) + '...';
  await loadModules();
  await loadConnections();
  await loadFlows();
  renderModuleBar();
  applyCanvasTransform();
  renderCanvas();
}

async function loadModules() {
  try {
    const res = await fetch(API + '/api', { headers: headers() });
    const data = await res.json();
    modulesCache = res.ok ? (data.modules || []) : [];
    if (!res.ok) showToast('Could not load modules (' + (data.error || res.status) + ')', 'error');
  } catch (e) { showToast('Network error loading modules: ' + e.message, 'error'); }
}

async function loadConnections() {
  try {
    const res = await fetch(API + '/connections', { headers: headers() });
    const data = await res.json();
    connectionsCache = res.ok ? (data.connections || []) : [];
    if (!res.ok) showToast('Could not load connections (' + (data.error || res.status) + ')', 'error');
  } catch (e) { showToast('Network error loading connections: ' + e.message, 'error'); }
}

async function loadFlows() {
  try {
    const res = await fetch(API + '/flows', { headers: headers() });
    const data = await res.json();
    flowsCache = res.ok ? (data.flows || []) : [];
    const sel = document.getElementById('flowSelect');
    sel.innerHTML = '<option value="">My saved flows…</option>' +
      flowsCache.map(f => `<option value="${f.id}">${f.name}</option>`).join('');
  } catch (e) { /* non-fatal */ }
}

// ---------- module bar ----------

function providerFor(moduleName) {
  const mod = modulesCache.find(m => m.name === moduleName);
  return mod ? mod.provider : 'google';
}

// A connection belongs to a module only if it was connected for that exact
// module. Legacy rows saved before per-module scoping existed have no
// `module` value - fall back to provider match for those so old data still
// works, but a module-scoped connection never leaks into another module's
// list (this is the fix for "shows one account for all" modules).
function connectionsForModule(moduleName) {
  const provider = providerFor(moduleName);
  return connectionsCache.filter(c =>
    c.status === 'active' &&
    c.provider === provider &&
    (c.module ? c.module === moduleName : true)
  );
}

function renderModuleBar() {
  const el = document.getElementById('moduleBar');
  el.innerHTML = MODULE_ORDER.map(name => {
    const def = NODE_DEFS[name];
    if (!def) return '';
    const conns = connectionsForModule(name);
    const connected = conns.length > 0;
    return `
      <div class="module-card" data-add-node="${name}">
        <div class="icon">${def.icon}</div>
        <div class="name">${def.label}</div>
        <button class="connect-btn" data-connect-module="${name}" type="button">${connected ? '+ add another' : 'Connect'}</button>
        <div class="conn-status ${connected ? 'on' : ''}">
          ${connected ? conns.map(c => `
            <span class="acc-chip">${c.account_label}
              <button type="button" class="acc-chip-x" data-disconnect-conn="${c.id}" title="Disconnect this account">×</button>
            </span>`).join('') : 'Not connected'}
        </div>
        <div class="add-hint">click card to add node →</div>
      </div>`;
  }).join('');
}

function wireModuleBarDelegation() {
  const el = document.getElementById('moduleBar');
  el.addEventListener('click', (e) => {
    const connectBtn = e.target.closest('[data-connect-module]');
    if (connectBtn) {
      e.stopPropagation();
      connectModule(connectBtn.dataset.connectModule);
      return;
    }
    const disconnectBtn = e.target.closest('[data-disconnect-conn]');
    if (disconnectBtn) {
      e.stopPropagation();
      disconnectConnection(disconnectBtn.dataset.disconnectConn);
      return;
    }
    const card = e.target.closest('[data-add-node]');
    if (card) addNode(card.dataset.addNode);
  });
}

async function connectModule(moduleName) {
  try {
    const res = await fetch(`${API}/oauth/google/start?module=${moduleName}&returnTo=flow-builder`, { headers: headers() });
    const data = await res.json();
    if (data.authUrl) location.href = data.authUrl;
    else showToast(data.message || 'Could not start connection', 'error');
  } catch (e) { showToast('Network error: ' + e.message, 'error'); }
}

async function disconnectConnection(connectionId) {
  if (!confirm('Disconnect this account? Any node using it will need a new account picked.')) return;
  try {
    const res = await fetch(`${API}/connections/${connectionId}`, { method: 'DELETE', headers: headers() });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showToast(data.message || 'Could not disconnect', 'error');
      return;
    }
    // Clear this connection off any node that was using it.
    canvasNodes.forEach(n => { if (n.connectionId === connectionId) n.connectionId = ''; });
    await loadConnections();
    renderModuleBar();
    renderCanvas();
    renderProps();
    showToast('Account disconnected.', 'ok');
  } catch (e) { showToast('Network error: ' + e.message, 'error'); }
}

// ---------- canvas view: zoom + pan ----------

function applyCanvasTransform() {
  const scroll = document.getElementById('canvasScroll');
  scroll.style.setProperty('--zoom', zoom);
  scroll.style.setProperty('--panx', panX + 'px');
  scroll.style.setProperty('--pany', panY + 'px');
  document.getElementById('zoomPct').textContent = Math.round(zoom * 100) + '%';
}

function setZoom(newZoom, centerClientX, centerClientY) {
  newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, newZoom));
  const scroll = document.getElementById('canvasScroll');
  const rect = scroll.getBoundingClientRect();
  const cx = centerClientX !== undefined ? centerClientX - rect.left : rect.width / 2;
  const cy = centerClientY !== undefined ? centerClientY - rect.top : rect.height / 2;
  // keep the world point under the cursor fixed while zooming
  const worldX = (cx - panX) / zoom;
  const worldY = (cy - panY) / zoom;
  zoom = newZoom;
  panX = cx - worldX * zoom;
  panY = cy - worldY * zoom;
  applyCanvasTransform();
}

function resetZoom() {
  zoom = 1; panX = 40; panY = 40;
  applyCanvasTransform();
}

function wireZoomPan() {
  const scroll = document.getElementById('canvasScroll');

  scroll.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = -e.deltaY * 0.0015;
    setZoom(zoom * (1 + delta), e.clientX, e.clientY);
  }, { passive: false });

  let panning = null; // { startX, startY, panX0, panY0 }
  scroll.addEventListener('mousedown', (e) => {
    // only pan when clicking empty canvas background, not a node/socket/edge
    if (e.target.closest('.node-box') || e.target.closest('svg')) return;
    panning = { startX: e.clientX, startY: e.clientY, panX0: panX, panY0: panY };
    scroll.classList.add('panning');
  });
  document.addEventListener('mousemove', (e) => {
    if (!panning) return;
    panX = panning.panX0 + (e.clientX - panning.startX);
    panY = panning.panY0 + (e.clientY - panning.startY);
    applyCanvasTransform();
  });
  document.addEventListener('mouseup', () => { panning = null; scroll.classList.remove('panning'); });

  document.getElementById('zoomInBtn').addEventListener('click', () => setZoom(zoom * 1.2));
  document.getElementById('zoomOutBtn').addEventListener('click', () => setZoom(zoom / 1.2));
  document.getElementById('zoomResetBtn').addEventListener('click', resetZoom);
}

// ---------- canvas: nodes + edges ----------

function addNode(moduleName, opts) {
  opts = opts || {};
  const def = NODE_DEFS[moduleName];
  if (!def) return;
  // "first node" here means "no trigger exists yet", not "canvas is empty" -
  // if the trigger node got deleted, the next node added should be able to
  // become the trigger again even if other action nodes remain.
  const isFirst = !canvasNodes.some(n => n.role === 'trigger');
  const firstTrigger = def.triggers[0];
  const firstAction = def.actions[0];
  if (isFirst && !firstTrigger) {
    showToast(`${def.label} has no trigger defined yet, so it can't be the first node.`, 'error');
    return;
  }
  const conns = connectionsForModule(moduleName);

  // place near the selected node (if any) so a chain reads left-to-right,
  // otherwise stagger from the last node, otherwise start near the origin.
  const fromNode = !isFirst ? canvasNodes.find(n => n.id === selectedNodeId) : null;
  let x, y;
  if (opts.x !== undefined) { x = opts.x; y = opts.y; }
  else if (fromNode) { x = fromNode.x + 260; y = fromNode.y; }
  else if (canvasNodes.length) {
    const last = canvasNodes[canvasNodes.length - 1];
    x = last.x + 260; y = last.y;
  } else { x = 60; y = 60; }

  const node = {
    id: 'n' + (nodeSeq++),
    module: moduleName,
    role: isFirst ? 'trigger' : 'action',
    typeId: isFirst ? firstTrigger.id : (firstAction ? firstAction.id : ''),
    connectionId: conns[0] ? conns[0].id : '',
    config: {},
    x, y,
  };
  canvasNodes.push(node);

  // Auto-wire from the previously selected node if it has a free outgoing
  // slot - mirrors n8n's "+ " on a node auto-connecting the new node.
  if (fromNode && !edges.some(e => e.from === fromNode.id)) {
    edges.push({ from: fromNode.id, to: node.id });
  }

  selectedNodeId = node.id;
  renderCanvas();
  renderNodeSide();
  renderProps();
}

function removeNode(id) {
  canvasNodes = canvasNodes.filter(n => n.id !== id);
  edges = edges.filter(e => e.from !== id && e.to !== id);
  if (selectedNodeId === id) selectedNodeId = null;
  renderCanvas();
  renderNodeSide();
  renderProps();
}

function connectNodes(fromId, toId) {
  if (fromId === toId) return;
  const fromNode = canvasNodes.find(n => n.id === fromId);
  const toNode = canvasNodes.find(n => n.id === toId);
  if (!fromNode || !toNode) return;
  if (toNode.role === 'trigger') {
    showToast("Can't connect into a trigger node - triggers only have an output.", 'error');
    return;
  }
  // enforce single linear chain: at most one outgoing edge per node, one
  // incoming edge per node (matches the backend's ordered steps array)
  edges = edges.filter(e => e.from !== fromId && e.to !== toId);
  edges.push({ from: fromId, to: toId });
  renderCanvas();
}

function disconnectEdge(fromId, toId) {
  edges = edges.filter(e => !(e.from === fromId && e.to === toId));
  renderCanvas();
}

function nodeTypeDef(node) {
  const def = NODE_DEFS[node.module];
  if (!def) return null;
  const list = node.role === 'trigger' ? def.triggers : def.actions;
  return list.find(t => t.id === node.typeId) || null;
}

function renderCanvas() {
  const canvas = document.getElementById('canvas');
  const empty = document.getElementById('canvasEmpty');
  empty.style.display = canvasNodes.length ? 'none' : 'block';

  canvas.innerHTML = canvasNodes.map((n) => {
    const def = NODE_DEFS[n.module];
    const typeDef = nodeTypeDef(n);
    const conns = connectionsForModule(n.module);
    const conn = conns.find(c => c.id === n.connectionId);
    const hasOut = edges.some(e => e.from === n.id);
    const hasIn = edges.some(e => e.to === n.id);
    return `
      <div class="node-box ${n.id === selectedNodeId ? 'selected' : ''}" data-node-id="${n.id}" style="left:${n.x}px; top:${n.y}px;">
        <div class="nb-role">${n.role}</div>
        <button class="nb-remove" type="button" data-remove-node="${n.id}" title="Remove node">✕</button>
        <div class="nb-head"><span class="nb-icon">${def.icon}</span>${def.label}</div>
        <div class="nb-sub">${typeDef ? typeDef.label : 'choose an operation'}${conn ? ' · ' + conn.account_label : (n.connectionId === '' && conns.length === 0 ? ' · no account' : '')}</div>
        ${n.role !== 'trigger' ? `<div class="nb-socket in ${hasIn ? 'filled' : ''}" data-socket="in" data-node-id="${n.id}" title="Drag a connector here"></div>` : ''}
        <div class="nb-socket out ${hasOut ? 'filled' : ''}" data-socket="out" data-node-id="${n.id}" title="Drag to another node's input to connect"></div>
      </div>`;
  }).join('');

  drawEdges();
}

// socket position in world (unscaled canvas) coordinates
function socketPos(node, which) {
  const y = node.y + NODE_H / 2;
  const x = which === 'out' ? node.x + NODE_W : node.x;
  return { x, y };
}

function edgePathD(p1, p2) {
  const mx = (p1.x + p2.x) / 2;
  return `M ${p1.x} ${p1.y} C ${mx} ${p1.y}, ${mx} ${p2.y}, ${p2.x} ${p2.y}`;
}

function drawEdges() {
  const svg = document.getElementById('edgesSvg');
  let html = '';
  edges.forEach(edge => {
    const a = canvasNodes.find(n => n.id === edge.from);
    const b = canvasNodes.find(n => n.id === edge.to);
    if (!a || !b) return;
    const p1 = socketPos(a, 'out');
    const p2 = socketPos(b, 'in');
    const d = edgePathD(p1, p2);
    const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
    html += `<path class="edge-hit" d="${d}" data-edge-from="${edge.from}" data-edge-to="${edge.to}"></path>`;
    html += `<path class="edge-line" d="${d}"></path>`;
    html += `<g class="edge-del-btn" data-edge-from="${edge.from}" data-edge-to="${edge.to}">
      <circle cx="${mx}" cy="${my}" r="9"></circle>
      <text x="${mx}" y="${my + 1}">✕</text>
    </g>`;
  });
  if (dragEdgeState) {
    html += `<path class="edge-drawing" d="${edgePathD(dragEdgeState.from, dragEdgeState.current)}"></path>`;
  }
  svg.innerHTML = html;
}

// ---------- canvas: node drag, socket-drag connect, selection ----------

let dragEdgeState = null; // { fromId, from: {x,y}, current: {x,y} }

function clientToWorld(clientX, clientY) {
  const scroll = document.getElementById('canvasScroll');
  const rect = scroll.getBoundingClientRect();
  return {
    x: (clientX - rect.left - panX) / zoom,
    y: (clientY - rect.top - panY) / zoom,
  };
}

function wireCanvasDragAndSelect() {
  const canvas = document.getElementById('canvas');
  let dragging = null; // { id, offsetX, offsetY } in world units

  canvas.addEventListener('mousedown', (e) => {
    const removeBtn = e.target.closest('[data-remove-node]');
    if (removeBtn) { removeNode(removeBtn.dataset.removeNode); return; }

    const socket = e.target.closest('.nb-socket');
    if (socket && socket.dataset.socket === 'out') {
      e.stopPropagation();
      const node = canvasNodes.find(n => n.id === socket.dataset.nodeId);
      if (!node) return;
      const from = socketPos(node, 'out');
      dragEdgeState = { fromId: node.id, from, current: clientToWorld(e.clientX, e.clientY) };
      return;
    }

    const box = e.target.closest('.node-box');
    if (!box) return;
    const id = box.dataset.nodeId;
    selectedNodeId = id;
    renderCanvas();
    renderNodeSide();
    renderProps();

    const node = canvasNodes.find(n => n.id === id);
    const world = clientToWorld(e.clientX, e.clientY);
    dragging = { id, offsetX: world.x - node.x, offsetY: world.y - node.y };
    box.style.cursor = 'grabbing';
  });

  document.getElementById('edgesSvg').addEventListener('click', (e) => {
    const del = e.target.closest('[data-edge-from]');
    if (del) disconnectEdge(del.dataset.edgeFrom, del.dataset.edgeTo);
  });

  document.addEventListener('mousemove', (e) => {
    if (dragEdgeState) {
      dragEdgeState.current = clientToWorld(e.clientX, e.clientY);
      drawEdges();
      // highlight a valid drop target
      document.querySelectorAll('.node-box.drag-target').forEach(el => el.classList.remove('drag-target'));
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      const overSocket = hit ? hit.closest('.nb-socket[data-socket="in"]') : null;
      if (overSocket) {
        const box = canvas.querySelector(`[data-node-id="${overSocket.dataset.nodeId}"]`);
        if (box) box.classList.add('drag-target');
      }
      return;
    }
    if (!dragging) return;
    const node = canvasNodes.find(n => n.id === dragging.id);
    if (!node) return;
    const world = clientToWorld(e.clientX, e.clientY);
    node.x = Math.max(0, world.x - dragging.offsetX);
    node.y = Math.max(0, world.y - dragging.offsetY);
    const box = canvas.querySelector(`[data-node-id="${node.id}"]`);
    if (box) { box.style.left = node.x + 'px'; box.style.top = node.y + 'px'; }
    drawEdges();
  });

  document.addEventListener('mouseup', (e) => {
    if (dragEdgeState) {
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      const target = hit ? hit.closest('.nb-socket[data-socket="in"]') : null;
      document.querySelectorAll('.node-box.drag-target').forEach(el => el.classList.remove('drag-target'));
      if (target) connectNodes(dragEdgeState.fromId, target.dataset.nodeId);
      dragEdgeState = null;
      drawEdges();
    }
    dragging = null;
  });
}

// ---------- left panel: triggers/actions for the selected node's module ----------

function renderNodeSide() {
  const side = document.getElementById('nodeSide');
  const node = canvasNodes.find(n => n.id === selectedNodeId);
  if (!node) {
    side.innerHTML = '<div class="node-side-empty" id="nodeSideEmpty">Select a node on the canvas to see its triggers and actions here.</div>';
    return;
  }
  const def = NODE_DEFS[node.module];
  const isFirstNode = node.role === 'trigger';

  const triggerItems = def.triggers.map(t => `
    <div class="op-item trigger ${node.role === 'trigger' && node.typeId === t.id ? 'selected' : ''} ${isFirstNode ? '' : 'disabled'}"
         data-op="trigger:${t.id}" style="${isFirstNode ? '' : 'opacity:.4; pointer-events:none;'}">
      <span class="op-marker"></span>${t.label}
    </div>`).join('') || '<div class="node-side-empty">No triggers for this module yet.</div>';

  const actionItems = def.actions.map(a => `
    <div class="op-item ${node.role === 'action' && node.typeId === a.id ? 'selected' : ''} ${isFirstNode ? 'disabled' : ''}"
         data-op="action:${a.id}" style="${isFirstNode ? 'opacity:.4; pointer-events:none;' : ''}">
      <span class="op-marker"></span>${a.label}
    </div>`).join('');

  side.innerHTML = `
    <h2>${def.icon} ${def.label}</h2>
    <div class="group-label">Triggers ${isFirstNode ? '' : '(only available on the first node)'}</div>
    ${triggerItems}
    <div class="group-label">Actions ${isFirstNode ? '(add another node first)' : ''}</div>
    ${actionItems}
  `;
}

function wireNodeSideDelegation() {
  const side = document.getElementById('nodeSide');
  side.addEventListener('click', (e) => {
    const item = e.target.closest('[data-op]');
    if (!item) return;
    const node = canvasNodes.find(n => n.id === selectedNodeId);
    if (!node) return;
    const [role, typeId] = item.dataset.op.split(':');
    if ((role === 'trigger') !== (node.role === 'trigger')) return; // guarded by disabled styling too
    node.typeId = typeId;
    node.config = {};
    renderCanvas();
    renderNodeSide();
    renderProps();
  });
}

// ---------- right panel: Node Properties ----------

function setPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

function parseFieldValue(f, raw) {
  if (f.type === 'number') return raw === '' ? undefined : Number(raw);
  if (f.parse === 'csv') return raw.split(',').map(s => s.trim()).filter(Boolean);
  if (f.parse === 'json') { try { return JSON.parse(raw); } catch { return raw; } }
  return raw;
}

function renderProps() {
  const panel = document.getElementById('propsPanel');
  const node = canvasNodes.find(n => n.id === selectedNodeId);
  if (!node) {
    panel.innerHTML = '<h2>Node Properties</h2><div class="props-empty" id="propsEmpty">Nothing selected.</div>';
    return;
  }
  const typeDef = nodeTypeDef(node);
  const conns = connectionsForModule(node.module);

  const connRow = `
    <div class="conn-select-row">
      <label style="display:block; font-size:12px; font-weight:600; margin-bottom:6px;">Account for this node</label>
      <select id="propConnSelect">
        <option value="">choose account…</option>
        ${conns.map(c => `<option value="${c.id}" ${c.id === node.connectionId ? 'selected' : ''}>${c.account_label}</option>`).join('')}
      </select>
      <div style="margin-top:8px;">
        <button type="button" class="tbtn" id="propConnectMoreBtn" data-connect-module="${node.module}" style="font-size:11px; padding:5px 10px;">+ connect another account</button>
        ${node.connectionId ? `<button type="button" class="tbtn" id="propDisconnectBtn" data-disconnect-conn="${node.connectionId}" style="font-size:11px; padding:5px 10px; color:var(--danger); border-color:var(--danger); margin-left:6px;">disconnect this one</button>` : ''}
      </div>
      ${conns.length === 0 ? `<div class="hint">No account connected for ${NODE_DEFS[node.module].label} yet — connect one above.</div>` : ''}
    </div>`;

  const fields = typeDef ? typeDef.fields : [];
  const fieldsHtml = fields.map(f => {
    const val = node.config[f.name] ?? '';
    if (f.type === 'resource') {
      const placeholder = f.placeholder || `Select ${f.label}`;
      return `<div class="pfield" data-resource-field="${f.name}" data-resource-type="${f.resourceType}" data-depends-on="${f.dependsOn || ''}">
        <label>${f.label}</label>
        <select data-prop-field="${f.name}" class="resource-select">
          <option value="">${placeholder}</option>
        </select>
        <button type="button" class="tbtn load-resources-btn" style="font-size:11px; padding:4px 8px; margin-top:6px;">↻ Load options</button>
      </div>`;
    }
    if (f.type === 'select') {
      return `<div class="pfield"><label>${f.label}</label><select data-prop-field="${f.name}">
        <option value="">${f.placeholder || 'Select...'}</option>
        ${(f.options || []).map(o => `<option value="${o}" ${o === val ? 'selected' : ''}>${o}</option>`).join('')}
      </select></div>`;
    }
    if (f.type === 'textarea') {
      return `<div class="pfield"><label>${f.label}</label><textarea data-prop-field="${f.name}" placeholder="${f.placeholder || ''}">${val}</textarea></div>`;
    }
    if (f.type === 'checkbox') {
      return `<div class="pfield"><label><input type="checkbox" data-prop-field="${f.name}" ${val ? 'checked' : ''} /> ${f.label}</label></div>`;
    }
    if (f.type === 'checkboxGroup') {
      // Inclusive multi-select (e.g. sheets "Trigger on: added / updated") -
      // pick one or both, stored as an array on node.config[f.name].
      const current = Array.isArray(node.config[f.name]) ? node.config[f.name] : (f.default ? [...f.default] : []);
      node.config[f.name] = current; // seed so it's included even if untouched
      return `<div class="pfield" data-checkbox-group="${f.name}">
        <label>${f.label}</label>
        ${(f.options || []).map(o => `
          <label style="display:flex; align-items:center; gap:6px; font-weight:400; margin-top:4px;">
            <input type="checkbox" data-prop-field="${f.name}" data-checkbox-value="${o.value}" ${current.includes(o.value) ? 'checked' : ''} />
            ${o.label}
          </label>`).join('')}
      </div>`;
    }
    return `<div class="pfield"><label>${f.label}</label><input type="${f.type === 'number' ? 'number' : 'text'}" data-prop-field="${f.name}" placeholder="${f.placeholder || ''}" value="${val}" /></div>`;
  }).join('') || '<div class="props-empty">No inputs needed for this operation.</div>';

  panel.innerHTML = `
    <h2>Node Properties</h2>
    ${connRow}
    <div class="group-label" style="margin:0 0 10px; padding:0;">${typeDef ? typeDef.label : 'Choose an operation'}</div>
    ${fieldsHtml}
  `;
}

function wirePropsDelegation() {
  const panel = document.getElementById('propsPanel');
  panel.addEventListener('click', (e) => {
    const connectBtn = e.target.closest('[data-connect-module]');
    if (connectBtn) { connectModule(connectBtn.dataset.connectModule); return; }
    const disconnectBtn = e.target.closest('[data-disconnect-conn]');
    if (disconnectBtn) { disconnectConnection(disconnectBtn.dataset.disconnectConn); return; }
    
    // Handle "Load options" button for resource fields
    const loadBtn = e.target.closest('.load-resources-btn');
    if (loadBtn) {
      const pfield = loadBtn.closest('.pfield');
      const select = pfield.querySelector('.resource-select');
      const resourceType = pfield.dataset.resourceType;
      const dependsOn = pfield.dataset.dependsOn;
      const fieldName = pfield.dataset.resourceField;
      
      loadResources(select, resourceType, dependsOn, fieldName);
      return;
    }
  });
  panel.addEventListener('change', (e) => {
    const node = canvasNodes.find(n => n.id === selectedNodeId);
    if (!node) return;

    if (e.target.id === 'propConnSelect') {
      node.connectionId = e.target.value;
      renderCanvas();
      renderProps();
      return;
    }
    const fieldEl = e.target.closest('[data-prop-field]');
    if (!fieldEl) return;
    const typeDef = nodeTypeDef(node);
    const f = (typeDef ? typeDef.fields : []).find(x => x.name === fieldEl.dataset.propField);
    if (!f) return;

    if (f.type === 'checkboxGroup') {
      // Collect every checked box sharing this field name into an array -
      // this is what makes "one or both" possible instead of a radio choice.
      const boxes = panel.querySelectorAll(`[data-prop-field="${f.name}"][data-checkbox-value]`);
      node.config[f.name] = Array.from(boxes).filter(b => b.checked).map(b => b.dataset.checkboxValue);
      return;
    }

    const raw = f.type === 'checkbox' ? fieldEl.checked : fieldEl.value;
    node.config[f.name] = raw;
    
    // If this is a resource field that other fields depend on, trigger reload of dependent fields
    // (dependsOn can be a single field name or a comma-separated list, e.g. "accountId,locationId").
    if (f.type === 'resource') {
      const dependsOnList = (fld) => (fld.dependsOn || '').split(',').map(s => s.trim()).filter(Boolean);
      const dependentFields = (typeDef ? typeDef.fields : []).filter(field => dependsOnList(field).includes(f.name));
      dependentFields.forEach(depField => {
        const depPfield = panel.querySelector(`.pfield[data-resource-field="${depField.name}"]`);
        if (depPfield) {
          const depSelect = depPfield.querySelector('.resource-select');
          loadResources(depSelect, depField.resourceType, depField.dependsOn, depField.name);
        }
      });
    }
  });
  // live-update text/textarea as you type, not just on blur/change
  panel.addEventListener('input', (e) => {
    const node = canvasNodes.find(n => n.id === selectedNodeId);
    if (!node) return;
    const fieldEl = e.target.closest('[data-prop-field]');
    if (!fieldEl || fieldEl.tagName === 'SELECT') return;
    const typeDef = nodeTypeDef(node);
    const f = (typeDef ? typeDef.fields : []).find(x => x.name === fieldEl.dataset.propField);
    if (!f) return;
    node.config[f.name] = fieldEl.type === 'checkbox' ? fieldEl.checked : fieldEl.value;
  });
}

// Load resources from API for dropdown population
async function loadResources(selectEl, resourceType, dependsOnField, currentFieldName) {
  const node = canvasNodes.find(n => n.id === selectedNodeId);
  if (!node || !node.connectionId) {
    showToast('Please select an account first', 'error');
    return;
  }
  
  const originalText = selectEl.innerHTML;
  selectEl.innerHTML = '<option value="">Loading...</option>';
  selectEl.disabled = true;
  
  // dependsOn can be a single field name or a comma-separated list (e.g.
  // "accountId,locationId" for a review dropdown that needs both parents).
  const depNames = (dependsOnField || '').split(',').map(s => s.trim()).filter(Boolean);
  for (const dep of depNames) {
    if (!node.config[dep]) {
      showToast(`Please select ${dep} first`, 'error');
      selectEl.innerHTML = originalText;
      selectEl.disabled = false;
      return;
    }
  }

  try {
    let actionName = '';
    let inputPayload = {};
    depNames.forEach(dep => { inputPayload[dep] = node.config[dep]; });
    
    // Map resource types to backend actions
    switch (resourceType) {
      case 'spreadsheet':
        actionName = 'listSpreadsheets';
        break;
      case 'sheet':
        actionName = 'listSheets';
        break;
      case 'calendar':
        actionName = 'getCalendars';
        break;
      case 'driveFile':
        actionName = 'getFiles';
        break;
      case 'driveFolder':
        actionName = 'getFolders';
        break;
      case 'form':
        actionName = 'listForms';
        break;
      case 'gbpAccount':
        actionName = 'listAccounts';
        break;
      case 'gbpLocation':
        actionName = 'listLocations';
        break;
      case 'gbpReview':
        actionName = 'listReviews';
        break;
      case 'gbpPost':
        actionName = 'listPosts';
        break;
      default:
        throw new Error(`Unknown resource type: ${resourceType}`);
    }
    
    const res = await fetch(`${API}/api/${node.module}/${actionName}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ connectionId: node.connectionId, input: inputPayload }),
    });
    
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error || 'Failed to load resources');
    
    let options = [];
    if (data.output) {
      // Handle different response formats
      if (data.output.spreadsheets) {
        options = data.output.spreadsheets.map(s => ({ value: s.id, label: s.name }));
      } else if (data.output.sheets) {
        options = data.output.sheets.map(s => ({ value: s.title, label: s.title }));
      } else if (data.output.options) {
        options = data.output.options;
      } else if (data.output.calendars) {
        options = data.output.calendars.map(c => ({ value: c.id, label: c.name || c.summary }));
      } else if (data.output.files) {
        options = data.output.files.map(f => ({ value: f.id, label: f.name }));
      } else if (data.output.forms) {
        options = data.output.forms.map(f => ({ value: f.id, label: f.name }));
      } else if (data.output.accounts) {
        options = data.output.accounts.map(a => ({ value: a.name, label: a.accountName || a.name }));
      } else if (data.output.locations) {
        options = data.output.locations.map(l => ({ value: l.name, label: l.title || l.name }));
      } else if (data.output.reviews) {
        options = data.output.reviews.map(r => ({
          value: r.reviewId || r.name,
          label: `${r.reviewer?.displayName || 'Anonymous'} - ${r.starRating || ''} ${(r.comment || '').slice(0, 40)}`,
        }));
      } else if (data.output.posts) {
        options = data.output.posts.map(p => ({
          value: (p.name || '').split('/').pop() || p.name,
          label: (p.summary || p.name || '').slice(0, 50),
        }));
      }
    }
    
    const currentVal = node.config[currentFieldName] || '';
    selectEl.innerHTML = '<option value="">Select...</option>' + 
      options.map(o => `<option value="${o.value}" ${o.value === currentVal ? 'selected' : ''}>${o.label}</option>`).join('');
    
    if (options.length === 0) {
      showToast('No resources found', 'error');
    }
  } catch (err) {
    showToast('Error loading resources: ' + err.message, 'error');
    selectEl.innerHTML = originalText;
  } finally {
    selectEl.disabled = false;
  }
}

// ---------- quick-add node search (Tab) ----------

function buildQuickAddIndex() {
  const items = [];
  MODULE_ORDER.forEach(moduleName => {
    const def = NODE_DEFS[moduleName];
    if (!def) return;
    const isFirst = !canvasNodes.some(n => n.role === 'trigger');
    (isFirst ? def.triggers : def.actions).forEach(op => {
      items.push({ moduleName, role: isFirst ? 'trigger' : 'action', typeId: op.id, label: `${def.label} · ${op.label}`, icon: def.icon });
    });
  });
  return items;
}

function openQuickAdd() {
  const panel = document.getElementById('quickAdd');
  const input = document.getElementById('quickAddInput');
  panel.classList.add('open');
  input.value = '';
  renderQuickAddList('');
  setTimeout(() => input.focus(), 0);
}

function closeQuickAdd() {
  document.getElementById('quickAdd').classList.remove('open');
}

function renderQuickAddList(query) {
  const list = document.getElementById('quickAddList');
  const items = buildQuickAddIndex().filter(it => it.label.toLowerCase().includes(query.toLowerCase()));
  if (!items.length) { list.innerHTML = '<div class="quick-add-empty">No matching triggers/actions.</div>'; return; }
  list.innerHTML = items.map((it, i) => `
    <div class="quick-add-item ${i === 0 ? 'active' : ''}" data-add-module="${it.moduleName}" data-add-type="${it.typeId}">
      <span class="icon">${it.icon}</span>${it.label}
    </div>`).join('');
}

function wireQuickAdd() {
  document.getElementById('quickAddBtn').addEventListener('click', openQuickAdd);
  const input = document.getElementById('quickAddInput');
  input.addEventListener('input', () => renderQuickAddList(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeQuickAdd(); }
    if (e.key === 'Enter') {
      const first = document.querySelector('#quickAddList .quick-add-item');
      if (first) first.click();
    }
  });
  document.getElementById('quickAddList').addEventListener('click', (e) => {
    const item = e.target.closest('[data-add-module]');
    if (!item) return;
    addNode(item.dataset.addModule);
    // set the specific trigger/action type picked, not just the module default
    const node = canvasNodes[canvasNodes.length - 1];
    if (node) node.typeId = item.dataset.addType;
    closeQuickAdd();
    renderCanvas();
    renderNodeSide();
    renderProps();
  });
  document.getElementById('canvasScroll').addEventListener('mousedown', (e) => {
    if (!e.target.closest('.quick-add')) closeQuickAdd();
  });
}

// ---------- keyboard shortcuts ----------

function isTypingInField() {
  const tag = document.activeElement && document.activeElement.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function wireKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (document.getElementById('quickAdd').classList.contains('open')) return; // let its own handler run

    if (e.key === 'Tab' && !isTypingInField()) {
      e.preventDefault();
      openQuickAdd();
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && !isTypingInField() && selectedNodeId) {
      e.preventDefault();
      removeNode(selectedNodeId);
      return;
    }
    if ((e.key === '+' || e.key === '=') && !isTypingInField()) { setZoom(zoom * 1.2); return; }
    if (e.key === '-' && !isTypingInField()) { setZoom(zoom / 1.2); return; }
    if (e.key === '0' && !isTypingInField()) { resetZoom(); return; }
    if (e.key === 'Escape') { closeQuickAdd(); dragEdgeState = null; drawEdges(); }
  });
}

// ---------- save / run ----------

function buildInputMapForNode(node, typeDef) {
  const inputMap = {};
  (typeDef.fields || []).forEach(f => {
    const raw = node.config[f.name];
    if (raw === undefined || raw === '' ) return;
    setPath(inputMap, f.path || f.name, parseFieldValue(f, raw));
  });
  return inputMap;
}

// Walks the connector graph from the trigger node to produce the ordered
// chain the backend's linear flowRunner expects. Returns null (and toasts
// an explanation) if the graph isn't a single connected chain yet.
function computeOrderedChain() {
  if (canvasNodes.length === 0) return null;
  const trigger = canvasNodes.find(n => n.role === 'trigger');
  if (!trigger) { showToast('Add a trigger node first (it must be the first node you add).', 'error'); return null; }

  const nextByFrom = new Map(edges.map(e => [e.from, e.to]));
  const chain = [trigger];
  const seen = new Set([trigger.id]);
  let cur = trigger;
  while (nextByFrom.has(cur.id)) {
    const nextId = nextByFrom.get(cur.id);
    if (seen.has(nextId)) { showToast('That connector graph loops back on itself - remove the cycle before saving.', 'error'); return null; }
    const nextNode = canvasNodes.find(n => n.id === nextId);
    if (!nextNode) break;
    chain.push(nextNode);
    seen.add(nextNode.id);
    cur = nextNode;
  }

  const unconnected = canvasNodes.filter(n => !seen.has(n.id));
  if (unconnected.length) {
    showToast(`${unconnected.length} node(s) aren't connected into the trigger's chain yet - drag a connector from the previous node's output socket into each one's input socket.`, 'error');
    return null;
  }
  return chain;
}

async function saveFlow() {
  const name = document.getElementById('flowNameInput').value.trim() || 'Untitled flow';
  if (canvasNodes.length === 0) return showToast('Add at least one node first.', 'error');

  const chain = computeOrderedChain();
  if (!chain) return;

  for (const n of chain) {
    if (!n.connectionId) return showToast(`Pick an account for the ${NODE_DEFS[n.module].label} node.`, 'error');
    if (!n.typeId) return showToast(`Pick a trigger/action for the ${NODE_DEFS[n.module].label} node.`, 'error');
  }

  let triggerType = 'manual';
  let triggerConfig = {};
  let actionNodes = chain;

  if (chain[0].role === 'trigger') {
    const triggerNode = chain[0];
    const triggerDef = nodeTypeDef(triggerNode);
    triggerType = triggerDef && triggerDef.kind === 'webhook' ? 'webhook' : 'schedule';
    triggerConfig = {
      module: triggerNode.module,
      trigger: triggerNode.typeId,
      connectionId: triggerNode.connectionId,
      config: buildInputMapForNode(triggerNode, triggerDef),
    };
    actionNodes = chain.slice(1);
  }

  if (actionNodes.length === 0) {
    return showToast('Add at least one action node after the trigger.', 'error');
  }

  const steps = actionNodes.map(n => ({
    module: n.module,
    action: n.typeId,
    connectionId: n.connectionId,
    inputMap: buildInputMapForNode(n, nodeTypeDef(n)),
  }));

  try {
    const res = await fetch(API + '/flows', {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ name, triggerType, triggerConfig, steps }),
    });
    const data = await res.json();
    if (!res.ok) return showToast(data.message || data.error || 'Save failed', 'error');
    lastSavedFlowId = data.flow.id;
    document.getElementById('canvasStatus').textContent = `Saved as "${name}"`;
    showToast('Flow saved.', 'ok');
    await loadFlows();
  } catch (e) { showToast('Network error: ' + e.message, 'error'); }
}

async function runFlow() {
  const id = lastSavedFlowId || document.getElementById('flowSelect').value;
  if (!id) return showToast('Save the flow first (or pick a saved one from the dropdown).', 'error');
  document.getElementById('canvasStatus').textContent = 'Running…';
  try {
    const res = await fetch(`${API}/flows/${id}/run`, { method: 'POST', headers: headers() });
    const data = await res.json();
    document.getElementById('canvasStatus').textContent = `Run ${data.status}` + (data.error ? ': ' + data.error : '');
    showToast(`Run ${data.status}` + (data.error ? ': ' + data.error : ''), data.status === 'success' ? 'ok' : 'error');
  } catch (e) { showToast('Network error: ' + e.message, 'error'); }
}

// ---------- init ----------

function wireStaticButtons() {
  document.getElementById('toggleSideBtn').addEventListener('click', () => {
    document.getElementById('nodeSide').classList.toggle('collapsed');
  });
  document.getElementById('saveFlowBtn').addEventListener('click', saveFlow);
  document.getElementById('runFlowBtn').addEventListener('click', runFlow);
  document.getElementById('flowSelect').addEventListener('change', (e) => {
    if (e.target.value) document.getElementById('canvasStatus').textContent = 'Selected a saved flow to run — click "Run now".';
  });

  wireModuleBarDelegation();
  wireZoomPan();
  wireCanvasDragAndSelect();
  wireNodeSideDelegation();
  wirePropsDelegation();
  wireQuickAdd();
  wireKeyboardShortcuts();

  // OAuth redirect lands back here with ?provider=&email= - refresh connections.
  const params = new URLSearchParams(location.search);
  if (params.get('provider')) {
    showToast(`Connected ${params.get('provider')} account: ${params.get('email') || ''}`, 'ok');
    history.replaceState({}, '', '/flow-builder.html');
    loadConnections().then(renderModuleBar);
  }
}

document.addEventListener('DOMContentLoaded', init);
