// =============================================================================
// Canvas Rendering
// =============================================================================
function resizeCanvas() {
    if (!canvas) return;
    const container = document.getElementById('canvasContainer');
    if (!container) return;
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
    if (drawing && drawStart && drawCurrent) {
        const x1 = Math.min(drawStart.x, drawCurrent.x), y1 = Math.min(drawStart.y, drawCurrent.y);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.setLineDash([5, 5]);
        ctx.strokeRect(x1, y1, Math.abs(drawCurrent.x - drawStart.x), Math.abs(drawCurrent.y - drawStart.y));
        ctx.setLineDash([]);
    }
    if (mode === 'polygon' && polygonPoints.length > 0) {
        drawInProgressPolygon();
    }
    drawInferenceOverlays();
}

function drawPolygonAnnotation(lbl, idx, color) {
    const pts = lbl.points.map(p => [offsetX + p[0] * imgW * scale, offsetY + p[1] * imgH * scale]);
    if (pts.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.fillStyle = color + '20';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = idx === selectedBoxIdx ? 3 : 2;
    ctx.stroke();
    let cx = 0, cy = 0;
    pts.forEach(p => { cx += p[0]; cy += p[1]; });
    cx /= pts.length; cy /= pts.length;
    const label = '' + lbl.class_id;
    ctx.fillStyle = color;
    ctx.font = '12px monospace';
    ctx.fillRect(cx - 4, cy - 18, ctx.measureText(label).width + 8, 18);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, cx, cy - 5);
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
    polygonPoints.forEach((p, i) => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, i === 0 ? 7 : 4, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? '#00ff88' : '#fff';
        ctx.fill();
        ctx.strokeStyle = '#00ff88'; ctx.lineWidth = 1;
        ctx.stroke();
    });
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
    if (e.key === 'p') { e.preventDefault(); }
    if (e.key === 'q') { openQualityMetrics(); e.preventDefault(); }
    if (e.key === 'm') { toggleBatchMode(); e.preventDefault(); }
    if (e.key >= '1' && e.key <= '9') {
        const classIdx = parseInt(e.key) - 1;
        const sel = document.getElementById('classSelect');
        if (classIdx < sel.options.length) { sel.selectedIndex = classIdx; }
    }
}
