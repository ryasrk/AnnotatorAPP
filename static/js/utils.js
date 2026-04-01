// =============================================================================
// Utility Functions
// =============================================================================

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

function openModal(id) { document.getElementById(id).classList.add('show'); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }

function pushUndo() { undoStack.push(JSON.parse(JSON.stringify(currentLabels))); if (undoStack.length > 50) undoStack.shift(); }
function undo() { if (!undoStack.length) return; currentLabels = undoStack.pop(); selectedBoxIdx=-1; hasUnsavedChanges=true; renderBboxList(); draw(); }

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
