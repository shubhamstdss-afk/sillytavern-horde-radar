import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

// --- 1. Core data and cache initialization ---
const EXT_ID = 'hordeRadarApp';
if (!extension_settings[EXT_ID]) {
    extension_settings[EXT_ID] = {};
}

let globalModelsData = [];

const BASE_PARAMS = {
    sdxl: { width: 832, height: 1216, sampler: "k_euler_a", steps: 30, scale: 7, clip_skip: 2, karras: false },
    sd15: { width: 512, height: 768, sampler: "k_dpmpp_2m", steps: 25, scale: 7, clip_skip: 2, karras: true }
};

// --- Advanced model scoring (excludes unreliable queued data) ---
function calculateModelScore(m) {
    const perf = m.performance || 0;
    const count = m.count || 0;
    const eta = m.eta || 0;
    const jobs = m.jobs || 0;

    // 1. Smooth performance
    const smoothPerf = Math.log10(perf + 10);

    // 2. Detect idle workers and apply availability bonus
    const idleWorkers = Math.max(0, count - jobs);
    const availabilityBonus = idleWorkers > 0 ? Math.sqrt(count) * 1.5 : Math.sqrt(count);

    // 3. Estimate queue pressure using jobs only
    const realQueuePressure = jobs / (count + 0.1);

    // 4. Apply a non-linear ETA penalty
    const penaltyETA = Math.pow(eta + 1, 1.2);

    return (smoothPerf * availabilityBonus * 100) / (penaltyETA + realQueuePressure * 0.5);
}

// --- 2. Smart model classification and parameter selection ---
function analyzeModel(mName, baseline, style, rawDesc) {
    const n = (mName || "").toLowerCase();
    const b = (baseline || "").toLowerCase();
    const s = (style || "").toLowerCase();
    const d = (rawDesc || "").toLowerCase();

    // Keep these internal preset names unchanged so existing
    // SillyTavern style presets continue to match.
    let presetStyle = "SD 1.5 (纯写实/真人照)";
    let params = BASE_PARAMS.sd15;

    if (b.includes("pony") || n.includes("pony") || s.includes("pony")) {
        presetStyle = "Pony (动漫/R-18)";
        params = BASE_PARAMS.sdxl;
    } else if (b.includes("xl") || b.includes("sdxl")) {
        presetStyle = "SDXL (写实/通用)";
        params = BASE_PARAMS.sdxl;
    } else if (
        s.includes("anime") ||
        s.includes("2.5d") ||
        d.includes("anime") ||
        d.includes("2.5d") ||
        n.includes("mix") ||
        n.includes("rev animated")
    ) {
        presetStyle = "SD 1.5 (动漫/韩漫2.5D)";
    }

    let shortTags = [];

    if (d.includes("anime")) shortTags.push("Anime");
    if (d.includes("realistic") || d.includes("photoreal")) shortTags.push("Photorealistic");
    if (d.includes("2.5d") || d.includes("blend")) shortTags.push("2.5D");
    if (d.includes("hands")) shortTags.push("Hand-fix");
    if (d.includes("nsfw")) shortTags.push("NSFW-friendly");

    const shortDesc = shortTags.length > 0
        ? `Style tags: ${shortTags.join(", ")}`
        : "Mixed style";

    return { presetStyle, params, shortDesc };
}

// Convert internal preset identifiers to English for display only.
function displayPresetStyle(style) {
    const labels = {
        "Pony (动漫/R-18)": "Pony (Anime / R-18)",
        "SDXL (写实/通用)": "SDXL (Realistic / General)",
        "SD 1.5 (动漫/韩漫2.5D)": "SD 1.5 (Anime / Manhwa 2.5D)",
        "SD 1.5 (纯写实/真人照)": "SD 1.5 (Photorealistic)"
    };

    return labels[style] || style;
}

// --- 3. Build and inject the UI ---
jQuery(async () => {
    const uiHtml = `
        <div class="extension-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>AI Horde Image Generation Radar</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>

                <div class="inline-drawer-content" style="padding: 15px; background: #121212; color: #eee; border-radius: 8px;">

                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; border-bottom: 1px solid #333; padding-bottom: 10px;">
                        <span id="horde-radar-status" style="font-size: 12px; color: #aaa;">Waiting for data...</span>
                        <button id="btn-horde-refresh" class="menu_button" style="margin: 0; font-weight: bold;">📡 Refresh Radar</button>
                    </div>

                    <div style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 15px;">
                        ${buildSelectRow("all", "🏆 Best Overall")}
                        ${buildSelectRow("pony", "🦄 Pony (Anime / R-18)")}
                        ${buildSelectRow("sdxl", "📸 SDXL (Realistic / General)")}
                        ${buildSelectRow("sd15_anime", "🌸 SD 1.5 (Anime / Manhwa)")}
                        ${buildSelectRow("sd15_real", "🎞️ SD 1.5 (Photorealistic)")}
                    </div>

                    <div id="horde-info-panel" style="display: none; background: #1e1e1e; border: 1px solid #444; border-radius: 8px; padding: 15px; font-size: 13px;">
                    </div>

                </div>
            </div>
        </div>
    `;

    $('#extensions_settings').append(uiHtml);

    // Bind events
    $('#btn-horde-refresh').on('click', fetchHordeData);

    $(document).on('click', '.btn-horde-sync', function () {
        syncToST($(this).data('target'));
    });

    $(document).on('click', '.btn-horde-info', function () {
        showInfoPanel($(this).data('target'));
    });

    // Bind direct-sync and single-model refresh buttons
    $(document).on('click', '.btn-horde-sync-direct', function () {
        executeSync($(this).data('model'));
    });

    $(document).on('click', '.btn-horde-refresh-single', function () {
        refreshSingleModel($(this));
    });

    fetchHordeData();
});

function buildSelectRow(id, label) {
    return `
        <div style="display: flex; gap: 8px; align-items: center;">
            <div style="width: 140px; font-size: 12px; font-weight: bold; color: #bb86fc; flex-shrink: 0;">${label}</div>

            <select id="horde-sel-${id}" style="flex: 1; background: #222; color: #eee; border: 1px solid #444; padding: 6px; border-radius: 4px;">
                <option value="">-- Waiting for scan --</option>
            </select>

            <button class="menu_button btn-horde-sync" data-target="${id}" title="Sync parameters" style="margin:0; padding: 6px 10px;">⚙️ Sync</button>

            <button class="menu_button btn-horde-info" data-target="${id}" title="View details" style="margin:0; padding: 6px 10px;">ℹ️ Details</button>
        </div>
    `;
}

// --- 4. Fetch model data ---
async function fetchHordeData() {
    $('#horde-radar-status').text('Connecting to AI Horde and GitHub...');
    $('#btn-horde-refresh').prop('disabled', true);

    try {
        const [statusRes, infoRes] = await Promise.all([
            fetch('https://aihorde.net/api/v2/status/models'),
            fetch('https://raw.githubusercontent.com/Haidra-Org/AI-Horde-image-model-reference/main/stable_diffusion.json')
        ]);

        const statusData = await statusRes.json();
        const infoDict = await infoRes.json();

        globalModelsData = [];

        statusData.forEach(m => {
            if (m.type === "image" && m.count > 0) {
                const info = infoDict[m.name] || {};
                const optimalScore = calculateModelScore(m);
                const analysis = analyzeModel(
                    m.name,
                    info.baseline,
                    info.style,
                    info.description
                );

                globalModelsData.push({
                    name: m.name,
                    workers: m.count,
                    performance: Math.round(m.performance),
                    eta: m.eta,
                    jobs: m.jobs,
                    score: optimalScore,
                    nsfw: info.nsfw === true,
                    baseline: info.baseline || "Unknown",
                    version: info.version || "Unknown",
                    style: info.style || "Mixed",
                    rawDesc: info.description || "",
                    showcases: info.showcases || [],
                    presetStyle: analysis.presetStyle,
                    shortDesc: analysis.shortDesc,
                    params: analysis.params
                });
            }
        });

        globalModelsData.sort((a, b) => b.score - a.score);

        populateDropdowns();

        $('#horde-radar-status').text(
            `✅ Loaded ${globalModelsData.length} models | ${new Date().toLocaleTimeString('en-US', { hour12: false })}`
        );

    } catch (error) {
        console.error('AI Horde Radar: Failed to fetch model data.', error);
        $('#horde-radar-status').text('❌ Failed to fetch data. Please try again.');
    } finally {
        $('#btn-horde-refresh').prop('disabled', false);
    }
}

function populateDropdowns() {
    const sels = {
        all: $('#horde-sel-all').empty().append('<option value="">-- Select a model --</option>'),
        pony: $('#horde-sel-pony').empty().append('<option value="">-- Select a model --</option>'),
        sdxl: $('#horde-sel-sdxl').empty().append('<option value="">-- Select a model --</option>'),
        sd15_anime: $('#horde-sel-sd15_anime').empty().append('<option value="">-- Select a model --</option>'),
        sd15_real: $('#horde-sel-sd15_real').empty().append('<option value="">-- Select a model --</option>')
    };

    globalModelsData.forEach(m => {
        const text = `${m.name} ${m.nsfw ? '🔞' : ''} (${m.workers} workers)`;
        const opt = `<option value="${m.name}">${text}</option>`;

        sels.all.append(opt);

        // Internal preset names are deliberately unchanged.
        if (m.presetStyle === "Pony (动漫/R-18)") {
            sels.pony.append(opt);
        } else if (m.presetStyle === "SDXL (写实/通用)") {
            sels.sdxl.append(opt);
        } else if (m.presetStyle === "SD 1.5 (动漫/韩漫2.5D)") {
            sels.sd15_anime.append(opt);
        } else if (m.presetStyle === "SD 1.5 (纯写实/真人照)") {
            sels.sd15_real.append(opt);
        }
    });
}

// --- 5. Model information panel ---
function showInfoPanel(targetId) {
    const selName = $(`#horde-sel-${targetId}`).val();

    if (!selName) {
        toastr.warning("Please select a model from the dropdown first.");
        return;
    }

    const m = globalModelsData.find(x => x.name === selName);

    if (!m) {
        toastr.error("The selected model could not be found. Refresh the radar and try again.");
        return;
    }

    const modelDesc = m.rawDesc || "No description provided by the model reference.";

    let imgHtml = '';

    if (m.showcases.length > 0) {
        m.showcases.forEach(url => {
            imgHtml += `<img src="${url}" alt="Model preview" style="width:100%; border-radius:6px; margin-top:10px;">`;
        });
    } else {
        imgHtml = `
            <div style="text-align:center; padding:10px; color:#666; border:1px dashed #444; margin-top:10px;">
                No official preview images available
            </div>
        `;
    }

    // Format performance
    const perfText = m.performance > 1000
        ? (m.performance / 1000).toFixed(1) + 'k'
        : m.performance;

    const etaColor = m.eta === 0 ? 'var(--success)' : 'var(--danger)';

    const html = `
        <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #444; padding-bottom: 8px; margin-bottom: 10px;">

            <div style="font-size: 16px; font-weight: bold; color: #bb86fc; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                ${m.name} ${m.nsfw ? '<span style="color:#ff5252">🔞</span>' : ''}
            </div>

            <div style="display: flex; gap: 6px; flex-shrink: 0;">
                <button class="menu_button btn-horde-refresh-single" data-model="${m.name}" style="margin: 0; padding: 6px 12px; font-weight: bold; border-radius: 6px;">🔄 Refresh</button>

                <button class="menu_button btn-horde-sync-direct" data-model="${m.name}" style="margin: 0; padding: 6px 12px; font-weight: bold; border-radius: 6px;">⚙️ Sync Now</button>
            </div>
        </div>

        <div style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 15px;">

            <div style="background:#000; padding:6px 8px; border-radius:4px;">
                🎯 Style: <span style="color:#eee">${displayPresetStyle(m.presetStyle)}</span>
            </div>

            <div style="background:#000; padding:6px 8px; border-radius:4px;">
                🏗️ Architecture: <span style="color:#eee">${m.baseline} (v${m.version})</span>
            </div>

            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">

                <div style="background:#000; padding:6px 8px; border-radius:4px;">
                    ⚡ Performance: <span id="info-val-perf" style="color:#ffb74d; font-weight:bold;">${perfText}</span>
                </div>

                <div style="background:#000; padding:6px 8px; border-radius:4px;">
                    💻 Workers: <span id="info-val-workers" style="color:var(--success); font-weight:bold;">${m.workers} workers</span>
                </div>

                <div style="background:#000; padding:6px 8px; border-radius:4px;">
                    ⚙️ Queue: <span id="info-val-jobs" style="color:#03dac6; font-weight:bold;">${m.jobs} jobs</span>
                </div>

                <div style="background:#000; padding:6px 8px; border-radius:4px;">
                    ⏱️ ETA: <span id="info-val-eta" style="color:${etaColor}; font-weight:bold;">${m.eta}s</span>
                </div>

            </div>

            <div style="background:#111; border: 1px solid #333; padding:8px; border-radius:4px; text-align: center;">
                🏆 Radar Score: <span id="info-val-score" style="color:#bb86fc; font-size:16px; font-weight:bold;">${Math.round(m.score)}</span>
            </div>

        </div>

        <div style="background:#2a2a2a; border-left:3px solid #03dac6; padding:8px 10px; margin-bottom:15px; border-radius: 0 4px 4px 0;">
            <div style="color:#fff; font-weight:bold; margin-bottom:4px;">Model Description:</div>
            <div style="color:#ccc; line-height: 1.5;">${modelDesc}</div>
        </div>

        <div style="font-weight:bold; color:#bb86fc;">🖼️ Official Preview Images:</div>
        ${imgHtml}
    `;

    $('#horde-info-panel').html(html).slideDown(200);
}

// --- 6. Refresh the live status of a single model ---
async function refreshSingleModel(btnObj) {
    const modelName = btnObj.data('model');

    if (!modelName) return;

    const originalText = btnObj.html();
    btnObj.html('⏳...').prop('disabled', true);

    try {
        const res = await fetch('https://aihorde.net/api/v2/status/models');

        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }

        const statusData = await res.json();
        const liveData = statusData.find(m => m.name === modelName);

        if (liveData) {
            const mInfo = globalModelsData.find(x => x.name === modelName);

            if (mInfo) {
                // Update in-memory data
                mInfo.workers = liveData.count;
                mInfo.performance = Math.round(liveData.performance);
                mInfo.eta = liveData.eta;
                mInfo.jobs = liveData.jobs;
                mInfo.score = calculateModelScore(liveData);

                // Update the UI in place
                const perfText = mInfo.performance > 1000
                    ? (mInfo.performance / 1000).toFixed(1) + 'k'
                    : mInfo.performance;

                const etaColor = mInfo.eta === 0 ? 'var(--success)' : 'var(--danger)';

                $('#info-val-perf').text(perfText);
                $('#info-val-workers').text(mInfo.workers + ' workers');
                $('#info-val-jobs').text(`${mInfo.jobs} jobs`);
                $('#info-val-eta').text(`${mInfo.eta}s`).css('color', etaColor);
                $('#info-val-score').text(Math.round(mInfo.score));

                // Keep the model dropdown counts up to date as well.
                const option = $(`#horde-sel-all option[value="${CSS.escape(modelName)}"]`);
                if (option.length) {
                    option.text(`${mInfo.name} ${mInfo.nsfw ? '🔞' : ''} (${mInfo.workers} workers)`);
                }

                toastr.success(`Live status updated for ${modelName}`);
            }
        } else {
            toastr.warning('This model may have no workers online right now.');
        }
    } catch (e) {
        console.error('AI Horde Radar: Failed to refresh live status.', e);
        toastr.error('Failed to refresh live status. Check your connection.');
    } finally {
        btnObj.html(originalText).prop('disabled', false);
    }
}

// --- 7. Full parameter synchronization ---
function syncToST(targetId) {
    const selName = $(`#horde-sel-${targetId}`).val();

    if (!selName) {
        toastr.warning("Please select a model from the dropdown to sync.");
        return;
    }

    executeSync(selName);
}

// Core sync logic, also callable directly by model name
function executeSync(selName) {
    const m = globalModelsData.find(x => x.name === selName);

    if (!m) {
        toastr.error("The selected model could not be found. Refresh the radar and try again.");
        return;
    }

    const sd = extension_settings.sd;

    sd.model = m.name;
    $('#sd_model').val(m.name).trigger('change');

    const p = m.params;

    sd.width = p.width;
    $('#sd_width').val(p.width).trigger('input');

    sd.height = p.height;
    $('#sd_height').val(p.height).trigger('input');

    sd.sampler = p.sampler;
    $('#sd_sampler').val(p.sampler).trigger('change');

    sd.steps = p.steps;
    $('#sd_steps').val(p.steps).trigger('input');

    sd.scale = p.scale;
    $('#sd_scale').val(p.scale).trigger('input');

    sd.clip_skip = p.clip_skip;
    $('#sd_clip_skip').val(p.clip_skip).trigger('input');

    sd.horde_karras = p.karras;
    $('#sd_horde_karras').prop('checked', p.karras).trigger('change');

    $('#sd_resolution').val(`${p.width}x${p.height}`).trigger('change');

    const targetStyle = m.presetStyle;
    const styleObj = sd.styles.find(s => s.name === targetStyle);

    if (styleObj) {
        sd.style = targetStyle;
        sd.prompt_prefix = styleObj.prefix;
        sd.negative_prompt = styleObj.negative;

        $('#sd_style').val(targetStyle).trigger('change');
        $('#sd_prompt_prefix').val(styleObj.prefix).trigger('input');
        $('#sd_negative_prompt').val(styleObj.negative).trigger('input');
    } else {
        toastr.error(
            `Could not find the style preset "${targetStyle}" in SillyTavern. Create it in the image-generation panel first.`,
            "Sync Warning"
        );
    }

    saveSettingsDebounced();

    toastr.success(
        `All parameters applied!\nModel: ${m.name}\nStyle: ${displayPresetStyle(targetStyle)}`,
        'AI Horde Sync',
        { timeOut: 3000 }
    );
}
