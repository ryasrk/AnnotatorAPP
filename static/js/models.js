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
    await loadInferenceModels();
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
        const data = await apiPost('/api/model/validate', {
            model_path: model,
            data_yaml: document.getElementById('valDataYaml').value.trim(),
            imgsz: parseInt(document.getElementById('valImgsz').value) || 640,
            conf: parseFloat(document.getElementById('valConf').value) || 0.001,
            iou: parseFloat(document.getElementById('valIou').value) || 0.6,
            split: document.getElementById('valSplit').value,
        });
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
        const job = await apiGet('/api/model/job/' + _valJobId);
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
        const data = await apiPost('/api/model/export', {
            model_path: model,
            format: fmt,
            imgsz: parseInt(document.getElementById('exportImgsz').value) || 640,
            batch: parseInt(document.getElementById('exportBatch').value) || 1,
            half: document.getElementById('exportHalf').checked,
            dynamic: document.getElementById('exportDynamic').checked,
            simplify: document.getElementById('exportSimplify').checked,
        });
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
        const job = await apiGet('/api/model/job/' + _exportJobId);
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
        const data = await apiPost('/api/model/benchmark', {
            model_path: model,
            data_yaml: document.getElementById('benchDataYaml').value.trim(),
            imgsz: parseInt(document.getElementById('benchImgsz').value) || 640,
            device: document.getElementById('benchDevice').value,
            half: document.getElementById('benchHalf').value === 'true',
        });
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
        const job = await apiGet('/api/model/job/' + _benchJobId);
        if (job.status === 'completed') {
            clearInterval(_benchPollTimer);
            _benchPollTimer = null;
            _benchJobId = null;
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
// Model Inference Preview
// =============================================================================
let _inferenceDetections = [];
let _modelNames = {};

let _sharedModels = [];
let _browsedModels = [];

function syncModelSelects(preserveSelection) {
    const ids = ['inferenceModelSelect', 'autoAnnotateModel', 'valModelSelect', 'exportModelSelect', 'benchModelSelect'];
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
        const data = await apiGet('/api/inference/models');
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
        const data = await apiPost('/api/inference/predict', {
            model_path: modelPath, image_name: currentImageName, confidence: conf
        });
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
            apiPost('/api/rooms/' + currentRoom.room_id + '/classes', { classes: existingClasses });
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
    const modeMap = { all: 'all', annotated: 'annotated', unannotated: 'unannotated', assigned: 'assigned' };
    const modeSelect = document.getElementById('autoAnnotateMode');
    if (modeMap[currentFilter]) modeSelect.value = modeMap[currentFilter];
    await loadInferenceModels();
    document.getElementById('autoAnnotateProgress').style.display = 'none';
    const aaBtn = document.getElementById('autoAnnotateBtn');
    aaBtn.disabled = false;
    aaBtn.textContent = '🚀 Start Auto-Annotate';
    const aaCancelBtn = document.getElementById('autoAnnotateCancelBtn');
    if (aaCancelBtn) aaCancelBtn.textContent = 'Cancel';
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

function openModelBrowserFor(selectId, browsePath) {
    _modelBrowserTarget = selectId;
    openModal('browseModelModal');
    browseForModel(browsePath);
}

async function browseForModel(browsePath) {
    const listDiv = document.getElementById('browseModelList');
    const pathLabel = document.getElementById('browseModelPath');
    listDiv.innerHTML = '<div style="padding:10px; color:#888;">Loading...</div>';

    try {
        const data = await apiPost('/api/browse', { path: browsePath || '', file_ext: '.pt' });
        if (data.error) { listDiv.innerHTML = '<div style="padding:10px; color:#e74c3c;">' + escHtml(data.error) + '</div>'; return; }

        pathLabel.textContent = data.path ? '📂 ' + data.path : '📂 Allowed roots';

        let html = '';

        if (data.is_root && !data.path) {
            (data.dirs || []).forEach(d => {
                const esc = escHtml(d).replace(/'/g, "\\'");
                html += '<div style="padding:6px 12px; cursor:pointer; display:flex; align-items:center; gap:8px;" onclick="browseForModel(\'' + esc + '\')" onmouseover="this.style.background=\'#16213e\'" onmouseout="this.style.background=\'\'"><span>📁</span><span style="font-size:13px;">' + escHtml(d) + '</span></div>';
            });
            listDiv.innerHTML = html || '<div style="padding:10px; color:#888;">No allowed roots</div>';
            return;
        }

        if (data.parent) {
            const parentEsc = escHtml(data.parent).replace(/'/g, "\\'");
            html += '<div style="padding:6px 12px; cursor:pointer; color:#ffd54f; display:flex; align-items:center; gap:8px;" onclick="browseForModel(\'' + parentEsc + '\')" onmouseover="this.style.background=\'#16213e\'" onmouseout="this.style.background=\'\'"><span>⬆</span><span style="font-size:13px;">..</span></div>';
        }

        (data.dirs || []).forEach(d => {
            const full = escHtml(data.path + '/' + d).replace(/'/g, "\\'");
            html += '<div style="padding:6px 12px; cursor:pointer; display:flex; align-items:center; gap:8px;" onclick="browseForModel(\'' + full + '\')" onmouseover="this.style.background=\'#16213e\'" onmouseout="this.style.background=\'\'"><span>📁</span><span style="font-size:13px;">' + escHtml(d) + '</span></div>';
        });

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
    const targetSel = document.getElementById(_modelBrowserTarget);
    if (targetSel) targetSel.value = modelPath;
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
        const data = await apiPost('/api/inference/model-classes', { model_path: modelPath });
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

    const classCbs = document.querySelectorAll('.autoAnnotateClassCb');
    let selectedClasses = null;
    if (classCbs.length > 0) {
        const checked = document.querySelectorAll('.autoAnnotateClassCb:checked');
        if (checked.length === 0) return showToast('Select at least one class', true);
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
    const merge = document.getElementById('autoAnnotateMerge').checked;

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
            merge: merge,
            image_names: imageNames,
        };
        if (selectedClasses !== null) body.selected_classes = selectedClasses;

        const data = await apiPost('/api/inference/apply-predictions', body);
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

let _aaPolling = false;
function _pollAutoAnnotateProgress() {
    if (_aaPolling) return;
    _aaPolling = true;
    const poll = async () => {
        try {
            const data = await apiGet('/api/inference/apply-progress');
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
                const btn = document.getElementById('autoAnnotateBtn');
                btn.disabled = false;
                btn.textContent = '🔄 Restart Auto-Annotate';
                const cancelBtn = document.getElementById('autoAnnotateCancelBtn');
                if (cancelBtn) { cancelBtn.textContent = 'Close'; }
                showToast('Auto-annotate complete: ' + data.saved + ' images annotated');
                loadImagePage(currentPage);
                updateStats();
                _aaPolling = false;
            } else if (data.status === 'error') {
                document.getElementById('autoAnnotateProgressText').textContent = 'Error: ' + (data.error || 'unknown');
                document.getElementById('autoAnnotateBtn').disabled = false;
                showToast('Auto-annotate failed', true);
                _aaPolling = false;
            } else {
                document.getElementById('autoAnnotateBtn').disabled = false;
                document.getElementById('autoAnnotateProgress').style.display = 'none';
                _aaPolling = false;
            }
        } catch(e) {
            setTimeout(poll, 2000);
        }
    };
    setTimeout(poll, 1000);
}
