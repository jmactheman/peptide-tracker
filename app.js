'use strict';

// ── STATE ────────────────────────────────────────────────────
var appData = {
    peptides:  [],
    doses:     [],
    cycles:    [],
    protocols: [],
    settings:  { theme: 'dark' }
};

var selectedColor     = PEPTIDE_COLORS[0];
var editSelectedColor = PEPTIDE_COLORS[0];
var bodyView          = 'front';

var sitePickerPeptideId    = null;
var sitePickerTime         = null;
var sitePickerSelectedSite = null;

async function loadAllData() {
    appData.peptides  = await dbGetAll('peptides');
    appData.doses     = await dbGetAll('doses');
    appData.cycles    = await dbGetAll('cycles');
    appData.protocols = await dbGetAll('protocols');
    var s = await dbGet('settings', 'app_settings');
    if (s) appData.settings = s;
}

// ── HELPERS ──────────────────────────────────────────────────
function genId() { return Date.now().toString(36) + Math.random().toString(36).substr(2); }
function isIU(p) { return p && p.unit === 'IU'; }
function doseUnit(p) { return isIU(p) ? 'IU' : 'mcg'; } // storage unit
function dispUnit(p) { // display unit (respects per-peptide preference)
    if (!p) return 'mcg';
    if (p.unit === 'IU') return 'IU';
    if (p.unit === 'mL') return 'mL';
    return p.displayUnit || 'mcg';
}
function dispAmt(mcgAmt, p) { // convert stored mcg amount to display unit
    if (!mcgAmt || !p || p.displayUnit !== 'mg' || p.unit !== 'mg') return mcgAmt;
    return parseFloat((mcgAmt / 1000).toPrecision(6));
}
function toMcg(amt, p) { // convert display unit value back to mcg for storage/calc
    if (!amt || !p || p.displayUnit !== 'mg' || p.unit !== 'mg') return amt;
    return amt * 1000;
}
function mlToUnits(ml) { return ml * 100; }
function getPeptideColor(p) { return (p && p.color) ? p.color : 'var(--accent)'; }

function escapeHtml(s) {
    if (typeof s !== 'string') return '';
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function fmtDate(s) {
    return new Date(s + 'T00:00:00').toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' });
}
function localDateStr(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
function fmtDateShort(d) {
    return d.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'2-digit' });
}
function fmtDateTime(iso) {
    return new Date(iso).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
}

function calcDaysRemaining(p) {
    if (!p.dailyDose || !p.dosesPerWeek) return null;
    var vc    = isIU(p) ? p.mgPerVial : p.mgPerVial * 1000;
    var total = p.vialsOnHand * vc;
    var daily = p.dailyDose * (p.dosesPerWeek / 7);
    if (!daily) return null;
    return Math.floor(total / daily);
}

function daysClass(d) {
    if (d === null) return '';
    if (d <= 7)  return 'days-crit';
    if (d <= 21) return 'days-warn';
    return 'days-ok';
}

function calcReconInfo(p) {
    if (!p.reconstituted) return null;
    var wml   = p.reconstituted.waterMl;
    var total = isIU(p) ? p.mgPerVial : p.mgPerVial * 1000;
    var pml   = total / wml;
    var dose  = p.dailyDose || 0;
    var ml    = dose > 0 ? dose / pml : 0;
    var rem   = (p.reconstituted.remainingUnits !== undefined) ? p.reconstituted.remainingUnits : total;
    return {
        waterMl: wml, totalUnits: total, unitsPerMl: pml, concentration: pml / 100,
        remainingUnits: rem, mlPerDose: ml,
        units: mlToUnits(ml),
        dosesRemaining: dose > 0 ? Math.floor(rem / dose) : 0,
        unit: isIU(p) ? 'IU' : 'mcg'
    };
}

function calcSupplyStr(p) {
    if (!p.dailyDose) return 'N/A';
    var vc     = isIU(p) ? p.mgPerVial : p.mgPerVial * 1000;
    var total  = p.vialsOnHand * vc;
    var weekly = p.dailyDose * p.dosesPerWeek;
    if (!weekly) return 'N/A';
    var w = total / weekly;
    return w < 1 ? Math.round(w * 7) + ' days' : '~' + w.toFixed(1) + ' weeks';
}

function calcPostCycleProjection(p, cycle) {
    if (!p.dailyDose || !p.cycleDuration) return null;
    var end = new Date(cycle.startDate + 'T00:00:00');
    end.setDate(end.getDate() + p.cycleDuration * 7);
    var today = new Date(); today.setHours(0,0,0,0);
    var dr  = Math.max(0, Math.ceil((end - today) / 86400000));
    var ur  = p.dailyDose * (p.dosesPerWeek / 7) * dr;
    var vc  = isIU(p) ? p.mgPerVial : p.mgPerVial * 1000;
    return { postVials: Math.max(0, Math.floor(p.vialsOnHand - ur / vc)), daysRemaining: dr };
}

// ── THEME ────────────────────────────────────────────────────
function toggleTheme() {
    var next = appData.settings.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    document.getElementById('settings-theme-btn').textContent = next === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode';
    appData.settings.theme = next;
    dbPut('settings', { id: 'app_settings', theme: next });
}

function applyTheme() {
    var t = appData.settings.theme || 'dark';
    document.documentElement.setAttribute('data-theme', t);
    document.getElementById('settings-theme-btn').textContent = t === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode';
}

// ── LOW STOCK BANNER ─────────────────────────────────────────
function checkLowStockNotification() {
    var low = appData.peptides.filter(function(p) {
        if ((p.trackingMode || 'simple') === 'simple') return false;
        return p.vialsOnHand <= (p.reorderThreshold || 5);
    });
    var dot = document.getElementById('notif-dot');
    if (dot) dot.classList.toggle('show', low.length > 0);
    window._lowStockAlerts = low;
}

function showNotifications() {
    var low = window._lowStockAlerts || [];
    var content = document.getElementById('notif-modal-content');
    if (!low.length) {
        content.innerHTML = '<p style="color:var(--text-secondary);padding:16px 0;">No active alerts.</p>';
    } else {
        content.innerHTML = low.map(function(p) {
            return '<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border);">' +
                '<span style="font-size:1.2rem;">⚠️</span>' +
                '<div><div style="font-weight:600;">' + escapeHtml(p.name) + '</div>' +
                '<div style="font-size:0.83rem;color:var(--text-secondary);">' + p.vialsOnHand + ' vials left (reorder at ' + (p.reorderThreshold || 5) + ')</div></div>' +
                '</div>';
        }).join('');
    }
    document.getElementById('notif-modal').classList.add('active');
}

// ── COLOR PICKER ─────────────────────────────────────────────
function buildColorPicker(containerId, onSelect, currentColor) {
    var container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';
    PEPTIDE_COLORS.forEach(function(c) {
        var sw = document.createElement('div');
        sw.className = 'color-swatch' + (c === (currentColor || PEPTIDE_COLORS[0]) ? ' selected' : '');
        sw.style.background = c;
        sw.title = c;
        sw.onclick = function() {
            container.querySelectorAll('.color-swatch').forEach(function(s) { s.classList.remove('selected'); });
            sw.classList.add('selected');
            onSelect(c);
        };
        container.appendChild(sw);
    });
}

// ── TAB NAVIGATION ───────────────────────────────────────────
function switchTab(tabId) {
    // Update tab content
    document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
    var target = document.getElementById(tabId);
    if (target) target.classList.add('active');

    // Update desktop top tabs
    document.querySelectorAll('#desktop-tabs .tab-btn').forEach(function(b) {
        b.classList.toggle('active', b.dataset.tab === tabId);
    });

    // Update bottom nav (settings has no bnav button — that's fine)
    document.querySelectorAll('.bnav-btn').forEach(function(b) {
        b.classList.toggle('active', b.dataset.tab === tabId);
    });

    // Lazy-render tabs that need fresh data
    if (tabId === 'dashboard') renderDashboard();
    if (tabId === 'cycles')    renderCycles();
    if (tabId === 'tracking')  renderLogDosePlate();
    if (tabId === 'settings')  renderProtocolTemplatesList();
}

// Wire desktop top tabs
document.querySelectorAll('#desktop-tabs .tab-btn').forEach(function(btn) {
    btn.addEventListener('click', function() { switchTab(btn.dataset.tab); });
});

// Wire bottom nav
document.querySelectorAll('.bnav-btn').forEach(function(btn) {
    btn.addEventListener('click', function() { switchTab(btn.dataset.tab); });
});

// ── PEPTIDE DROPDOWN (replaces catalog) ──────────────────────
function initPeptideDropdown() {
    var sel    = document.getElementById('peptide-select');
    var sorted = PEPTIDE_NAMES.slice().sort();
    sel.innerHTML =
        '<option value="">Choose a peptide...</option>' +
        sorted.map(function(n) { return '<option value="' + escapeHtml(n) + '">' + escapeHtml(n) + '</option>'; }).join('') +
        '<option value="__custom">+ Custom (type below)...</option>';
    buildColorPicker('supply-color-picker', function(c) { selectedColor = c; }, PEPTIDE_COLORS[0]);
    buildScheduleUI('supply-sched-container', null);
}

document.getElementById('peptide-select').addEventListener('change', function() {
    var val         = this.value;
    var customGroup = document.getElementById('custom-name-group');
    customGroup.style.display = (val === '__custom') ? 'block' : 'none';

    if (val !== '__custom' && val !== '') {
        var unitSel = document.getElementById('peptide-unit');
        if (IU_DEFAULTS.has(val))      unitSel.value = 'IU';
        else if (ML_DEFAULTS.has(val)) unitSel.value = 'mL';
        else                           unitSel.value = 'mg';
    }
    updateDoseLabelFromUnit();
    updateAddPreview();
});

document.getElementById('peptide-unit').addEventListener('change', function() {
    updateDoseLabelFromUnit();
    updateAddPreview();
});

document.getElementById('peptide-display-unit').addEventListener('change', function() {
    updateDoseLabelFromUnit();
    updateAddPreview();
});

document.getElementById('peptide-tracking-mode').addEventListener('change', function() {
    var isSimple = this.value === 'simple';
    document.querySelectorAll('#peptide-form .full-mode-only').forEach(function(el) {
        el.style.display = isSimple ? 'none' : '';
    });
});

document.getElementById('edit-tracking-mode').addEventListener('change', function() {
    var isSimple = this.value === 'simple';
    document.querySelectorAll('#edit-form .edit-full-only').forEach(function(el) {
        el.style.display = isSimple ? 'none' : '';
    });
});

function updateDoseLabelFromUnit() {
    var unit  = document.getElementById('peptide-unit').value;
    var dispG = document.getElementById('display-unit-group');
    var isMg  = (unit === 'mg');
    if (dispG) dispG.style.display = isMg ? '' : 'none';
    var doseDispU = isMg ? document.getElementById('peptide-display-unit').value : (unit === 'IU' ? 'IU' : unit);
    document.getElementById('dose-label').textContent     = 'Your Dose (' + doseDispU + ')';
    document.getElementById('per-vial-label').textContent = unit + ' per Vial *';
}

['peptide-mg','peptide-vpk','kits-on-hand','daily-dose','doses-per-week','cycle-duration'].forEach(function(id) {
    document.getElementById(id).addEventListener('input', updateAddPreview);
});

function getFormPeptideName() {
    var sel = document.getElementById('peptide-select').value;
    return sel === '__custom'
        ? document.getElementById('peptide-custom-name').value.trim()
        : sel;
}

function clearPreview() {
    document.getElementById('add-preview').style.display = 'none';
}

function updateAddPreview() {
    var name  = getFormPeptideName();
    var unit  = document.getElementById('peptide-unit').value;
    var mg    = parseFloat(document.getElementById('peptide-mg').value);
    var vpk   = parseInt(document.getElementById('peptide-vpk').value) || 10;
    var kits  = parseInt(document.getElementById('kits-on-hand').value) || 0;
    var dose  = parseFloat(document.getElementById('daily-dose').value) || 0;
    var dpw   = parseInt(document.getElementById('doses-per-week').value) || 7;
    var cd    = parseInt(document.getElementById('cycle-duration').value) || 0;

    if (!name || !mg) { clearPreview(); return; }

    var tv   = kits * vpk;
    var ta   = tv * mg;
    var isiu = (unit === 'IU');

    document.getElementById('preview-name').textContent        = name;
    document.getElementById('preview-total-label').textContent = 'Total ' + unit + ':';
    document.getElementById('preview-total-vials').textContent = tv;
    document.getElementById('preview-total-mg').textContent    = ta + ' ' + unit;

    var dDispU = (unit === 'mg') ? document.getElementById('peptide-display-unit').value : (isiu ? 'IU' : unit);
    var se = 'N/A', ct = 'N/A';
    if (dose > 0) {
        var totalUnits  = isiu ? ta : ta * 1000; // always mcg/IU
        var doseInMcg   = (dDispU === 'mg') ? dose * 1000 : dose;
        var weekly      = doseInMcg * dpw;
        if (weekly > 0) {
            var w = totalUnits / weekly;
            se = w < 1 ? Math.round(w * 7) + ' days' : '~' + w.toFixed(1) + ' weeks';
        }
        if (cd > 0) ct = (dose * dpw * cd).toFixed(dDispU === 'mg' ? 4 : 0) + ' ' + dDispU;
    }
    document.getElementById('preview-supply').textContent      = se;
    document.getElementById('preview-cycle-total').textContent = ct;
    document.getElementById('add-preview').style.display = 'block';
}

// ── ADD PEPTIDE ───────────────────────────────────────────────
document.getElementById('peptide-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    var name = getFormPeptideName();
    if (!name) { alert('Enter a peptide name.'); return; }
    var unit     = document.getElementById('peptide-unit').value;
    var isSimple = document.getElementById('peptide-tracking-mode').value === 'simple';
    var mg       = parseFloat(document.getElementById('peptide-mg').value) || 0;
    var vpk      = parseInt(document.getElementById('peptide-vpk').value) || 10;
    var kits     = parseInt(document.getElementById('kits-on-hand').value) || 0;

    if (!isSimple && (!mg || mg <= 0)) { alert('Enter a valid amount per vial.'); return; }

    var dUnit    = document.getElementById('peptide-display-unit').value;
    var rawDose  = parseFloat(document.getElementById('daily-dose').value) || 0;
    var dailyMcg = (dUnit === 'mg' && unit === 'mg') ? rawDose * 1000 : rawDose;
    var p = {
        id: genId(), name: name, mgPerVial: mg, unit: unit, vialsPerKit: vpk,
        vialsOnHand: isSimple ? 0 : (kits * vpk),
        dailyDose:       dailyMcg,
        displayUnit:     (unit === 'mg') ? dUnit : 'mcg',
        trackingMode:    document.getElementById('peptide-tracking-mode').value || 'simple',
        dosesPerWeek:    parseInt(document.getElementById('doses-per-week').value) || 7,
        cycleDuration:   parseInt(document.getElementById('cycle-duration').value) || 0,
        reorderThreshold:parseInt(document.getElementById('reorder-threshold').value) || 5,
        color: selectedColor, reconstituted: null, createdAt: new Date().toISOString(),
        schedule: readScheduleUI('supply-sched-container')
    };

    try {
        await dbPut('peptides', p);
        appData.peptides.push(p);
    } catch(err) {
        alert('Failed to save peptide: ' + err.message);
        return;
    }

    renderSupply();
    updateDoseDropdown();
    checkLowStockNotification();

    // Reset form
    document.getElementById('peptide-select').value = '';
    document.getElementById('peptide-custom-name').value = '';
    document.getElementById('custom-name-group').style.display = 'none';
    document.getElementById('peptide-unit').value = 'mg';
    document.getElementById('peptide-mg').value   = '';
    document.getElementById('peptide-vpk').value  = 10;
    document.getElementById('kits-on-hand').value = 1;
    document.getElementById('daily-dose').value   = '';
    document.getElementById('cycle-duration').value = '';
    document.getElementById('doses-per-week').value  = 7;
    document.getElementById('reorder-threshold').value = 5;
    document.getElementById('dose-label').textContent     = 'Your Dose (mcg)';
    document.getElementById('per-vial-label').textContent = 'mg per Vial *';
    document.getElementById('peptide-display-unit').value  = 'mcg';
    document.getElementById('peptide-tracking-mode').value = 'simple';
    document.getElementById('display-unit-group').style.display = '';
    document.querySelectorAll('#peptide-form .full-mode-only').forEach(function(el) { el.style.display = 'none'; });
    selectedColor = PEPTIDE_COLORS[0];
    buildColorPicker('supply-color-picker', function(c) { selectedColor = c; }, PEPTIDE_COLORS[0]);
    buildScheduleUI('supply-sched-container', null);
    clearPreview();
});

// ── RENDER SUPPLY ─────────────────────────────────────────────
function getStockStatus(p) {
    if ((p.trackingMode || 'simple') === 'simple') return null;
    if (p.vialsOnHand === 0)                return { txt:'OUT', cls:'status-critical' };
    if (p.vialsOnHand <= (p.reorderThreshold || 5)) return { txt:'LOW', cls:'status-low' };
    return { txt:'OK', cls:'status-good' };
}

function renderSupply() {
    var grid    = document.getElementById('supply-grid');
    var summary = document.getElementById('supply-summary');

    if (!appData.peptides.length) {
        grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1;"><p>No peptides added yet.</p></div>';
        summary.innerHTML = '';
        return;
    }

    var tv = appData.peptides.reduce(function(s,p) { return s + (p.vialsOnHand || 0); }, 0);
    var ls = appData.peptides.filter(function(p) {
        if ((p.trackingMode || 'simple') === 'simple') return false;
        return p.vialsOnHand <= (p.reorderThreshold || 5);
    }).length;
    var ac = (appData.cycles || []).filter(function(c) { return c.status === 'active'; }).length;

    summary.innerHTML =
        '<div class="summary-card"><div class="summary-card-value">' + appData.peptides.length + '</div><div class="summary-card-label">Peptides</div></div>' +
        '<div class="summary-card"><div class="summary-card-value">' + tv + '</div><div class="summary-card-label">Total Vials</div></div>' +
        '<div class="summary-card"><div class="summary-card-value" style="color:' + (ls > 0 ? 'var(--warning)' : 'var(--success)') + '">' + ls + '</div><div class="summary-card-label">Low Stock</div></div>' +
        '<div class="summary-card"><div class="summary-card-value" style="color:var(--purple)">' + ac + '</div><div class="summary-card-label">Active Cycles</div></div>';

    var html = '';
    appData.peptides.forEach(function(p) {
        var st      = getStockStatus(p);
        var sup     = calcSupplyStr(p);
        var ri      = calcReconInfo(p);
        var acyc    = (appData.cycles || []).find(function(c) { return c.peptideId === p.id && c.status === 'active'; });
        var proj    = acyc ? calcPostCycleProjection(p, acyc) : null;
        var du      = dispUnit(p);
        var dAmt    = dispAmt(p.dailyDose, p);
        var pColor  = getPeptideColor(p);
        var eName   = escapeHtml(p.name);
        var simple  = (p.trackingMode || 'simple') === 'simple';

        var syH = '';
        if (!simple && ri && p.dailyDose) {
            syH = '<div class="syringe-display">' +
                  '<span class="syringe-badge">' + ri.units.toFixed(1) + ' units</span>' +
                  '</div>';
        }

        var projHtml = '';
        if (!simple && proj) {
            var pc = proj.postVials <= p.reorderThreshold ? 'var(--warning)' : 'var(--success)';
            projHtml = '<div class="peptide-info-row" style="background:var(--bg-primary);border-radius:4px;padding:6px 4px;">' +
                       '<span class="info-label">After Cycle</span>' +
                       '<span class="info-value" style="color:' + pc + '">~' + proj.postVials + ' vials' + (proj.postVials <= p.reorderThreshold ? ' ⚠️' : '') + ' left</span></div>';
        }

        var reconHtml = '';
        if (!simple && ri) {
            reconHtml = '<div class="recon-section"><strong style="color:var(--success);">✓ Active Reconstituted Vial</strong>' +
                        '<div class="dose-calc">' +
                        '<p>' + ri.waterMl + ' mL ' + escapeHtml(p.reconstituted.waterType) + ' — <span class="highlight">' + ri.concentration.toFixed(2) + ' ' + ri.unit + '/unit</span></p>' +
                        '<p>Remaining: <span class="highlight">' + ri.remainingUnits.toFixed(1) + ' ' + ri.unit + '</span> (' + ri.dosesRemaining + ' doses)</p>' +
                        '<p>Draw <span class="highlight">' + ri.mlPerDose.toFixed(3) + ' mL</span> for ' + dispAmt(p.dailyDose, p) + ' ' + du + '</p>' +
                        syH + '</div></div>';
        } else if (simple && ri) {
            reconHtml = '<div class="recon-section" style="font-size:0.82rem;color:var(--success);">✓ Active vial — ' + ri.dosesRemaining + ' doses remaining</div>';
        }

        var doseRow = (dAmt || p.dailyDose)
            ? '<div class="peptide-info-row"><span class="info-label">Your Dose</span><span class="info-value">' + (dAmt || '—') + ' ' + du + ' × ' + p.dosesPerWeek + '/wk</span></div>'
            : '';
        var cycleRow = (!simple && p.cycleDuration)
            ? '<div class="peptide-info-row"><span class="info-label">Cycle Duration</span><span class="info-value">' + p.cycleDuration + ' weeks</span></div>'
            : '';

        var cycleStripe = '';
        if (p.cycleDuration) {
            if (acyc) {
                var today0 = new Date(); today0.setHours(0,0,0,0);
                var wkIn = ((today0 - new Date(acyc.startDate + 'T00:00:00')) / (7 * 86400000)).toFixed(1);
                cycleStripe = '<div class="cycle-stripe" style="background:' + pColor + ';" onclick="openCycleModal(\'' + acyc.id + '\')">Week ' + wkIn + ' of ' + p.cycleDuration + ' — tap to manage ▸</div>';
            } else {
                cycleStripe = '<div class="cycle-stripe cycle-stripe-start" onclick="startCycleManual(\'' + p.id + '\')">▶ Start Cycle</div>';
            }
        }

        html += '<div class="peptide-card ' + (acyc ? 'has-active-cycle' : '') + '" style="border-color:' + pColor + '40;">' +
            cycleStripe +
            '<h3><span class="color-dot" style="background:' + pColor + ';"></span>' + eName + (acyc ? ' <span class="status-badge status-cycle">● Active</span>' : '') + '</h3>' +
            '<div class="peptide-info">' +
            (st ? '<div class="peptide-info-row"><span class="info-label">Vials on Hand</span><span class="info-value">' + p.vialsOnHand + ' <span class="status-badge ' + st.cls + '">' + st.txt + '</span></span></div>' : '') +
            '<div class="peptide-info-row"><span class="info-label">Size</span><span class="info-value">' + p.mgPerVial + ' ' + p.unit + '/vial</span></div>' +
            doseRow + cycleRow +
            '<div class="peptide-info-row"><span class="info-label">Est. Supply</span><span class="info-value">' + sup + '</span></div>' +
            projHtml + '</div>' +
            reconHtml +
            '<div class="peptide-actions">' +
            (!simple ? (!ri ? '<button class="btn-primary btn-small" onclick="openReconstitute(\'' + p.id + '\')">💧 Reconstitute</button>'
                            : '<button class="btn-warning btn-small" onclick="finishVial(\'' + p.id + '\')">✓ Finish Vial</button>') : '') +
            ' <button class="btn-ghost btn-small" onclick="openEdit(\'' + p.id + '\')">✏️ Edit</button>' +
            ' <button class="btn-danger btn-small" onclick="deletePeptide(\'' + p.id + '\')">🗑️</button>' +
            '</div></div>';
    });
    grid.innerHTML = html;
}

// ── RECONSTITUTE ─────────────────────────────────────────────
function openReconstitute(id) {
    document.getElementById('recon-peptide-id').value = id;
    document.getElementById('water-ml').value = '';
    document.getElementById('recon-preview').innerHTML = '';
    document.getElementById('reconstitute-modal').classList.add('active');
}

document.getElementById('water-ml').addEventListener('input', function() {
    var id  = document.getElementById('recon-peptide-id').value;
    var ml  = parseFloat(this.value);
    var p   = appData.peptides.find(function(x) { return x.id === id; });
    var pre = document.getElementById('recon-preview');
    if (!p || !ml || ml <= 0) { pre.innerHTML = ''; return; }

    var total = isIU(p) ? p.mgPerVial : p.mgPerVial * 1000;
    var pml   = total / ml;
    var du    = isIU(p) ? 'IU' : 'mcg';
    var dose  = p.dailyDose || 0;
    var mpd   = dose > 0 ? dose / pml : 0;
    var doses = dose > 0 ? Math.floor(total / dose) : 0;

    pre.innerHTML = '<div class="dose-calc"><p><strong>After reconstitution with ' + ml + ' mL:</strong></p>' +
        '<p>Concentration: <span class="highlight">' + (pml / 100).toFixed(2) + ' ' + du + ' per unit</span></p>' +
        (dose > 0
            ? '<p>For ' + dose + ' ' + du + ': draw <span class="highlight">' + mpd.toFixed(3) + ' mL</span></p>' +
              '<p>→ <span class="highlight-green">' + mlToUnits(mpd).toFixed(1) + ' units</span></p>' +
              '<p>Doses per vial: <span class="highlight">' + doses + '</span></p>'
            : '') +
        '</div>';
});

document.getElementById('reconstitute-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    var id = document.getElementById('recon-peptide-id').value;
    var p  = appData.peptides.find(function(x) { return x.id === id; });
    if (!p) return;
    var total = isIU(p) ? p.mgPerVial : p.mgPerVial * 1000;
    p.reconstituted = {
        waterType:        document.getElementById('water-type').value,
        waterMl:          parseFloat(document.getElementById('water-ml').value),
        remainingUnits:   total,
        reconstitutedAt:  new Date().toISOString()
    };
    try { await dbPut('peptides', p); } catch(err) { alert('Save failed: ' + err.message); return; }
    renderSupply();
    closeModal('reconstitute-modal');
});

async function finishVial(id) {
    var p = appData.peptides.find(function(x) { return x.id === id; });
    if (!p || !confirm('Mark this ' + p.name + ' vial as finished?')) return;
    p.reconstituted = null;
    p.vialsOnHand   = Math.max(0, p.vialsOnHand - 1);
    try { await dbPut('peptides', p); } catch(err) { alert('Save failed: ' + err.message); return; }
    renderSupply();
    updateDoseDropdown();
    checkLowStockNotification();
}

// ── EDIT ─────────────────────────────────────────────────────
function openEdit(id) {
    var p = appData.peptides.find(function(x) { return x.id === id; });
    if (!p) return;
    document.getElementById('edit-id').value              = id;
    document.getElementById('edit-vials').value           = p.vialsOnHand;
    document.getElementById('edit-dose').value            = dispAmt(p.dailyDose, p);
    document.getElementById('edit-dpw').value             = p.dosesPerWeek;
    document.getElementById('edit-cycle-dur').value       = p.cycleDuration || '';
    document.getElementById('edit-reorder').value         = p.reorderThreshold || 5;
    document.getElementById('edit-display-unit').value    = p.displayUnit || 'mcg';
    document.getElementById('edit-tracking-mode').value   = p.trackingMode || 'simple';
    document.getElementById('edit-dose-label').textContent = 'Your Dose (' + dispUnit(p) + ')';
    editSelectedColor = p.color || PEPTIDE_COLORS[0];
    buildColorPicker('edit-color-picker', function(c) { editSelectedColor = c; }, editSelectedColor);
    buildScheduleUI('edit-sched-container', p.schedule || null);
    var editIsSimple = (p.trackingMode || 'simple') === 'simple';
    document.querySelectorAll('#edit-form .edit-full-only').forEach(function(el) {
        el.style.display = editIsSimple ? 'none' : '';
    });
    document.getElementById('edit-modal').classList.add('active');
}

document.getElementById('edit-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    var id = document.getElementById('edit-id').value;
    var p  = appData.peptides.find(function(x) { return x.id === id; });
    if (!p) return;
    var newDUnit   = document.getElementById('edit-display-unit').value;
    var rawDose    = parseFloat(document.getElementById('edit-dose').value) || 0;
    var editSimple = document.getElementById('edit-tracking-mode').value === 'simple';
    p.vialsOnHand      = editSimple ? (p.vialsOnHand || 0) : (parseInt(document.getElementById('edit-vials').value) || 0);
    p.dailyDose        = (newDUnit === 'mg' && p.unit === 'mg') ? rawDose * 1000 : rawDose;
    p.displayUnit      = (p.unit === 'mg') ? newDUnit : 'mcg';
    p.trackingMode     = document.getElementById('edit-tracking-mode').value || 'simple';
    p.dosesPerWeek     = parseInt(document.getElementById('edit-dpw').value) || 7;
    p.cycleDuration    = parseInt(document.getElementById('edit-cycle-dur').value) || 0;
    p.reorderThreshold = parseInt(document.getElementById('edit-reorder').value) || 5;
    p.color            = editSelectedColor;
    p.schedule         = readScheduleUI('edit-sched-container');
    try { await dbPut('peptides', p); } catch(err) { alert('Save failed: ' + err.message); return; }
    renderSupply();
    updateDoseDropdown();
    checkLowStockNotification();
    renderTodaySchedule();
    closeModal('edit-modal');
});

async function deletePeptide(id) {
    var p = appData.peptides.find(function(x) { return x.id === id; });
    if (!p || !confirm('Delete ' + p.name + '?')) return;

    // Collect cycles to delete BEFORE filtering them out of memory (bug fix)
    var cyclesToDel = (appData.cycles || []).filter(function(c) { return c.peptideId === id; });

    appData.peptides = appData.peptides.filter(function(x) { return x.id !== id; });
    appData.cycles   = (appData.cycles || []).filter(function(c) { return c.peptideId !== id; });

    try {
        await dbDelete('peptides', id);
        for (var i = 0; i < cyclesToDel.length; i++) {
            await dbDelete('cycles', cyclesToDel[i].id);
        }
    } catch(err) { alert('Delete failed: ' + err.message); }

    renderSupply();
    updateDoseDropdown();
    checkLowStockNotification();
}

// ── CYCLES ────────────────────────────────────────────────────
function startCycle(peptideId, date) {
    if (!appData.cycles) appData.cycles = [];
    if (appData.cycles.find(function(c) { return c.peptideId === peptideId && c.status === 'active'; })) return;
    var p = appData.peptides.find(function(x) { return x.id === peptideId; });
    if (!p) return;
    var ped = null;
    if (p.cycleDuration) {
        var d = new Date(date + 'T00:00:00');
        d.setDate(d.getDate() + p.cycleDuration * 7);
        ped = localDateStr(d);
    }
    var cycle = {
        id: genId(), peptideId: peptideId, peptideName: p.name,
        color: p.color || 'var(--accent)', startDate: date,
        endDate: null, plannedDuration: p.cycleDuration || 0,
        plannedEndDate: ped, status: 'active', createdAt: new Date().toISOString()
    };
    appData.cycles.push(cycle);
    dbPut('cycles', cycle);
}

async function endCycle(cycleId) {
    var cycle = (appData.cycles || []).find(function(c) { return c.id === cycleId; });
    if (!cycle) return;
    cycle.status  = 'completed';
    cycle.endDate = localDateStr();
    // Note: vials are already decremented per-dose via reconstituted.remainingUnits / finishVial.
    // Do NOT double-decrement here.
    try { await dbPut('cycles', cycle); } catch(err) { alert('Save failed: ' + err.message); return; }
    renderSupply();
    renderCycles();
    closeModal('cycle-modal');
}

function getCycleDoses(cycleId) {
    var cycle = (appData.cycles || []).find(function(c) { return c.id === cycleId; });
    if (!cycle) return [];
    return (appData.doses || []).filter(function(d) {
        return d.peptideId === cycle.peptideId &&
               d.date >= cycle.startDate &&
               (!cycle.endDate || d.date <= cycle.endDate);
    });
}

var ganttWindowStart = null, GANTT_WEEKS = 26;

function renderCycles() {
    renderGantt(appData.cycles || []);
    renderCycleDetails(appData.cycles || []);
}

function renderGantt(cycles) {
    var wrapper = document.getElementById('gantt-wrapper');
    var rl      = document.getElementById('gantt-range-label');
    if (!cycles.length) { wrapper.innerHTML = '<div class="empty-state"><p>No cycles yet.</p></div>'; rl.textContent = ''; return; }

    if (!ganttWindowStart) {
        var earliest = cycles.reduce(function(m,c) { return c.startDate < m ? c.startDate : m; }, cycles[0].startDate);
        var d = new Date(earliest + 'T00:00:00'); d.setDate(d.getDate() - 14);
        ganttWindowStart = d;
    }

    var we    = new Date(ganttWindowStart.getTime() + GANTT_WEEKS * 7 * 86400000);
    var tm    = GANTT_WEEKS * 7 * 86400000;
    var today = new Date(); today.setHours(0,0,0,0);
    rl.textContent = fmtDateShort(ganttWindowStart) + ' — ' + fmtDateShort(we);

    var mm = [], cur = new Date(ganttWindowStart.getFullYear(), ganttWindowStart.getMonth(), 1);
    while (cur < we) {
        var pct = ((cur - ganttWindowStart) / tm) * 100;
        if (pct >= 0 && pct <= 100) mm.push({ label: cur.toLocaleDateString('en-US',{month:'short',year:'2-digit'}), pct: pct });
        cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    }

    var mh = mm.map(function(m) { return '<div class="gantt-month-label" style="left:' + m.pct.toFixed(1) + '%;">' + m.label + '</div>'; }).join('');
    var gl = mm.map(function(m) { return '<div class="gantt-grid-line" style="left:' + m.pct.toFixed(1) + '%;"></div>'; }).join('');
    var tp = ((today - ganttWindowStart) / tm) * 100;
    var tl = (tp >= 0 && tp <= 100) ? '<div class="gantt-today-line" style="left:' + tp.toFixed(1) + '%;"></div>' : '';

    var bp = {};
    cycles.forEach(function(c) { if (!bp[c.peptideId]) bp[c.peptideId] = []; bp[c.peptideId].push(c); });

    var rows = '';
    Object.keys(bp).forEach(function(pid) {
        var pcs   = bp[pid];
        var pName = escapeHtml(pcs[0].peptideName);
        var bars  = pcs.map(function(c) {
            var sd  = new Date(c.startDate + 'T00:00:00');
            var ed  = c.endDate ? new Date(c.endDate + 'T00:00:00')
                    : c.plannedEndDate ? new Date(c.plannedEndDate + 'T00:00:00')
                    : new Date(today.getTime() + 7 * 86400000);
            var lp  = ((sd - ganttWindowStart) / tm) * 100;
            var wp  = ((ed - sd) / tm) * 100;
            if (lp > 100 || lp + wp < 0) return '';
            var cl  = Math.max(0, lp);
            var cw  = Math.min(100 - cl, wp - (cl - lp));
            var cnt = getCycleDoses(c.id).length;
            return '<div class="gantt-bar ' + (c.status === 'active' ? 'active' : 'completed') +
                   '" style="left:' + cl.toFixed(1) + '%;width:' + Math.max(0.5, cw).toFixed(1) + '%;background:' + (c.color || 'var(--accent)') + ';"' +
                   ' title="' + pName + ': ' + c.startDate + ' (' + cnt + ' doses)"' +
                   ' onclick="openCycleModal(\'' + c.id + '\')">' +
                   (c.status === 'active' ? '● ' : '') + cnt + ' doses</div>';
        }).join('');
        rows += '<div class="gantt-row"><div class="gantt-row-label"><strong>' + pName + '</strong><small>' + pcs.length + ' cycle' + (pcs.length > 1 ? 's' : '') + '</small></div>' +
                '<div class="gantt-track">' + gl + tl + bars + '</div></div>';
    });

    wrapper.innerHTML = '<div class="gantt-header"><div class="gantt-label-col">Peptide</div><div class="gantt-months">' + mh + '</div></div>' + rows;
}

function renderCycleDetails(cycles) {
    var container = document.getElementById('cycle-details-list');
    if (!cycles.length) { container.innerHTML = '<div class="empty-state"><p>No cycles yet.</p></div>'; return; }

    var sorted = cycles.slice().sort(function(a,b) { return b.startDate.localeCompare(a.startDate); });
    var html   = '';
    sorted.forEach(function(c) {
        var doses  = getCycleDoses(c.id);
        var p      = appData.peptides.find(function(x) { return x.id === c.peptideId; });
        var start  = new Date(c.startDate + 'T00:00:00');
        var today  = new Date(); today.setHours(0,0,0,0);
        var endD   = c.endDate ? new Date(c.endDate + 'T00:00:00') : today;
        var elapsed= Math.ceil((endD - start) / 86400000);
        var pct    = c.plannedDuration ? Math.min(100, (elapsed / (c.plannedDuration * 7)) * 100) : null;
        var totalU = doses.reduce(function(s,d) {
            return s + ((d.unit === 'mg') ? d.amount * 1000 : d.amount);
        }, 0);
        var du = p ? (isIU(p) ? 'IU' : 'mcg') : 'mcg';
        var sColor = c.status === 'active' ? 'var(--success)' : 'var(--accent)';
        var barColor = c.color || 'var(--success)';

        var progHtml = pct !== null
            ? '<div style="font-size:0.82rem;color:var(--text-secondary);margin-bottom:4px;">Week ' + (elapsed/7).toFixed(1) + ' of ' + c.plannedDuration + ' (' + pct.toFixed(0) + '% complete)</div>' +
              '<div class="cycle-progress-bar"><div class="cycle-progress-fill" style="width:' + pct + '%;background:' + barColor + ';"></div></div>'
            : '<div style="font-size:0.82rem;color:var(--text-secondary);">Week ' + (elapsed/7).toFixed(1) + ' elapsed</div>';

        var vc        = p ? (isIU(p) ? p.mgPerVial : p.mgPerVial * 1000) : 1000;
        var vialsUsed = p ? '<div class="cycle-stat"><div class="cycle-stat-value">' + (totalU / vc).toFixed(2) + '</div><div class="cycle-stat-label">Vials Used</div></div>' : '';

        var projHtml = '';
        if (p && c.status === 'active') {
            var proj = calcPostCycleProjection(p, c);
            if (proj) {
                var rw = proj.postVials <= p.reorderThreshold ? ' — <span style="color:var(--warning);">⚠️ Reorder</span>' : '';
                projHtml = '<div class="supply-projection">📊 Post-Cycle: ~' + proj.postVials + ' vials remaining' + rw +
                           '<br><small style="color:var(--text-secondary);">' + proj.daysRemaining + ' days remaining</small></div>';
            }
        }

        var endBtn = c.status === 'active'
            ? '<div style="margin-top:12px;"><button class="btn-danger btn-small" onclick="openCycleModal(\'' + c.id + '\')">End Cycle</button></div>'
            : '';

        html += '<div class="cycle-detail-card">' +
            '<div class="cycle-detail-header">' +
            '<div><strong style="font-size:1.05rem;">' + escapeHtml(c.peptideName) + '</strong>' +
            '<span class="status-badge" style="background:rgba(255,255,255,0.07);color:' + sColor + ';margin-left:8px;">' + c.status.toUpperCase() + '</span></div>' +
            '<div style="font-size:0.82rem;color:var(--text-secondary);">' + fmtDate(c.startDate) + ' → ' + (c.endDate ? fmtDate(c.endDate) : c.plannedEndDate ? fmtDate(c.plannedEndDate) + ' (planned)' : 'Ongoing') + '</div></div>' +
            progHtml +
            '<div class="cycle-stats">' +
            '<div class="cycle-stat"><div class="cycle-stat-value">' + doses.length + '</div><div class="cycle-stat-label">Doses</div></div>' +
            '<div class="cycle-stat"><div class="cycle-stat-value">' + elapsed + '</div><div class="cycle-stat-label">Days</div></div>' +
            '<div class="cycle-stat"><div class="cycle-stat-value">' + totalU.toFixed(0) + '</div><div class="cycle-stat-label">Total ' + du + '</div></div>' +
            vialsUsed + '</div>' + projHtml + endBtn + '</div>';
    });
    container.innerHTML = html;
}

function openCycleModal(cycleId) {
    var cycle  = (appData.cycles || []).find(function(c) { return c.id === cycleId; });
    if (!cycle) return;
    var endBtn = document.getElementById('cycle-end-btn');
    document.getElementById('cycle-modal-content').innerHTML =
        '<p><strong>' + escapeHtml(cycle.peptideName) + '</strong></p>' +
        '<p style="color:var(--text-secondary);font-size:0.88rem;margin-top:6px;">Started: ' + fmtDate(cycle.startDate) +
        '<br>Status: ' + cycle.status + '<br>Doses: ' + getCycleDoses(cycleId).length + '</p>';
    endBtn.style.display = cycle.status === 'active' ? 'inline-block' : 'none';
    endBtn.onclick = function() { if (confirm('End ' + cycle.peptideName + ' cycle?')) endCycle(cycleId); };
    document.getElementById('cycle-modal').classList.add('active');
}

document.getElementById('gantt-scroll-left').addEventListener('click', function() {
    if (ganttWindowStart) { ganttWindowStart = new Date(ganttWindowStart.getTime() - 28 * 86400000); renderGantt(appData.cycles || []); }
});
document.getElementById('gantt-scroll-right').addEventListener('click', function() {
    if (ganttWindowStart) { ganttWindowStart = new Date(ganttWindowStart.getTime() + 28 * 86400000); renderGantt(appData.cycles || []); }
});

// ── DOSE LOG ──────────────────────────────────────────────────
function updateDoseDropdown() {
    var sel = document.getElementById('ld-pep-select');
    if (!sel) return;
    var cur = sel.value;
    sel.innerHTML = '<option value="">Select peptide…</option>' +
        (appData.peptides || []).map(function(p) {
            return '<option value="' + p.id + '">' + escapeHtml(p.name) + (p.reconstituted ? ' ✓' : '') + '</option>';
        }).join('');
    if (cur && (appData.peptides || []).find(function(x) { return x.id === cur; })) sel.value = cur;
}

document.getElementById('dose-peptide').addEventListener('change', function() {
    var id  = this.value;
    var ref = document.getElementById('quick-reference');
    var cnt = document.getElementById('quick-reference-content');
    if (!id) { ref.style.display = 'none'; return; }
    var p = appData.peptides.find(function(x) { return x.id === id; });
    if (!p) { ref.style.display = 'none'; return; }

    var du = dispUnit(p);
    document.getElementById('log-dose-label').textContent = 'Dose (' + du + ') *';
    if (p.dailyDose) document.getElementById('dose-amount').value = dispAmt(p.dailyDose, p);

    if (p.reconstituted) {
        var ri = calcReconInfo(p);
        cnt.innerHTML = '<div class="dose-calc">' +
            '<p><strong>' + escapeHtml(p.name) + '</strong> — Active vial</p>' +
            '<p>Draw <span class="highlight">' + ri.mlPerDose.toFixed(3) + ' mL</span> — <span class="highlight">' + ri.units.toFixed(1) + ' units</span></p>' +
            '<p>For ' + dispAmt(p.dailyDose, p) + ' ' + du + ' | Remaining: ' + ri.remainingUnits.toFixed(1) + ' ' + du + ' (' + ri.dosesRemaining + ' doses)</p></div>';
    } else {
        cnt.innerHTML = '<div class="dose-calc" style="border:1px solid var(--warning);background:rgba(245,158,11,0.08);"><p><strong>⚠️ ' + escapeHtml(p.name) + ' not reconstituted.</strong></p></div>';
    }
    ref.style.display = 'block';
});

document.getElementById('dose-date').value = localDateStr();

document.getElementById('dose-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    var id = document.getElementById('dose-peptide').value;
    var p  = appData.peptides.find(function(x) { return x.id === id; });
    if (!p) { alert('Select a peptide.'); return; }

    var site = document.getElementById('injection-site').value || null;
    if (!site) { alert('Select an injection site.'); return; }

    var amount = parseFloat(document.getElementById('dose-amount').value);
    if (!amount || amount <= 0) { alert('Set a dose amount for ' + p.name + ' before logging.'); return; }

    var doseDate  = document.getElementById('dose-date').value || localDateStr();
    var doseTime  = document.getElementById('dose-time').value || (function() {
        var n = new Date();
        return String(n.getHours()).padStart(2,'0') + ':' + String(n.getMinutes()).padStart(2,'0');
    })();
    var du        = dispUnit(p);
    var mcgAmount = toMcg(amount, p);

    // Snapshot pre-state for transactional Undo
    var snapshot = {
        peptideId: p.id,
        prevReconstituted: p.reconstituted ? JSON.parse(JSON.stringify(p.reconstituted)) : null,
        prevVialsOnHand: p.vialsOnHand,
        cycleStartedId: null,
        prevSelectedSite: site
    };

    if (p.reconstituted) {
        var totalUnits = (p.reconstituted.remainingUnits !== undefined)
            ? p.reconstituted.remainingUnits
            : (isIU(p) ? p.mgPerVial : p.mgPerVial * 1000);
        p.reconstituted.remainingUnits = Math.max(0, totalUnits - mcgAmount);
        var vialEmptied = (totalUnits - mcgAmount <= 0);
        if (vialEmptied) {
            p.reconstituted = null;
            p.vialsOnHand   = Math.max(0, p.vialsOnHand - 1);
        }
        try { await dbPut('peptides', p); } catch(err) { alert('Save failed: ' + err.message); return; }
    }

    var hadActiveCycle = (appData.cycles || []).some(function(c) { return c.peptideId === id && c.status === 'active'; });
    if (!hadActiveCycle && p.cycleDuration) {
        var cyclesBefore = (appData.cycles || []).length;
        startCycle(id, doseDate);
        // Capture the just-started cycle so Undo can reverse it
        if ((appData.cycles || []).length > cyclesBefore) {
            snapshot.cycleStartedId = appData.cycles[appData.cycles.length - 1].id;
        }
    }

    var dose = {
        id: genId(), peptideId: id, peptideName: p.name,
        date: doseDate,
        time: doseTime,
        amount: amount, unit: du,
        site: site,
        notes: document.getElementById('dose-notes').value.trim() || null,
        loggedAt: new Date().toISOString()
    };

    try {
        await dbPut('doses', dose);
        appData.doses.push(dose);
    } catch(err) { alert('Save failed: ' + err.message); return; }

    snapshot.doseId = dose.id;
    logDoseState.lastSnapshot = snapshot;

    renderSupply();
    renderHistory();
    renderTodaySchedule();
    renderDashCalendar();
    renderDashDayDetail(selectedDashDate || localDateStr());
    checkLowStockNotification();

    // Reset note field for next time
    var nta = document.getElementById('ld-note-textarea');
    if (nta) { nta.value = ''; document.getElementById('dose-notes').value = ''; }
    var nc = document.getElementById('ld-note-counter');
    if (nc) nc.textContent = '0 / 140';
    document.querySelectorAll('.ld-note-chip.active').forEach(function(c) { c.classList.remove('active'); });
    var noteCard = document.getElementById('ld-note-card');
    if (noteCard) noteCard.style.display = 'none';
    logDoseState.noteOpen = false;

    showLoggedScreen(dose, p);
});

// ── LOG DOSE V2 (hero plate + chip grid) ──────────────────────
var logDoseState = {
    peptideId:        null,
    selectedSite:     null,
    recommendedSite:  null,
    isOffRotation:    false,
    showWarning:      false,
    noteOpen:         false,
    autoDismissTimer: null,
    lastSnapshot:     null
};

var LD_CANONICAL_SITES = [
    'Abdomen - Left',  'Abdomen - Right',
    'Thigh - Left',    'Thigh - Right',
    'Glute - Left',    'Glute - Right',
    'Deltoid - Left',  'Deltoid - Right'
];

function ldDaysSinceDate(dateStr) {
    if (!dateStr) return Infinity;
    var d = new Date(dateStr + 'T00:00:00');
    var t = new Date(); t.setHours(0,0,0,0);
    return Math.max(0, Math.floor((t - d) / 86400000));
}

function ldGetPeptideLastUsedMap(peptideId) {
    var doses = (appData.doses || [])
        .filter(function(d) { return d.peptideId === peptideId && d.site; })
        .sort(function(a,b) {
            return b.date.localeCompare(a.date) || ((b.time || '').localeCompare(a.time || ''));
        });
    var map = {};
    doses.forEach(function(d) {
        if (map[d.site] === undefined) map[d.site] = ldDaysSinceDate(d.date);
    });
    return map;
}

function ldGetRecommended(peptideId) {
    var map = ldGetPeptideLastUsedMap(peptideId);
    var best = null, bestDays = -1;
    LD_CANONICAL_SITES.forEach(function(s) {
        var days = (map[s] === undefined) ? Infinity : map[s];
        if (days > bestDays) { bestDays = days; best = s; }
    });
    return best;
}

function ldGetCyclePos(peptideId) {
    var c = (appData.cycles || []).find(function(x) {
        return x.peptideId === peptideId && x.status === 'active';
    });
    if (!c || !c.plannedDuration) return null;
    var start = new Date(c.startDate + 'T00:00:00');
    var t = new Date(); t.setHours(0,0,0,0);
    var diffDays = Math.max(0, Math.floor((t - start) / 86400000));
    var week = Math.min(c.plannedDuration, Math.floor(diffDays / 7) + 1);
    return week + ' / ' + c.plannedDuration;
}

function ldGetStreak() {
    var doses = appData.doses || [];
    if (!doses.length) return 0;
    var dateSet = {};
    doses.forEach(function(d) { if (d.date) dateSet[d.date] = true; });
    var cursor = new Date(); cursor.setHours(0,0,0,0);
    // If today has no dose yet, start counting from yesterday
    if (!dateSet[localDateStr(cursor)]) cursor.setDate(cursor.getDate() - 1);
    var streak = 0;
    while (dateSet[localDateStr(cursor)] && streak < 999) {
        streak++;
        cursor.setDate(cursor.getDate() - 1);
    }
    return streak;
}

function ldStatusOf(daysSince, isRecommended) {
    if (isRecommended)          return 'rec';
    if (daysSince === Infinity) return 'new';
    if (daysSince <= 1)         return 'hot';
    if (daysSince <= 4)         return 'warn';
    return 'ok';
}

function ldFormatDays(daysSince) {
    if (daysSince === Infinity) return '—';
    if (daysSince === 0)        return 'today';
    return daysSince + 'd';
}

function ldFormatTime12(t) {
    if (!t || !/^\d{1,2}:\d{2}$/.test(t)) return '';
    var parts = t.split(':');
    var h = parseInt(parts[0], 10);
    var m = parts[1];
    var ampm = h >= 12 ? 'PM' : 'AM';
    var hh = h % 12 || 12;
    return hh + ':' + m + ' ' + ampm;
}

function ldFormatRegionSide(site) {
    if (!site) return { region: '—', side: '—', abbrev: '' };
    var parts = site.split(' - ');
    var region = parts[0] || '—';
    var side   = parts[1] === 'Left' ? 'Left side' : (parts[1] === 'Right' ? 'Right side' : '—');
    var abbrev = parts[1] === 'Left' ? 'L' : (parts[1] === 'Right' ? 'R' : '');
    return { region: region, side: side, abbrev: abbrev };
}

// Recompute the inline "X units" readout based on the current dose-amount input.
// Called on initial render AND on every keystroke in the amount input.
function ldRecalcUnits() {
    var readout = document.getElementById('ld-units-readout');
    if (!readout) return;
    var p = (appData.peptides || []).find(function(x) { return x.id === logDoseState.peptideId; });
    var amtEl = document.getElementById('dose-amount');
    var amtVal = amtEl ? parseFloat(amtEl.value) : NaN;
    if (!p || !p.reconstituted || isNaN(amtVal) || amtVal <= 0) {
        readout.textContent = '— units';
        return;
    }
    // Build a transient peptide with the user's typed dose, in mcg, then reuse calcReconInfo
    var mcgAmt = toMcg(amtVal, p);
    var probe  = Object.assign({}, p, { dailyDose: mcgAmt });
    var ri = calcReconInfo(probe);
    if (ri && ri.units) {
        readout.textContent = ri.units.toFixed(1) + ' units';
    } else {
        readout.textContent = '— units';
    }
}

function ldPickDefaultPeptide() {
    if (logDoseState.peptideId) {
        var existing = (appData.peptides || []).find(function(x) { return x.id === logDoseState.peptideId; });
        if (existing) return existing.id;
    }
    // First peptide with a scheduled dose today, prefer untaken
    if (typeof getTodaysSchedule === 'function') {
        var todays = getTodaysSchedule();
        var untaken = todays.find(function(item) { return !item.taken; });
        if (untaken) return untaken.peptide.id;
        if (todays.length) return todays[0].peptide.id;
    }
    return (appData.peptides && appData.peptides[0]) ? appData.peptides[0].id : null;
}

function renderLogDosePlate() {
    var formScreen = document.getElementById('ld-form-screen');
    if (!formScreen) return;

    // Make sure we're showing the form (not the logged overlay)
    var loggedScreen = document.getElementById('ld-logged-screen');
    if (loggedScreen) loggedScreen.style.display = 'none';
    formScreen.style.display = 'block';

    // Populate peptide select
    updateDoseDropdown();

    // No peptides at all → empty state
    if (!appData.peptides || !appData.peptides.length) {
        renderLogDoseEmptyState();
        return;
    }

    // Decide active peptide
    var pid = logDoseState.peptideId || ldPickDefaultPeptide();
    var p   = (appData.peptides || []).find(function(x) { return x.id === pid; });
    if (!p) {
        renderLogDoseEmptyState();
        return;
    }
    logDoseState.peptideId = p.id;
    var pepSelect = document.getElementById('ld-pep-select');
    if (pepSelect) pepSelect.value = p.id;

    // Sync form inputs (visible amount/time inputs feed the existing submit handler)
    document.getElementById('dose-peptide').value = p.id;
    document.getElementById('dose-date').value    = localDateStr();
    var now = new Date();
    document.getElementById('dose-time').value =
        String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
    if (p.dailyDose) document.getElementById('dose-amount').value = dispAmt(p.dailyDose, p);
    // Reflect the peptide's display unit in the inline label
    var metaUnitEl = document.getElementById('ld-meta-unit');
    if (metaUnitEl) metaUnitEl.textContent = dispUnit(p);

    // Rotation calc
    var lastUsedMap = ldGetPeptideLastUsedMap(p.id);
    var recommended = ldGetRecommended(p.id);
    logDoseState.recommendedSite = recommended;

    // Default to recommended on first render or after a fresh log
    if (!logDoseState.selectedSite) logDoseState.selectedSite = recommended;
    var sel = logDoseState.selectedSite;

    // Off-rotation flags
    var isOffRot   = (sel !== recommended);
    var selDays    = (sel && lastUsedMap[sel] !== undefined) ? lastUsedMap[sel] : Infinity;
    var showWarn   = isOffRot && selDays !== Infinity && selDays < 5;
    logDoseState.isOffRotation = isOffRot;
    logDoseState.showWarning   = showWarn;

    // Show all form sections (in case they were hidden by empty state)
    ['ld-peptide-card','ld-eyebrow','ld-hero-plate'].forEach(function(elId) {
        var el = document.getElementById(elId);
        if (el) el.style.display = '';
    });
    var metaEl = document.querySelector('.ld-pep-meta');
    if (metaEl) metaEl.style.display = '';
    var primaryWrap  = document.querySelector('.ld-primary-wrap');
    var addNoteWrap  = document.querySelector('.ld-add-note-wrap');
    var chooseSec    = document.querySelector('.ld-choose-section');
    if (primaryWrap) primaryWrap.style.display = '';
    if (addNoteWrap) addNoteWrap.style.display = '';
    if (chooseSec)   chooseSec.style.display   = '';

    // ── Peptide context card ──
    var col = getPeptideColor(p);
    document.getElementById('ld-color-stripe').style.background = col;
    document.getElementById('ld-pep-name').textContent = p.name;

    // Refresh the inline "X units" readout from the current dose-amount value
    ldRecalcUnits();

    // ── Section eyebrow ──
    var isRec = (sel === recommended);
    var eyebrowLbl = document.getElementById('ld-eyebrow-label');
    eyebrowLbl.textContent = isRec ? 'Next on rotation' : 'Selected site';
    eyebrowLbl.classList.toggle('rec', isRec);

    // ── Hero plate ──
    var rs = ldFormatRegionSide(sel);
    document.getElementById('ld-hero-region').textContent = rs.region;
    document.getElementById('ld-hero-side').textContent   = rs.side;
    document.getElementById('ld-stat-last').textContent =
        selDays === Infinity ? 'never' : (selDays === 0 ? 'today' : selDays + 'd ago');
    document.getElementById('ld-stat-cycle').textContent =
        isOffRot ? 'off-rot' : (ldGetCyclePos(p.id) || '—');
    var streak = ldGetStreak();
    document.getElementById('ld-stat-streak').textContent = streak ? (streak + 'd') : '—';

    // ── Off-rotation warning ──
    var warning = document.getElementById('ld-warning');
    if (showWarn) {
        document.getElementById('ld-warning-text').textContent =
            'Off rotation. Used ' + selDays + ' day' + (selDays === 1 ? '' : 's') +
            ' ago — consider a different side.';
        warning.style.display = 'flex';
    } else {
        warning.style.display = 'none';
    }

    // ── Primary button ──
    var btn = document.getElementById('ld-primary-btn');
    btn.textContent = sel ? ('Log to ' + rs.region + ' ' + rs.abbrev) : 'Select a site';
    btn.disabled    = !sel;
    btn.style.background = sel ? '' : 'var(--bg-tertiary)';

    // Hidden site input feeds the submit handler
    document.getElementById('injection-site').value = sel || '';

    // ── Chip grid ──
    renderLdChipGrid(lastUsedMap, recommended);

    // ── "Or choose another" / "All sites" label ──
    document.getElementById('ld-choose-label').textContent =
        isOffRot ? 'All sites' : 'Or choose another';
}

function renderLdChipGrid(lastUsedMap, recommended) {
    var grid = document.getElementById('ld-chip-grid');
    if (!grid) return;

    var sites = LD_CANONICAL_SITES.slice();
    var chips = logDoseState.isOffRotation
        ? sites
        : sites.filter(function(s) { return s !== recommended; }).slice(0, 6);

    grid.innerHTML = chips.map(function(site) {
        var days     = (lastUsedMap[site] === undefined) ? Infinity : lastUsedMap[site];
        var isRec    = (site === recommended);
        var isSelChp = (site === logDoseState.selectedSite);
        var status   = ldStatusOf(days, isRec);
        var label    = site.replace(' - Left', ' L').replace(' - Right', ' R');
        var lastTxt  = ldFormatDays(days);
        var cls      = 'ld-chip ld-status-' + status + (isSelChp ? ' selected' : '');
        var safeSite = site.replace(/'/g, "\\'");
        return '<button type="button" class="' + cls + '" onclick="selectLogDoseSite(\'' + safeSite + '\')">' +
               '<span class="ld-chip-status"></span>' +
               '<span class="ld-chip-label">' + escapeHtml(label) + '</span>' +
               '<span class="ld-chip-last">' + escapeHtml(lastTxt) + '</span>' +
               '</button>';
    }).join('');
}

function renderLogDoseEmptyState() {
    // Hide active form sections, show simple empty message inside the peptide card area
    document.getElementById('ld-eyebrow').style.display    = 'none';
    document.getElementById('ld-hero-plate').style.display = 'none';
    document.getElementById('ld-warning').style.display    = 'none';
    document.getElementById('ld-note-card').style.display  = 'none';
    var primaryWrap = document.querySelector('.ld-primary-wrap');
    var addNoteWrap = document.querySelector('.ld-add-note-wrap');
    var chooseSec   = document.querySelector('.ld-choose-section');
    if (primaryWrap) primaryWrap.style.display = 'none';
    if (addNoteWrap) addNoteWrap.style.display = 'none';
    if (chooseSec)   chooseSec.style.display   = 'none';
    document.getElementById('ld-color-stripe').style.background = 'var(--bg-tertiary)';
    document.getElementById('ld-pep-name').textContent = 'No peptides yet — add one in Supply';
    // Hide the inline dose/time/units row entirely in empty state (don't clobber the inputs)
    var metaEl = document.querySelector('.ld-pep-meta');
    if (metaEl) metaEl.style.display = 'none';
}

function selectLogDoseSite(site) {
    logDoseState.selectedSite = site;
    renderLogDosePlate();
}

// Wire peptide select change
(function() {
    var sel = document.getElementById('ld-pep-select');
    if (sel) {
        sel.addEventListener('change', function() {
            logDoseState.peptideId    = this.value || null;
            logDoseState.selectedSite = null;     // re-pick recommended for new peptide
            renderLogDosePlate();
        });
    }
})();

// ── Note card handlers ──
function ldToggleNote() {
    var card = document.getElementById('ld-note-card');
    var link = document.getElementById('ld-add-note-link');
    if (!card || !link) return;
    logDoseState.noteOpen = !logDoseState.noteOpen;
    if (logDoseState.noteOpen) {
        card.style.display = 'block';
        link.textContent   = '− Hide note';
        var ta = document.getElementById('ld-note-textarea');
        if (ta) ta.focus();
    } else {
        card.style.display = 'none';
        link.textContent   = '+ Add note';
    }
}

function ldNoteInput(el) {
    var hidden = document.getElementById('dose-notes');
    if (hidden) hidden.value = el.value;
    var counter = document.getElementById('ld-note-counter');
    if (counter) counter.textContent = el.value.length + ' / 140';
    // Reflect chip "active" state if their text appears
    document.querySelectorAll('.ld-note-chip').forEach(function(c) {
        var t = c.dataset.text || c.textContent;
        c.classList.toggle('active', el.value.indexOf(t) > -1);
    });
}

function ldNoteChip(btn, text) {
    var ta = document.getElementById('ld-note-textarea');
    if (!ta) return;
    var hidden = document.getElementById('dose-notes');
    var idx = ta.value.indexOf(text);
    if (idx > -1) {
        // Remove this chip's text, plus a leading separator if present
        var before = ta.value.substring(0, idx).replace(/[,\s]+$/, '');
        var after  = ta.value.substring(idx + text.length).replace(/^[,\s]+/, '');
        var joined = (before && after) ? (before + ', ' + after) : (before + after);
        ta.value = joined;
        btn.classList.remove('active');
    } else {
        ta.value = ta.value ? (ta.value.replace(/\s+$/, '') + ', ' + text) : text;
        btn.classList.add('active');
    }
    if (hidden) hidden.value = ta.value;
    var counter = document.getElementById('ld-note-counter');
    if (counter) counter.textContent = ta.value.length + ' / 140';
}

// ── Logged confirmation screen + Undo ──
function showLoggedScreen(dose, p) {
    var formScreen   = document.getElementById('ld-form-screen');
    var loggedScreen = document.getElementById('ld-logged-screen');
    if (!loggedScreen) return;
    formScreen.style.display   = 'none';
    loggedScreen.style.display = 'flex';

    var du   = dose.unit;
    var rs   = ldFormatRegionSide(dose.site);
    var pos  = ldGetCyclePos(p.id);
    var when = (function() {
        var d  = new Date(dose.date + 'T00:00:00');
        var dt = d.toLocaleDateString('en-US', { month:'short', day:'numeric' });
        var tm = ldFormatTime12(dose.time);
        return dt + (tm ? (' · ' + tm) : '');
    })();

    document.getElementById('ld-logged-headline').textContent = p.name + ' · ' + dose.amount + ' ' + du;
    document.getElementById('ld-logged-sub').textContent      = rs.region + (rs.abbrev ? ' ' + rs.abbrev : '');
    document.getElementById('ld-logged-meta').textContent     = when + (pos ? ' · cycle ' + pos : '');

    // Trigger check-ring animation
    var ring = document.querySelector('#ld-logged-screen .ld-check-ring');
    if (ring) {
        ring.classList.remove('animate');
        // force reflow
        void ring.offsetWidth;
        ring.classList.add('animate');
    }

    // Reset for next use
    logDoseState.selectedSite = null;

    // Clear any prior timer, then auto-dismiss to dashboard
    if (logDoseState.autoDismissTimer) clearTimeout(logDoseState.autoDismissTimer);
    logDoseState.autoDismissTimer = setTimeout(function() {
        logDoseState.autoDismissTimer = null;
        logDoseState.lastSnapshot = null;
        // Re-render plate so next time tracking opens it's fresh
        renderLogDosePlate();
        switchTab('dashboard');
    }, 1500);
}

async function undoLastLog() {
    var snap = logDoseState.lastSnapshot;
    if (!snap) {
        // Nothing to undo — just go back to form
        var loggedScreen = document.getElementById('ld-logged-screen');
        var formScreen   = document.getElementById('ld-form-screen');
        if (loggedScreen) loggedScreen.style.display = 'none';
        if (formScreen)   formScreen.style.display   = 'block';
        return;
    }

    if (logDoseState.autoDismissTimer) {
        clearTimeout(logDoseState.autoDismissTimer);
        logDoseState.autoDismissTimer = null;
    }

    // 1. Delete dose row
    appData.doses = (appData.doses || []).filter(function(d) { return d.id !== snap.doseId; });
    try { await dbDelete('doses', snap.doseId); } catch(e) { /* swallow */ }

    // 2. Restore peptide pre-state (recon + vials)
    var p = (appData.peptides || []).find(function(x) { return x.id === snap.peptideId; });
    if (p) {
        p.reconstituted = snap.prevReconstituted
            ? JSON.parse(JSON.stringify(snap.prevReconstituted))
            : null;
        p.vialsOnHand = snap.prevVialsOnHand;
        try { await dbPut('peptides', p); } catch(e) { /* swallow */ }
    }

    // 3. If a cycle was newly auto-started, remove it
    if (snap.cycleStartedId) {
        appData.cycles = (appData.cycles || []).filter(function(c) { return c.id !== snap.cycleStartedId; });
        try { await dbDelete('cycles', snap.cycleStartedId); } catch(e) { /* swallow */ }
    }

    // 4. Restore selection so the user can re-tap or pick a different site
    logDoseState.selectedSite = snap.prevSelectedSite || null;
    logDoseState.lastSnapshot = null;

    // 5. Refresh everything
    renderSupply();
    renderHistory();
    renderTodaySchedule();
    renderDashCalendar();
    renderDashDayDetail(selectedDashDate || localDateStr());
    checkLowStockNotification();
    renderLogDosePlate();
}

// ── INJECTION SITE ROTATION ───────────────────────────────────
// Site coordinates on the body SVG (200×400 viewBox) — split by view
var BODY_SITE_POSITIONS = {
    front: {
        'Deltoid - Left':  { x: 136, y:  58 },
        'Deltoid - Right': { x:  93, y:  58 },
        'Abdomen - Left':  { x: 126, y: 100 },
        'Abdomen - Right': { x: 104, y: 100 },
        'Thigh - Left':    { x: 136, y: 152 },
        'Thigh - Right':   { x:  94, y: 152 }
    },
    back: {
        'Deltoid - Left':  { x:  54, y:  58 },
        'Deltoid - Right': { x:  96, y:  58 },
        'Glute - Left':    { x:  50, y: 133 },
        'Glute - Right':   { x: 100, y: 133 },
        'Thigh - Left':    { x:  55, y: 160 },
        'Thigh - Right':   { x:  95, y: 160 }
    }
};

function toggleBodyView(v, containerId, callbackFn) {
    bodyView = v;
    renderSiteRotation(containerId, callbackFn);
}

function renderSiteRotation(containerId, callbackFn) {
    containerId = containerId || 'rotation-grid';
    callbackFn  = callbackFn  || 'selectSiteFromBody';
    var grid = document.getElementById(containerId);
    if (!grid) return;

    // Sort doses newest-first; index 0 = most recent
    var recent = appData.doses.slice().sort(function(a,b) {
        return b.date.localeCompare(a.date) || ((b.time||'').localeCompare(a.time||''));
    }).slice(0, 14);

    var lastUsed = {};
    recent.forEach(function(d,i) {
        if (d.site && lastUsed[d.site] === undefined) lastUsed[d.site] = i;
    });

    var allSites = INJECTION_SITES.filter(function(s) { return s !== 'Other'; });
    var positions = BODY_SITE_POSITIONS[bodyView];
    var viewSites = allSites.filter(function(s) { return positions[s]; });

    // Next = least-recently-used (or unused) across ALL sites (not just visible ones)
    var sorted = allSites.slice().sort(function(a,b) {
        return (lastUsed[b] !== undefined ? lastUsed[b] : 999) - (lastUsed[a] !== undefined ? lastUsed[a] : 999);
    });
    var next = sorted[sorted.length - 1];

    function colorFor(site) {
        var idx = lastUsed[site];
        if (site === next)        return 'var(--success)';
        if (idx === undefined)    return 'var(--bg-tertiary)';
        if (idx === 0)            return 'var(--danger)';
        if (idx <= 2)             return 'var(--warning)';
        return 'var(--text-secondary)';
    }
    function labelFor(site) {
        var idx = lastUsed[site];
        if (site === next)     return 'Next';
        if (idx === undefined) return 'Unused';
        if (idx === 0)         return 'Last used';
        return idx + ' dose' + (idx === 1 ? '' : 's') + ' ago';
    }

    var dotsSvg = viewSites.map(function(site) {
        var p = positions[site]; if (!p) return '';
        var c = colorFor(site);
        var isNext = (site === next);
        return '<g class="body-site' + (isNext ? ' next-pulse' : '') + '" data-site="' + escapeHtml(site) + '" onclick="' + callbackFn + '(\'' + site.replace(/'/g, "\\'") + '\')">' +
            '<circle cx="' + p.x + '" cy="' + p.y + '" r="9" fill="' + c + '" stroke="var(--bg-secondary)" stroke-width="2"/>' +
            '<title>' + escapeHtml(site) + ' — ' + labelFor(site) + '</title>' +
            '</g>';
    }).join('');

    var bodySvg =
        '<svg class="body-svg" viewBox="0 0 200 267" xmlns="http://www.w3.org/2000/svg">' +
            '<image href="silhouette-' + bodyView + '.png" x="0" y="0" width="200" height="267" preserveAspectRatio="xMidYMid meet"/>' +
            dotsSvg +
        '</svg>';

    var iF = bodyView === 'front';
    var toggle =
        '<div class="body-view-toggle">' +
            '<button class="body-view-btn' + (iF ? ' active' : '') + '" onclick="toggleBodyView(\'front\',\'' + containerId + '\',\'' + callbackFn + '\')">Front</button>' +
            '<button class="body-view-btn' + (!iF ? ' active' : '') + '" onclick="toggleBodyView(\'back\',\'' + containerId + '\',\'' + callbackFn + '\')">Back</button>' +
        '</div>';

    var legend =
        '<div class="body-legend">' +
            '<h4>Status</h4>' +
            '<div class="body-legend-row"><span class="body-dot-legend" style="background:var(--success);"></span><span>Next (' + escapeHtml(next) + ')</span></div>' +
            '<div class="body-legend-row"><span class="body-dot-legend" style="background:var(--danger);"></span><span>Just used</span></div>' +
            '<div class="body-legend-row"><span class="body-dot-legend" style="background:var(--warning);"></span><span>Used recently</span></div>' +
            '<div class="body-legend-row"><span class="body-dot-legend" style="background:var(--text-secondary);"></span><span>3+ doses ago</span></div>' +
            '<div class="body-legend-row"><span class="body-dot-legend" style="background:var(--bg-tertiary);border:1px solid var(--border);"></span><span>Never used</span></div>' +
        '</div>';

    grid.innerHTML = toggle + '<div class="body-diagram-row">' + bodySvg + legend + '</div>';
}

function selectSiteFromBody(site) {
    var inp = document.getElementById('injection-site');
    if (inp) inp.value = site;
    var lbl = document.getElementById('selected-site-display');
    if (lbl) lbl.textContent = site;
    document.querySelectorAll('#rotation-grid .body-site').forEach(function(g) { g.classList.remove('selected'); });
    var picked = document.querySelector('#rotation-grid .body-site[data-site="' + site.replace(/"/g, '\\"') + '"]');
    if (picked) picked.classList.add('selected');
}

function selectSiteForModal(site) {
    sitePickerSelectedSite = site;
    var lbl = document.getElementById('site-picker-selected-display');
    if (lbl) lbl.textContent = site;
    var btn = document.getElementById('site-picker-log-btn');
    if (btn) btn.disabled = false;
    document.querySelectorAll('#site-picker-grid .body-site').forEach(function(g) { g.classList.remove('selected'); });
    var picked = document.querySelector('#site-picker-grid .body-site[data-site="' + site.replace(/"/g, '\\"') + '"]');
    if (picked) picked.classList.add('selected');
}

// ── HISTORY ───────────────────────────────────────────────────
function renderHistory(filter) {
    filter = filter !== undefined ? filter : (document.getElementById('history-search').value || '');
    var tbody = document.getElementById('history-table');
    var doses = (appData.doses || []).slice().sort(function(a,b) { return b.date.localeCompare(a.date); });
    if (filter) doses = doses.filter(function(d) { return d.peptideName.toLowerCase().indexOf(filter.toLowerCase()) > -1; });
    if (!doses.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--text-secondary);">No doses logged yet</td></tr>';
        return;
    }
    tbody.innerHTML = doses.map(function(d) {
        return '<tr><td>' + fmtDate(d.date) + '</td>' +
               '<td>' + (d.time || '-') + '</td>' +
               '<td>' + escapeHtml(d.peptideName) + '</td>' +
               '<td>' + d.amount + ' ' + (d.unit || 'mcg') + '</td>' +
               '<td>' + escapeHtml(d.site || '-') + '</td>' +
               '<td style="font-size:0.8rem;color:var(--text-secondary);max-width:160px;">' + escapeHtml(d.notes || '') + '</td>' +
               '<td style="white-space:nowrap;">' +
               '<button class="btn-ghost btn-small" onclick="openEditDoseModal(\'' + d.id + '\')" title="Edit">✏️</button> ' +
               '<button class="btn-danger btn-small" onclick="deleteDose(\'' + d.id + '\')" title="Delete">🗑️</button>' +
               '</td></tr>';
    }).join('');
}

document.getElementById('history-search').addEventListener('input', function() { renderHistory(this.value); });

async function deleteDose(id) {
    if (!confirm('Delete this dose?')) return;
    appData.doses = appData.doses.filter(function(d) { return d.id !== id; });
    try { await dbDelete('doses', id); } catch(err) { alert('Delete failed: ' + err.message); }
    renderHistory();
    renderTodaySchedule();
    renderDashCalendar();
    renderDashDayDetail(selectedDashDate || localDateStr());
}

function exportCSV() {
    if (!appData.doses || !appData.doses.length) { alert('No doses to export.'); return; }
    var rows = [['Date','Time','Peptide','Dose','Unit','Site','Notes']];
    appData.doses.slice().sort(function(a,b) { return a.date.localeCompare(b.date); }).forEach(function(d) {
        rows.push([d.date, d.time||'', d.peptideName, d.amount, d.unit||'mcg', d.site||'', (d.notes||'').replace(/,/g,' ')]);
    });
    dlCSV(rows, 'peptide-log');
}

function dlCSV(rows, name) {
    var blob = new Blob([rows.map(function(r) { return r.join(','); }).join('\n')], { type:'text/csv' });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement('a');
    a.href = url; a.download = name + '-' + localDateStr() + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

// ── CALENDAR ──────────────────────────────────────────────────
var calDate = new Date();

function renderCalendar() {
    var grid   = document.getElementById('calendar-grid');
    var header = document.getElementById('calendar-month-year');
    var year   = calDate.getFullYear(), month = calDate.getMonth();
    header.textContent = new Date(year, month).toLocaleDateString('en-US', { month:'long', year:'numeric' });

    var fd  = new Date(year, month, 1).getDay();
    var dim = new Date(year, month + 1, 0).getDate();
    var pl  = new Date(year, month, 0).getDate();
    var today = new Date(); today.setHours(0,0,0,0);

    var html = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
        .map(function(d) { return '<div class="cal-day-header">' + d + '</div>'; }).join('');

    for (var i = fd - 1; i >= 0; i--) html += '<div class="cal-day other-month"><div class="cal-day-num">' + (pl - i) + '</div></div>';

    for (var day = 1; day <= dim; day++) {
        var ds  = year + '-' + String(month + 1).padStart(2,'0') + '-' + String(day).padStart(2,'0');
        var ds2 = ds; // closure capture
        var isT = new Date(year, month, day).getTime() === today.getTime();
        var dd  = (appData.doses || []).filter(function(d) { return d.date === ds2; });

        var chipsHtml = dd.map(function(d) {
            var p  = appData.peptides.find(function(x) { return x.id === d.peptideId; });
            var bg = p ? getPeptideColor(p) : 'var(--accent)';
            return '<div class="cal-dose" style="background:' + bg + ';" title="' + escapeHtml(d.peptideName) + ': ' + d.amount + ' ' + (d.unit||'mcg') + '">' + escapeHtml(d.peptideName) + '</div>';
        }).join('');

        var MAX_DOTS = 3;
        var dotsHtml = '';
        if (dd.length) {
            var dotSpans = dd.slice(0, MAX_DOTS).map(function(d) {
                var p  = appData.peptides.find(function(x) { return x.id === d.peptideId; });
                var bg = p ? getPeptideColor(p) : 'var(--accent)';
                return '<span class="cal-dot" style="background:' + bg + ';" title="' + escapeHtml(d.peptideName) + '"></span>';
            }).join('');
            var badge = dd.length > MAX_DOTS ? '<span class="cal-dot-badge">+' + (dd.length - MAX_DOTS) + '</span>' : '';
            dotsHtml = '<div class="cal-dots-row">' + dotSpans + badge + '</div>';
        }

        html += '<div class="cal-day' + (isT ? ' today' : '') + '" onclick="openDayModal(\'' + ds2 + '\')">' +
                '<div class="cal-day-num">' + day + '</div>' + chipsHtml + dotsHtml + '</div>';
    }

    var rem = 42 - (fd + dim);
    for (var j = 1; j <= rem; j++) html += '<div class="cal-day other-month"><div class="cal-day-num">' + j + '</div></div>';
    grid.innerHTML = html;
}

// Dashboard calendar nav
document.getElementById('dash-prev-month').addEventListener('click', function() { dashCalDate.setMonth(dashCalDate.getMonth() - 1); renderDashCalendar(); });
document.getElementById('dash-next-month').addEventListener('click', function() { dashCalDate.setMonth(dashCalDate.getMonth() + 1); renderDashCalendar(); });
document.getElementById('dash-today-btn').addEventListener('click', function() { dashCalDate = new Date(); selectDashDay(localDateStr()); });

// ── SCHEDULING ────────────────────────────────────────────────
function isScheduledOn(p, dateStr) {
    if (!p.schedule || !p.schedule.mode) return false;
    var d   = new Date(dateStr + 'T00:00:00');
    var dow = d.getDay(); // 0=Sun
    if (p.schedule.mode === 'daily')  return true;
    if (p.schedule.mode === 'random') return true;
    if (p.schedule.mode === 'specificDays') {
        return Array.isArray(p.schedule.days) && p.schedule.days.indexOf(dow) > -1;
    }
    if (p.schedule.mode === 'everyN' && p.schedule.everyN) {
        var anchor = new Date(p.createdAt || p.schedule.anchorDate || dateStr);
        anchor.setHours(0,0,0,0);
        var diff = Math.floor((d - anchor) / 86400000);
        return diff >= 0 && diff % p.schedule.everyN === 0;
    }
    return false;
}

function getScheduleForDay(dateStr) {
    var items = [];
    (appData.peptides || []).forEach(function(p) {
        if (!isScheduledOn(p, dateStr)) return;
        var sched = p.schedule || {};
        var times = (sched.times && sched.times.length) ? sched.times : (sched.time ? [sched.time] : ['']);
        var dosesForDay = (appData.doses || []).filter(function(d) { return d.peptideId === p.id && d.date === dateStr; });
        times.forEach(function(t, idx) {
            var dose = dosesForDay[idx] || null;
            items.push({ peptide: p, time: t, taken: !!dose, doseId: dose ? dose.id : null, slotIndex: idx });
        });
    });
    return items;
}

function getTodaysSchedule() {
    return getScheduleForDay(localDateStr());
}

function buildScheduleUI(containerId, sched) {
    var container = document.getElementById(containerId);
    if (!container) return;
    sched = sched || { mode: '', days: [], everyN: 2, times: [] };
    // normalise legacy sched.time → sched.times
    var schedTimes = (sched.times && sched.times.length) ? sched.times : (sched.time ? [sched.time] : ['']);
    var timesCount = schedTimes.length || 1;

    var dayLabels = ['S','M','T','W','T','F','S'];
    var daysHtml = dayLabels.map(function(lbl, i) {
        var active = Array.isArray(sched.days) && sched.days.indexOf(i) > -1;
        return '<button type="button" class="day-chip' + (active ? ' active' : '') + '" data-day="' + i + '">' + lbl + '</button>';
    }).join('');

    var timeInputsHtml = schedTimes.map(function(t) {
        return '<input type="time" class="sched-time" value="' + (t || '') + '">';
    }).join('');

    var hasMode = !!sched.mode;
    container.innerHTML =
        '<div class="sched-row">' +
            '<select class="sched-mode">' +
                '<option value=""'              + (!sched.mode ? ' selected' : '') + '>No schedule</option>' +
                '<option value="daily"'         + (sched.mode === 'daily'        ? ' selected' : '') + '>Daily</option>' +
                '<option value="specificDays"'  + (sched.mode === 'specificDays' ? ' selected' : '') + '>Specific days</option>' +
                '<option value="everyN"'        + (sched.mode === 'everyN'       ? ' selected' : '') + '>Every N days</option>' +
                '<option value="random"'        + (sched.mode === 'random'       ? ' selected' : '') + '>Random / as needed</option>' +
            '</select>' +
        '</div>' +
        '<div class="sched-days-row" style="display:' + (sched.mode === 'specificDays' ? 'flex' : 'none') + ';">' + daysHtml + '</div>' +
        '<div class="sched-everyn-row" style="display:' + (sched.mode === 'everyN' ? 'flex' : 'none') + ';">' +
            '<span style="color:var(--text-secondary);font-size:0.85rem;">Every</span>' +
            '<input type="number" class="sched-everyn" min="2" max="90" value="' + (sched.everyN || 2) + '" style="width:58px;">' +
            '<span style="color:var(--text-secondary);font-size:0.85rem;">days</span>' +
        '</div>' +
        '<div class="sched-timescount-row" style="display:' + (hasMode ? 'flex' : 'none') + ';">' +
            '<span style="color:var(--text-secondary);font-size:0.85rem;">Times per day</span>' +
            '<select class="sched-timescount" style="width:auto;padding:4px 8px;">' +
                [1,2,3,4].map(function(n) { return '<option value="' + n + '"' + (timesCount === n ? ' selected' : '') + '>' + n + 'x</option>'; }).join('') +
            '</select>' +
        '</div>' +
        '<div class="sched-times-inputs" style="display:' + (hasMode ? 'flex' : 'none') + ';">' + timeInputsHtml + '</div>';

    var modeEl      = container.querySelector('.sched-mode');
    var daysRow     = container.querySelector('.sched-days-row');
    var enRow       = container.querySelector('.sched-everyn-row');
    var tcRow       = container.querySelector('.sched-timescount-row');
    var timesInputs = container.querySelector('.sched-times-inputs');

    function syncTimeInputs() {
        var n = parseInt(container.querySelector('.sched-timescount').value) || 1;
        var existing = Array.from(timesInputs.querySelectorAll('.sched-time')).map(function(el) { return el.value; });
        timesInputs.innerHTML = '';
        for (var i = 0; i < n; i++) {
            var inp = document.createElement('input');
            inp.type = 'time'; inp.className = 'sched-time';
            inp.value = existing[i] || '';
            timesInputs.appendChild(inp);
        }
    }

    modeEl.addEventListener('change', function() {
        var v = this.value;
        daysRow.style.display = v === 'specificDays' ? 'flex' : 'none';
        enRow.style.display   = v === 'everyN'       ? 'flex' : 'none';
        tcRow.style.display   = v ? 'flex' : 'none';
        timesInputs.style.display = v ? 'flex' : 'none';
        if (!v) timesInputs.innerHTML = '';
        else if (!timesInputs.querySelector('.sched-time')) syncTimeInputs();
    });
    container.querySelector('.sched-timescount').addEventListener('change', syncTimeInputs);
    container.querySelectorAll('.day-chip').forEach(function(chip) {
        chip.addEventListener('click', function() { chip.classList.toggle('active'); });
    });
}

function readScheduleUI(containerId) {
    var container = document.getElementById(containerId);
    if (!container) return null;
    var modeEl = container.querySelector('.sched-mode');
    if (!modeEl || !modeEl.value) return null;
    var days = [];
    container.querySelectorAll('.day-chip.active').forEach(function(c) { days.push(parseInt(c.dataset.day)); });
    var enEl = container.querySelector('.sched-everyn');
    var times = Array.from(container.querySelectorAll('.sched-time')).map(function(el) { return el.value || ''; });
    return {
        mode:   modeEl.value,
        days:   days,
        everyN: enEl ? (parseInt(enEl.value) || 2) : 2,
        times:  times,
        time:   times[0] || ''
    };
}

// ── DASHBOARD ─────────────────────────────────────────────────
var dashCalDate    = new Date();
var selectedDashDate = null;

function updateGreeting() {
    var h = new Date().getHours();
    var txt = h < 12 ? 'Good morning ☀️' : h < 17 ? 'Good afternoon 🌤️' : 'Good evening 🌙';
    var el = document.getElementById('dash-greeting-text');
    if (el) el.textContent = txt;
    var de = document.getElementById('dash-today-date');
    if (de) de.textContent = new Date().toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' });
}

function renderTodaySchedule() {
    var container = document.getElementById('dash-today-list');
    if (!container) return;
    var todayStr = localDateStr();
    var scheduled = getTodaysSchedule();
    if (!scheduled.length) {
        container.innerHTML = '<p style="color:var(--text-secondary);font-size:0.88rem;padding:8px 0;">No doses scheduled today. Add a schedule via Supply → Edit.</p>';
        return;
    }
    container.innerHTML = scheduled.map(function(item) {
        var p    = item.peptide;
        var du   = dispUnit(p);
        var dAmt = dispAmt(p.dailyDose, p);
        var col  = getPeptideColor(p);
        var isRandom  = p.schedule && p.schedule.mode === 'random';
        var times = (p.schedule && p.schedule.times && p.schedule.times.length > 1);
        var timeHint = isRandom ? ' · as needed' : (item.time ? ' · ' + item.time : '');
        var slotLabel = times ? (item.slotIndex === 0 ? ' (AM)' : item.slotIndex === 1 ? ' (PM)' : ' #' + (item.slotIndex + 1)) : '';
        var ri = calcReconInfo(p);
        var unitsHint = (ri && p.dailyDose) ? '<span style="color:' + col + ';font-weight:700;">' + ri.units.toFixed(1) + ' units</span> · ' : '';
        return '<div class="dash-dose-row">' +
            '<span class="color-dot" style="background:' + col + ';width:10px;height:10px;flex-shrink:0;"></span>' +
            '<div class="dash-dose-info">' +
                '<span class="dash-dose-name">' + escapeHtml(p.name) + escapeHtml(slotLabel) + '</span>' +
                '<span class="dash-dose-detail">' + unitsHint + (dAmt || '—') + ' ' + du + timeHint + '</span>' +
            '</div>' +
            (item.taken
                ? '<button class="dash-take-btn dash-taken" onclick="undoQuickLog(\'' + item.doseId + '\')">✓ Taken</button>'
                : '<button class="dash-take-btn" style="border-color:' + col + ';color:' + col + ';" onclick="showSitePickerModal(\'' + p.id + '\',\'' + (item.time || '') + '\')">Take</button>'
            ) +
        '</div>';
    }).join('');
}

function showSitePickerModal(peptideId, scheduledTime) {
    var p = (appData.peptides || []).find(function(x) { return x.id === peptideId; });
    if (!p) return;
    sitePickerPeptideId    = peptideId;
    sitePickerTime         = scheduledTime;
    sitePickerSelectedSite = null;
    var title = document.getElementById('site-picker-title');
    if (title) title.textContent = '💉 ' + p.name + ' — Choose Site';
    var lbl = document.getElementById('site-picker-selected-display');
    if (lbl) lbl.textContent = 'Tap a site on the diagram';
    var btn = document.getElementById('site-picker-log-btn');
    if (btn) btn.disabled = true;
    document.getElementById('site-picker-modal').classList.add('active');
    renderSiteRotation('site-picker-grid', 'selectSiteForModal');
}

async function confirmSitePickerLog() {
    closeModal('site-picker-modal');
    await quickLogDose(sitePickerPeptideId, sitePickerTime, sitePickerSelectedSite);
}

async function quickLogDose(peptideId, scheduledTime, site) {
    var p = (appData.peptides || []).find(function(x) { return x.id === peptideId; });
    if (!p) return;
    var now      = new Date();
    var todayStr = localDateStr(now);
    var timeStr  = scheduledTime || (String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0'));
    var du       = dispUnit(p);
    var dAmt     = dispAmt(p.dailyDose, p) || 0;
    if (!dAmt) { alert('Set a dose amount for ' + p.name + ' before quick-logging.'); return; }
    if (p.reconstituted) {
        var mcgAmt    = toMcg(dAmt, p);
        var remaining = (p.reconstituted.remainingUnits !== undefined)
            ? p.reconstituted.remainingUnits
            : (isIU(p) ? p.mgPerVial : p.mgPerVial * 1000);
        p.reconstituted.remainingUnits = Math.max(0, remaining - mcgAmt);
        if (remaining - mcgAmt <= 0) { p.reconstituted = null; p.vialsOnHand = Math.max(0, p.vialsOnHand - 1); }
        try { await dbPut('peptides', p); } catch(e) {}
    }
    var hasActive = (appData.cycles || []).some(function(c) { return c.peptideId === p.id && c.status === 'active'; });
    if (!hasActive && p.cycleDuration) startCycle(p.id, todayStr);
    var dose = {
        id: genId(), peptideId: p.id, peptideName: p.name,
        date: todayStr, time: timeStr,
        amount: dAmt, unit: du,
        site: site || null, notes: null, loggedAt: now.toISOString()
    };
    try { await dbPut('doses', dose); appData.doses.push(dose); } catch(e) { alert('Save failed: ' + e.message); return; }
    renderTodaySchedule();
    renderDashCalendar();
    renderDashDayDetail(selectedDashDate || todayStr);
    renderHistory();
    renderSupply();
    renderLogDosePlate();
    checkLowStockNotification();
}

async function undoQuickLog(doseId) {
    if (!confirm('Remove this logged dose?')) return;
    appData.doses = appData.doses.filter(function(d) { return d.id !== doseId; });
    try { await dbDelete('doses', doseId); } catch(e) { alert('Failed: ' + e.message); return; }
    renderTodaySchedule();
    renderDashCalendar();
    renderDashDayDetail(selectedDashDate || localDateStr());
    renderHistory();
}

function logAdhocDose(dateStr) {
    var d = dateStr || localDateStr();
    document.getElementById('dose-date').value = d;
    switchTab('tracking');
}

function renderDashCalendar() {
    var grid   = document.getElementById('dash-calendar-grid');
    var header = document.getElementById('dash-month-year');
    if (!grid || !header) return;
    var year  = dashCalDate.getFullYear(), month = dashCalDate.getMonth();
    header.textContent = new Date(year, month).toLocaleDateString('en-US', { month:'long', year:'numeric' });
    var fd    = new Date(year, month, 1).getDay();
    var dim   = new Date(year, month + 1, 0).getDate();
    var pl    = new Date(year, month, 0).getDate();
    var today = new Date(); today.setHours(0,0,0,0);
    var selStr = selectedDashDate || localDateStr(today);
    var html = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
        .map(function(d) { return '<div class="cal-day-header">' + d + '</div>'; }).join('');
    for (var i = fd - 1; i >= 0; i--) html += '<div class="cal-day other-month"><div class="cal-day-num">' + (pl - i) + '</div></div>';
    for (var day = 1; day <= dim; day++) {
        var ds   = year + '-' + String(month + 1).padStart(2,'0') + '-' + String(day).padStart(2,'0');
        var ds2  = ds;
        var isT  = new Date(year, month, day).getTime() === today.getTime();
        var isSel = ds === selStr;
        var dd   = (appData.doses || []).filter(function(d) { return d.date === ds2; });
        var chips = dd.map(function(d) {
            var p  = (appData.peptides || []).find(function(x) { return x.id === d.peptideId; });
            var bg = p ? getPeptideColor(p) : 'var(--accent)';
            return '<div class="cal-dose" style="background:' + bg + ';">' + escapeHtml(d.peptideName) + '</div>';
        }).join('');
        var dots = '';
        if (dd.length) {
            var dotSpans = dd.slice(0, 3).map(function(d) {
                var p  = (appData.peptides || []).find(function(x) { return x.id === d.peptideId; });
                var bg = p ? getPeptideColor(p) : 'var(--accent)';
                return '<span class="cal-dot" style="background:' + bg + ';"></span>';
            }).join('');
            var badge = dd.length > 3 ? '<span class="cal-dot-badge">+' + (dd.length - 3) + '</span>' : '';
            dots = '<div class="cal-dots-row">' + dotSpans + badge + '</div>';
        }
        html += '<div class="cal-day' + (isT ? ' today' : '') + (isSel ? ' selected-day' : '') + '" onclick="selectDashDay(\'' + ds2 + '\')">' +
                '<div class="cal-day-num">' + day + '</div>' + chips + dots + '</div>';
    }
    var rem = 42 - (fd + dim);
    for (var j = 1; j <= rem; j++) html += '<div class="cal-day other-month"><div class="cal-day-num">' + j + '</div></div>';
    grid.innerHTML = html;
}

function selectDashDay(dateStr) {
    selectedDashDate = dateStr;
    renderDashCalendar();
    renderDashDayDetail(dateStr);
}

function renderDashDayDetail(dateStr) {
    var titleEl = document.getElementById('dash-day-detail-title');
    var listEl  = document.getElementById('dash-day-detail-list');
    var logBtn  = document.getElementById('dash-log-for-day-btn');
    if (!titleEl || !listEl) return;

    var d = new Date(dateStr + 'T00:00:00');
    titleEl.textContent = d.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' });

    var todayStr    = localDateStr();
    var isToday     = dateStr === todayStr;
    var scheduled   = getScheduleForDay(dateStr);
    var loggedDoses = (appData.doses || []).filter(function(x) { return x.date === dateStr; });

    var html = '';

    if (scheduled.length) {
        html += '<div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-secondary);margin-bottom:8px;">Scheduled</div>';
        html += scheduled.map(function(item) {
            var p    = item.peptide;
            var du   = dispUnit(p);
            var dAmt = dispAmt(p.dailyDose, p);
            var col  = getPeptideColor(p);
            var isRandom2  = p.schedule && p.schedule.mode === 'random';
            var timeHint = isRandom2 ? ' · as needed' : (item.time ? ' · ' + item.time : '');
            var multiTimes = p.schedule && p.schedule.times && p.schedule.times.length > 1;
            var slotLabel  = multiTimes ? (item.slotIndex === 0 ? ' (AM)' : item.slotIndex === 1 ? ' (PM)' : ' #' + (item.slotIndex + 1)) : '';
            var ri2 = calcReconInfo(p);
            var unitsHint2 = (ri2 && p.dailyDose) ? '<span style="color:' + col + ';font-weight:700;">' + ri2.units.toFixed(1) + ' units</span> · ' : '';
            var actionHtml = isToday
                ? (item.taken
                    ? '<button class="dash-take-btn dash-taken" onclick="undoQuickLog(\'' + item.doseId + '\')">✓ Taken</button>'
                    : '<button class="dash-take-btn" style="border-color:' + col + ';color:' + col + ';" onclick="showSitePickerModal(\'' + p.id + '\',\'' + (item.time || '') + '\')">Take</button>')
                : (item.taken
                    ? '<span style="color:var(--success);font-size:0.8rem;font-weight:600;">✓</span>'
                    : '<span style="color:var(--text-secondary);font-size:0.8rem;">—</span>');
            return '<div class="dash-dose-row">' +
                '<span class="color-dot" style="background:' + col + ';width:10px;height:10px;flex-shrink:0;"></span>' +
                '<div class="dash-dose-info">' +
                    '<span class="dash-dose-name">' + escapeHtml(p.name) + escapeHtml(slotLabel) + '</span>' +
                    '<span class="dash-dose-detail">' + unitsHint2 + (dAmt || '—') + ' ' + du + timeHint + '</span>' +
                '</div>' + actionHtml + '</div>';
        }).join('');
        html += '<div style="margin-bottom:14px;"></div>';
    }

    if (loggedDoses.length) {
        html += '<div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-secondary);margin-bottom:8px;">Logged</div>';
        html += loggedDoses.map(function(dose) {
            var p  = (appData.peptides || []).find(function(x) { return x.id === dose.peptideId; });
            var bg = p ? getPeptideColor(p) : 'var(--accent)';
            var meta = [];
            if (dose.time)  meta.push(dose.time);
            if (dose.site)  meta.push(escapeHtml(dose.site));
            if (dose.notes) meta.push('<em>' + escapeHtml(dose.notes) + '</em>');
            return '<div style="display:flex;align-items:flex-start;gap:10px;padding:9px 0;border-bottom:1px solid var(--border);">' +
                '<span style="width:8px;height:8px;border-radius:50%;background:' + bg + ';flex-shrink:0;margin-top:5px;display:inline-block;"></span>' +
                '<div style="flex:1;min-width:0;">' +
                    '<div style="font-weight:600;font-size:0.9rem;">' + escapeHtml(dose.peptideName) + '</div>' +
                    '<div style="font-size:0.78rem;color:var(--text-secondary);">' + dose.amount + ' ' + (dose.unit || 'mcg') +
                    (meta.length ? ' · ' + meta.join(' · ') : '') + '</div>' +
                '</div>' +
                '<div style="display:flex;gap:6px;flex-shrink:0;">' +
                '<button class="btn-ghost btn-small" onclick="openEditDoseModal(\'' + dose.id + '\')" title="Edit">✏️</button>' +
                '<button class="btn-danger btn-small" onclick="deleteDose(\'' + dose.id + '\')" title="Delete">🗑️</button>' +
                '</div>' +
            '</div>';
        }).join('');
    }

    if (!scheduled.length && !loggedDoses.length) {
        html = '<p style="color:var(--text-secondary);font-size:0.88rem;padding:8px 0;">No doses scheduled or logged this day.</p>';
    }

    listEl.innerHTML = html;
    if (logBtn) logBtn.onclick = function() { logAdhocDose(dateStr); };
}

function renderDashboard() {
    updateGreeting();
    renderTodaySchedule();
    renderDashCalendar();
    renderDashDayDetail(selectedDashDate || localDateStr());
}

function startCycleManual(peptideId) {
    var todayStr = localDateStr();
    startCycle(peptideId, todayStr);
    renderSupply();
    renderCycles();
}

// legacy stub — no longer called but left to avoid reference errors
function openDayModal(dateStr) { selectDashDay(dateStr); }

// ── PROTOCOL TEMPLATES ────────────────────────────────────────
function openCreateProtocolModal() {
    document.getElementById('proto-name').value = '';
    var list = document.getElementById('proto-peptide-list');
    if (!appData.peptides.length) {
        list.innerHTML = '<p style="color:var(--text-secondary);">No peptides in supply yet.</p>';
        document.getElementById('protocol-modal').classList.add('active');
        return;
    }
    list.innerHTML = appData.peptides.map(function(p) {
        return '<label style="display:flex;align-items:center;gap:10px;padding:10px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px;cursor:pointer;">' +
               '<input type="checkbox" value="' + p.id + '" style="width:16px;height:16px;accent-color:var(--accent);">' +
               '<span class="color-dot" style="background:' + (p.color || 'var(--accent)') + '"></span>' +
               '<span>' + escapeHtml(p.name) + ' — ' + p.mgPerVial + p.unit + '/vial, ' + p.dailyDose + ' ' + doseUnit(p) + ' × ' + p.dosesPerWeek + '/wk</span></label>';
    }).join('');
    document.getElementById('protocol-modal').classList.add('active');
}

async function saveProtocolTemplate() {
    var name = document.getElementById('proto-name').value.trim();
    if (!name) { alert('Enter a template name.'); return; }
    var checked = Array.from(document.getElementById('proto-peptide-list').querySelectorAll('input:checked')).map(function(c) { return c.value; });
    if (!checked.length) { alert('Select at least one peptide.'); return; }

    var peptides = checked.map(function(id) {
        var p = appData.peptides.find(function(x) { return x.id === id; });
        return { name:p.name, mgPerVial:p.mgPerVial, unit:p.unit, vialsPerKit:p.vialsPerKit,
                 dailyDose:p.dailyDose, dosesPerWeek:p.dosesPerWeek, cycleDuration:p.cycleDuration,
                 color:p.color };
    });

    var proto = { id: genId(), name: name, peptides: peptides, createdAt: new Date().toISOString() };
    try {
        await dbPut('protocols', proto);
        appData.protocols.push(proto);
    } catch(err) { alert('Save failed: ' + err.message); return; }
    renderProtocolTemplatesList();
    closeModal('protocol-modal');
}

function renderProtocolTemplatesList() {
    var container = document.getElementById('protocol-templates-list');
    if (!appData.protocols.length) {
        container.innerHTML = '<p style="color:var(--text-secondary);font-size:0.88rem;">No protocol templates yet.</p>';
        return;
    }
    container.innerHTML = appData.protocols.map(function(proto) {
        return '<div class="template-card">' +
               '<div><strong>' + escapeHtml(proto.name) + '</strong>' +
               '<div style="font-size:0.82rem;color:var(--text-secondary);margin-top:3px;">' +
               proto.peptides.map(function(p) { return escapeHtml(p.name); }).join(', ') + '</div></div>' +
               '<div style="display:flex;gap:8px;">' +
               '<button class="btn-primary btn-small" onclick="applyProtocolTemplate(\'' + proto.id + '\')">Apply to Supply</button>' +
               '<button class="btn-danger btn-small" onclick="deleteProtocol(\'' + proto.id + '\')">🗑️</button>' +
               '</div></div>';
    }).join('');
}

async function applyProtocolTemplate(protoId) {
    var proto = appData.protocols.find(function(x) { return x.id === protoId; });
    if (!proto || !confirm('Add all peptides from "' + proto.name + '" to your supply?')) return;
    for (var i = 0; i < proto.peptides.length; i++) {
        var pp = proto.peptides[i];
        var p  = {
            id: genId(), name: pp.name, mgPerVial: pp.mgPerVial, unit: pp.unit || 'mg',
            vialsPerKit: pp.vialsPerKit, vialsOnHand: pp.vialsPerKit,
            dailyDose: pp.dailyDose || 0, dosesPerWeek: pp.dosesPerWeek || 7,
            cycleDuration: pp.cycleDuration || 0,
            reorderThreshold: 5, color: pp.color || PEPTIDE_COLORS[0],
            reconstituted: null, createdAt: new Date().toISOString()
        };
        try { await dbPut('peptides', p); appData.peptides.push(p); } catch(err) { alert('Save failed: ' + err.message); }
    }
    renderSupply();
    updateDoseDropdown();
    alert('Protocol applied! ' + proto.peptides.length + ' peptides added.');
}

async function deleteProtocol(id) {
    if (!confirm('Delete this protocol template?')) return;
    appData.protocols = appData.protocols.filter(function(x) { return x.id !== id; });
    try { await dbDelete('protocols', id); } catch(err) { alert('Delete failed: ' + err.message); }
    renderProtocolTemplatesList();
}

// ── DOSE EDITING ──────────────────────────────────────────────
function openEditDoseModal(doseId) {
    var dose = (appData.doses || []).find(function(d) { return d.id === doseId; });
    if (!dose) return;
    document.getElementById('edit-dose-id').value     = doseId;
    document.getElementById('edit-dose-date').value   = dose.date  || '';
    document.getElementById('edit-dose-time').value   = dose.time  || '';
    document.getElementById('edit-dose-amount').value = dose.amount || '';
    document.getElementById('edit-dose-site').value   = dose.site  || '';
    document.getElementById('edit-dose-notes').value  = dose.notes || '';
    var p = (appData.peptides || []).find(function(x) { return x.id === dose.peptideId; });
    var unit = p ? dispUnit(p) : (dose.unit || 'mcg');
    document.getElementById('edit-dose-amount-label').textContent = 'Dose (' + unit + ') *';
    document.getElementById('edit-dose-modal').classList.add('active');
}

document.getElementById('edit-dose-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    var doseId = document.getElementById('edit-dose-id').value;
    var idx = (appData.doses || []).findIndex(function(d) { return d.id === doseId; });
    if (idx === -1) return;
    var dose = Object.assign({}, appData.doses[idx]);
    dose.date   = document.getElementById('edit-dose-date').value;
    dose.time   = document.getElementById('edit-dose-time').value  || null;
    dose.amount = parseFloat(document.getElementById('edit-dose-amount').value);
    dose.site   = document.getElementById('edit-dose-site').value  || null;
    dose.notes  = document.getElementById('edit-dose-notes').value.trim() || null;
    try { await dbPut('doses', dose); } catch(err) { alert('Save failed: ' + err.message); return; }
    appData.doses[idx] = dose;
    closeModal('edit-dose-modal');
    renderHistory();
    renderDashCalendar();
    renderDashDayDetail(selectedDashDate || localDateStr());
    renderTodaySchedule();
    renderSupply();
    renderLogDosePlate();
});

// ── MODALS ────────────────────────────────────────────────────
function closeModal(id) { document.getElementById(id).classList.remove('active'); }
document.querySelectorAll('.modal-overlay').forEach(function(m) {
    m.addEventListener('click', function(e) { if (e.target === this) this.classList.remove('active'); });
});

// ── BACKUP & RESTORE ──────────────────────────────────────────
async function backupData() {
    var backup = {
        peptides: appData.peptides, doses: appData.doses, cycles: appData.cycles,
        protocols: appData.protocols, settings: appData.settings,
        exportedAt: new Date().toISOString(), version: 2
    };
    var blob = new Blob([JSON.stringify(backup, null, 2)], { type:'application/json' });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement('a');
    a.href = url; a.download = 'peptide-tracker-backup-' + localDateStr() + '.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

async function restoreData(event) {
    var file = event.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = async function(e) {
        try {
            var backup = JSON.parse(e.target.result);
            if (!backup.peptides && !backup.doses) { alert('Invalid backup file.'); return; }
            if (!confirm('Restore this backup? All current data will be replaced.')) return;

            for (var i = 0; i < STORES.length; i++) await dbClear(STORES[i]);

            appData.peptides  = backup.peptides  || [];
            appData.doses     = backup.doses     || [];
            appData.cycles    = backup.cycles    || [];
            appData.protocols = backup.protocols || [];
            if (backup.settings) appData.settings = backup.settings;

            for (var i = 0; i < appData.peptides.length;  i++) await dbPut('peptides',  appData.peptides[i]);
            for (var i = 0; i < appData.doses.length;     i++) await dbPut('doses',     appData.doses[i]);
            for (var i = 0; i < appData.cycles.length;    i++) await dbPut('cycles',    appData.cycles[i]);
            for (var i = 0; i < appData.protocols.length; i++) await dbPut('protocols', appData.protocols[i]);
            if (backup.settings) await dbPut('settings', Object.assign({ id:'app_settings' }, backup.settings));

            applyTheme();
            renderAll();
            renderProtocolTemplatesList();
            checkLowStockNotification();
            alert('Data restored successfully!');
        } catch(err) { alert('Restore failed: ' + err.message); }
    };
    reader.readAsText(file);
    event.target.value = '';
}

async function clearAllData() {
    if (!confirm('Delete ALL data? This cannot be undone.')) return;
    if (!confirm('Are you absolutely sure?')) return;
    for (var i = 0; i < STORES.length; i++) await dbClear(STORES[i]);
    appData = { peptides:[], doses:[], cycles:[], protocols:[], settings:{ theme:'dark' } };
    renderAll();
    checkLowStockNotification();
    alert('All data cleared.');
}

// ── RENDER ALL ────────────────────────────────────────────────
function renderAll() {
    renderSupply();
    updateDoseDropdown();
    renderHistory();
    renderDashboard();
    renderLogDosePlate();
    renderProtocolTemplatesList();
}

// ── INIT ──────────────────────────────────────────────────────
async function init() {
    try {
        // Apply Simple mode defaults on first load
        document.querySelectorAll('#peptide-form .full-mode-only').forEach(function(el) { el.style.display = 'none'; });

        await loadAllData();
        initPeptideDropdown();
        renderAll();
        applyTheme();
        checkLowStockNotification();
        if (navigator.storage && navigator.storage.persist) {
            navigator.storage.persist().catch(function() {});
        }
        console.log('[PeptideTracker] Ready — ' + appData.peptides.length + ' peptides, ' + appData.doses.length + ' doses');
    } catch(e) {
        console.error('[Init] Error:', e);
        document.body.innerHTML = '<div style="padding:40px;text-align:center;font-family:sans-serif;color:#ef4444;">' +
            '<h2>Failed to initialize</h2><p>' + e.message + '</p>' +
            '<p>Try Chrome, Firefox, or Safari on iOS 15.4+.</p></div>';
    }
}

init();
