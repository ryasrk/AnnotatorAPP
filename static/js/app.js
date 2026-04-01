// =============================================================================
// Dashboard
// =============================================================================
async function openDashboard() {
    openModal('dashboardModal');
    refreshDashboard();
}

async function refreshDashboard() {
    const stats = await apiGet('/api/stats');
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
        const editsData = await apiGet('/api/dashboard-stats?room_id=' + currentRoom.room_id);
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
    const data = await apiPost('/api/dataset/split', { train: train, val: val });
    if (data.error) { showToast(data.error, true); return; }
    closeModal('splitModal');
    showToast('Split complete: ' + data.train_count + ' train, ' + data.val_count + ' val' + (data.test_count ? ', ' + data.test_count + ' test' : '') + ' → ' + escHtml(data.export_dir));
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
    const data = await apiPost('/api/batch/delete-labels', { image_names: Array.from(batchSelected) });
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
    const data = await apiPost('/api/batch/reassign-class', {
        image_names: Array.from(batchSelected), from_class: parseInt(from), to_class: parseInt(to)
    });
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
    const data = await apiPost('/api/assignments/' + currentRoom.room_id, {
        image_names: Array.from(batchSelected), user_id: userId ? parseInt(userId) : null
    });
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
        const data = await apiGet('/api/assignments/' + currentRoom.room_id);
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
    const data = await apiPost('/api/assignments/' + currentRoom.room_id + '/distribute', { ratios: ratios });
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
    const data = await apiGet('/api/quality-metrics');
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
    batchMode = false;
    batchSelected.clear();

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
    const data = await apiGet('/api/images?' + params);
    loadedImages = data.images;
    totalImages = data.total;
    totalPages = data.total_pages;
    currentPage = page;
    renderImageList();
    updatePagination();
}

async function loadLabels(imageName) {
    const data = await apiGet('/api/labels/' + encodeURIComponent(imageName));
    currentLabels = data.labels || [];
    undoStack = [];
    selectedBoxIdx = -1;
    hasUnsavedChanges = false;
    renderBboxList();
    draw();
}

async function saveLabels() {
    if (!currentImageName) return;
    const saveName = currentImageName;
    const saveData = JSON.parse(JSON.stringify(currentLabels));
    hasUnsavedChanges = false;
    const data = await apiPost('/api/labels/' + encodeURIComponent(saveName), { labels: saveData });
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
    const stats = await apiGet('/api/stats');
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
    const data = await apiPost('/api/export', body);
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
    const data = await apiPost('/api/rooms/' + currentRoom.room_id + '/privacy', { is_private: isPrivate });
    if (data.error) { showToast(data.error, true); return; }
    currentRoom.is_private = isPrivate;
    document.getElementById('privacyDescription').textContent = isPrivate
        ? 'Private: Members need approval to join.'
        : 'Public: Anyone with the code can join immediately.';
    showToast(isPrivate ? 'Room set to Private 🔒' : 'Room set to Public 🌐');
}

async function loadJoinRequests() {
    if (!currentRoom) return;
    const roomId = currentRoom.room_id;
    const listDiv = document.getElementById('joinRequestsList');
    const countSpan = document.getElementById('joinRequestCount');

    const data = await apiGet('/api/rooms/' + roomId + '/join-requests');
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
}

async function resolveJoinRequest(requestId, action) {
    if (!currentRoom) return;
    const data = await apiPost('/api/rooms/' + currentRoom.room_id + '/join-requests/' + requestId, { action });
    if (data.error) { showToast(data.error, true); return; }
    showToast(action === 'approve' ? 'Request approved ✓' : 'Request denied ✕');
    loadJoinRequests();
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
    const data = await apiDelete('/api/rooms/' + currentRoom.room_id);
    if (data.error) { showToast(data.error, true); btn.disabled = false; btn.textContent = 'Delete Forever'; return; }
    showToast('Room deleted');
    closeModal('deleteRoomModal');
    closeModal('settingsModal');
    leaveRoom();
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
    const data = await apiGet('/api/current-dirs');
    const dd = document.getElementById('dirDisplay');
    dd.innerHTML = '<div>📁 IMG: <span style="color:#4caf50;">' + escHtml(data.images_dir || 'Not set') + '</span></div>' +
        '<div>🏷️ LBL: <span style="color:#2196f3;">' + escHtml(data.labels_dir || 'Not set') + '</span></div>';
    const info = document.getElementById('currentPathsInfo');
    if (info && data.images_dir) info.style.display = 'block';
    document.getElementById('imgDirInput').value = data.images_dir;
    document.getElementById('saveDirInput').value = data.export_dir;
}

async function browseFolders(path, targetBrowserId, targetInputId) {
    const data = await apiPost('/api/browse', { path });
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
    const data = await apiPost('/api/open-folder', body);
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
    const data = await apiPost('/api/save-folder', { save_dir: saveDir });
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
    apiGet('/api/rooms/' + currentRoom.room_id + '/classes').then(data => {
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
    const data = await apiPost('/api/rooms/' + currentRoom.room_id + '/classes', { classes: cleaned });
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
