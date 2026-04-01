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
    const data = await apiPost('/api/login', { username, password });
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
    const data = await apiPost('/api/register', { username, password, display_name });
    if (data.error) { document.getElementById('registerError').textContent = data.error; return; }
    currentUser = data;
    initSocket();
    enterRoomsView();
}

async function doLogout() {
    await apiPost('/api/logout');
    currentUser = null; currentRoom = null;
    if (socket) { socket.disconnect(); socket = null; }
    showView('loginView');
}

async function checkAuth() {
    const data = await apiGet('/api/me');
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
    const data = await apiGet('/api/rooms');
    const list = document.getElementById('roomList');
    if (data.rooms.length === 0) { list.innerHTML = '<div style="color:#888; font-size:13px;">No rooms yet. Create or join one!</div>'; return; }

    let onlineCounts = {};
    try {
        const ocData = await apiGet('/api/rooms/online-counts');
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
    const data = await apiPost('/api/rooms/create', { name, is_private: isPrivate });
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
    const data = await apiPost('/api/rooms/join', { code });
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
    const data = await apiPost('/api/rooms/' + roomId + '/enter');
    if (data.error) { showToast(data.error, true); return; }
    currentRoom = data;
    showView('annotatorView');
    initAnnotator();
    joinSocketRoom(roomId);
    const roomClasses = data.classes || ['object'];
    const sel = document.getElementById('classSelect');
    sel.innerHTML = roomClasses.map((name, i) => '<option value="' + i + '">' + i + ': ' + escHtml(name) + '</option>').join('');
    const infoData = await apiGet('/api/rooms/' + roomId);
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
    const data = await apiGet('/api/image-edits?room_id=' + currentRoom.room_id);
    imageEdits = data.edits || {};
    renderImageList();
}
