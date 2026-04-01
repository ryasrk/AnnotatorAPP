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

    const data = await apiGet('/api/train/params-schema');
    trainParamsSchema = data.schema;
    buildTrainParamUI();

    try {
        const dirs = await apiGet('/api/current-dirs');
        document.getElementById('trainDataYaml').value = dirs.export_dir + '/data.yaml';
    } catch(e) {}

    await refreshSessionList();

    loadGpuInfo();
    _gpuInterval = setInterval(loadGpuInfo, 5000);
    _sessionRefreshInterval = setInterval(refreshSessionList, 3000);
}

async function loadGpuInfo() {
    try {
        const data = await apiGet('/api/gpu-info');
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

async function refreshSessionList() {
    try {
        const data = await apiGet('/api/train/sessions');
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
        const data = await apiGet('/api/train/status?session_id=' + sessionId);
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
        apiGet('/api/train/status?session_id=' + sessionId).then(d => {
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

    const data = await apiPost('/api/train', params);
    if (data.error) { showToast(data.error, true); return; }

    showToast('Training started: ' + data.session_name);
    hideNewTrainingForm();

    await refreshSessionList();
    viewSession(data.session_id);
}

async function stopTrainingSession() {
    if (!_activeSessionId) return;
    const data = await apiPost('/api/train/stop/' + _activeSessionId);
    showToast(data.message || 'Stop requested');
    setTimeout(() => {
        refreshSessionList();
        if (_activeSessionId) updateSessionDetailHeader(_activeSessionId);
    }, 500);
}

async function removeTrainingSession() {
    if (!_activeSessionId) return;
    if (!confirm('Remove this training session log?')) return;
    const data = await apiPost('/api/train/remove/' + _activeSessionId);
    if (data.error) { showToast(data.error, true); return; }
    showToast('Session removed');
    _activeSessionId = null;
    document.getElementById('sessionLogView').style.display = 'none';
    document.getElementById('sessionEmptyState').style.display = 'flex';
    await refreshSessionList();
}

async function resumeTrainingSession() {
    if (!_activeSessionId) return;
    const data = await apiPost('/api/train/resume/' + _activeSessionId);
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
    const data = await apiPost('/api/browse', { path: browsePath, file_ext: '.yaml,.yml' });
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
    apiPost('/api/browse', { path, file_ext: '.yaml,.yml' }).then(data => {
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
