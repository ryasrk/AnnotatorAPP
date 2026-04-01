// =============================================================================
// Unified API Client
// =============================================================================

async function apiGet(url) {
    try {
        const res = await fetch(url);
        return await res.json();
    } catch(e) {
        showToast('Network error', true);
        return { error: e.message };
    }
}

async function apiPost(url, body = {}) {
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        return await res.json();
    } catch(e) {
        showToast('Network error', true);
        return { error: e.message };
    }
}

async function apiDelete(url) {
    try {
        const res = await fetch(url, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
        });
        return await res.json();
    } catch(e) {
        showToast('Network error', true);
        return { error: e.message };
    }
}
