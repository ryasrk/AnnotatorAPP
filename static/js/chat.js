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
        const data = await apiGet('/api/rooms/' + currentRoom.room_id + '/online');
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
        const data = await apiGet(url);
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
        await apiPost('/api/rooms/' + currentRoom.room_id + '/messages', body);
    } catch(e) {
        showToast('Failed to send message', true);
    }
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
