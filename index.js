import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

// AI Horde Radar — English UI, architecture-aware classification, safe syncing.
const EXT_ID = "hordeRadarApp";
if (!extension_settings[EXT_ID]) extension_settings[EXT_ID] = {};

let globalModelsData = [];
let selectedModelName = "";
let currentFamilyFilter = "all";
let currentSearch = "";

// Conservative defaults for architectures supported by this extension.
// Unknown families never receive guessed settings.
const BASE_PARAMS = {
    sdxl: {
        width: 832,
        height: 1216,
        sampler: "k_euler_a",
        steps: 30,
        scale: 7,
        clip_skip: 2,
        karras: false
    },
    sd15: {
        width: 512,
        height: 768,
        sampler: "k_dpmpp_2m",
        steps: 25,
        scale: 7,
        clip_skip: 2,
        karras: true
    }
};

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[char]);
}

function calculateModelScore(m) {
    const perf = Number(m.performance) || 0;
    const count = Number(m.count) || 0;
    const eta = Number(m.eta) || 0;
    const jobs = Number(m.jobs) || 0;

    const smoothPerf = Math.log10(perf + 10);
    const idleWorkers = Math.max(0, count - jobs);
    const availabilityBonus = idleWorkers > 0
        ? Math.sqrt(count) * 1.5
        : Math.sqrt(count);

    const realQueuePressure = jobs / (count + 0.1);
    const penaltyETA = Math.pow(eta + 1, 1.2);

    return (smoothPerf * availabilityBonus * 100)
        / (penaltyETA + realQueuePressure * 0.5);
}

// Classify using the model reference's baseline first.
// Unknown or unsupported architectures receive no automatic parameters.
function classifyModel(name, info = {}) {
    const modelName = String(name || "").toLowerCase();
    const baseline = String(info.baseline || "")
        .toLowerCase()
        .replace(/[_-]+/g, " ");
    const style = String(info.style || "").toLowerCase();
    const desc = String(info.description || "").toLowerCase();
    const tags = Array.isArray(info.tags)
        ? info.tags.join(" ").toLowerCase()
        : "";

    const text = `${modelName} ${baseline} ${style} ${desc} ${tags}`;

    if (
        baseline.includes("pony") ||
        modelName.includes("pony") ||
        style.includes("pony")
    ) {
        return {
            family: "pony",
            familyLabel: "Pony (SDXL-based)",
            params: BASE_PARAMS.sdxl
        };
    }

    if (
        baseline.includes("stable diffusion xl") ||
        baseline.includes("sdxl") ||
        baseline.trim() === "xl" ||
        modelName.includes("sdxl")
    ) {
        return {
            family: "sdxl",
            familyLabel: "SDXL",
            params: BASE_PARAMS.sdxl
        };
    }

    const isSD15 =
        baseline.includes("stable diffusion 1") ||
        baseline.includes("sd 1.5") ||
        baseline.includes("sd15") ||
        baseline.trim() === "sd1";

    if (isSD15) {
        const anime = /anime|manga|manhwa|2\.5d|animated|waifu/.test(text);

        return {
            family: anime ? "sd15_anime" : "sd15_real",
            familyLabel: anime
                ? "SD 1.5 · Anime / 2.5D"
                : "SD 1.5 · General / Realistic",
            params: BASE_PARAMS.sd15
        };
    }

    // Flux, Qwen Image, SD 2.x and unknown families remain discoverable.
    // We deliberately do not assume their sampler, resolution or other settings.
    let label = "Other / Unclassified";

    if (text.includes("flux")) {
        label = "Flux · settings not configured";
    } else if (text.includes("qwen")) {
        label = "Qwen Image · settings not configured";
    } else if (
        baseline.includes("stable diffusion 2") ||
        baseline.includes("sd 2")
    ) {
        label = "SD 2.x · settings not configured";
    }

    return {
        family: "other",
        familyLabel: label,
        params: null
    };
}

function getStyleCandidates(model) {
    const english = {
        pony: [
            "Pony (Anime / R-18)",
            "Pony"
        ],
        sdxl: [
            "SDXL (Realistic / General)",
            "SDXL"
        ],
        sd15_anime: [
            "SD 1.5 (Anime / 2.5D)",
            "SD 1.5 Anime"
        ],
        sd15_real: [
            "SD 1.5 (Photorealistic)",
            "SD 1.5 Realistic"
        ]
    };

    // Legacy names remain supported for existing SillyTavern presets.
    const legacy = {
        pony: ["Pony (动漫/R-18)"],
        sdxl: ["SDXL (写实/通用)"],
        sd15_anime: ["SD 1.5 (动漫/韩漫2.5D)"],
        sd15_real: ["SD 1.5 (纯写实/真人照)"]
    };

    return [
        ...(english[model.family] || []),
        ...(legacy[model.family] || [])
    ];
}

// --- User interface ---
jQuery(() => {
    if ($("#horde-radar-root").length) return;

    const uiHtml = `
        <div class="extension-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>AI Horde Image Generation Radar</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>

                <div class="inline-drawer-content"
                     style="padding:15px;background:#121212;color:#eee;border-radius:8px;">

                    <div style="display:flex;justify-content:space-between;
                                align-items:center;gap:10px;margin-bottom:12px;
                                border-bottom:1px solid #333;padding-bottom:10px;">
                        <span id="horde-radar-status"
                              style="font-size:12px;color:#aaa;">
                            Waiting for data...
                        </span>
                        <button id="btn-horde-refresh" class="menu_button"
                                style="margin:0;font-weight:bold;white-space:nowrap;">
                            📡 Refresh
                        </button>
                    </div>

                    <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px;">

                        <label for="horde-family-filter"
                               style="font-size:12px;color:#bb86fc;font-weight:bold;">
                            Architecture / Family
                        </label>

                        <select id="horde-family-filter"
                                style="width:100%;background:#222;color:#eee;
                                       border:1px solid #444;padding:7px;border-radius:4px;">
                            <option value="all">
                                All families (alphabetical; scores not compared across families)
                            </option>
                            <option value="pony">Pony (SDXL-based)</option>
                            <option value="sdxl">SDXL</option>
                            <option value="sd15_anime">SD 1.5 · Anime / 2.5D</option>
                            <option value="sd15_real">SD 1.5 · General / Realistic</option>
                            <option value="other">
                                Other / Unclassified (including unsupported architectures)
                            </option>
                        </select>

                        <label for="horde-model-search"
                               style="font-size:12px;color:#bb86fc;font-weight:bold;">
                            Search Models
                        </label>

                        <input id="horde-model-search"
                               type="search"
                               placeholder="Search name, baseline, style, or description..."
                               style="width:100%;box-sizing:border-box;background:#222;
                                      color:#eee;border:1px solid #444;padding:8px;
                                      border-radius:4px;" />

                        <label for="horde-model-select"
                               style="font-size:12px;color:#bb86fc;font-weight:bold;">
                            Available Models
                        </label>

                        <select id="horde-model-select"
                                size="8"
                                style="width:100%;background:#222;color:#eee;
                                       border:1px solid #444;padding:6px;
                                       border-radius:4px;min-height:150px;">
                        </select>

                        <div style="display:flex;gap:8px;flex-wrap:wrap;">
                            <button id="btn-horde-sync" class="menu_button" style="margin:0;">
                                ⚙️ Sync Model / Settings
                            </button>
                            <button id="btn-horde-info" class="menu_button" style="margin:0;">
                                ℹ️ Show Details
                            </button>
                        </div>

                        <div style="font-size:11px;color:#999;line-height:1.4;">
                            Scores use the existing formula and should only be compared
                            within the same supported family. Unknown architectures are
                            listed without guessed parameter settings.
                        </div>
                    </div>

                    <div id="horde-info-panel"
                         style="display:none;background:#1e1e1e;border:1px solid #444;
                                border-radius:8px;padding:12px;font-size:13px;">
                    </div>
                </div>
            </div>
        </div>
    `;

    $("#extensions_settings").append(
        `<div id="horde-radar-root">${uiHtml}</div>`
    );

    $("#btn-horde-refresh").on("click", fetchHordeData);

    $("#horde-family-filter").on("change", function () {
        currentFamilyFilter = $(this).val() || "all";
        renderModelList();
    });

    $("#horde-model-search").on("input", function () {
        currentSearch = String($(this).val() || "").trim().toLowerCase();
        renderModelList();
    });

    $("#horde-model-select")
        .on("change", function () {
            selectedModelName = $(this).val() || "";
        })
        .on("dblclick", showInfoPanel);

    $("#btn-horde-sync").on("click", () => {
        if (!selectedModelName) {
            return toastr.warning("Select a model first.");
        }
        executeSync(selectedModelName);
    });

    $("#btn-horde-info").on("click", showInfoPanel);

    fetchHordeData();
});

async function fetchJson(url) {
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
    }

    return response.json();
}

// --- Fetch live status and model metadata ---
async function fetchHordeData() {
    $("#horde-radar-status").text(
        "Connecting to AI Horde and model reference..."
    );
    $("#btn-horde-refresh").prop("disabled", true);

    try {
        const statusPromise = fetchJson(
            "https://aihorde.net/api/v2/status/models"
        );

        const referencePromise = fetchJson(
            "https://models.aihorde.net/api/model_references/v2/image_generation"
        ).catch(() => fetchJson(
            "https://raw.githubusercontent.com/Haidra-Org/AI-Horde-image-model-reference/main/stable_diffusion.json"
        ));

        const [statusData, infoDict] = await Promise.all([
            statusPromise,
            referencePromise
        ]);

        globalModelsData = [];

        statusData.forEach(status => {
            if (status.type !== "image" || !(Number(status.count) > 0)) {
                return;
            }

            const info = infoDict[status.name] || {};
            const classification = classifyModel(status.name, info);

            globalModelsData.push({
                name: status.name,
                workers: Number(status.count) || 0,
                performance: Math.round(Number(status.performance) || 0),
                eta: Number(status.eta) || 0,
                jobs: Number(status.jobs) || 0,
                score: calculateModelScore(status),
                nsfw: info.nsfw === true,
                baseline: info.baseline || "Unknown baseline",
                version: info.version || "Unknown",
                style: info.style || "Not specified",
                rawDesc: info.description || "",
                showcases: Array.isArray(info.showcases) ? info.showcases : [],
                tags: Array.isArray(info.tags) ? info.tags : [],
                family: classification.family,
                familyLabel: classification.familyLabel,
                params: classification.params
            });
        });

        renderModelList();

        $("#horde-radar-status").text(
            `✅ Loaded ${globalModelsData.length} active image models · ` +
            new Date().toLocaleTimeString()
        );
    } catch (error) {
        console.error("AI Horde Radar: data fetch failed.", error);

        $("#horde-radar-status").text(
            "❌ Could not load model data. Check your connection and retry."
        );

        toastr.error(
            "Could not load AI Horde model data. Check the browser console for details."
        );
    } finally {
        $("#btn-horde-refresh").prop("disabled", false);
    }
}

// --- Search, filter and sort the model browser ---
function renderModelList() {
    const $select = $("#horde-model-select");
    if (!$select.length) return;

    const previous = selectedModelName || $select.val() || "";

    let models = globalModelsData.filter(model => {
        const familyMatch =
            currentFamilyFilter === "all" ||
            model.family === currentFamilyFilter;

        const searchable = [
            model.name,
            model.baseline,
            model.style,
            model.familyLabel,
            model.rawDesc,
            model.tags.join(" ")
        ].join(" ").toLowerCase();

        return familyMatch &&
            (!currentSearch || searchable.includes(currentSearch));
    });

    // Do not rank different architectures against each other.
    // The all-family browser is alphabetical; individual families use the score.
    if (currentFamilyFilter === "all") {
        models.sort((a, b) => a.name.localeCompare(b.name));
    } else {
        models.sort((a, b) => b.score - a.score);
    }

    $select.empty();

    if (!models.length) {
        $select.append(
            '<option value="">No matching active models</option>'
        );
        selectedModelName = "";
        return;
    }

    models.forEach(model => {
        const label =
            `${model.name}${model.nsfw ? " 🔞" : ""} · ` +
            `${model.workers} workers · ${model.familyLabel}`;

        $select.append(
            `<option value="${escapeHtml(model.name)}">` +
            `${escapeHtml(label)}</option>`
        );
    });

    if (models.some(model => model.name === previous)) {
        $select.val(previous);
        selectedModelName = previous;
    } else {
        $select.prop("selectedIndex", 0);
        selectedModelName = $select.val() || "";
    }
}

// --- Model details ---
function showInfoPanel() {
    const modelName = selectedModelName || $("#horde-model-select").val();
    const model = globalModelsData.find(item => item.name === modelName);

    if (!model) {
        return toastr.warning("Select an available model first.");
    }

    const perfText = model.performance > 1000
        ? `${(model.performance / 1000).toFixed(1)}k`
        : model.performance;

    const etaColor = model.eta === 0
        ? "var(--success)"
        : "var(--danger)";

    const paramsHtml = model.params
        ? `<div><b>Recommended parameters:</b>
               ${model.params.width} × ${model.params.height},
               ${escapeHtml(model.params.sampler)},
               ${model.params.steps} steps,
               CFG ${model.params.scale},
               clip skip ${model.params.clip_skip},
               Karras ${model.params.karras ? "on" : "off"}
           </div>`
        : `<div style="color:#ffcc80;">
               <b>Automatic parameters:</b> Not configured for this architecture.
               The extension will not guess settings.
           </div>`;

    let imagesHtml = "";

    model.showcases.forEach(url => {
        if (typeof url === "string" && /^https:\/\//i.test(url)) {
            imagesHtml +=
                `<img src="${escapeHtml(url)}" alt="Model preview" loading="lazy" ` +
                `style="width:100%;max-width:520px;border-radius:6px;margin-top:10px;">`;
        }
    });

    if (!imagesHtml) {
        imagesHtml =
            '<div style="color:#888;margin-top:8px;">No official preview images available.</div>';
    }

    const html = `
        <div style="display:flex;justify-content:space-between;gap:10px;
                    align-items:start;border-bottom:1px solid #444;
                    padding-bottom:8px;margin-bottom:10px;">
            <div style="font-size:16px;font-weight:bold;color:#bb86fc;
                        overflow-wrap:anywhere;">
                ${escapeHtml(model.name)} ${model.nsfw ? "🔞" : ""}
            </div>
            <button class="menu_button" id="btn-horde-refresh-single"
                    style="margin:0;white-space:nowrap;">
                🔄 Refresh Status
            </button>
        </div>

        <div style="display:flex;flex-direction:column;gap:8px;">
            <div><b>Family:</b> ${escapeHtml(model.familyLabel)}</div>
            <div><b>Baseline:</b> ${escapeHtml(model.baseline)}</div>
            <div><b>Version:</b> ${escapeHtml(model.version)}</div>
            <div><b>Reference style:</b> ${escapeHtml(model.style)}</div>

            <div>
                <b>Performance:</b> ${escapeHtml(perfText)}
                · <b>Workers:</b> ${model.workers}
                · <b>Queued jobs:</b> ${model.jobs}
                · <b>ETA:</b>
                <span style="color:${etaColor};">${model.eta}s</span>
            </div>

            <div>
                <b>Radar score:</b> ${Math.round(model.score)}
                <span style="color:#999;font-size:11px;">
                    (compare only within the same family)
                </span>
            </div>

            ${paramsHtml}

            <div style="margin-top:6px;padding:9px;background:#111;
                        border-left:3px solid #03dac6;overflow-wrap:anywhere;">
                <b>Model Description</b>
                <div style="color:#ccc;line-height:1.5;margin-top:4px;">
                    ${escapeHtml(
                        model.rawDesc ||
                        "No description supplied by the model reference."
                    )}
                </div>
            </div>

            <div style="font-weight:bold;color:#bb86fc;margin-top:4px;">
                Official Preview Images
            </div>
            ${imagesHtml}
        </div>
    `;

    $("#horde-info-panel").html(html).slideDown(180);

    $("#btn-horde-refresh-single").on("click", () => {
        refreshSingleModel(model.name);
    });
}

// --- Refresh one model's live status ---
async function refreshSingleModel(modelName) {
    const $button = $("#btn-horde-refresh-single");
    const oldText = $button.text();

    $button.text("Refreshing...").prop("disabled", true);

    try {
        const statuses = await fetchJson(
            "https://aihorde.net/api/v2/status/models"
        );

        const live = statuses.find(
            item => item.name === modelName && item.type === "image"
        );

        const model = globalModelsData.find(
            item => item.name === modelName
        );

        if (!live || !model) {
            toastr.warning(
                "This model is no longer reporting active workers. " +
                "Refresh the full radar for the latest list."
            );
            return;
        }

        model.workers = Number(live.count) || 0;
        model.performance = Math.round(Number(live.performance) || 0);
        model.eta = Number(live.eta) || 0;
        model.jobs = Number(live.jobs) || 0;
        model.score = calculateModelScore(live);

        renderModelList();
        showInfoPanel();

        toastr.success(`Live status updated for ${modelName}.`);
    } catch (error) {
        console.error(
            "AI Horde Radar: single-model refresh failed.",
            error
        );
        toastr.error(
            "Failed to refresh model status. Check your connection."
        );
    } finally {
        $("#btn-horde-refresh-single")
            .text(oldText)
            .prop("disabled", false);
    }
}

// --- Sync model, compatible parameters, and optional style ---
function executeSync(modelName) {
    const model = globalModelsData.find(
        item => item.name === modelName
    );

    if (!model) {
        return toastr.error(
            "The selected model is no longer in the active model list. Refresh the radar."
        );
    }

    const sd = extension_settings.sd;

    if (!sd) {
        return toastr.error(
            "SillyTavern image-generation settings are unavailable. " +
            "Open the image-generation panel and try again."
        );
    }

    // Always sync the model, even if no matching style exists.
    sd.model = model.name;
    $("#sd_model").val(model.name).trigger("change");

    // Change generation parameters only for supported, configured families.
    if (model.params) {
        const p = model.params;

        sd.width = p.width;
        $("#sd_width").val(p.width).trigger("input");

        sd.height = p.height;
        $("#sd_height").val(p.height).trigger("input");

        sd.sampler = p.sampler;
        $("#sd_sampler").val(p.sampler).trigger("change");

        sd.steps = p.steps;
        $("#sd_steps").val(p.steps).trigger("input");

        sd.scale = p.scale;
        $("#sd_scale").val(p.scale).trigger("input");

        sd.clip_skip = p.clip_skip;
        $("#sd_clip_skip").val(p.clip_skip).trigger("input");

        sd.horde_karras = p.karras;
        $("#sd_horde_karras")
            .prop("checked", p.karras)
            .trigger("change");

        $("#sd_resolution")
            .val(`${p.width}x${p.height}`)
            .trigger("change");
    }

    // A style is optional. Missing styles never block model synchronization.
    let appliedStyle = false;
    const styles = Array.isArray(sd.styles) ? sd.styles : [];
    const candidates = getStyleCandidates(model);

    const styleObj = styles.find(style =>
        candidates.includes(style.name)
    );

    if (styleObj) {
        sd.style = styleObj.name;
        sd.prompt_prefix = styleObj.prefix || "";
        sd.negative_prompt = styleObj.negative || "";

        $("#sd_style").val(styleObj.name).trigger("change");
        $("#sd_prompt_prefix")
            .val(styleObj.prefix || "")
            .trigger("input");
        $("#sd_negative_prompt")
            .val(styleObj.negative || "")
            .trigger("input");

        appliedStyle = true;
    }

    saveSettingsDebounced();

    if (!model.params) {
        toastr.warning(
            `Model selected: ${model.name}. No automatic parameters are ` +
            `configured for ${model.familyLabel}; existing generation ` +
            `settings were left unchanged.`
        );
    } else if (!appliedStyle) {
        toastr.warning(
            `Model and recommended parameters synced for ${model.name}. ` +
            `No matching optional style preset was found, so your current ` +
            `style and prompts were left unchanged.`
        );
    } else {
        toastr.success(
            `Model, parameters, and style synced for ${model.name}.`,
            "AI Horde Radar",
            { timeOut: 3500 }
        );
    }
}
