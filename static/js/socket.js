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
        if (data.classes_updated && data.classes) {
            const sel = document.getElementById('classSelect');
            sel.innerHTML = data.classes.map((name, i) => '<option value="' + i + '">' + i + ': ' + escHtml(name) + '</option>').join('');
        }
    });

    socket.on('apply_error', (data) => {
        showToast('Auto-annotate error: ' + (data.error || 'unknown'), true);
        const btn = document.getElementById('autoAnnotateBtn');
        if (btn) btn.disabled = false;
    });

    // Model management events
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
    const data = await apiGet('/api/rooms/' + currentRoom.room_id);
    roomMembers = data.members || [];
    updateTopbar();
    renderAssignMemberList();
}
