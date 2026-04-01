// =============================================================================
// Global State
// =============================================================================
let currentUser = null;
let currentRoom = null;
let roomMembers = [];
let imageEdits = {};
let socket = null;

let loadedImages = [];
let totalImages = 0;
let totalPages = 0;
let currentPage = 0;
let currentGlobalIndex = -1;
let currentImageName = null;
let currentLabels = [];
let undoStack = [];
let selectedBoxIdx = -1;
let mode = 'draw';
let drawing = false;
let drawStart = null;
let drawCurrent = null;
let currentFilter = 'all';
let currentSearch = '';
let hasUnsavedChanges = false;

let canvas, ctx;
let img = new Image();
let imgLoaded = false;
let scale = 1;
let offsetX = 0, offsetY = 0;
let imgW = 0, imgH = 0;

let dragging = false;
let dragStart = null;
let resizing = false;
let resizeHandle = null;

// Polygon drawing state
let polygonPoints = [];        // in-progress polygon (canvas coords)
let polygonDragging = false;   // dragging a polygon vertex
let polygonDragIdx = -1;       // index of vertex being dragged
let polygonHoverIdx = -1;      // vertex under cursor (for highlight)

const BBOX_COLORS = ['#e94560', '#4caf50', '#2196f3', '#ff9800', '#9c27b0', '#00bcd4'];
const HANDLE_SIZE = 6;
const PER_PAGE = 100;

// =============================================================================
// WebSocket
// =============================================================================
function initSocket() {
    if (socket) return;
    socket = io({ transports: ['websocket', 'polling'] });
    requestNotifPermission();

    socket.on('connect', () => {
        console.log('[WS] Connected');
        const wsEl = document.getElementById('wsIndicator');
        if (wsEl) { wsEl.classList.remove('disconnected'); wsEl.classList.add('connected'); wsEl.textContent = '🟢 Connected'; }
    });

    socket.on('disconnect', () => {
        console.log('[WS] Disconnected');
        const wsEl = document.getElementById('wsIndicator');
        if (wsEl) { wsEl.classList.remove('connected'); wsEl.classList.add('disconnected'); wsEl.textContent = '🔴 Disconnected'; }
    });

    socket.on('connect_error', (err) => {
        console.error('[WS] Connection error:', err.message);
        const wsEl = document.getElementById('wsIndicator');
        if (wsEl) { wsEl.classList.remove('connected'); wsEl.classList.add('disconnected'); wsEl.textContent = '🔴 Error'; }
    });

    // Room events
    socket.on('label_saved', (data) => {
        imageEdits[data.image_name] = data.editor;
        const item = loadedImages.find(i => i.name === data.image_name);
        if (item) {
            item.annotated = data.annotated;
            item.bbox_count = data.bbox_count;
        }
        renderImageList();
        updateStats();
        showToast(data.editor.display_name + ' saved ' + data.image_name, false);
    });

    socket.on('folder_changed', (data) => {
        showToast('Folder updated: ' + data.image_count + ' images');
        loadCurrentDirs();
        loadImagePage(0).then(() => { if (loadedImages.length > 0) selectImage(0); });
        updateStats();
    });

    socket.on('user_joined', (data) => {
        showToast(data.display_name + ' joined the room');
        showDesktopNotif('Member Joined', data.display_name + ' joined the room');
        refreshRoomMembers();
    });

    socket.on('user_left', (data) => {
        showToast(data.display_name + ' left the room');
        showDesktopNotif('Member Left', data.display_name + ' left the room');
        refreshRoomMembers();
    });

    // Remote cursor tracking
    socket.on('cursor_update', (data) => {
        if (!currentImageName || data.image_name !== currentImageName) {
            removeRemoteCursor(data.user_id);
            return;
        }
        updateRemoteCursor(data);
    });

    // Online users update
    socket.on('online_users', (data) => {
        _roomOnlineUsers = data.users || [];
        updateChatMembersList();
        updateTopbar();
    });

    // Join request notifications
    socket.on('join_request', (data) => {
        showToast('🔒 ' + (data.display_name || data.username) + ' wants to join this room');
        showDesktopNotif('Join Request', (data.display_name || data.username) + ' wants to join');
        // Auto-refresh if settings modal is open
        if (document.getElementById('settingsModal').classList.contains('show')) {
            loadJoinRequests();
        }
    });

    socket.on('join_request_resolved', (data) => {
        if (currentUser && data.user_id === currentUser.user_id) {
            if (data.status === 'approved') {
                showToast('Your join request was approved! 🎉');
                loadRooms();
            } else {
                showToast('Your join request was denied', true);
            }
        }
    });

    // Chat message
    socket.on('chat_message', (data) => {
        if (!currentRoom || data.room_id !== currentRoom.room_id) return;
        const panel = document.getElementById('chatPanel');
        const isOpen = panel.classList.contains('open');

        if (data.msg_type === 'dm') {
            if (_chatDmTarget && (data.sender_id === _chatDmTarget || data.sender_id === currentUser.user_id)) {
                appendChatMessage(data);
            }
            if (!isOpen || !_chatDmTarget) {
                _chatUnreadCount++;
                updateChatUnread();
                playChatSound();
            }
        } else {
            if (!_chatDmTarget) {
                appendChatMessage(data);
            }
            if (!isOpen || _chatDmTarget) {
                _chatUnreadCount++;
                updateChatUnread();
                playChatSound();
            }
        }
    });

    // Training events
    socket.on('train_log', (data) => {
        if (data.session_id === _activeSessionId) {
            addSessionLogLine(data.message, data.type);
        }
        refreshSessionList();
    });

    socket.on('train_progress', (data) => {
        if (data.session_id === _activeSessionId) {
            const el = document.getElementById('sessionDetailProgress');
            if (el) el.textContent = 'Epoch ' + data.current_epoch + '/' + data.total_epochs + ' (' + data.percent + '%)';
            updateTrainingChart(data);
        }
        refreshSessionList();
    });

    socket.on('train_metrics', (data) => {
        if (data.session_id === _activeSessionId) {
            updateTrainingChartVal(data);
        }
    });

    socket.on('train_complete', (data) => {
        refreshSessionList();
        if (data.session_id === _activeSessionId) {
            updateSessionDetailHeader(data.session_id);
        }
        showDesktopNotif('Training Complete', 'Session ' + data.session_id.slice(0,8) + ' ' + (data.status || 'finished'));
    });

    // Auto-annotate events
    socket.on('apply_progress', (data) => {
        const pct = data.total > 0 ? Math.round(data.done / data.total * 100) : 0;
        const bar = document.getElementById('autoAnnotateProgressBar');
        const text = document.getElementById('autoAnnotateProgressText');
        if (bar) bar.style.width = pct + '%';
        if (text) text.textContent = 'Processing ' + data.done + '/' + data.total + ' — ' + data.saved + ' saved';
    });

    socket.on('apply_complete', (data) => {
        showToast('Auto-annotate complete: ' + data.saved + ' images from ' + escHtml(data.model));
        showDesktopNotif('Auto-Annotate Complete', data.saved + ' images annotated');
        const bar = document.getElementById('autoAnnotateProgressBar');
        const text = document.getElementById('autoAnnotateProgressText');
        const btn = document.getElementById('autoAnnotateBtn');
        if (bar) bar.style.width = '100%';
        if (text) text.textContent = 'Done! ' + data.saved + '/' + data.total + ' images annotated.';
        if (btn) btn.disabled = false;
        loadImagePage(currentPage);
        updateStats();
    });

    socket.on('apply_error', (data) => {
        showToast('Auto-annotate error: ' + (data.error || 'unknown'), true);
        const btn = document.getElementById('autoAnnotateBtn');
        if (btn) btn.disabled = false;
    });

    // Model management events (validate/export/benchmark)
    socket.on('model_job_complete', (data) => {
        if (data.type === 'validate') {
            showDesktopNotif('Validation Complete', 'mAP50: ' + ((data.result?.mAP50 || 0) * 100).toFixed(1) + '%');
        } else if (data.type === 'export') {
            showDesktopNotif('Model Export Complete', data.result?.format_label + ' — ' + data.result?.size_mb + ' MB');
        } else if (data.type === 'benchmark') {
            showDesktopNotif('Benchmark Complete', data.result?.benchmarks?.length + ' formats tested');
        }
    });

    socket.on('model_job_error', (data) => {
        showToast('Model job error (' + data.type + '): ' + (data.error || 'unknown'), true);
    });
}

function joinSocketRoom(roomId) {
    if (socket) socket.emit('join_room', { room_id: roomId });
}

function leaveSocketRoom(roomId) {
    if (socket) socket.emit('leave_room', { room_id: roomId });
}

function joinTrainingChannel() {
    if (socket) socket.emit('join_training');
}

function leaveTrainingChannel() {
    if (socket) socket.emit('leave_training');
}

async function refreshRoomMembers() {
    if (!currentRoom) return;
    const res = await fetch('/api/rooms/' + currentRoom.room_id);
    const data = await res.json();
    roomMembers = data.members || [];
    updateTopbar();
    renderAssignMemberList();
}

// =============================================================================
// View Switching
// =============================================================================
function showView(viewId) {
    document.getElementById('loginView').style.display = 'none';
    document.getElementById('roomsView').style.display = 'none';
    document.getElementById('annotatorView').style.display = 'none';
    const el = document.getElementById(viewId);
    el.style.display = 'flex';
    if (viewId !== 'loginView') el.style.flexDirection = 'column';
}

// Main menu tabs (Rooms / Training)
function switchMainTab(tab) {
    document.querySelectorAll('.main-tab').forEach(t => t.classList.remove('active'));
    document.querySelector('.main-tab[data-tab="' + tab + '"]').classList.add('active');

    document.getElementById('roomsTabContent').style.display = tab === 'rooms' ? 'flex' : 'none';
    document.getElementById('trainingTabContent').style.display = tab === 'training' ? 'flex' : 'none';

    if (tab === 'training') {
        joinTrainingChannel();
        initTrainingView();
    } else {
        leaveTrainingChannel();
    }
}

// =============================================================================
// Auth
// =============================================================================
function showLogin() { document.getElementById('loginForm').style.display = 'block'; document.getElementById('registerForm').style.display = 'none'; }
function showRegister() { document.getElementById('loginForm').style.display = 'none'; document.getElementById('registerForm').style.display = 'block'; }

async function doLogin() {
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value;
    document.getElementById('loginError').textContent = '';
    if (!username || !password) { document.getElementById('loginError').textContent = 'Fill in all fields'; return; }
    const res = await fetch('/api/login', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ username, password }) });
    const data = await res.json();
    if (data.error) { document.getElementById('loginError').textContent = data.error; return; }
    currentUser = data;
    initSocket();
    enterRoomsView();
}

async function doRegister() {
    const username = document.getElementById('regUsername').value.trim();
    const display_name = document.getElementById('regDisplayName').value.trim();
    const password = document.getElementById('regPassword').value;
    document.getElementById('registerError').textContent = '';
    if (!username || !password) { document.getElementById('registerError').textContent = 'Fill in required fields'; return; }
    const res = await fetch('/api/register', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ username, password, display_name }) });
    const data = await res.json();
    if (data.error) { document.getElementById('registerError').textContent = data.error; return; }
    currentUser = data;
    initSocket();
    enterRoomsView();
}

async function doLogout() {
    await fetch('/api/logout', { method: 'POST' });
    currentUser = null; currentRoom = null;
    if (socket) { socket.disconnect(); socket = null; }
    showView('loginView');
}

async function checkAuth() {
    const res = await fetch('/api/me');
    const data = await res.json();
    if (data.logged_in) { currentUser = data; initSocket(); enterRoomsView(); }
    else { showView('loginView'); }
}

// =============================================================================
// Rooms
// =============================================================================
function enterRoomsView() {
    showView('roomsView');
    document.getElementById('roomsUsername').textContent = currentUser.display_name || currentUser.username;
    document.getElementById('roomsUserDot').style.background = currentUser.color;
    switchMainTab('rooms');
    loadRooms();
}

async function loadRooms() {
    const res = await fetch('/api/rooms');
    const data = await res.json();
    const list = document.getElementById('roomList');
    if (data.rooms.length === 0) { list.innerHTML = '<div style="color:#888; font-size:13px;">No rooms yet. Create or join one!</div>'; return; }

    let onlineCounts = {};
    try {
        const ocRes = await fetch('/api/rooms/online-counts');
        const ocData = await ocRes.json();
        onlineCounts = ocData.counts || {};
    } catch(e) {}

    list.innerHTML = data.rooms.map(r => {
        const onlineCount = onlineCounts[r.id] || 0;
        const onlineHtml = onlineCount > 0
            ? '<div class="online-dots"><div class="online-dot" style="background:#4caf50;"></div><span class="online-count">' + onlineCount + ' active</span></div>'
            : '<div class="online-dots"><span style="font-size:10px;color:#888;">—</span></div>';
        return '<div class="room-card" onclick="enterRoom(' + r.id + ')">' +
            '<div class="room-icon">🏠</div>' +
            '<div class="room-details"><div class="room-name">' + escHtml(r.name) + '</div>' +
            '<div class="room-meta">by ' + escHtml(r.creator_name || 'unknown') + ' · ' + r.member_count + ' members</div>' +
            onlineHtml + '</div>' +
            '<div class="room-code-badge">' + escHtml(r.code) + '</div></div>';
    }).join('');
}

async function createRoom() {
    const name = document.getElementById('createRoomName').value.trim();
    const isPrivate = document.getElementById('createRoomPrivate').checked;
    document.getElementById('createRoomError').textContent = '';
    if (!name) { document.getElementById('createRoomError').textContent = 'Name required'; return; }
    const res = await fetch('/api/rooms/create', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ name, is_private: isPrivate }) });
    const data = await res.json();
    if (data.error) { document.getElementById('createRoomError').textContent = data.error; return; }
    document.getElementById('createRoomName').value = '';
    document.getElementById('createRoomPrivate').checked = false;
    showToast('Room created! Code: ' + data.code + (data.is_private ? ' 🔒' : ''));
    loadRooms();
}

async function joinRoom() {
    const code = document.getElementById('joinRoomCode').value.trim().toUpperCase();
    document.getElementById('joinRoomError').textContent = '';
    if (!code) { document.getElementById('joinRoomError').textContent = 'Code required'; return; }
    const res = await fetch('/api/rooms/join', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ code }) });
    const data = await res.json();
    if (data.error) { document.getElementById('joinRoomError').textContent = data.error; return; }
    if (data.status === 'pending') {
        document.getElementById('joinRoomError').style.color = '#ffd54f';
        document.getElementById('joinRoomError').textContent = '🔒 ' + (data.message || 'Request pending approval');
        return;
    }
    document.getElementById('joinRoomCode').value = '';
    document.getElementById('joinRoomError').style.color = '';
    showToast('Joined room: ' + data.name);
    loadRooms();
}

async function enterRoom(roomId) {
    const res = await fetch('/api/rooms/' + roomId + '/enter', { method: 'POST', headers: {'Content-Type': 'application/json'} });
    const data = await res.json();
    if (data.error) { showToast(data.error, true); return; }
    currentRoom = data;
    showView('annotatorView');
    initAnnotator();
    joinSocketRoom(roomId);
    const roomClasses = data.classes || ['object'];
    const sel = document.getElementById('classSelect');
    sel.innerHTML = roomClasses.map((name, i) => '<option value="' + i + '">' + i + ': ' + escHtml(name) + '</option>').join('');
    const infoRes = await fetch('/api/rooms/' + roomId);
    const infoData = await infoRes.json();
    roomMembers = infoData.members || [];
    updateTopbar();
    renderAssignMemberList();
    loadImageEdits();
    document.getElementById('chatToggle').style.display = 'block';
    _chatUnreadCount = 0;
    _chatDmTarget = null;
    switchChatTab('global');
    loadChatMessages();
}

function leaveRoom() {
    if (hasUnsavedChanges && currentImageName) saveLabels();
    if (currentRoom) leaveSocketRoom(currentRoom.room_id);
    currentRoom = null;
    document.getElementById('chatToggle').style.display = 'none';
    document.getElementById('chatPanel').classList.remove('open');
    enterRoomsView();
}

function updateTopbar() {
    document.getElementById('topbarRoomCode').textContent = currentRoom.room_code;
    document.getElementById('topbarRoomName').textContent = currentRoom.room_name;
    document.getElementById('topbarUsername').textContent = currentUser.display_name || currentUser.username;
    const membersEl = document.getElementById('topbarMembers');
    const onlineIds = new Set(_roomOnlineUsers.map(u => u.user_id));
    membersEl.innerHTML = roomMembers.map(m => {
        const mId = m.user_id || m.id;
        const isOnline = onlineIds.has(mId);
        const cls = isOnline ? 'member-dot' : 'member-dot offline';
        const ring = isOnline ? '<div class="online-ring"></div>' : '';
        return '<div class="' + cls + '" style="background:' + m.color + ';" title="' + escHtml(m.display_name || m.username) + (isOnline ? ' (online)' : '') + '">' +
            escHtml((m.display_name || m.username).charAt(0).toUpperCase()) + ring + '</div>';
    }).join('');
    if (roomMembers.length > 0) {
        document.getElementById('userLegend').style.display = 'block';
        document.getElementById('userLegendItems').innerHTML = roomMembers.map(m =>
            '<span class="user-legend-item"><span class="dot" style="background:' + m.color + ';"></span>' +
            escHtml(m.display_name || m.username) + '</span>'
        ).join('');
    }
}

async function loadImageEdits() {
    if (!currentRoom) return;
    const res = await fetch('/api/image-edits?room_id=' + currentRoom.room_id);
    const data = await res.json();
    imageEdits = data.edits || {};
    renderImageList();
}

// =============================================================================
// Training View — Multi-Session
// =============================================================================
let trainingViewInitialized = false;
let trainParamsSchema = {};
let _activeSessionId = null;
let _gpuInterval = null;
let _sessionRefreshInterval = null;

async function initTrainingView() {
    if (trainingViewInitialized) return;
    trainingViewInitialized = true;

    const res = await fetch('/api/train/params-schema');
    const data = await res.json();
    trainParamsSchema = data.schema;
    buildTrainParamUI();

    try {
        const dirsRes = await fetch('/api/current-dirs');
        const dirs = await dirsRes.json();
        document.getElementById('trainDataYaml').value = dirs.export_dir + '/data.yaml';
    } catch(e) {}

    await refreshSessionList();

    loadGpuInfo();
    _gpuInterval = setInterval(loadGpuInfo, 5000);
    _sessionRefreshInterval = setInterval(refreshSessionList, 3000);
}

// --- GPU Info ---
async function loadGpuInfo() {
    try {
        const res = await fetch('/api/gpu-info');
        const data = await res.json();
        const textEl = document.getElementById('gpuInfoText');
        const barEl = document.getElementById('gpuBar');
        if (data.gpus && data.gpus.length > 0) {
            const gpu = data.gpus[0];
            const usedPct = Math.round((gpu.memory_used_mb / gpu.memory_total_mb) * 100);
            textEl.textContent = gpu.name + ' — ' + gpu.memory_used_mb + '/' + gpu.memory_total_mb + ' MB (' + usedPct + '%)';
            barEl.style.width = usedPct + '%';
            barEl.className = 'gpu-bar ' + (usedPct < 50 ? 'low' : usedPct < 80 ? 'mid' : 'high');
        } else {
            textEl.textContent = data.error || 'No GPU detected';
            barEl.style.width = '0%';
        }
    } catch(e) {
        document.getElementById('gpuInfoText').textContent = 'Error loading GPU info';
    }
}

// --- Session List ---
async function refreshSessionList() {
    try {
        const res = await fetch('/api/train/sessions');
        const data = await res.json();
        const list = document.getElementById('sessionList');
        const empty = document.getElementById('sessionListEmpty');

        if (!data.sessions || data.sessions.length === 0) {
            empty.style.display = 'block';
            list.querySelectorAll('.session-card').forEach(c => c.remove());
            return;
        }
        empty.style.display = 'none';

        let html = '';
        for (const s of data.sessions) {
            const active = s.id === _activeSessionId ? ' active' : '';
            const pct = s.progress ? s.progress.percent || 0 : 0;
            const epochStr = s.progress ? ('Epoch ' + (s.progress.current_epoch||0) + '/' + (s.progress.total_epochs||'?')) : '';
            html += '<div class="session-card' + active + '" onclick="viewSession(\'' + s.id + '\')">';
            html += '  <div class="session-name">' + escHtml(s.name) + '</div>';
            html += '  <div class="session-meta">';
            html += '    <span class="session-status ' + s.status + '">' + s.status + '</span>';
            html += '    <span>' + escHtml(s.model || '') + '</span>';
            html += '  </div>';
            if (s.status === 'running' || s.status === 'starting' || pct > 0) {
                html += '  <div class="session-progress">';
                html += '    <div class="progress-bar-outer"><div class="progress-bar-inner" style="width:' + pct + '%"></div></div>';
                html += '    <div class="progress-text">' + epochStr + (pct > 0 ? ' — ' + pct + '%' : '') + '</div>';
                html += '  </div>';
            }
            html += '  <div class="session-meta" style="margin-top:4px;">';
            html += '    <span>' + (s.created_at || '') + '</span>';
            if (s.log_count) html += '    <span>' + s.log_count + ' lines</span>';
            html += '  </div>';
            html += '</div>';
        }
        const scrollTop = list.scrollTop;
        list.querySelectorAll('.session-card').forEach(c => c.remove());
        list.insertAdjacentHTML('beforeend', html);
        list.scrollTop = scrollTop;
    } catch(e) {}
}

// --- View Session Detail ---
async function viewSession(sessionId) {
    _activeSessionId = sessionId;
    document.getElementById('newTrainForm').style.display = 'none';
    document.getElementById('sessionEmptyState').style.display = 'none';
    const logView = document.getElementById('sessionLogView');
    logView.style.display = 'flex';

    document.querySelectorAll('.session-card').forEach(c => c.classList.remove('active'));
    document.querySelectorAll('.session-card').forEach(c => {
        if (c.onclick && c.onclick.toString().includes(sessionId)) c.classList.add('active');
    });

    try {
        const res = await fetch('/api/train/status?session_id=' + sessionId);
        const data = await res.json();
        if (data.error) { showToast(data.error, true); return; }

        updateSessionDetailHeader(sessionId, data);

        const logEl = document.getElementById('sessionLogContent');
        logEl.innerHTML = '';
        if (data.log) {
            data.log.forEach(entry => {
                const line = document.createElement('div');
                line.className = 'log-line ' + (entry.type || 'info');
                line.textContent = entry.message || entry;
                logEl.appendChild(line);
            });
            logEl.scrollTop = logEl.scrollHeight;
        }

        if (data.metrics_history && data.metrics_history.length) {
            drawTrainingChart(data.metrics_history);
        } else {
            _metricsHistory = [];
            document.getElementById('trainChartContainer').style.display = 'none';
        }
    } catch(e) {
        showToast('Failed to load session', true);
    }

    refreshSessionList();
}

function updateSessionDetailHeader(sessionId, data) {
    if (!data) {
        fetch('/api/train/status?session_id=' + sessionId).then(r => r.json()).then(d => {
            if (!d.error) updateSessionDetailHeader(sessionId, d);
        });
        return;
    }
    document.getElementById('sessionDetailName').textContent = data.name || sessionId;
    const badge = document.getElementById('sessionDetailStatus');
    badge.className = 'status-badge ' + (data.status || 'idle');
    badge.textContent = data.status || 'idle';

    const stopBtn = document.getElementById('sessionStopBtn');
    const resumeBtn = document.getElementById('sessionResumeBtn');
    const removeBtn = document.getElementById('sessionRemoveBtn');
    if (data.status === 'running' || data.status === 'starting') {
        stopBtn.style.display = 'inline-block';
        resumeBtn.style.display = 'none';
        removeBtn.style.display = 'none';
    } else {
        stopBtn.style.display = 'none';
        if (data.status === 'stopped' || data.status === 'error') {
            resumeBtn.style.display = 'inline-block';
        } else {
            resumeBtn.style.display = 'none';
        }
        removeBtn.style.display = 'inline-block';
    }

    const progressEl = document.getElementById('sessionDetailProgress');
    if (data.progress && data.progress.current_epoch) {
        progressEl.textContent = 'Epoch ' + data.progress.current_epoch + '/' + data.progress.total_epochs + ' (' + (data.progress.percent||0) + '%)';
    } else {
        progressEl.textContent = '';
    }
}

function addSessionLogLine(message, type) {
    const logEl = document.getElementById('sessionLogContent');
    if (!logEl) return;
    const line = document.createElement('div');
    line.className = 'log-line ' + (type || 'info');
    line.textContent = message;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
}

// --- New Training ---
function showNewTrainingForm() {
    _activeSessionId = null;
    document.getElementById('sessionLogView').style.display = 'none';
    document.getElementById('sessionEmptyState').style.display = 'none';
    document.getElementById('newTrainForm').style.display = 'block';
    document.querySelectorAll('.session-card').forEach(c => c.classList.remove('active'));
}

function hideNewTrainingForm() {
    document.getElementById('newTrainForm').style.display = 'none';
    if (!_activeSessionId) {
        document.getElementById('sessionEmptyState').style.display = 'flex';
    }
}

function buildTrainParamUI() {
    const container = document.getElementById('trainParamGroups');
    const groups = {
        core: { label: '⚙️ Core Parameters', keys: [] },
        lr: { label: '📈 Learning Rate', keys: [] },
        loss: { label: '⚖️ Loss Weights', keys: [] },
        aug: { label: '🎨 Augmentation', keys: [] },
    };

    for (const [key, schema] of Object.entries(trainParamsSchema)) {
        if (key === 'model') continue;
        const group = schema.group || 'core';
        if (groups[group]) groups[group].keys.push(key);
    }

    for (const [groupId, group] of Object.entries(groups)) {
        if (group.keys.length === 0) continue;
        const isCore = groupId === 'core';
        let html = '<div class="param-group">';
        html += '<div class="param-group-header" onclick="toggleParamGroup(this)">';
        html += '<span>' + group.label + ' (' + group.keys.length + ')</span>';
        html += '<span class="chevron open">▶</span>';
        html += '</div>';
        html += '<div class="param-group-body open">';

        for (const key of group.keys) {
            const schema = trainParamsSchema[key];
            const label = schema.label || key;
            const defaultVal = schema.default;
            const ptype = schema.type;

            html += '<div class="param-row">';
            html += '<label title="' + key + '">' + escHtml(label) + '</label>';

            if (ptype === 'bool') {
                const checked = defaultVal ? 'checked' : '';
                html += '<input type="checkbox" id="tp_' + key + '" ' + checked + '>';
            } else if (schema.options) {
                html += '<select id="tp_' + key + '">';
                schema.options.forEach(opt => {
                    const sel = opt === defaultVal ? ' selected' : '';
                    html += '<option value="' + opt + '"' + sel + '>' + opt + '</option>';
                });
                html += '</select>';
            } else if (ptype === 'int' || ptype === 'float') {
                const step = ptype === 'float' ? '0.001' : '1';
                const val = defaultVal !== null && defaultVal !== undefined ? defaultVal : '';
                html += '<input type="number" id="tp_' + key + '" value="' + val + '" step="' + step + '"';
                if (schema.min !== undefined) html += ' min="' + schema.min + '"';
                if (schema.max !== undefined) html += ' max="' + schema.max + '"';
                html += '>';
            } else {
                html += '<input type="text" id="tp_' + key + '" value="' + (defaultVal || '') + '">';
            }

            const defDisplay = defaultVal !== null && defaultVal !== undefined ? defaultVal : 'none';
            html += '<span class="param-default">' + defDisplay + '</span>';
            html += '</div>';
        }

        html += '</div></div>';
        container.innerHTML += html;
    }
}

function toggleParamGroup(header) {
    const chevron = header.querySelector('.chevron');
    const body = header.nextElementSibling;
    chevron.classList.toggle('open');
    body.classList.toggle('open');
}

function collectTrainParams() {
    const params = {};
    params.model = document.getElementById('trainModel').value;
    params.data_yaml = document.getElementById('trainDataYaml').value.trim();
    params.session_name = (document.getElementById('trainSessionName').value.trim()) || ('Training ' + new Date().toLocaleTimeString());

    for (const [key, schema] of Object.entries(trainParamsSchema)) {
        if (key === 'model') continue;
        const el = document.getElementById('tp_' + key);
        if (!el) continue;

        if (schema.type === 'bool') {
            params[key] = el.checked;
        } else if (schema.type === 'int' || schema.type === 'float') {
            if (el.value !== '' && el.value !== String(schema.default)) {
                params[key] = schema.type === 'int' ? parseInt(el.value) : parseFloat(el.value);
            }
        } else {
            if (el.value.trim() && el.value.trim() !== String(schema.default || '')) {
                params[key] = el.value.trim();
            }
        }
    }
    return params;
}

async function startTrainingSession() {
    const params = collectTrainParams();
    if (!params.data_yaml) { showToast('Please set Data YAML path', true); return; }

    const res = await fetch('/api/train', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(params),
    });
    const data = await res.json();
    if (data.error) { showToast(data.error, true); return; }

    showToast('Training started: ' + data.session_name);
    hideNewTrainingForm();

    await refreshSessionList();
    viewSession(data.session_id);
}

async function stopTrainingSession() {
    if (!_activeSessionId) return;
    const res = await fetch('/api/train/stop/' + _activeSessionId, { method: 'POST' });
    const data = await res.json();
    showToast(data.message || 'Stop requested');
    setTimeout(() => {
        refreshSessionList();
        if (_activeSessionId) updateSessionDetailHeader(_activeSessionId);
    }, 500);
}

async function removeTrainingSession() {
    if (!_activeSessionId) return;
    if (!confirm('Remove this training session log?')) return;
    const res = await fetch('/api/train/remove/' + _activeSessionId, { method: 'POST' });
    const data = await res.json();
    if (data.error) { showToast(data.error, true); return; }
    showToast('Session removed');
    _activeSessionId = null;
    document.getElementById('sessionLogView').style.display = 'none';
    document.getElementById('sessionEmptyState').style.display = 'flex';
    await refreshSessionList();
}

async function resumeTrainingSession() {
    if (!_activeSessionId) return;
    const res = await fetch('/api/train/resume/' + _activeSessionId, { method: 'POST' });
    const data = await res.json();
    if (data.error) { showToast(data.error, true); return; }
    showToast('Training resumed: ' + (data.session_name || ''));
    setTimeout(() => {
        refreshSessionList();
        if (_activeSessionId) viewSession(_activeSessionId);
    }, 500);
}

async function browseForTrainData() {
    const input = document.getElementById('trainDataYaml');
    const browser = document.getElementById('trainDataBrowser');
    const current = input.value.trim();
    let browsePath = current ? current.substring(0, current.lastIndexOf('/')) : '';

    browser.style.display = 'block';
    const res = await fetch('/api/browse', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ path: browsePath, file_ext: '.yaml,.yml' }),
    });
    const data = await res.json();
    if (data.error) { showToast(data.error, true); return; }

    let html = '';
    if (data.parent) {
        html += '<div class="folder-item parent" onclick="browseTrainData(\'' +
                data.parent.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + '\')">⬆ ..</div>';
    }
    try {
        const dirPath = data.path;
        data.dirs.forEach(d => {
            const full = (dirPath + '/' + d).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            html += '<div class="folder-item" onclick="browseTrainData(\'' + full + '\')">📁 ' + escHtml(d) + '</div>';
        });
        (data.files || []).forEach(f => {
            const pathEsc = escHtml(f.path).replace(/'/g, "\\'");
            html += '<div class="folder-item" style="color:#4fc3f7; cursor:pointer;" onclick="selectTrainYaml(\'' + pathEsc + '\')">📄 ' + escHtml(f.name) + '</div>';
        });
    } catch(e) {}
    browser.innerHTML = html;
}

function browseTrainData(path) {
    const browser = document.getElementById('trainDataBrowser');
    fetch('/api/browse', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ path, file_ext: '.yaml,.yml' }),
    }).then(r => r.json()).then(data => {
        if (data.error) return;
        let html = '';
        if (data.parent) {
            html += '<div class="folder-item parent" onclick="browseTrainData(\'' +
                    data.parent.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + '\')">⬆ ..</div>';
        }
        data.dirs.forEach(d => {
            const full = (data.path + '/' + d).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            html += '<div class="folder-item" onclick="browseTrainData(\'' + full + '\')">📁 ' + escHtml(d) + '</div>';
        });
        (data.files || []).forEach(f => {
            const pathEsc = escHtml(f.path).replace(/'/g, "\\'");
            html += '<div class="folder-item" style="color:#4fc3f7; cursor:pointer;" onclick="selectTrainYaml(\'' + pathEsc + '\')">📄 ' + escHtml(f.name) + '</div>';
        });
        browser.innerHTML = html;
    });
}

function selectTrainYaml(yamlPath) {
    document.getElementById('trainDataYaml').value = yamlPath;
    document.getElementById('trainDataBrowser').style.display = 'none';
}

// =============================================================================
// Chat System
// =============================================================================
let _chatUnreadCount = 0;
let _chatDmTarget = null;
let _chatDmTargetName = '';
let _roomOnlineUsers = [];

function playChatSound() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.08);
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.25);
    } catch(e) {}
}

function toggleChat() {
    const panel = document.getElementById('chatPanel');
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) {
        _chatUnreadCount = 0;
        updateChatUnread();
        document.getElementById('chatInput').focus();
        const msgs = document.getElementById('chatMessages');
        msgs.scrollTop = msgs.scrollHeight;
    }
}

function updateChatUnread() {
    const badge = document.getElementById('chatUnread');
    if (_chatUnreadCount > 0) {
        badge.style.display = 'flex';
        badge.textContent = _chatUnreadCount > 99 ? '99+' : _chatUnreadCount;
    } else {
        badge.style.display = 'none';
    }
}

function switchChatTab(tab) {
    document.querySelectorAll('.chat-tab').forEach(t => t.classList.remove('active'));
    document.querySelector('.chat-tab[data-chat="' + tab + '"]').classList.add('active');

    const membersList = document.getElementById('chatMembersList');
    const messagesEl = document.getElementById('chatMessages');
    const inputBar = document.getElementById('chatInputBar');

    if (tab === 'members') {
        membersList.classList.add('visible');
        messagesEl.style.display = 'none';
        inputBar.style.display = 'none';
        loadOnlineMembers();
    } else if (tab === 'global') {
        _chatDmTarget = null;
        _chatDmTargetName = '';
        membersList.classList.remove('visible');
        messagesEl.style.display = 'flex';
        inputBar.style.display = 'flex';
        document.getElementById('chatTitle').textContent = '💬 Room Chat';
        document.getElementById('chatInput').placeholder = 'Type a message...';
        loadChatMessages();
    }
}

function openDmChat(userId, displayName) {
    _chatDmTarget = userId;
    _chatDmTargetName = displayName;
    document.getElementById('chatMembersList').classList.remove('visible');
    document.getElementById('chatMessages').style.display = 'flex';
    document.getElementById('chatInputBar').style.display = 'flex';
    document.getElementById('chatTitle').textContent = '💬 DM: ' + displayName;
    document.getElementById('chatInput').placeholder = 'Message ' + displayName + '...';
    document.querySelectorAll('.chat-tab').forEach(t => t.classList.remove('active'));
    loadChatMessages();
}

async function loadOnlineMembers() {
    if (!currentRoom) return;
    try {
        const res = await fetch('/api/rooms/' + currentRoom.room_id + '/online');
        const data = await res.json();
        _roomOnlineUsers = data.online || [];
    } catch(e) {}
    updateChatMembersList();
}

function updateChatMembersList() {
    const list = document.getElementById('chatMembersList');
    const onlineIds = new Set(_roomOnlineUsers.map(u => u.user_id));

    const allMembers = [...roomMembers];
    let html = '';
    for (const m of allMembers) {
        const mId = m.user_id || m.id;
        if (mId === currentUser.user_id) continue;
        const isOnline = onlineIds.has(mId);
        const name = m.display_name || m.username;
        html += '<div class="chat-member-item" onclick="openDmChat(' + mId + ', \'' + escHtml(name).replace(/'/g, "\\'") + '\')">';
        const ringStyle = isOnline ? 'border:2px solid #4caf50;' : '';
        html += '<div class="member-color" style="background:' + (m.color || '#888') + ';' + ringStyle + '"></div>';
        html += '<span>' + escHtml(name) + '</span>';
        if (isOnline) html += '<div class="online-indicator"></div>';
        html += '</div>';
    }
    if (!html) html = '<div style="padding:16px; color:#666; font-size:12px;">No other members</div>';
    list.innerHTML = html;
}

async function loadChatMessages() {
    if (!currentRoom) return;
    const messagesEl = document.getElementById('chatMessages');
    messagesEl.innerHTML = '<div style="text-align:center;color:#555;font-size:11px;padding:20px;">Loading...</div>';

    let url = '/api/rooms/' + currentRoom.room_id + '/messages?type=global';
    if (_chatDmTarget) {
        url = '/api/rooms/' + currentRoom.room_id + '/messages?type=dm&with_user=' + _chatDmTarget;
    }

    try {
        const res = await fetch(url);
        const data = await res.json();
        messagesEl.innerHTML = '';
        if (data.messages && data.messages.length > 0) {
            data.messages.forEach(m => appendChatMessage(m));
        } else {
            messagesEl.innerHTML = '<div style="text-align:center;color:#555;font-size:11px;padding:20px;">No messages yet. Say hi! 👋</div>';
        }
    } catch(e) {
        messagesEl.innerHTML = '<div style="text-align:center;color:#e94560;font-size:11px;padding:20px;">Error loading messages</div>';
    }
}

function appendChatMessage(msg) {
    const messagesEl = document.getElementById('chatMessages');
    const placeholder = messagesEl.querySelector('div[style*="text-align:center"]');
    if (placeholder) placeholder.remove();

    const isSelf = msg.sender_id === currentUser.user_id;
    const div = document.createElement('div');
    div.className = 'chat-msg ' + (isSelf ? 'self' : 'other');

    const senderName = msg.sender_display_name || msg.sender_username || '';
    const time = msg.created_at ? new Date(msg.created_at).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : '';

    let html = '';
    if (!isSelf) {
        html += '<div class="msg-sender" style="color:' + (msg.sender_color || '#888') + ';">' + escHtml(senderName) + '</div>';
    }
    html += '<div>' + escHtml(msg.message) + '</div>';
    html += '<div class="msg-time">' + time + '</div>';
    div.innerHTML = html;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function sendChatMessage() {
    const input = document.getElementById('chatInput');
    const message = input.value.trim();
    if (!message || !currentRoom) return;

    const body = {
        message: message,
        type: _chatDmTarget ? 'dm' : 'global',
    };
    if (_chatDmTarget) body.recipient_id = _chatDmTarget;

    input.value = '';
    try {
        await fetch('/api/rooms/' + currentRoom.room_id + '/messages', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body),
        });
    } catch(e) {
        showToast('Failed to send message', true);
    }
}

// =============================================================================
// Dashboard
// =============================================================================
async function openDashboard() {
    openModal('dashboardModal');
    refreshDashboard();
}

async function refreshDashboard() {
    const statsRes = await fetch('/api/stats');
    const stats = await statsRes.json();
    const pct = stats.total_images > 0 ? Math.round(stats.annotated / stats.total_images * 100) : 0;
    document.getElementById('dashCards').innerHTML =
        '<div class="dash-card"><div class="dash-value">' + stats.total_images + '</div><div class="dash-label">Total Images</div></div>' +
        '<div class="dash-card"><div class="dash-value">' + stats.annotated + '</div><div class="dash-label">Annotated</div></div>' +
        '<div class="dash-card"><div class="dash-value">' + stats.total_bboxes + '</div><div class="dash-label">Total Boxes</div></div>' +
        '<div class="dash-card"><div class="dash-value">' + pct + '%</div><div class="dash-label">Progress</div></div>';

    if (stats.class_distribution) {
        const classNames = stats.class_names || [];
        const maxCount = Math.max(...Object.values(stats.class_distribution), 1);
        const colors = ['#e94560','#4caf50','#2196f3','#ff9800','#9c27b0','#00bcd4','#ff5722','#795548'];
        let cdHtml = '';
        for (const [classId, count] of Object.entries(stats.class_distribution)) {
            const name = classNames[parseInt(classId)] || ('class_' + classId);
            const pctBar = Math.round(count / maxCount * 100);
            const color = colors[parseInt(classId) % colors.length];
            cdHtml += '<div class="dash-class-bar"><span class="bar-label">' + escHtml(name) + '</span>' +
                '<div class="bar"><div class="bar-fill" style="width:' + pctBar + '%;background:' + color + ';"></div></div>' +
                '<span class="bar-count">' + count + '</span></div>';
        }
        document.getElementById('dashClassDist').innerHTML = cdHtml || '<div style="font-size:11px;color:#666;">No data</div>';
    } else {
        document.getElementById('dashClassDist').innerHTML = '<div style="font-size:11px;color:#666;">Export or annotate to see class distribution</div>';
    }

    if (currentRoom) {
        const editsRes = await fetch('/api/dashboard-stats?room_id=' + currentRoom.room_id);
        const editsData = await editsRes.json();
        if (editsData.member_stats) {
            let mHtml = '';
            for (const m of editsData.member_stats) {
                mHtml += '<div class="dash-member-row">' +
                    '<div class="dm-color" style="background:' + (m.color || '#888') + ';"></div>' +
                    '<span class="dm-name">' + escHtml(m.display_name || m.username) + '</span>' +
                    '<span class="dm-count">' + m.edit_count + ' edits</span>' +
                    '</div>';
            }
            document.getElementById('dashMemberStats').innerHTML = mHtml || '<div style="font-size:11px;color:#666;">No edits yet</div>';
        }
    }
}

// =============================================================================
// Sort & Filter
// =============================================================================
function changeSortOrder() {
    const sort = document.getElementById('sortSelect').value;
    loadImagePage(0, sort).then(() => { if (loadedImages.length > 0) selectImage(0); });
}

// =============================================================================
// Dataset Split
// =============================================================================
function updateSplitPreview() {
    const train = parseInt(document.getElementById('splitTrainSlider').value);
    let val = parseInt(document.getElementById('splitValSlider').value);
    const test = Math.max(0, 100 - train - val);
    if (test < 0) { val = 100 - train; document.getElementById('splitValSlider').value = val; }
    document.getElementById('splitTrainVal').textContent = train;
    document.getElementById('splitValVal').textContent = val;
    document.getElementById('splitTestVal').textContent = test;

    const totalAnnotated = totalImages;
    document.getElementById('splitPreview').innerHTML =
        '<div class="split-card"><div class="split-name">Train</div><div class="split-count">~' + Math.round(totalAnnotated * train / 100) + '</div></div>' +
        '<div class="split-card"><div class="split-name">Valid</div><div class="split-count">~' + Math.round(totalAnnotated * val / 100) + '</div></div>' +
        '<div class="split-card"><div class="split-name">Test</div><div class="split-count">~' + Math.round(totalAnnotated * test / 100) + '</div></div>';
}

async function executeSplit() {
    const train = parseInt(document.getElementById('splitTrainSlider').value);
    const val = parseInt(document.getElementById('splitValSlider').value);
    const test = Math.max(0, 100 - train - val);
    const res = await fetch('/api/dataset/split', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ train: train, val: val }),
    });
    const data = await res.json();
    if (data.error) { showToast(data.error, true); return; }
    closeModal('splitModal');
    showToast('Split complete: ' + data.train_count + ' train, ' + data.val_count + ' val' + (data.test_count ? ', ' + data.test_count + ' test' : '') + ' → ' + escHtml(data.export_dir));
}

// =============================================================================
// Desktop Notifications
// =============================================================================
let _notifEnabled = false;

function requestNotifPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission().then(p => { _notifEnabled = (p === 'granted'); });
    } else if ('Notification' in window && Notification.permission === 'granted') {
        _notifEnabled = true;
    }
}

function showDesktopNotif(title, body) {
    const popup = document.getElementById('notifPopup');
    document.getElementById('notifTitle').textContent = title;
    document.getElementById('notifBody').textContent = body;
    popup.classList.add('show');
    setTimeout(() => popup.classList.remove('show'), 4000);

    if (_notifEnabled && document.hidden) {
        try { new Notification(title, { body: body, icon: '🔔' }); } catch(e) {}
    }
}

// =============================================================================
// Remote Cursors
// =============================================================================
let _remoteCursors = {};
let _cursorThrottleTimer = null;

function emitCursorThrottled(nx, ny) {
    if (_cursorThrottleTimer) return;
    _cursorThrottleTimer = setTimeout(() => { _cursorThrottleTimer = null; }, 50);
    if (socket && currentImageName) {
        socket.emit('cursor_move', { x: nx, y: ny, image_name: currentImageName });
    }
}

function updateRemoteCursor(data) {
    const container = document.getElementById('canvasContainer');
    if (!container || !imgLoaded) return;

    let el = _remoteCursors[data.user_id];
    if (!el) {
        el = document.createElement('div');
        el.className = 'remote-cursor';
        el.innerHTML = '<div class="cursor-arrow" style="color:' + (data.color || '#888') + ';"></div>' +
            '<div class="cursor-label" style="background:' + (data.color || '#888') + ';">' + escHtml(data.display_name || data.username) + '</div>';
        container.appendChild(el);
        _remoteCursors[data.user_id] = el;
    }

    const px = offsetX + data.x * imgW * scale;
    const py = offsetY + data.y * imgH * scale;
    el.style.left = px + 'px';
    el.style.top = py + 'px';

    clearTimeout(el._timeout);
    el._timeout = setTimeout(() => removeRemoteCursor(data.user_id), 5000);
}

function removeRemoteCursor(userId) {
    const el = _remoteCursors[userId];
    if (el) {
        el.remove();
        delete _remoteCursors[userId];
    }
}

function clearAllRemoteCursors() {
    for (const uid of Object.keys(_remoteCursors)) removeRemoteCursor(uid);
}

// =============================================================================
// Training Progress Chart
// =============================================================================
let _metricsHistory = [];

function drawTrainingChart(history) {
    _metricsHistory = history || _metricsHistory;
    const container = document.getElementById('trainChartContainer');
    const chartCanvas = document.getElementById('trainChartCanvas');
    if (!chartCanvas || !_metricsHistory.length) { if(container) container.style.display = 'none'; return; }
    container.style.display = 'block';
    const chartCtx = chartCanvas.getContext('2d');
    const rect = container.getBoundingClientRect();
    chartCanvas.width = rect.width;
    chartCanvas.height = rect.height;
    const W = chartCanvas.width, H = chartCanvas.height;
    const pad = { top: 20, right: 12, bottom: 30, left: 45 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;

    chartCtx.clearRect(0, 0, W, H);

    const series = [
        { key: 'box_loss', color: '#e94560', label: 'Box Loss' },
        { key: 'cls_loss', color: '#4caf50', label: 'Cls Loss' },
        { key: 'dfl_loss', color: '#2196f3', label: 'DFL Loss' },
        { key: 'val_mAP50', color: '#ff9800', label: 'mAP50' },
        { key: 'val_mAP50_95', color: '#9c27b0', label: 'mAP50-95' },
    ];

    const available = series.filter(s => _metricsHistory.some(m => m[s.key] !== undefined));
    if (!available.length) { container.style.display = 'none'; return; }

    let yMin = Infinity, yMax = -Infinity;
    for (const entry of _metricsHistory) {
        for (const s of available) {
            if (entry[s.key] !== undefined) {
                yMin = Math.min(yMin, entry[s.key]);
                yMax = Math.max(yMax, entry[s.key]);
            }
        }
    }
    if (yMin === yMax) { yMax = yMin + 1; }
    const yRange = yMax - yMin;
    yMin -= yRange * 0.05;
    yMax += yRange * 0.05;

    const epochs = _metricsHistory.map(m => m.epoch);
    const xMin = Math.min(...epochs), xMax = Math.max(...epochs);
    const xRange = Math.max(xMax - xMin, 1);

    chartCtx.strokeStyle = '#0f3460';
    chartCtx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
        const y = pad.top + (plotH * i / 4);
        chartCtx.beginPath(); chartCtx.moveTo(pad.left, y); chartCtx.lineTo(W - pad.right, y); chartCtx.stroke();
        const val = yMax - (yMax - yMin) * (i / 4);
        chartCtx.fillStyle = '#666';
        chartCtx.font = '9px sans-serif';
        chartCtx.textAlign = 'right';
        chartCtx.fillText(val.toFixed(3), pad.left - 4, y + 3);
    }
    chartCtx.textAlign = 'center';
    const step = Math.max(1, Math.floor(xRange / 5));
    for (let e = xMin; e <= xMax; e += step) {
        const x = pad.left + ((e - xMin) / xRange) * plotW;
        chartCtx.fillText(e.toString(), x, H - pad.bottom + 14);
    }
    chartCtx.fillText('Epoch', W / 2, H - 4);

    for (const s of available) {
        chartCtx.strokeStyle = s.color;
        chartCtx.lineWidth = 1.5;
        chartCtx.beginPath();
        let first = true;
        for (const entry of _metricsHistory) {
            if (entry[s.key] === undefined) continue;
            const x = pad.left + ((entry.epoch - xMin) / xRange) * plotW;
            const y = pad.top + ((yMax - entry[s.key]) / (yMax - yMin)) * plotH;
            if (first) { chartCtx.moveTo(x, y); first = false; } else chartCtx.lineTo(x, y);
        }
        chartCtx.stroke();
    }

    let lx = pad.left + 4;
    for (const s of available) {
        chartCtx.fillStyle = s.color;
        chartCtx.fillRect(lx, pad.top - 14, 12, 8);
        chartCtx.fillStyle = '#ccc';
        chartCtx.font = '9px sans-serif';
        chartCtx.textAlign = 'left';
        chartCtx.fillText(s.label, lx + 15, pad.top - 7);
        lx += chartCtx.measureText(s.label).width + 24;
    }
}

function updateTrainingChart(data) {
    if (!_metricsHistory.length) return;
    const epoch = data.current_epoch;
    if (epoch && !_metricsHistory.find(m => m.epoch === epoch)) {
        const entry = { epoch };
        if (data.box_loss !== undefined) entry.box_loss = data.box_loss;
        if (data.cls_loss !== undefined) entry.cls_loss = data.cls_loss;
        if (data.dfl_loss !== undefined) entry.dfl_loss = data.dfl_loss;
        _metricsHistory.push(entry);
        drawTrainingChart();
    }
}

function updateTrainingChartVal(data) {
    if (_metricsHistory.length) {
        const last = _metricsHistory[_metricsHistory.length - 1];
        if (data.val_mAP50 !== undefined) last.val_mAP50 = data.val_mAP50;
        if (data.val_mAP50_95 !== undefined) last.val_mAP50_95 = data.val_mAP50_95;
        if (data.val_precision !== undefined) last.val_precision = data.val_precision;
        if (data.val_recall !== undefined) last.val_recall = data.val_recall;
        drawTrainingChart();
    }
}

// =============================================================================
// Model Validation, Export, Benchmark
// =============================================================================

let _benchPollTimer = null;
let _benchJobId = null;
let _exportPollTimer = null;
let _exportJobId = null;
let _valPollTimer = null;
let _valJobId = null;

async function loadModelSelectOptions(selectId) {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    const existing = sel.value;
    try {
        const res = await fetch('/api/inference/models');
        const data = await res.json();
        sel.innerHTML = '<option value="">Select model...</option>';
        (data.models || []).forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.path;
            opt.textContent = m.name + ' (' + m.size_mb + ' MB)';
            sel.appendChild(opt);
        });
        if (existing) sel.value = existing;
    } catch(e) {}
}

// --- Validation ---
async function openValidateModal() {
    openModal('validateModal');
    await loadModelSelectOptions('valModelSelect');
    document.getElementById('valResultsSection').style.display = 'none';
    document.getElementById('valProgress').style.display = 'none';
    document.getElementById('valStartBtn').disabled = false;
}

async function startValidation() {
    const model = document.getElementById('valModelSelect').value;
    if (!model) { showToast('Select a model', true); return; }

    const btn = document.getElementById('valStartBtn');
    btn.disabled = true;
    document.getElementById('valProgress').style.display = 'block';
    document.getElementById('valResultsSection').style.display = 'none';

    try {
        const res = await fetch('/api/model/validate', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                model_path: model,
                data_yaml: document.getElementById('valDataYaml').value.trim(),
                imgsz: parseInt(document.getElementById('valImgsz').value) || 640,
                conf: parseFloat(document.getElementById('valConf').value) || 0.001,
                iou: parseFloat(document.getElementById('valIou').value) || 0.6,
                split: document.getElementById('valSplit').value,
            }),
        });
        const data = await res.json();
        if (data.error) { showToast(data.error, true); btn.disabled = false; document.getElementById('valProgress').style.display = 'none'; return; }

        _valJobId = data.job_id;
        if (_valPollTimer) clearInterval(_valPollTimer);
        _valPollTimer = setInterval(() => _pollValJob(), 2000);
    } catch(e) {
        btn.disabled = false;
        document.getElementById('valProgress').style.display = 'none';
        showToast('Validation request failed', true);
    }
}

async function _pollValJob() {
    if (!_valJobId) { clearInterval(_valPollTimer); return; }
    try {
        const jr = await fetch('/api/model/job/' + _valJobId);
        const job = await jr.json();
        if (job.status === 'completed') {
            clearInterval(_valPollTimer);
            _valPollTimer = null;
            _valJobId = null;
            const btn = document.getElementById('valStartBtn');
            if (btn) btn.disabled = false;
            const prog = document.getElementById('valProgress');
            if (prog) prog.style.display = 'none';
            displayValResults(job.result);
            showToast('Validation complete!');
            showDesktopNotif('Validation Complete', 'mAP50: ' + ((job.result?.mAP50 || 0) * 100).toFixed(1) + '%');
        } else if (job.status === 'error') {
            clearInterval(_valPollTimer);
            _valPollTimer = null;
            _valJobId = null;
            const btn = document.getElementById('valStartBtn');
            if (btn) btn.disabled = false;
            const prog = document.getElementById('valProgress');
            if (prog) prog.style.display = 'none';
            showToast('Validation error: ' + (job.error || 'unknown'), true);
        }
    } catch(e) {}
}

function displayValResults(metrics) {
    const section = document.getElementById('valResultsSection');
    section.style.display = 'block';

    // Metric cards
    const cards = document.getElementById('valMetricsCards');
    const cardData = [
        { label: 'mAP50', value: metrics.mAP50, color: '#4caf50' },
        { label: 'mAP50-95', value: metrics.mAP50_95, color: '#2196f3' },
        { label: 'Precision', value: metrics.precision, color: '#ff9800' },
        { label: 'Recall', value: metrics.recall, color: '#e94560' },
    ];
    cards.innerHTML = cardData.map(c => `
        <div style="background:#16213e; border-radius:6px; padding:8px 10px; text-align:center;">
            <div style="font-size:20px; font-weight:bold; color:${c.color};">${c.value != null ? (c.value * 100).toFixed(1) + '%' : 'N/A'}</div>
            <div style="font-size:10px; color:#888; margin-top:2px;">${c.label}</div>
        </div>
    `).join('');

    // Per-class table
    const tableDiv = document.getElementById('valPerClassTable');
    if (metrics.per_class && metrics.per_class.length) {
        let html = '<table style="width:100%; font-size:11px; border-collapse:collapse;">';
        html += '<thead><tr style="color:#888; border-bottom:1px solid #0f3460;"><th style="text-align:left; padding:4px;">Class</th><th>Prec</th><th>Recall</th><th>AP50</th><th>AP</th></tr></thead><tbody>';
        metrics.per_class.forEach(c => {
            html += `<tr style="border-bottom:1px solid #0a0f1e;">
                <td style="padding:3px 4px; color:#e0e0e0;">${escHtml(c.class_name)}</td>
                <td style="text-align:center; color:#ff9800;">${c.precision != null ? (c.precision*100).toFixed(1) : '-'}%</td>
                <td style="text-align:center; color:#e94560;">${c.recall != null ? (c.recall*100).toFixed(1) : '-'}%</td>
                <td style="text-align:center; color:#4caf50;">${c.ap50 != null ? (c.ap50*100).toFixed(1) : '-'}%</td>
                <td style="text-align:center; color:#2196f3;">${c.ap != null ? (c.ap*100).toFixed(1) : '-'}%</td>
            </tr>`;
        });
        html += '</tbody></table>';
        tableDiv.innerHTML = html;
    } else {
        tableDiv.innerHTML = '';
    }

    // Plots
    const plotsDiv = document.getElementById('valPlots');
    if (metrics.plots && Object.keys(metrics.plots).length) {
        plotsDiv.innerHTML = Object.entries(metrics.plots).map(([name, path]) =>
            `<div style="cursor:pointer;" onclick="window.open('/api/model/plot?path=${encodeURIComponent(path)}', '_blank')">
                <img src="/api/model/plot?path=${encodeURIComponent(path)}" style="width:100%; border-radius:4px; border:1px solid #0f3460;" alt="${escHtml(name)}">
                <div style="font-size:10px; color:#888; text-align:center; margin-top:2px;">${escHtml(name.replace(/_/g, ' '))}</div>
            </div>`
        ).join('');
    } else {
        plotsDiv.innerHTML = '<div style="color:#666; font-size:12px;">No plots generated.</div>';
    }
}

// --- Model Export ---
const EXPORT_FORMATS = {
    onnx: { label: 'ONNX', ext: '.onnx', desc: 'Open Neural Network Exchange' },
    torchscript: { label: 'TorchScript', ext: '.torchscript', desc: 'PyTorch TorchScript' },
    openvino: { label: 'OpenVINO', ext: '_openvino_model/', desc: 'Intel OpenVINO IR' },
    engine: { label: 'TensorRT', ext: '.engine', desc: 'NVIDIA TensorRT (requires GPU)' },
    coreml: { label: 'CoreML', ext: '.mlpackage', desc: 'Apple CoreML' },
    saved_model: { label: 'TF SavedModel', ext: '_saved_model/', desc: 'TensorFlow SavedModel' },
    tflite: { label: 'TFLite', ext: '.tflite', desc: 'TensorFlow Lite' },
    pb: { label: 'TF GraphDef', ext: '.pb', desc: 'TensorFlow GraphDef' },
    edgetpu: { label: 'Edge TPU', ext: '_edgetpu.tflite', desc: 'Google Edge TPU' },
    tfjs: { label: 'TF.js', ext: '_web_model/', desc: 'TensorFlow.js for browser/Node.js' },
    paddle: { label: 'PaddlePaddle', ext: '_paddle_model/', desc: 'Baidu PaddlePaddle' },
    mnn: { label: 'MNN', ext: '.mnn', desc: 'Alibaba MNN mobile framework' },
    ncnn: { label: 'NCNN', ext: '_ncnn_model/', desc: 'Tencent NCNN' },
    imx: { label: 'IMX500', ext: '_imx_model/', desc: 'Sony IMX500 sensor' },
    rknn: { label: 'RKNN', ext: '_rknn_model/', desc: 'Rockchip RKNN NPU' },
    executorch: { label: 'ExecuTorch', ext: '_executorch_model/', desc: 'Meta ExecuTorch mobile' },
    axelera: { label: 'Axelera', ext: '_axelera_model/', desc: 'Axelera AI accelerator' },
};

const EXPORT_OPT_SUPPORT = {
    half:     ['torchscript','onnx','openvino','engine','coreml','tflite','tfjs','mnn','ncnn'],
    dynamic:  ['torchscript','onnx','openvino','engine','coreml'],
    simplify: ['onnx','engine'],
};

function updateExportOptions(format) {
    const desc = EXPORT_FORMATS[format];
    document.getElementById('exportFormatDesc').textContent = desc ? desc.desc : '';
    document.getElementById('exportHalfWrap').style.display     = EXPORT_OPT_SUPPORT.half.includes(format) ? '' : 'none';
    document.getElementById('exportDynamicWrap').style.display   = EXPORT_OPT_SUPPORT.dynamic.includes(format) ? '' : 'none';
    document.getElementById('exportSimplifyWrap').style.display  = EXPORT_OPT_SUPPORT.simplify.includes(format) ? '' : 'none';
    // Uncheck hidden options so they aren't sent
    if (!EXPORT_OPT_SUPPORT.half.includes(format))     document.getElementById('exportHalf').checked = false;
    if (!EXPORT_OPT_SUPPORT.dynamic.includes(format))   document.getElementById('exportDynamic').checked = false;
    if (!EXPORT_OPT_SUPPORT.simplify.includes(format))  document.getElementById('exportSimplify').checked = false;
}

async function openModelExportModal() {
    openModal('modelExportModal');
    loadModelSelectOptions('exportModelSelect');
    document.getElementById('exportResultSection').style.display = 'none';
    document.getElementById('exportProgress').style.display = 'none';
    document.getElementById('exportStartBtn').disabled = false;

    const sel = document.getElementById('modelExportFmtSelect');
    sel.onchange = () => updateExportOptions(sel.value);
    updateExportOptions(sel.value);
}

async function startModelExport() {
    const model = document.getElementById('exportModelSelect').value;
    const fmt = document.getElementById('modelExportFmtSelect').value;
    if (!model) { showToast('Select a model', true); return; }
    if (!fmt) { showToast('Select an export format', true); return; }

    const btn = document.getElementById('exportStartBtn');
    btn.disabled = true;
    document.getElementById('exportProgress').style.display = 'block';
    document.getElementById('exportResultSection').style.display = 'none';

    try {
        const res = await fetch('/api/model/export', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                model_path: model,
                format: fmt,
                imgsz: parseInt(document.getElementById('exportImgsz').value) || 640,
                batch: parseInt(document.getElementById('exportBatch').value) || 1,
                half: document.getElementById('exportHalf').checked,
                dynamic: document.getElementById('exportDynamic').checked,
                simplify: document.getElementById('exportSimplify').checked,
            }),
        });
        const data = await res.json();
        if (data.error) { showToast(data.error, true); btn.disabled = false; document.getElementById('exportProgress').style.display = 'none'; return; }

        _exportJobId = data.job_id;
        if (_exportPollTimer) clearInterval(_exportPollTimer);
        _exportPollTimer = setInterval(() => _pollExportJob(), 2000);
    } catch(e) {
        btn.disabled = false;
        document.getElementById('exportProgress').style.display = 'none';
        showToast('Export request failed', true);
    }
}

async function _pollExportJob() {
    if (!_exportJobId) { clearInterval(_exportPollTimer); return; }
    try {
        const jr = await fetch('/api/model/job/' + _exportJobId);
        const job = await jr.json();
        if (job.status === 'completed') {
            clearInterval(_exportPollTimer);
            _exportJobId = null;
            const btn = document.getElementById('exportStartBtn');
            if (btn) btn.disabled = false;
            const prog = document.getElementById('exportProgress');
            if (prog) prog.style.display = 'none';
            const r = job.result;
            const sec = document.getElementById('exportResultSection');
            if (sec) {
                sec.style.display = 'block';
                document.getElementById('exportResultContent').innerHTML = `
                    <div style="font-size:13px; color:#4caf50; font-weight:bold; margin-bottom:6px;">✅ Export Complete</div>
                    <div style="font-size:12px; color:#ccc;">
                        <div>Format: <strong>${escHtml(r.format_label)}</strong></div>
                        <div>Path: <code style="font-size:11px; color:#4fc3f7;">${escHtml(r.exported_path)}</code></div>
                        <div>Size: <strong>${r.size_mb} MB</strong></div>
                        <div>Time: ${r.elapsed_seconds}s</div>
                    </div>
                `;
            }
            showToast('Model exported: ' + r.format_label);
            showDesktopNotif('Export Complete', r.format_label + ' — ' + r.size_mb + ' MB');
        } else if (job.status === 'error') {
            clearInterval(_exportPollTimer);
            _exportJobId = null;
            const btn = document.getElementById('exportStartBtn');
            if (btn) btn.disabled = false;
            const prog = document.getElementById('exportProgress');
            if (prog) prog.style.display = 'none';
            showToast('Export error: ' + (job.error || 'unknown'), true);
        }
    } catch(e) {}
}

// --- Benchmark ---
async function openBenchmarkModal() {
    openModal('benchmarkModal');
    loadModelSelectOptions('benchModelSelect');
    document.getElementById('benchResultsSection').style.display = 'none';
    document.getElementById('benchProgress').style.display = 'none';
    const btn = document.getElementById('benchStartBtn');
    // If a benchmark is already running, show stop button
    if (_benchJobId) {
        btn.textContent = '🛑 Stop Benchmark';
        btn.onclick = stopBenchmark;
        document.getElementById('benchProgress').style.display = 'block';
    } else {
        btn.textContent = '⚡ Run Benchmark';
        btn.onclick = startBenchmark;
        btn.disabled = false;
    }
}

async function startBenchmark() {
    const model = document.getElementById('benchModelSelect').value;
    if (!model) { showToast('Select a model', true); return; }

    const btn = document.getElementById('benchStartBtn');
    btn.textContent = '🛑 Stop Benchmark';
    btn.onclick = stopBenchmark;
    document.getElementById('benchProgress').style.display = 'block';
    document.getElementById('benchResultsSection').style.display = 'none';

    try {
        const res = await fetch('/api/model/benchmark', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                model_path: model,
                data_yaml: document.getElementById('benchDataYaml').value.trim(),
                imgsz: parseInt(document.getElementById('benchImgsz').value) || 640,
                device: document.getElementById('benchDevice').value,
                half: document.getElementById('benchHalf').value === 'true',
            }),
        });
        const data = await res.json();
        if (data.error) {
            showToast(data.error, true);
            btn.textContent = '⚡ Run Benchmark';
            btn.onclick = startBenchmark;
            document.getElementById('benchProgress').style.display = 'none';
            return;
        }

        _benchJobId = data.job_id;
        showToast('Benchmark started — you can close this modal, it will continue in background');
        if (_benchPollTimer) clearInterval(_benchPollTimer);
        _benchPollTimer = setInterval(() => _pollBenchJob(), 3000);
    } catch(e) {
        btn.textContent = '⚡ Run Benchmark';
        btn.onclick = startBenchmark;
        document.getElementById('benchProgress').style.display = 'none';
        showToast('Benchmark request failed', true);
    }
}

function stopBenchmark() {
    if (_benchPollTimer) { clearInterval(_benchPollTimer); _benchPollTimer = null; }
    _benchJobId = null;
    const btn = document.getElementById('benchStartBtn');
    if (btn) {
        btn.textContent = '⚡ Run Benchmark';
        btn.onclick = startBenchmark;
    }
    const prog = document.getElementById('benchProgress');
    if (prog) prog.style.display = 'none';
    showToast('Benchmark polling stopped (server-side process may still run)');
}

async function _pollBenchJob() {
    if (!_benchJobId) { clearInterval(_benchPollTimer); return; }
    try {
        const jr = await fetch('/api/model/job/' + _benchJobId);
        const job = await jr.json();
        if (job.status === 'completed') {
            clearInterval(_benchPollTimer);
            _benchPollTimer = null;
            _benchJobId = null;
            // Update UI if modal is open
            const btn = document.getElementById('benchStartBtn');
            if (btn) { btn.textContent = '⚡ Run Benchmark'; btn.onclick = startBenchmark; }
            const prog = document.getElementById('benchProgress');
            if (prog) prog.style.display = 'none';
            displayBenchResults(job.result);
            showToast('Benchmark complete!');
            showDesktopNotif('Benchmark Complete', (job.result?.benchmarks?.length || 0) + ' formats tested');
        } else if (job.status === 'error') {
            clearInterval(_benchPollTimer);
            _benchPollTimer = null;
            _benchJobId = null;
            const btn = document.getElementById('benchStartBtn');
            if (btn) { btn.textContent = '⚡ Run Benchmark'; btn.onclick = startBenchmark; }
            const prog = document.getElementById('benchProgress');
            if (prog) prog.style.display = 'none';
            showToast('Benchmark error: ' + (job.error || 'unknown'), true);
        }
    } catch(e) {}
}

function displayBenchResults(result) {
    const section = document.getElementById('benchResultsSection');
    section.style.display = 'block';
    const table = document.getElementById('benchResultsTable');

    if (!result.benchmarks || !result.benchmarks.length) {
        table.innerHTML = '<div style="color:#888; font-size:12px;">No benchmark data available.</div>';
        return;
    }

    const cols = Object.keys(result.benchmarks[0]);
    let html = '<table style="width:100%; font-size:11px; border-collapse:collapse;">';
    html += '<thead><tr style="color:#888; border-bottom:1px solid #0f3460;">';
    cols.forEach(c => { html += '<th style="padding:4px 6px; text-align:left;">' + escHtml(String(c)) + '</th>'; });
    html += '</tr></thead><tbody>';
    result.benchmarks.forEach(row => {
        html += '<tr style="border-bottom:1px solid #0a0f1e;">';
        cols.forEach(c => {
            let val = row[c];
            if (typeof val === 'number') val = val.toFixed(2);
            html += '<td style="padding:3px 6px; color:#e0e0e0;">' + escHtml(String(val != null ? val : '-')) + '</td>';
        });
        html += '</tr>';
    });
    html += '</tbody></table>';
    table.innerHTML = html;
}

// =============================================================================
// Batch Operations
// =============================================================================
let batchMode = false;
let batchSelected = new Set();
let _assignments = {};

function toggleBatchMode() {
    batchMode = !batchMode;
    batchSelected.clear();
    document.querySelector('.sidebar').classList.toggle('batch-mode', batchMode);
    updateBatchCount();
    renderImageList();
}

function toggleBatchImage(name) {
    if (batchSelected.has(name)) batchSelected.delete(name);
    else batchSelected.add(name);
    updateBatchCount();
}

function batchSelectAll() {
    loadedImages.forEach(img => batchSelected.add(img.name));
    updateBatchCount();
    renderImageList();
}

function batchSelectNone() {
    batchSelected.clear();
    updateBatchCount();
    renderImageList();
}

function updateBatchCount() {
    document.getElementById('batchCount').textContent = batchSelected.size;
}

async function batchDeleteLabels() {
    if (!batchSelected.size) return showToast('No images selected', true);
    if (!confirm('Delete labels for ' + batchSelected.size + ' images?')) return;
    const res = await fetch('/api/batch/delete-labels', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ image_names: Array.from(batchSelected) })
    });
    const data = await res.json();
    if (data.error) return showToast(data.error, true);
    showToast('Deleted labels for ' + data.deleted + ' images');
    batchSelected.clear(); updateBatchCount();
    loadImagePage(currentPage); updateStats();
}

function openBatchReassign() {
    if (!batchSelected.size) return showToast('No images selected', true);
    const sel = document.getElementById('classSelect');
    const opts = Array.from(sel.options).map(o => '<option value="' + o.value + '">' + o.textContent + '</option>').join('');
    document.getElementById('reassignFromClass').innerHTML = opts;
    document.getElementById('reassignToClass').innerHTML = opts;
    openModal('batchReassignModal');
}

async function executeBatchReassign() {
    const from = document.getElementById('reassignFromClass').value;
    const to = document.getElementById('reassignToClass').value;
    const res = await fetch('/api/batch/reassign-class', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ image_names: Array.from(batchSelected), from_class: parseInt(from), to_class: parseInt(to) })
    });
    const data = await res.json();
    if (data.error) return showToast(data.error, true);
    showToast('Modified ' + data.modified + ' images');
    closeModal('batchReassignModal');
    loadImagePage(currentPage);
}

function openBatchAssign() {
    if (!batchSelected.size) return showToast('No images selected', true);
    const sel = document.getElementById('batchAssignUser');
    sel.innerHTML = '<option value="">Unassign</option>';
    roomMembers.forEach(m => {
        const uid = m.user_id || m.id;
        const name = m.display_name || m.username;
        sel.innerHTML += '<option value="' + uid + '">' + escHtml(name) + '</option>';
    });
    openModal('batchAssignModal');
}

async function executeBatchAssign() {
    if (!currentRoom) return;
    const userId = document.getElementById('batchAssignUser').value || null;
    const res = await fetch('/api/assignments/' + currentRoom.room_id, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ image_names: Array.from(batchSelected), user_id: userId ? parseInt(userId) : null })
    });
    const data = await res.json();
    if (data.error) return showToast(data.error, true);
    showToast('Assigned ' + data.count + ' images');
    closeModal('batchAssignModal');
    batchSelected.clear(); updateBatchCount();
    loadAssignments(); renderImageList();
}

// =============================================================================
// Image Assignments
// =============================================================================

async function loadAssignments() {
    if (!currentRoom) return;
    try {
        const res = await fetch('/api/assignments/' + currentRoom.room_id);
        const data = await res.json();
        _assignments = data.assignments || {};
    } catch(e) { _assignments = {}; }
    renderAssignMemberList();
    updateAssigneeBadge();
}

function openAssignModal() {
    renderAssignMemberList();
    openModal('assignModal');
}

function renderAssignMemberList() {
    const container = document.getElementById('assignMemberList');
    if (!roomMembers.length) { container.innerHTML = '<div style="color:#666; padding:4px;">No members</div>'; return; }
    const counts = {};
    Object.values(_assignments).forEach(a => { counts[a.user_id] = (counts[a.user_id] || 0) + 1; });
    container.innerHTML = roomMembers.map(m => {
        const uid = m.user_id || m.id;
        const name = m.display_name || m.username;
        const color = m.color || '#888';
        const assignedCount = counts[uid] || 0;
        const pct = totalImages > 0 ? Math.round(assignedCount / totalImages * 100) : 0;
        return '<div style="padding:4px 0; border-bottom:1px solid #0f3460;">' +
            '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:2px;">' +
            '<span style="color:' + color + '; font-weight:bold;">' + escHtml(name) + '</span>' +
            '<span style="color:#888; font-size:10px;">' + assignedCount + '/' + totalImages + ' (' + pct + '%)</span>' +
            '</div>' +
            '<div style="display:flex; gap:4px; align-items:center;">' +
            '<input type="range" min="0" max="100" value="' + pct + '" ' +
            'data-uid="' + uid + '" class="assign-ratio-slider" ' +
            'style="flex:1; height:4px; accent-color:' + color + ';" ' +
            'oninput="updateAssignRatioLabel(this)">' +
            '<span class="assign-ratio-label" data-uid="' + uid + '" style="min-width:32px; text-align:right; color:#ccc; font-size:10px;">' + pct + '%</span>' +
            '</div></div>';
    }).join('');
}

function updateAssignRatioLabel(slider) {
    const uid = slider.dataset.uid;
    const label = document.querySelector('.assign-ratio-label[data-uid="' + uid + '"]');
    if (label) label.textContent = slider.value + '%';
    const allSliders = Array.from(document.querySelectorAll('.assign-ratio-slider'));
    const otherSliders = allSliders.filter(s => s.dataset.uid !== uid);
    const used = parseInt(slider.value);
    const remaining = 100 - used;
    const otherTotal = otherSliders.reduce((s, sl) => s + parseInt(sl.value), 0);
    if (otherTotal > remaining) {
        otherSliders.forEach(s => {
            const ratio = otherTotal > 0 ? parseInt(s.value) / otherTotal : 1 / otherSliders.length;
            const newVal = Math.round(remaining * ratio);
            s.value = newVal;
            s.max = remaining;
            const lbl = document.querySelector('.assign-ratio-label[data-uid="' + s.dataset.uid + '"]');
            if (lbl) lbl.textContent = newVal + '%';
        });
    } else {
        otherSliders.forEach(s => {
            const othersExceptThis = otherSliders.filter(os => os !== s).reduce((sum, os) => sum + parseInt(os.value), 0);
            s.max = 100 - used - othersExceptThis;
            const lbl = document.querySelector('.assign-ratio-label[data-uid="' + s.dataset.uid + '"]');
            if (lbl) lbl.textContent = s.value + '%';
        });
    }
}

async function distributeAssignments() {
    if (!currentRoom || !roomMembers.length) return;
    const sliders = document.querySelectorAll('.assign-ratio-slider');
    const ratios = [];
    sliders.forEach(s => {
        ratios.push({ user_id: parseInt(s.dataset.uid), pct: parseInt(s.value) });
    });
    const totalPct = ratios.reduce((sum, r) => sum + r.pct, 0);
    if (totalPct === 0) { showToast('Set at least one member ratio > 0%', true); return; }
    const res = await fetch('/api/assignments/' + currentRoom.room_id + '/distribute', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ ratios: ratios })
    });
    const data = await res.json();
    if (data.error) { showToast(data.error, true); return; }
    showToast('Distributed ' + data.total + ' images (' + data.assigned + ' assigned)');
    loadAssignments();
}

function updateAssigneeBadge() {
    const badge = document.getElementById('assigneeBadge');
    if (currentImageName && _assignments[currentImageName]) {
        const a = _assignments[currentImageName];
        const color = a.color || '#888';
        badge.style.display = 'flex';
        badge.innerHTML = '<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:10px;background:' + color + '22;border:1px solid ' + color + '44;font-size:10px;color:' + color + ';">' +
            '<span style="width:6px;height:6px;border-radius:50%;background:' + color + ';"></span>' +
            escHtml(a.display_name || a.username) + '</span>';
    } else {
        badge.style.display = 'none';
        badge.innerHTML = '';
    }
}

// =============================================================================
// Quality Metrics
// =============================================================================

async function openQualityMetrics() {
    openModal('qualityModal');
    document.getElementById('qualityContent').innerHTML = '<p style="color:#888;">Analyzing...</p>';
    const res = await fetch('/api/quality-metrics');
    const data = await res.json();
    if (data.error) { document.getElementById('qualityContent').innerHTML = '<p style="color:#e94560;">Error: ' + escHtml(data.error) + '</p>'; return; }

    const coverage = data.annotation_coverage || 0;
    const balance = data.class_balance_score || 0;
    const scoreClass = balance >= 0.8 ? 'good' : balance >= 0.5 ? 'ok' : 'bad';

    let html = '<div class="quality-score ' + scoreClass + '">Balance Score: ' + (balance * 100).toFixed(0) + '%</div>';
    html += '<div class="quality-bar"><div class="fill" style="width:' + coverage + '%; background:#4caf50;"></div></div>';
    html += '<div style="text-align:center; font-size:10px; color:#888; margin-bottom:8px;">Coverage: ' + coverage + '%</div>';
    html += '<div class="quality-row"><span class="label">Total Images</span><span class="value">' + data.total_images + '</span></div>';
    html += '<div class="quality-row"><span class="label">Annotated</span><span class="value">' + data.annotated_images + '</span></div>';
    html += '<div class="quality-row"><span class="label">Unannotated</span><span class="value">' + data.unannotated_images + '</span></div>';
    html += '<div class="quality-row"><span class="label">Total Boxes</span><span class="value">' + data.total_boxes + '</span></div>';
    html += '<div class="quality-row"><span class="label">Avg Boxes/Image</span><span class="value">' + data.avg_boxes_per_image + '</span></div>';
    html += '<div class="quality-row"><span class="label">Max Boxes</span><span class="value">' + data.max_boxes + '</span></div>';
    html += '<div class="quality-row"><span class="label">Tiny Boxes (&lt;0.1%)</span><span class="value">' + data.tiny_boxes + '</span></div>';
    html += '<div class="quality-row"><span class="label">Huge Boxes (&gt;50%)</span><span class="value">' + data.huge_boxes + '</span></div>';

    const classDist = data.class_distribution || {};
    if (Object.keys(classDist).length) {
        html += '<h4 style="margin:12px 0 6px; font-size:11px; color:#e94560;">Class Distribution</h4>';
        const maxCount = Math.max(...Object.values(classDist));
        for (const [cls, count] of Object.entries(classDist)) {
            const pctVal = Math.round(count / maxCount * 100);
            html += '<div style="margin:3px 0;">';
            html += '<span style="color:#888; font-size:10px;">Class ' + cls + ': ' + count + '</span>';
            html += '<div class="quality-bar"><div class="fill" style="width:' + pctVal + '%; background:#2196f3;"></div></div>';
            html += '</div>';
        }
    }

    document.getElementById('qualityContent').innerHTML = html;
    document.getElementById('qualitySummary').innerHTML = '📊 ' + data.annotated_images + '/' + data.total_images + ' annotated · ' + data.total_boxes + ' boxes · Balance: ' + (balance * 100).toFixed(0) + '%';
}

// =============================================================================
// Model Inference Preview
// =============================================================================
let _inferenceDetections = [];
let _modelNames = {};

let _sharedModels = [];
let _browsedModels = [];

function syncModelSelects(preserveSelection) {
    const ids = ['inferenceModelSelect', 'autoAnnotateModel'];
    const saved = {};
    ids.forEach(id => { const s = document.getElementById(id); if (s) saved[id] = s.value; });
    const all = _sharedModels.concat(_browsedModels);
    ids.forEach(id => {
        const sel = document.getElementById(id);
        if (!sel) return;
        sel.innerHTML = '<option value="">Select model...</option>';
        all.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.path;
            opt.textContent = (m.browsed ? '📂 ' : '') + m.name + (m.size_mb != null ? ' (' + m.size_mb + 'MB)' : '') + (m.browsed ? ' (browsed)' : '');
            sel.appendChild(opt);
        });
        if (preserveSelection && saved[id]) sel.value = saved[id];
    });
}

async function loadInferenceModels() {
    try {
        const res = await fetch('/api/inference/models');
        const data = await res.json();
        _sharedModels = (data.models || []).map(m => ({ path: m.path, name: m.name, size_mb: m.size_mb }));
        syncModelSelects(true);
    } catch(e) {}
}

async function runInference() {
    const modelPath = document.getElementById('inferenceModelSelect').value;
    if (!modelPath) return showToast('Select a model first', true);
    if (!currentImageName) return showToast('No image selected', true);
    const conf = parseInt(document.getElementById('inferenceConfSlider').value) / 100;
    showToast('Running inference...');
    try {
        const res = await fetch('/api/inference/predict', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ model_path: modelPath, image_name: currentImageName, confidence: conf })
        });
        const data = await res.json();
        if (data.error) return showToast(data.error, true);
        _inferenceDetections = data.detections || [];
        _modelNames = data.model_names || {};
        showToast('Found ' + data.count + ' detections');
        document.getElementById('infClearBtn').style.display = data.count > 0 ? '' : 'none';
        document.getElementById('infAcceptBtn').style.display = data.count > 0 ? '' : 'none';
        draw();
    } catch(e) {
        showToast('Inference failed', true);
    }
}

function clearInference() {
    _inferenceDetections = [];
    document.getElementById('infClearBtn').style.display = 'none';
    document.getElementById('infAcceptBtn').style.display = 'none';
    draw();
}

function acceptInference() {
    if (!_inferenceDetections.length) return showToast('No detections to accept', true);
    pushUndo();
    const sel = document.getElementById('classSelect');
    const existingClasses = Array.from(sel.options).map(o => o.textContent.replace(/^\d+:\s*/, ''));
    const classMap = {};
    const uniqueModelIds = [...new Set(_inferenceDetections.map(d => d.class_id))].sort((a, b) => a - b);
    for (const modelId of uniqueModelIds) {
        if (modelId < existingClasses.length) {
            classMap[modelId] = modelId;
        } else {
            const modelName = _modelNames[String(modelId)] || ('class_' + modelId);
            const nextId = existingClasses.length;
            existingClasses.push(modelName);
            classMap[modelId] = nextId;
        }
    }
    const addedCount = existingClasses.length - sel.options.length;
    if (addedCount > 0) {
        sel.innerHTML = existingClasses.map((name, i) => '<option value="' + i + '">' + i + ': ' + escHtml(name) + '</option>').join('');
        if (currentRoom) {
            fetch('/api/rooms/' + currentRoom.room_id + '/classes', {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ classes: existingClasses })
            });
        }
        showToast('Added ' + addedCount + ' new classes from model');
    }
    const count = _inferenceDetections.length;
    for (const det of _inferenceDetections) {
        const mappedClassId = classMap[det.class_id] !== undefined ? classMap[det.class_id] : det.class_id;
        if (det.type === 'polygon' && det.points) {
            currentLabels.push({
                type: 'polygon',
                class_id: mappedClassId,
                points: det.points.map(p => ({x: p[0], y: p[1]})),
            });
        } else {
            currentLabels.push({
                type: 'bbox',
                class_id: mappedClassId,
                cx: det.cx, cy: det.cy,
                w: det.w, h: det.h,
            });
        }
    }
    hasUnsavedChanges = true;
    _inferenceDetections = [];
    document.getElementById('infClearBtn').style.display = 'none';
    document.getElementById('infAcceptBtn').style.display = 'none';
    renderBboxList();
    draw();
    showToast('Accepted ' + count + ' detections as labels');
}

function drawInferenceOverlays() {
    if (!_inferenceDetections.length || !imgLoaded) return;
    const classSelect = document.getElementById('classSelect');
    for (const det of _inferenceDetections) {
        const className = det.class_name || _modelNames[String(det.class_id)] || classSelect.options[det.class_id]?.textContent || ('cls' + det.class_id);
        const label = className + ' ' + (det.confidence * 100).toFixed(0) + '%';
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = 'rgba(0,255,136,0.7)';
        ctx.lineWidth = 2;

        if (det.type === 'polygon' && det.points) {
            // Draw polygon overlay
            ctx.beginPath();
            for (let i = 0; i < det.points.length; i++) {
                const px = offsetX + det.points[i][0] * imgW * scale;
                const py = offsetY + det.points[i][1] * imgH * scale;
                if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            }
            ctx.closePath();
            ctx.stroke();
            ctx.fillStyle = 'rgba(0,255,136,0.1)';
            ctx.fill();
            // Label at first point
            const lx = offsetX + det.points[0][0] * imgW * scale;
            const ly = offsetY + det.points[0][1] * imgH * scale;
            ctx.setLineDash([]);
            ctx.font = '10px sans-serif';
            const tw = ctx.measureText(label).width;
            ctx.fillStyle = 'rgba(0,255,136,0.8)';
            ctx.fillRect(lx, ly - 14, tw + 6, 14);
            ctx.fillStyle = '#000';
            ctx.fillText(label, lx + 3, ly - 3);
        } else {
            // Draw bbox overlay
            const x = offsetX + (det.cx - det.w / 2) * imgW * scale;
            const y = offsetY + (det.cy - det.h / 2) * imgH * scale;
            const w = det.w * imgW * scale;
            const h = det.h * imgH * scale;
            ctx.strokeRect(x, y, w, h);
            ctx.setLineDash([]);
            ctx.font = '10px sans-serif';
            const tw = ctx.measureText(label).width;
            ctx.fillStyle = 'rgba(0,255,136,0.8)';
            ctx.fillRect(x, y - 14, tw + 6, 14);
            ctx.fillStyle = '#000';
            ctx.fillText(label, x + 3, y - 3);
        }
    }
}

// =============================================================================
// Auto-Annotate (Apply Predictions — Active Learning Loop)
// =============================================================================
function switchAATab(tabId) {
    document.querySelectorAll('.aa-tab').forEach(t => t.classList.remove('active'));
    document.querySelector('.aa-tab[data-tab="' + tabId + '"]').classList.add('active');
    document.querySelectorAll('.aa-tab-content').forEach(c => c.style.display = 'none');
    document.getElementById(tabId).style.display = 'block';
}

async function openAutoAnnotate() {
    openModal('autoAnnotateModal');
    switchAATab('aa-main');
    document.getElementById('autoAnnotateClassesList').innerHTML = '<div style="color:#888; font-size:12px;">Select a model first</div>';
    document.getElementById('aaClassBadge').textContent = '';
    // Sync target mode with current sidebar filter
    const modeMap = { all: 'all', annotated: 'annotated', unannotated: 'unannotated', assigned: 'assigned' };
    const modeSelect = document.getElementById('autoAnnotateMode');
    if (modeMap[currentFilter]) modeSelect.value = modeMap[currentFilter];
    await loadInferenceModels();
    document.getElementById('autoAnnotateProgress').style.display = 'none';
    document.getElementById('autoAnnotateBtn').disabled = false;
}

let _modelBrowserTarget = 'autoAnnotateModel';

function openModelBrowser(browsePath) {
    _modelBrowserTarget = 'autoAnnotateModel';
    openModal('browseModelModal');
    browseForModel(browsePath);
}

function openModelBrowserForInference(browsePath) {
    _modelBrowserTarget = 'inferenceModelSelect';
    openModal('browseModelModal');
    browseForModel(browsePath);
}

async function browseForModel(browsePath) {
    const listDiv = document.getElementById('browseModelList');
    const pathLabel = document.getElementById('browseModelPath');
    listDiv.innerHTML = '<div style="padding:10px; color:#888;">Loading...</div>';

    try {
        const res = await fetch('/api/browse', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ path: browsePath || '', file_ext: '.pt' }),
        });
        const data = await res.json();
        if (data.error) { listDiv.innerHTML = '<div style="padding:10px; color:#e74c3c;">' + escHtml(data.error) + '</div>'; return; }

        pathLabel.textContent = data.path ? '📂 ' + data.path : '📂 Allowed roots';

        let html = '';

        // Root listing (allowed roots)
        if (data.is_root && !data.path) {
            (data.dirs || []).forEach(d => {
                const esc = escHtml(d).replace(/'/g, "\\'");
                html += '<div style="padding:6px 12px; cursor:pointer; display:flex; align-items:center; gap:8px;" onclick="browseForModel(\'' + esc + '\')" onmouseover="this.style.background=\'#16213e\'" onmouseout="this.style.background=\'\'"><span>📁</span><span style="font-size:13px;">' + escHtml(d) + '</span></div>';
            });
            listDiv.innerHTML = html || '<div style="padding:10px; color:#888;">No allowed roots</div>';
            return;
        }

        // Parent directory
        if (data.parent) {
            const parentEsc = escHtml(data.parent).replace(/'/g, "\\'");
            html += '<div style="padding:6px 12px; cursor:pointer; color:#ffd54f; display:flex; align-items:center; gap:8px;" onclick="browseForModel(\'' + parentEsc + '\')" onmouseover="this.style.background=\'#16213e\'" onmouseout="this.style.background=\'\'"><span>⬆</span><span style="font-size:13px;">..</span></div>';
        }

        // Directories
        (data.dirs || []).forEach(d => {
            const full = escHtml(data.path + '/' + d).replace(/'/g, "\\'");
            html += '<div style="padding:6px 12px; cursor:pointer; display:flex; align-items:center; gap:8px;" onclick="browseForModel(\'' + full + '\')" onmouseover="this.style.background=\'#16213e\'" onmouseout="this.style.background=\'\'"><span>📁</span><span style="font-size:13px;">' + escHtml(d) + '</span></div>';
        });

        // .pt files
        (data.files || []).forEach(f => {
            const pathEsc = escHtml(f.path).replace(/'/g, "\\'");
            html += '<div style="padding:6px 12px; cursor:pointer; color:#4fc3f7; display:flex; align-items:center; gap:8px;" onclick="selectBrowsedModel(\'' + pathEsc + '\', \'' + escHtml(f.name).replace(/'/g, "\\'") + '\')" onmouseover="this.style.background=\'#16213e\'" onmouseout="this.style.background=\'\'"><span>🧠</span><span style="font-size:13px;">' + escHtml(f.name) + '</span><span style="color:#888; font-size:11px; margin-left:auto;">' + f.size_mb + ' MB</span></div>';
        });

        listDiv.innerHTML = html || '<div style="padding:10px; color:#888;">Empty directory</div>';
    } catch(e) {
        listDiv.innerHTML = '<div style="padding:10px; color:#e74c3c;">Error browsing</div>';
    }
}

function selectBrowsedModel(modelPath, modelName) {
    if (!_browsedModels.some(m => m.path === modelPath)) {
        _browsedModels.push({ path: modelPath, name: modelName, browsed: true });
    }
    syncModelSelects(true);
    document.getElementById(_modelBrowserTarget).value = modelPath;
    closeModal('browseModelModal');
    if (_modelBrowserTarget === 'autoAnnotateModel') onAutoAnnotateModelChange();
}

async function onAutoAnnotateModelChange() {
    const modelPath = document.getElementById('autoAnnotateModel').value;
    const listDiv = document.getElementById('autoAnnotateClassesList');
    const countDiv = document.getElementById('autoAnnotateClassCount');
    const badge = document.getElementById('aaClassBadge');

    if (!modelPath) {
        listDiv.innerHTML = '<div style="color:#888; font-size:12px;">Select a model first</div>';
        badge.textContent = '';
        return;
    }

    listDiv.innerHTML = '<div style="color:#888; font-size:12px;">Loading classes...</div>';
    countDiv.textContent = '';

    try {
        const res = await fetch('/api/inference/model-classes', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ model_path: modelPath }),
        });
        const data = await res.json();
        if (!data.ok || !data.classes || data.classes.length === 0) {
            listDiv.innerHTML = '<div style="color:#888; font-size:12px;">No classes found in model</div>';
            badge.textContent = '';
            return;
        }
        let html = '';
        data.classes.forEach(c => {
            html += '<label style="display:block; padding:2px 0; font-size:13px; cursor:pointer;">' +
                '<input type="checkbox" class="autoAnnotateClassCb" value="' + c.id + '" checked> ' +
                '<span style="color:#4fc3f7;">[' + c.id + ']</span> ' + escHtml(c.name) +
                '</label>';
        });
        listDiv.innerHTML = html;
        document.getElementById('autoAnnotateSelectAll').checked = true;
        badge.textContent = '(' + data.classes.length + ')';
        _updateAutoAnnotateClassCount();

        // Listen for individual checkbox changes
        listDiv.querySelectorAll('.autoAnnotateClassCb').forEach(cb => {
            cb.addEventListener('change', function() {
                _updateAutoAnnotateClassCount();
                const all = listDiv.querySelectorAll('.autoAnnotateClassCb');
                const checked = listDiv.querySelectorAll('.autoAnnotateClassCb:checked');
                document.getElementById('autoAnnotateSelectAll').checked = (checked.length === all.length);
            });
        });
    } catch(e) {
        listDiv.innerHTML = '<div style="color:#e74c3c; font-size:12px;">Error loading classes</div>';
    }
}

function toggleAllAutoAnnotateClasses(checked) {
    document.querySelectorAll('.autoAnnotateClassCb').forEach(cb => { cb.checked = checked; });
    _updateAutoAnnotateClassCount();
}

function _updateAutoAnnotateClassCount() {
    const all = document.querySelectorAll('.autoAnnotateClassCb');
    const checked = document.querySelectorAll('.autoAnnotateClassCb:checked');
    const countDiv = document.getElementById('autoAnnotateClassCount');
    countDiv.textContent = checked.length + ' of ' + all.length + ' classes selected';
}

async function startAutoAnnotate() {
    const modelPath = document.getElementById('autoAnnotateModel').value;
    if (!modelPath) return showToast('Select a model first', true);

    // Gather selected classes
    const classCbs = document.querySelectorAll('.autoAnnotateClassCb');
    let selectedClasses = null;
    if (classCbs.length > 0) {
        const checked = document.querySelectorAll('.autoAnnotateClassCb:checked');
        if (checked.length === 0) return showToast('Select at least one class', true);
        // Only send filter if not all are selected
        if (checked.length < classCbs.length) {
            selectedClasses = Array.from(checked).map(cb => parseInt(cb.value));
        }
    }

    const confidence = parseInt(document.getElementById('autoAnnotateConf').value) / 100;
    const iou = parseInt(document.getElementById('autoAnnotateIou').value) / 100;
    const imgsz = parseInt(document.getElementById('autoAnnotateImgsz').value);
    const maxDet = parseInt(document.getElementById('autoAnnotateMaxDet').value);
    const mode = document.getElementById('autoAnnotateMode').value;
    const overwrite = document.getElementById('autoAnnotateOverwrite').checked;

    let imageNames = [];
    if (mode === 'selected') {
        imageNames = [...batchSelected];
        if (imageNames.length === 0) return showToast('No images selected. Use checkboxes to select images.', true);
    }

    document.getElementById('autoAnnotateBtn').disabled = true;
    document.getElementById('autoAnnotateProgress').style.display = 'block';
    document.getElementById('autoAnnotateProgressText').textContent = 'Starting...';
    document.getElementById('autoAnnotateProgressBar').style.width = '0%';

    try {
        const body = {
            model_path: modelPath,
            confidence: confidence,
            iou: iou,
            imgsz: imgsz,
            max_det: maxDet,
            mode: mode,
            overwrite: overwrite,
            image_names: imageNames,
        };
        if (selectedClasses !== null) body.selected_classes = selectedClasses;

        const res = await fetch('/api/inference/apply-predictions', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body),
        });
        const data = await res.json();
        if (data.error) {
            showToast(data.error, true);
            document.getElementById('autoAnnotateBtn').disabled = false;
            document.getElementById('autoAnnotateProgress').style.display = 'none';
            return;
        }
        showToast('Auto-annotating ' + data.target_count + ' images...');
        _pollAutoAnnotateProgress();
    } catch(e) {
        showToast('Failed to start auto-annotate', true);
        document.getElementById('autoAnnotateBtn').disabled = false;
        document.getElementById('autoAnnotateProgress').style.display = 'none';
    }
}

function _pollAutoAnnotateProgress() {
    const poll = async () => {
        try {
            const res = await fetch('/api/inference/apply-progress');
            const data = await res.json();
            if (data.status === 'running') {
                const pct = data.total > 0 ? Math.round(data.done / data.total * 100) : 0;
                document.getElementById('autoAnnotateProgressBar').style.width = pct + '%';
                document.getElementById('autoAnnotateProgressText').textContent =
                    'Processing ' + data.done + '/' + data.total + ' — ' + data.saved + ' saved' +
                    (data.skipped ? ', ' + data.skipped + ' skipped' : '') +
                    (data.no_detect ? ', ' + data.no_detect + ' empty' : '') +
                    (data.errors ? ', ' + data.errors + ' errors' : '');
                setTimeout(poll, 1000);
            } else if (data.status === 'completed') {
                document.getElementById('autoAnnotateProgressBar').style.width = '100%';
                document.getElementById('autoAnnotateProgressText').textContent =
                    'Done! ' + data.saved + ' saved' +
                    (data.skipped ? ', ' + data.skipped + ' skipped' : '') +
                    (data.no_detect ? ', ' + data.no_detect + ' no detections' : '') +
                    (data.errors ? ', ' + data.errors + ' errors' : '') +
                    ' of ' + data.total + ' images.';
                document.getElementById('autoAnnotateBtn').disabled = false;
                showToast('Auto-annotate complete: ' + data.saved + ' images annotated');
                // Refresh the image list to show new annotations
                loadImagePage(currentPage);
                updateStats();
            } else if (data.status === 'error') {
                document.getElementById('autoAnnotateProgressText').textContent = 'Error: ' + (data.error || 'unknown');
                document.getElementById('autoAnnotateBtn').disabled = false;
                showToast('Auto-annotate failed', true);
            } else {
                document.getElementById('autoAnnotateBtn').disabled = false;
                document.getElementById('autoAnnotateProgress').style.display = 'none';
            }
        } catch(e) {
            setTimeout(poll, 2000);
        }
    };
    setTimeout(poll, 1000);
}

// =============================================================================
// Render Image List
// =============================================================================
function renderImageList() {
    const list = document.getElementById('imageList');
    if (!loadedImages || !loadedImages.length) { list.innerHTML = '<div style="padding:16px; color:#666; font-size:12px;">No images</div>'; return; }
    list.innerHTML = loadedImages.map((imgItem, idx) => {
        const isSelected = idx === currentGlobalIndex;
        const boxCount = imgItem.bbox_count || 0;
        const dotClass = imgItem.annotated ? 'annotated' : 'empty';
        const globalNum = imgItem.global_index || (idx + 1);
        const assign = _assignments[imgItem.name];
        const editor = imageEdits[imgItem.name];
        let cls = 'image-item' + (isSelected ? ' active' : '');
        let style = '';
        if (editor && !isSelected) style = 'border-left:3px solid ' + (editor.color || '#888') + '; background:' + (editor.color || '#888') + '15;';
        let html = '<div class="' + cls + '" style="' + style + '" onclick="selectImage(' + idx + ')" title="' + escHtml(imgItem.name) + (editor ? ' | Last edit: ' + escHtml(editor.display_name || editor.username || '') : '') + '">';
        const batchChecked = batchSelected.has(imgItem.name) ? ' checked' : '';
        html += '<input type="checkbox" class="batch-check" onclick="event.stopPropagation();toggleBatchImage(\'' + escHtml(imgItem.name) + '\')"' + batchChecked + '>';
        html += '<span class="item-number">' + globalNum + '</span>';
        if (assign) html += '<span style="width:6px;height:6px;border-radius:50%;background:' + (assign.color || '#888') + ';flex-shrink:0;" title="Assigned: ' + escHtml(assign.display_name || '') + '"></span>';
        html += '<span class="dot ' + dotClass + '"></span>';
        html += '<span class="name">' + escHtml(imgItem.name) + '</span>';
        html += '<span class="box-count">' + boxCount + '</span>';
        html += '</div>';
        return html;
    }).join('');
}

// =============================================================================
// Annotator Init
// =============================================================================
function initAnnotator() {
    canvas = document.getElementById('annotationCanvas');
    ctx = canvas.getContext('2d');
    setupEvents();

    // Reset state from previous room
    loadedImages = [];
    totalImages = 0;
    totalPages = 0;
    currentPage = 0;
    currentGlobalIndex = -1;
    currentImageName = null;
    currentLabels = [];
    undoStack = [];
    selectedBoxIdx = -1;
    hasUnsavedChanges = false;
    imageEdits = {};
    imgLoaded = false;
    polygonPoints = [];
    drawing = false;
    drawStart = null;
    drawCurrent = null;
    _inferenceDetections = [];

    // Clear canvas
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    document.getElementById('bboxList').innerHTML = '<div style="padding:16px;color:#666;font-size:12px;">No annotations yet</div>';
    document.getElementById('imageList').innerHTML = '';
    document.getElementById('imageInfo').textContent = 'No image selected';

    loadCurrentDirs();

    if (currentRoom && currentRoom.blank) {
        document.getElementById('blankPrompt').style.display = 'flex';
    } else {
        document.getElementById('blankPrompt').style.display = 'none';
        loadImagePage(0).then(() => { if (loadedImages.length > 0) selectImage(0); });
    }
    updateStats();
    loadAssignments();
    loadInferenceModels();
}

// =============================================================================
// API
// =============================================================================
async function loadImagePage(page, sortOverride) {
    const sort = sortOverride || (document.getElementById('sortSelect') ? document.getElementById('sortSelect').value : 'name-asc');
    const params = new URLSearchParams({ page, per_page: PER_PAGE, filter: currentFilter, search: currentSearch, sort: sort });
    if (currentRoom && currentRoom.room_id) params.set('room_id', currentRoom.room_id);
    const res = await fetch('/api/images?' + params);
    const data = await res.json();
    loadedImages = data.images;
    totalImages = data.total;
    totalPages = data.total_pages;
    currentPage = page;
    renderImageList();
    updatePagination();
}

async function loadLabels(imageName) {
    const res = await fetch('/api/labels/' + encodeURIComponent(imageName));
    const data = await res.json();
    currentLabels = data.labels || [];
    undoStack = [];
    selectedBoxIdx = -1;
    hasUnsavedChanges = false;
    renderBboxList();
    draw();
}

async function saveLabels() {
    if (!currentImageName) return;
    // Capture current state before any async operations
    const saveName = currentImageName;
    const saveData = JSON.parse(JSON.stringify(currentLabels));
    hasUnsavedChanges = false;
    const res = await fetch('/api/labels/' + encodeURIComponent(saveName), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labels: saveData }),
    });
    const data = await res.json();
    if (data.status === 'saved') {
        showToast('Saved ' + data.count + ' labels for ' + saveName);
        const item = loadedImages.find(i => i.name === saveName);
        if (item) { item.annotated = saveData.length > 0; item.bbox_count = saveData.length; }
        if (currentUser) {
            imageEdits[saveName] = { username: currentUser.username, display_name: currentUser.display_name, color: currentUser.color };
        }
        renderImageList();
        updateStats();
    } else {
        showToast('Save failed: ' + (data.error || 'unknown'), true);
    }
}

async function updateStats() {
    const res = await fetch('/api/stats');
    const stats = await res.json();
    if (stats.cache_ready === false) {
        document.getElementById('statsBar').textContent = stats.total_images + ' images | indexing...';
        setTimeout(updateStats, 3000);
    } else {
        document.getElementById('statsBar').textContent =
            stats.total_images + ' images | ' + stats.annotated + ' annotated | ' + stats.total_bboxes + ' boxes';
    }
}

async function exportDataset() {
    const btn = document.getElementById('exportBtn');
    btn.disabled = true; btn.textContent = 'Exporting...';
    const ratio = parseInt(document.getElementById('splitSlider').value) / 100;
    const format = document.getElementById('exportFormatSelect').value;
    const exportPath = document.getElementById('saveDirInput').value.trim();
    const body = { train_ratio: ratio, format: format };
    if (exportPath) body.export_path = exportPath;
    const res = await fetch('/api/export', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) });
    const data = await res.json();
    btn.disabled = false; btn.textContent = '📦 Export';
    if (data.status === 'exported') {
        showToast('Exported (' + data.format + ')! Train: ' + data.train_count + ', Valid: ' + data.valid_count);
        closeModal('saveExportModal');
    }
    else { showToast('Export failed: ' + (data.error || 'unknown'), true); }
}

function openSaveExportModal() {
    browseFolders(document.getElementById('saveDirInput').value || '', 'saveDirBrowser', 'saveDirInput');
    openModal('saveExportModal');
}

function openSettingsModal() {
    if (currentRoom) {
        document.getElementById('settingsRoomName').textContent = currentRoom.room_name || currentRoom.name || '';
        document.getElementById('settingsRoomCode').textContent = currentRoom.room_code || currentRoom.code || '';

        // Show privacy controls only for room creator
        const isCreator = currentRoom.created_by === (currentUser && currentUser.user_id);
        const privacySection = document.getElementById('settingsPrivacySection');
        const requestsSection = document.getElementById('settingsJoinRequests');

        if (isCreator) {
            privacySection.style.display = 'block';
            const isPrivate = currentRoom.is_private;
            document.getElementById('roomPrivacyPublic').checked = !isPrivate;
            document.getElementById('roomPrivacyPrivate').checked = isPrivate;
            document.getElementById('privacyDescription').textContent = isPrivate
                ? 'Private: Members need approval to join.'
                : 'Public: Anyone with the code can join immediately.';

            // Load pending requests
            requestsSection.style.display = 'block';
            loadJoinRequests();
        } else {
            privacySection.style.display = 'none';
            requestsSection.style.display = 'none';
        }
    }
    openModal('settingsModal');
}

async function updateRoomPrivacy(isPrivate) {
    if (!currentRoom) return;
    const roomId = currentRoom.room_id;
    try {
        const res = await fetch('/api/rooms/' + roomId + '/privacy', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ is_private: isPrivate }),
        });
        const data = await res.json();
        if (data.error) { showToast(data.error, true); return; }
        currentRoom.is_private = isPrivate;
        document.getElementById('privacyDescription').textContent = isPrivate
            ? 'Private: Members need approval to join.'
            : 'Public: Anyone with the code can join immediately.';
        showToast(isPrivate ? 'Room set to Private 🔒' : 'Room set to Public 🌐');
    } catch(e) {
        showToast('Failed to update privacy', true);
    }
}

async function loadJoinRequests() {
    if (!currentRoom) return;
    const roomId = currentRoom.room_id;
    const listDiv = document.getElementById('joinRequestsList');
    const countSpan = document.getElementById('joinRequestCount');

    try {
        const res = await fetch('/api/rooms/' + roomId + '/join-requests');
        const data = await res.json();
        const requests = data.requests || [];
        countSpan.textContent = requests.length > 0 ? '(' + requests.length + ')' : '';

        if (requests.length === 0) {
            listDiv.innerHTML = '<div style="font-size:12px; color:#888; padding:4px 0;">No pending requests</div>';
            return;
        }

        let html = '';
        requests.forEach(r => {
            const name = escHtml(r.display_name || r.username);
            html += '<div style="display:flex; align-items:center; justify-content:space-between; padding:6px 0; border-bottom:1px solid #0f3460;">';
            html += '<div><span style="color:' + escHtml(r.color) + '; font-weight:bold;">' + name + '</span> <span style="color:#888; font-size:11px;">@' + escHtml(r.username) + '</span></div>';
            html += '<div style="display:flex; gap:4px;">';
            html += '<button class="btn" style="font-size:11px; padding:2px 8px; background:#4caf50; color:#fff; border:none;" onclick="resolveJoinRequest(' + r.id + ', \'approve\')">✓ Approve</button>';
            html += '<button class="btn" style="font-size:11px; padding:2px 8px; background:#e94560; color:#fff; border:none;" onclick="resolveJoinRequest(' + r.id + ', \'deny\')">✕ Deny</button>';
            html += '</div></div>';
        });
        listDiv.innerHTML = html;
    } catch(e) {
        listDiv.innerHTML = '<div style="font-size:12px; color:#e74c3c;">Error loading requests</div>';
    }
}

async function resolveJoinRequest(requestId, action) {
    if (!currentRoom) return;
    const roomId = currentRoom.room_id;
    try {
        const res = await fetch('/api/rooms/' + roomId + '/join-requests/' + requestId, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ action }),
        });
        const data = await res.json();
        if (data.error) { showToast(data.error, true); return; }
        showToast(action === 'approve' ? 'Request approved ✓' : 'Request denied ✕');
        loadJoinRequests();
    } catch(e) {
        showToast('Failed to process request', true);
    }
}

function confirmDeleteRoom() {
    if (!currentRoom) return;
    document.getElementById('deleteRoomConfirmInput').value = '';
    openModal('deleteRoomModal');
}

async function executeDeleteRoom() {
    if (!currentRoom) return;
    const typed = document.getElementById('deleteRoomConfirmInput').value.trim().toUpperCase();
    const roomCode = (currentRoom.room_code || currentRoom.code || '').toUpperCase();
    if (typed !== roomCode) {
        showToast('Room code does not match', true);
        return;
    }
    const btn = document.getElementById('deleteRoomBtn');
    btn.disabled = true; btn.textContent = 'Deleting...';
    try {
        const res = await fetch('/api/rooms/' + currentRoom.room_id, {
            method: 'DELETE',
            headers: {'Content-Type': 'application/json'},
        });
        const data = await res.json();
        if (data.error) { showToast(data.error, true); btn.disabled = false; btn.textContent = 'Delete Forever'; return; }
        showToast('Room deleted');
        closeModal('deleteRoomModal');
        closeModal('settingsModal');
        leaveRoom();
    } catch(e) {
        showToast('Failed to delete room', true);
        btn.disabled = false; btn.textContent = 'Delete Forever';
    }
}

// =============================================================================
// Image Selection
// =============================================================================
async function selectImage(index) {
    if (index < 0 || index >= loadedImages.length) return;
    if (hasUnsavedChanges && currentImageName) await saveLabels();
    currentGlobalIndex = index;
    const item = loadedImages[index];
    currentImageName = item.name;
    clearAllRemoteCursors();
    clearInference();
    document.getElementById('imageInfo').textContent = item.name + ' (' + (currentPage * PER_PAGE + index + 1) + '/' + totalImages + ')';
    document.getElementById('blankPrompt').style.display = 'none';
    imgLoaded = false;
    img.onload = () => { imgLoaded = true; imgW = img.naturalWidth; imgH = img.naturalHeight; fitToScreen(); loadLabels(item.name); };
    img.src = '/api/image/' + encodeURIComponent(item.name);
    renderImageList();
    updateAssigneeBadge();
    const el = document.querySelector('.image-item[data-index="' + index + '"]');
    if (el) el.scrollIntoView({ block: 'nearest' });
}

function applyFilter(filter) {
    currentFilter = filter;
    document.querySelectorAll('.filter-bar button').forEach(b => b.classList.remove('active'));
    document.querySelector('.filter-bar button[data-filter="' + filter + '"]').classList.add('active');
    currentGlobalIndex = -1; currentImageName = null;
    loadImagePage(0).then(() => { if (loadedImages.length > 0) selectImage(0); });
}

// =============================================================================
// Render
// =============================================================================

function updatePagination() {
    document.getElementById('pageInfo').textContent = (currentPage + 1) + ' / ' + Math.max(1, totalPages);
    document.getElementById('pageFirst').disabled = currentPage <= 0;
    document.getElementById('pagePrev').disabled = currentPage <= 0;
    document.getElementById('pageNext').disabled = currentPage >= totalPages - 1;
    document.getElementById('pageLast').disabled = currentPage >= totalPages - 1;
}

function _getClassName(classId) {
    const sel = document.getElementById('classSelect');
    if (sel && sel.options[classId]) {
        return sel.options[classId].textContent;
    }
    if (_modelNames && _modelNames[String(classId)]) {
        return classId + ': ' + _modelNames[String(classId)];
    }
    return classId + ': unknown';
}

function renderBboxList() {
    const list = document.getElementById('bboxList');
    if (currentLabels.length === 0) {
        list.innerHTML = '<div style="padding:16px;color:#666;font-size:12px;">No annotations yet. Draw on the image.</div>';
        return;
    }
    list.innerHTML = currentLabels.map((lbl, i) => {
        const color = BBOX_COLORS[lbl.class_id % BBOX_COLORS.length];
        const className = _getClassName(lbl.class_id);
        const isPolygon = lbl.type === 'polygon';
        const typeIcon = isPolygon ? '🔷' : '⬜';
        let sizeInfo;
        if (isPolygon) {
            sizeInfo = lbl.points.length + ' pts';
        } else {
            const x1 = Math.round((lbl.cx - lbl.w / 2) * imgW);
            const y1 = Math.round((lbl.cy - lbl.h / 2) * imgH);
            const x2 = Math.round((lbl.cx + lbl.w / 2) * imgW);
            const y2 = Math.round((lbl.cy + lbl.h / 2) * imgH);
            sizeInfo = x1 + ',' + y1 + ' → ' + x2 + ',' + y2;
        }
        return '<div class="bbox-item ' + (i === selectedBoxIdx ? 'selected' : '') +
            '" onclick="selectBox(' + i + ')">' +
            '<div class="bbox-color" style="background:' + color + '">' + typeIcon + '</div>' +
            '<span class="bbox-class-edit" ondblclick="event.stopPropagation();editBoxClass(' + i + ', this)" title="Double-click to change class">' + escHtml(className) + '</span>' +
            '<div class="bbox-info">' + sizeInfo + '</div>' +
            '<div class="bbox-delete" onclick="event.stopPropagation();deleteBox(' + i + ')">✕</div></div>';
    }).join('');
}

function editBoxClass(idx, el) {
    const lbl = currentLabels[idx];
    if (!lbl) return;
    const sel = document.getElementById('classSelect');
    let html = '<select class="bbox-class-dropdown" onchange="applyBoxClass(' + idx + ', this.value)" onblur="renderBboxList()">';
    for (let i = 0; i < sel.options.length; i++) {
        html += '<option value="' + i + '"' + (i === lbl.class_id ? ' selected' : '') + '>' + escHtml(sel.options[i].textContent) + '</option>';
    }
    html += '</select>';
    el.innerHTML = html;
    el.querySelector('select').focus();
}

function applyBoxClass(idx, newClassId) {
    pushUndo();
    currentLabels[idx].class_id = parseInt(newClassId);
    hasUnsavedChanges = true;
    renderBboxList();
    draw();
}

function selectBox(idx) { selectedBoxIdx = idx; renderBboxList(); draw(); }
function deleteBox(idx) { pushUndo(); currentLabels.splice(idx, 1); hasUnsavedChanges = true; if (selectedBoxIdx >= currentLabels.length) selectedBoxIdx = -1; renderBboxList(); draw(); }

// =============================================================================
// Canvas
// =============================================================================
function resizeCanvas() {
    const container = document.getElementById('canvasContainer');
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;
    draw();
}

function fitToScreen() {
    if (!imgLoaded) return;
    const container = document.getElementById('canvasContainer');
    scale = Math.min(container.clientWidth / imgW, container.clientHeight / imgH) * 0.95;
    offsetX = (container.clientWidth - imgW * scale) / 2;
    offsetY = (container.clientHeight - imgH * scale) / 2;
    resizeCanvas();
    document.getElementById('zoomDisplay').textContent = 'Zoom: ' + (scale * 100).toFixed(0) + '%';
}

function draw() {
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!imgLoaded) return;
    ctx.drawImage(img, offsetX, offsetY, imgW * scale, imgH * scale);
    currentLabels.forEach((lbl, i) => {
        const color = BBOX_COLORS[lbl.class_id % BBOX_COLORS.length];
        if (lbl.type === 'polygon' && lbl.points) {
            drawPolygonAnnotation(lbl, i, color);
        } else {
            const x = offsetX + (lbl.cx - lbl.w / 2) * imgW * scale;
            const y = offsetY + (lbl.cy - lbl.h / 2) * imgH * scale;
            const w = lbl.w * imgW * scale;
            const h = lbl.h * imgH * scale;
            ctx.strokeStyle = color;
            ctx.lineWidth = i === selectedBoxIdx ? 3 : 2;
            ctx.strokeRect(x, y, w, h);
            ctx.fillStyle = color + '20';
            ctx.fillRect(x, y, w, h);
            ctx.fillStyle = color;
            ctx.font = '12px monospace';
            const label = '' + lbl.class_id;
            ctx.fillRect(x, y - 18, ctx.measureText(label).width + 8, 18);
            ctx.fillStyle = '#fff';
            ctx.fillText(label, x + 4, y - 5);
            if (i === selectedBoxIdx) drawHandles(x, y, w, h, color);
        }
    });
    // In-progress bbox
    if (drawing && drawStart && drawCurrent) {
        const x1 = Math.min(drawStart.x, drawCurrent.x), y1 = Math.min(drawStart.y, drawCurrent.y);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.setLineDash([5, 5]);
        ctx.strokeRect(x1, y1, Math.abs(drawCurrent.x - drawStart.x), Math.abs(drawCurrent.y - drawStart.y));
        ctx.setLineDash([]);
    }
    // In-progress polygon
    if (mode === 'polygon' && polygonPoints.length > 0) {
        drawInProgressPolygon();
    }
    drawInferenceOverlays();
}

function drawPolygonAnnotation(lbl, idx, color) {
    const pts = lbl.points.map(p => [offsetX + p[0] * imgW * scale, offsetY + p[1] * imgH * scale]);
    if (pts.length < 2) return;
    // Fill
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.fillStyle = color + '20';
    ctx.fill();
    // Stroke
    ctx.strokeStyle = color;
    ctx.lineWidth = idx === selectedBoxIdx ? 3 : 2;
    ctx.stroke();
    // Label at centroid
    let cx = 0, cy = 0;
    pts.forEach(p => { cx += p[0]; cy += p[1]; });
    cx /= pts.length; cy /= pts.length;
    const label = '' + lbl.class_id;
    ctx.fillStyle = color;
    ctx.font = '12px monospace';
    ctx.fillRect(cx - 4, cy - 18, ctx.measureText(label).width + 8, 18);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, cx, cy - 5);
    // Vertex handles when selected
    if (idx === selectedBoxIdx) {
        pts.forEach((p, vi) => {
            ctx.beginPath();
            ctx.arc(p[0], p[1], vi === polygonHoverIdx ? 6 : 4, 0, Math.PI * 2);
            ctx.fillStyle = vi === polygonHoverIdx ? '#fff' : color;
            ctx.fill();
            ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
            ctx.stroke();
        });
    }
}

function drawInProgressPolygon() {
    if (polygonPoints.length === 0) return;
    ctx.beginPath();
    ctx.moveTo(polygonPoints[0].x, polygonPoints[0].y);
    for (let i = 1; i < polygonPoints.length; i++) {
        ctx.lineTo(polygonPoints[i].x, polygonPoints[i].y);
    }
    ctx.strokeStyle = '#00ff88'; ctx.lineWidth = 2; ctx.setLineDash([5, 5]);
    ctx.stroke(); ctx.setLineDash([]);
    // Draw vertices
    polygonPoints.forEach((p, i) => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, i === 0 ? 7 : 4, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? '#00ff88' : '#fff';
        ctx.fill();
        ctx.strokeStyle = '#00ff88'; ctx.lineWidth = 1;
        ctx.stroke();
    });
    // Hint: close zone around first point
    if (polygonPoints.length >= 3) {
        ctx.beginPath();
        ctx.arc(polygonPoints[0].x, polygonPoints[0].y, 12, 0, Math.PI * 2);
        ctx.strokeStyle = '#00ff8866'; ctx.lineWidth = 1;
        ctx.stroke();
    }
}

function drawHandles(x, y, w, h, color) {
    getHandlePositions(x, y, w, h).forEach(hp => {
        ctx.fillStyle = color;
        ctx.fillRect(hp.x - HANDLE_SIZE/2, hp.y - HANDLE_SIZE/2, HANDLE_SIZE, HANDLE_SIZE);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
        ctx.strokeRect(hp.x - HANDLE_SIZE/2, hp.y - HANDLE_SIZE/2, HANDLE_SIZE, HANDLE_SIZE);
    });
}

function getHandlePositions(x, y, w, h) {
    return [
        {x:x, y:y, cursor:'nw-resize', name:'tl'}, {x:x+w, y:y, cursor:'ne-resize', name:'tr'},
        {x:x, y:y+h, cursor:'sw-resize', name:'bl'}, {x:x+w, y:y+h, cursor:'se-resize', name:'br'},
        {x:x+w/2, y:y, cursor:'n-resize', name:'tm'}, {x:x+w/2, y:y+h, cursor:'s-resize', name:'bm'},
        {x:x, y:y+h/2, cursor:'w-resize', name:'ml'}, {x:x+w, y:y+h/2, cursor:'e-resize', name:'mr'},
    ];
}

function canvasToYolo(cx, cy, cw, ch) { return { cx:(cx-offsetX)/(imgW*scale), cy:(cy-offsetY)/(imgH*scale), w:cw/(imgW*scale), h:ch/(imgH*scale) }; }
function yoloToCanvas(lbl) { return { x:offsetX+(lbl.cx-lbl.w/2)*imgW*scale, y:offsetY+(lbl.cy-lbl.h/2)*imgH*scale, w:lbl.w*imgW*scale, h:lbl.h*imgH*scale }; }

// =============================================================================
// Polygon Helpers
// =============================================================================
function onPolygonClick(mx, my) {
    // Close polygon if clicking near first point (>= 3 points)
    if (polygonPoints.length >= 3) {
        const fp = polygonPoints[0];
        if (Math.abs(mx - fp.x) < 12 && Math.abs(my - fp.y) < 12) {
            finishPolygon();
            return;
        }
    }
    polygonPoints.push({x: mx, y: my});
    draw();
}

function onPolygonDblClick(mx, my) {
    if (polygonPoints.length >= 3) {
        finishPolygon();
    }
}

function finishPolygon() {
    if (polygonPoints.length < 3) { polygonPoints = []; draw(); return; }
    pushUndo();
    const pts = polygonPoints.map(p => [
        Math.max(0, Math.min(1, (p.x - offsetX) / (imgW * scale))),
        Math.max(0, Math.min(1, (p.y - offsetY) / (imgH * scale))),
    ]);
    currentLabels.push({
        type: 'polygon',
        class_id: parseInt(document.getElementById('classSelect').value),
        points: pts,
    });
    selectedBoxIdx = currentLabels.length - 1;
    hasUnsavedChanges = true;
    polygonPoints = [];
    renderBboxList();
    draw();
}

function pointInPolygon(mx, my, lbl) {
    const pts = lbl.points.map(p => [offsetX + p[0] * imgW * scale, offsetY + p[1] * imgH * scale]);
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const xi = pts[i][0], yi = pts[i][1];
        const xj = pts[j][0], yj = pts[j][1];
        if (((yi > my) !== (yj > my)) && (mx < (xj - xi) * (my - yi) / (yj - yi) + xi)) {
            inside = !inside;
        }
    }
    return inside;
}

function deletePolygonVertex(idx, vertexIdx) {
    const lbl = currentLabels[idx];
    if (!lbl || lbl.type !== 'polygon') return;
    if (lbl.points.length <= 3) {
        // Can't have < 3 points, delete the entire polygon
        deleteBox(idx);
        return;
    }
    pushUndo();
    lbl.points.splice(vertexIdx, 1);
    hasUnsavedChanges = true;
    polygonHoverIdx = -1;
    renderBboxList();
    draw();
}

function addPolygonVertex(idx, mx, my) {
    const lbl = currentLabels[idx];
    if (!lbl || lbl.type !== 'polygon') return;
    // Find closest edge to insert
    const pts = lbl.points.map(p => [offsetX + p[0] * imgW * scale, offsetY + p[1] * imgH * scale]);
    let bestDist = Infinity, bestEdge = 0;
    for (let i = 0; i < pts.length; i++) {
        const j = (i + 1) % pts.length;
        const d = distToSegment(mx, my, pts[i][0], pts[i][1], pts[j][0], pts[j][1]);
        if (d < bestDist) { bestDist = d; bestEdge = j; }
    }
    pushUndo();
    const newPt = [
        Math.max(0, Math.min(1, (mx - offsetX) / (imgW * scale))),
        Math.max(0, Math.min(1, (my - offsetY) / (imgH * scale))),
    ];
    lbl.points.splice(bestEdge, 0, newPt);
    hasUnsavedChanges = true;
    renderBboxList();
    draw();
}

function distToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// =============================================================================
// Mouse Events
// =============================================================================
let eventsSetup = false;
function setupEvents() {
    if (eventsSetup) return;
    eventsSetup = true;
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('dblclick', onCanvasDblClick);
    canvas.addEventListener('contextmenu', onCanvasContextMenu);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('resize', () => { if (imgLoaded) fitToScreen(); });
    window.addEventListener('keydown', onKeyDown);
    document.getElementById('prevBtn').addEventListener('click', () => navigateImage(-1));
    document.getElementById('nextBtn').addEventListener('click', () => navigateImage(1));
    document.getElementById('saveBtn').addEventListener('click', saveLabels);
    document.getElementById('undoBtn').addEventListener('click', undo);
    document.getElementById('zoomFit').addEventListener('click', fitToScreen);
    document.getElementById('drawTool').addEventListener('click', () => setMode('draw'));
    document.getElementById('polygonTool').addEventListener('click', () => setMode('polygon'));
    document.getElementById('selectTool').addEventListener('click', () => setMode('select'));
    document.querySelectorAll('.filter-bar button').forEach(btn => { btn.addEventListener('click', () => applyFilter(btn.dataset.filter)); });
    let searchTimeout;
    document.getElementById('searchInput').addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => { currentSearch = e.target.value; loadImagePage(0).then(() => { if (loadedImages.length > 0) selectImage(0); }); }, 300);
    });
    document.getElementById('pageFirst').addEventListener('click', () => { loadImagePage(0).then(() => { if (loadedImages.length > 0) selectImage(0); }); });
    document.getElementById('pagePrev').addEventListener('click', () => { if (currentPage > 0) loadImagePage(currentPage - 1).then(() => { if (loadedImages.length > 0) selectImage(0); }); });
    document.getElementById('pageNext').addEventListener('click', () => { if (currentPage < totalPages - 1) loadImagePage(currentPage + 1).then(() => { if (loadedImages.length > 0) selectImage(0); }); });
    document.getElementById('pageLast').addEventListener('click', () => { if (totalPages > 1) loadImagePage(totalPages - 1).then(() => { if (loadedImages.length > 0) selectImage(0); }); });
    document.getElementById('openFolderBtn').addEventListener('click', () => {
        openModal('openFolderModal');
    });
    document.getElementById('editClassesBtn').addEventListener('click', openClassEditor);
    document.querySelectorAll('.modal-overlay').forEach(overlay => { overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('show'); }); });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.show').forEach(m => m.classList.remove('show')); });
}

function onMouseDown(e) {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    if (mode === 'polygon') {
        onPolygonClick(mx, my);
        return;
    }
    if (mode === 'select') {
        // Check polygon vertex drag first
        if (selectedBoxIdx >= 0 && currentLabels[selectedBoxIdx] && currentLabels[selectedBoxIdx].type === 'polygon') {
            const lbl = currentLabels[selectedBoxIdx];
            for (let vi = 0; vi < lbl.points.length; vi++) {
                const px = offsetX + lbl.points[vi][0] * imgW * scale;
                const py = offsetY + lbl.points[vi][1] * imgH * scale;
                if (Math.abs(mx - px) < 8 && Math.abs(my - py) < 8) {
                    pushUndo(); polygonDragging = true; polygonDragIdx = vi;
                    return;
                }
            }
        }
        // Check bbox handle resize
        if (selectedBoxIdx >= 0 && currentLabels[selectedBoxIdx] && currentLabels[selectedBoxIdx].type !== 'polygon') {
            const bx = yoloToCanvas(currentLabels[selectedBoxIdx]);
            const handles = getHandlePositions(bx.x, bx.y, bx.w, bx.h);
            for (const h of handles) {
                if (Math.abs(mx-h.x) < HANDLE_SIZE && Math.abs(my-h.y) < HANDLE_SIZE) {
                    pushUndo(); resizing = true; resizeHandle = h.name;
                    dragStart = {x:mx, y:my, origLabel:{...currentLabels[selectedBoxIdx]}};
                    return;
                }
            }
        }
        // Hit test all annotations (reverse order)
        for (let i = currentLabels.length-1; i >= 0; i--) {
            if (currentLabels[i].type === 'polygon') {
                if (pointInPolygon(mx, my, currentLabels[i])) {
                    selectedBoxIdx = i; pushUndo(); dragging = true;
                    dragStart = {x:mx, y:my, origLabel: JSON.parse(JSON.stringify(currentLabels[i]))};
                    polygonHoverIdx = -1; renderBboxList(); draw(); return;
                }
            } else {
                const bx = yoloToCanvas(currentLabels[i]);
                if (mx >= bx.x && mx <= bx.x+bx.w && my >= bx.y && my <= bx.y+bx.h) {
                    selectedBoxIdx = i; pushUndo(); dragging = true;
                    dragStart = {x:mx, y:my, origLabel:{...currentLabels[i]}};
                    renderBboxList(); draw(); return;
                }
            }
        }
        selectedBoxIdx = -1; polygonHoverIdx = -1; renderBboxList(); draw();
    } else if (mode === 'draw') {
        drawing = true; drawStart = {x:mx, y:my}; drawCurrent = {x:mx, y:my};
    }
}

function onMouseMove(e) {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    if (imgLoaded) {
        const imgX = ((mx-offsetX)/(imgW*scale)*imgW).toFixed(0);
        const imgY = ((my-offsetY)/(imgH*scale)*imgH).toFixed(0);
        document.getElementById('coordsDisplay').textContent = 'x: ' + imgX + ', y: ' + imgY;
        emitCursorThrottled(parseFloat(imgX) / imgW, parseFloat(imgY) / imgH);
    }
    if (drawing) { drawCurrent = {x:mx, y:my}; draw(); }
    else if (polygonDragging && selectedBoxIdx >= 0 && polygonDragIdx >= 0) {
        const lbl = currentLabels[selectedBoxIdx];
        lbl.points[polygonDragIdx] = [
            Math.max(0, Math.min(1, (mx - offsetX) / (imgW * scale))),
            Math.max(0, Math.min(1, (my - offsetY) / (imgH * scale))),
        ];
        hasUnsavedChanges = true; draw();
    }
    else if (dragging && selectedBoxIdx >= 0) {
        const lbl = currentLabels[selectedBoxIdx];
        if (lbl.type === 'polygon') {
            // Move entire polygon
            const dx = (mx - dragStart.x) / (imgW * scale);
            const dy = (my - dragStart.y) / (imgH * scale);
            const orig = dragStart.origLabel;
            for (let pi = 0; pi < lbl.points.length; pi++) {
                lbl.points[pi] = [
                    Math.max(0, Math.min(1, orig.points[pi][0] + dx)),
                    Math.max(0, Math.min(1, orig.points[pi][1] + dy)),
                ];
            }
        } else {
            const dx = (mx-dragStart.x)/(imgW*scale), dy = (my-dragStart.y)/(imgH*scale);
            lbl.cx = Math.max(0,Math.min(1, dragStart.origLabel.cx+dx));
            lbl.cy = Math.max(0,Math.min(1, dragStart.origLabel.cy+dy));
        }
        hasUnsavedChanges = true; draw();
    }
    else if (resizing && selectedBoxIdx >= 0) { resizeBox(mx, my); hasUnsavedChanges = true; draw(); }
    else if (mode === 'select' && selectedBoxIdx >= 0 && currentLabels[selectedBoxIdx] && currentLabels[selectedBoxIdx].type === 'polygon') {
        // Hover highlight on polygon vertices
        const lbl = currentLabels[selectedBoxIdx];
        let newHover = -1;
        for (let vi = 0; vi < lbl.points.length; vi++) {
            const px = offsetX + lbl.points[vi][0] * imgW * scale;
            const py = offsetY + lbl.points[vi][1] * imgH * scale;
            if (Math.abs(mx - px) < 8 && Math.abs(my - py) < 8) { newHover = vi; break; }
        }
        if (newHover !== polygonHoverIdx) { polygonHoverIdx = newHover; draw(); }
    }
}

function onMouseUp(e) {
    if (drawing && drawStart && drawCurrent) {
        const x1 = Math.min(drawStart.x, drawCurrent.x), y1 = Math.min(drawStart.y, drawCurrent.y);
        const w = Math.abs(drawCurrent.x-drawStart.x), h = Math.abs(drawCurrent.y-drawStart.y);
        if (w > 5 && h > 5) {
            const yolo = canvasToYolo(x1+w/2, y1+h/2, w, h);
            if (yolo.cx >= 0 && yolo.cy >= 0 && yolo.w > 0.005 && yolo.h > 0.005) {
                pushUndo();
                currentLabels.push({ type: 'bbox', class_id: parseInt(document.getElementById('classSelect').value),
                    cx: Math.max(0,Math.min(1,yolo.cx)), cy: Math.max(0,Math.min(1,yolo.cy)),
                    w: Math.min(1,yolo.w), h: Math.min(1,yolo.h) });
                selectedBoxIdx = currentLabels.length - 1;
                hasUnsavedChanges = true; renderBboxList();
            }
        }
        drawing = false; drawStart = null; drawCurrent = null; draw();
    }
    if (polygonDragging) { polygonDragging = false; polygonDragIdx = -1; renderBboxList(); }
    if (dragging) { dragging = false; renderBboxList(); }
    if (resizing) { resizing = false; resizeHandle = null; }
}

function resizeBox(mx, my) {
    const orig = dragStart.origLabel;
    const ob = yoloToCanvas(orig);
    let x1=ob.x, y1=ob.y, x2=ob.x+ob.w, y2=ob.y+ob.h;
    if (resizeHandle.includes('l')) x1=mx; if (resizeHandle.includes('r')) x2=mx;
    if (resizeHandle.includes('t')) y1=my; if (resizeHandle.includes('b')) y2=my;
    if (Math.abs(x2-x1)<5 || Math.abs(y2-y1)<5) return;
    const nx1=Math.min(x1,x2), ny1=Math.min(y1,y2), nw=Math.abs(x2-x1), nh=Math.abs(y2-y1);
    const yolo = canvasToYolo(nx1+nw/2, ny1+nh/2, nw, nh);
    const lbl = currentLabels[selectedBoxIdx];
    lbl.cx=Math.max(0,Math.min(1,yolo.cx)); lbl.cy=Math.max(0,Math.min(1,yolo.cy));
    lbl.w=Math.min(1,yolo.w); lbl.h=Math.min(1,yolo.h);
}

function onCanvasDblClick(e) {
    if (mode === 'polygon' && polygonPoints.length >= 3) {
        const rect = canvas.getBoundingClientRect();
        onPolygonDblClick(e.clientX - rect.left, e.clientY - rect.top);
        e.preventDefault();
    } else if (mode === 'select' && selectedBoxIdx >= 0) {
        // Double-click on polygon edge to add vertex
        const lbl = currentLabels[selectedBoxIdx];
        if (lbl && lbl.type === 'polygon') {
            const rect = canvas.getBoundingClientRect();
            addPolygonVertex(selectedBoxIdx, e.clientX - rect.left, e.clientY - rect.top);
            e.preventDefault();
        }
    }
}

function onCanvasContextMenu(e) {
    e.preventDefault();
    if (mode === 'select' && selectedBoxIdx >= 0) {
        const lbl = currentLabels[selectedBoxIdx];
        if (lbl && lbl.type === 'polygon') {
            const rect = canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left, my = e.clientY - rect.top;
            for (let vi = 0; vi < lbl.points.length; vi++) {
                const px = offsetX + lbl.points[vi][0] * imgW * scale;
                const py = offsetY + lbl.points[vi][1] * imgH * scale;
                if (Math.abs(mx - px) < 8 && Math.abs(my - py) < 8) {
                    deletePolygonVertex(selectedBoxIdx, vi);
                    return;
                }
            }
        }
    }
}

function onWheel(e) {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX-rect.left, my = e.clientY-rect.top;
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const newScale = Math.max(0.1, Math.min(10, scale*delta));
    offsetX = mx-(mx-offsetX)*(newScale/scale);
    offsetY = my-(my-offsetY)*(newScale/scale);
    scale = newScale;
    document.getElementById('zoomDisplay').textContent = 'Zoom: ' + (scale*100).toFixed(0) + '%';
    draw();
}

// =============================================================================
// Keyboard
// =============================================================================
function onKeyDown(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
    if (document.getElementById('annotatorView').style.display === 'none') return;
    if (e.key === 'a' || e.key === 'ArrowLeft') { navigateImage(-1); e.preventDefault(); }
    if (e.key === 'd' || e.key === 'ArrowRight') { navigateImage(1); e.preventDefault(); }
    if (e.key === 'w') { if (currentPage > 0) loadImagePage(currentPage - 1).then(() => { if (loadedImages.length > 0) selectImage(loadedImages.length - 1); }); e.preventDefault(); }
    if (e.key === 's' && !e.ctrlKey) { if (currentPage < totalPages - 1) loadImagePage(currentPage + 1).then(() => { if (loadedImages.length > 0) selectImage(0); }); e.preventDefault(); }
    if (e.key === 'b') setMode('draw');
    if (e.key === 'g') setMode('polygon');
    if (e.key === 'v') setMode('select');
    if (e.key === 'Escape' && mode === 'polygon' && polygonPoints.length > 0) { polygonPoints = []; draw(); e.preventDefault(); }
    if (e.key === 'f') fitToScreen();
    if (e.key === 'Delete' || e.key === 'Backspace') { if (selectedBoxIdx >= 0) { deleteBox(selectedBoxIdx); e.preventDefault(); } }
    if (e.ctrlKey && e.key === 's') { saveLabels(); e.preventDefault(); }
    if (e.ctrlKey && e.key === 'z') { undo(); e.preventDefault(); }
    if (e.key === '?') { openModal('shortcutsModal'); e.preventDefault(); }
    if (e.key === 'c') { toggleChat(); e.preventDefault(); }
    if (e.key === 'i') { openDashboard(); e.preventDefault(); }
    if (e.key === 'e') { openSaveExportModal(); e.preventDefault(); }
    if (e.key === 'p') { e.preventDefault(); } // reserved
    if (e.key === 'q') { openQualityMetrics(); e.preventDefault(); }
    if (e.key === 'm') { toggleBatchMode(); e.preventDefault(); }
    if (e.key >= '1' && e.key <= '9') {
        const classIdx = parseInt(e.key) - 1;
        const sel = document.getElementById('classSelect');
        if (classIdx < sel.options.length) { sel.selectedIndex = classIdx; }
    }
}

// =============================================================================
// Helpers
// =============================================================================
function navigateImage(dir) {
    const idx = currentGlobalIndex + dir;
    if (idx >= 0 && idx < loadedImages.length) { selectImage(idx); }
    else if (idx >= loadedImages.length && currentPage < totalPages - 1) {
        loadImagePage(currentPage + 1).then(() => { if (loadedImages.length > 0) selectImage(0); });
    } else if (idx < 0 && currentPage > 0) {
        loadImagePage(currentPage - 1).then(() => { if (loadedImages.length > 0) selectImage(loadedImages.length - 1); });
    }
}

function setMode(m) {
    // Cancel in-progress polygon when switching away
    if (mode === 'polygon' && m !== 'polygon') { polygonPoints = []; }
    mode = m;
    document.getElementById('drawTool').classList.toggle('active', m === 'draw');
    document.getElementById('polygonTool').classList.toggle('active', m === 'polygon');
    document.getElementById('selectTool').classList.toggle('active', m === 'select');
    canvas.style.cursor = (m === 'draw' || m === 'polygon') ? 'crosshair' : 'default';
    const labels = { draw: 'Draw', select: 'Select', polygon: 'Polygon' };
    document.getElementById('modeDisplay').textContent = 'Mode: ' + (labels[m] || m);
    draw();
}

function pushUndo() { undoStack.push(JSON.parse(JSON.stringify(currentLabels))); if (undoStack.length > 50) undoStack.shift(); }
function undo() { if (!undoStack.length) return; currentLabels = undoStack.pop(); selectedBoxIdx=-1; hasUnsavedChanges=true; renderBboxList(); draw(); }

function showToast(msg, isError) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.className = 'toast' + (isError ? ' error' : '');
    t.style.display = 'block'; setTimeout(() => { t.style.display = 'none'; }, 2500);
}

function escHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// =============================================================================
// Open Folder
// =============================================================================
let openFolderMode = 'images_labels';

function switchOpenMode(m) {
    openFolderMode = m;
    const single = document.getElementById('singleFolderFields');
    const dual = document.getElementById('dualFolderFields');
    if (m === 'images_labels') { single.classList.add('hidden'); dual.classList.remove('hidden'); }
    else {
        dual.classList.add('hidden'); single.classList.remove('hidden');
        document.getElementById('singleFolderLabel').textContent =
            m === 'images_only' ? 'Images Folder (labels auto-created in sibling dir)' : 'Folder (contains images + labels)';
    }
}

async function loadCurrentDirs() {
    const res = await fetch('/api/current-dirs');
    const data = await res.json();
    const dd = document.getElementById('dirDisplay');
    dd.innerHTML = '<div>📁 IMG: <span style="color:#4caf50;">' + escHtml(data.images_dir || 'Not set') + '</span></div>' +
        '<div>🏷️ LBL: <span style="color:#2196f3;">' + escHtml(data.labels_dir || 'Not set') + '</span></div>';
    const info = document.getElementById('currentPathsInfo');
    if (info && data.images_dir) info.style.display = 'block';
    document.getElementById('imgDirInput').value = data.images_dir;
    document.getElementById('saveDirInput').value = data.export_dir;
}

function openModal(id) { document.getElementById(id).classList.add('show'); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }

async function browseFolders(path, targetBrowserId, targetInputId) {
    const res = await fetch('/api/browse', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ path }) });
    const data = await res.json();
    if (data.error) { showToast(data.error, true); return; }
    const browser = document.getElementById(targetBrowserId);
    let html = '';
    if (data.parent) {
        html += '<div class="folder-item parent" onclick="browseAndSet(\'' +
                data.parent.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + '\',\'' + targetBrowserId + '\',\'' + targetInputId + '\')">⬆ ..</div>';
    }
    data.dirs.forEach(d => {
        const full = (data.path + (data.path.endsWith('/') || data.path.endsWith('\\') ? '' : '/') + d).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        html += '<div class="folder-item" onclick="browseAndSet(\'' + full + '\',\'' + targetBrowserId + '\',\'' + targetInputId + '\')">' +
                '📁 ' + escHtml(d) + '</div>';
    });
    browser.innerHTML = html;
    document.getElementById(targetInputId).value = data.path;
}

function browseAndSet(path, browserId, inputId) {
    document.getElementById(inputId).value = path;
    browseFolders(path, browserId, inputId);
}

async function submitOpenFolder() {
    let body = { mode: openFolderMode };
    if (openFolderMode === 'images_labels') {
        const imgDir = document.getElementById('imgDirInput').value.trim();
        const lblDir = document.getElementById('lblDirInput').value.trim();
        if (!imgDir) { showToast('Images directory is required', true); return; }
        body.images_dir = imgDir; body.labels_dir = lblDir;
    } else {
        const folder = document.getElementById('singleFolderInput').value.trim();
        if (!folder) { showToast('Folder path is required', true); return; }
        body.folder = folder;
    }
    const res = await fetch('/api/open-folder', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) });
    const data = await res.json();
    if (data.error) { showToast(data.error, true); return; }
    closeModal('openFolderModal');
    showToast('Opened (' + data.mode + '): ' + data.image_count + ' images');
    document.getElementById('blankPrompt').style.display = 'none';
    loadCurrentDirs();
    currentGlobalIndex = -1; currentImageName = null;
    loadImagePage(0).then(() => { if (loadedImages.length > 0) selectImage(0); });
    updateStats(); loadImageEdits();
}

async function submitSaveFolder() {
    const saveDir = document.getElementById('saveDirInput').value.trim();
    if (!saveDir) { showToast('Save directory is required', true); return; }
    const res = await fetch('/api/save-folder', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ save_dir: saveDir }) });
    const data = await res.json();
    if (data.error) { showToast(data.error, true); return; }
    closeModal('saveExportModal');
    showToast('Export dir set: ' + data.save_dir);
    loadCurrentDirs();
}

// =============================================================================
// Class Editor
// =============================================================================
let editClasses = [];

function openClassEditor() {
    if (!currentRoom) return;
    fetch('/api/rooms/' + currentRoom.room_id + '/classes').then(r => r.json()).then(data => {
        editClasses = [...data.classes];
        renderClassEditor();
        openModal('classEditorModal');
    });
}

function renderClassEditor() {
    const list = document.getElementById('classEditorList');
    list.innerHTML = editClasses.map((name, i) =>
        '<div class="class-editor-row">' +
        '<span class="class-id">' + i + '</span>' +
        '<input type="text" value="' + escHtml(name) + '" onchange="editClasses[' + i + ']=this.value">' +
        (editClasses.length > 1 ? '<span class="btn-del" onclick="removeClassRow(' + i + ')">✕</span>' : '') +
        '</div>'
    ).join('');
}

function addClassRow() { editClasses.push('new_class'); renderClassEditor(); }
function removeClassRow(idx) { editClasses.splice(idx, 1); renderClassEditor(); }

async function submitClasses() {
    const cleaned = editClasses.map(c => c.trim()).filter(c => c);
    if (cleaned.length === 0) { showToast('Need at least one class', true); return; }
    if (!currentRoom) return;
    const res = await fetch('/api/rooms/' + currentRoom.room_id + '/classes', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ classes: cleaned }) });
    const data = await res.json();
    if (data.error) { showToast(data.error, true); return; }
    closeModal('classEditorModal');
    showToast('Saved ' + data.classes.length + ' classes');
    const sel = document.getElementById('classSelect');
    sel.innerHTML = data.classes.map((name, i) => '<option value="' + i + '">' + i + ': ' + escHtml(name) + '</option>').join('');
}

// =============================================================================
// Init
// =============================================================================
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('loginPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
    document.getElementById('regPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') doRegister(); });
    document.getElementById('createRoomName').addEventListener('keydown', (e) => { if (e.key === 'Enter') createRoom(); });
    document.getElementById('joinRoomCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
    checkAuth();
});
