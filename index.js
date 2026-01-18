/**
 * CosyVoice TTS Extension for SillyTavern
 * 支持预设角色、即时克隆、预设管理、自定义引号
 * v1.1.0 - 添加角色列表、并行预生成、完整控制按钮
 */

import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js";

const extensionName = "st-cosyvoice-tts";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}/`;

// ==================== 默认设置 ====================
const defaultSettings = {
    apiBaseUrl: 'http://localhost:9880',
    speed: 1.0,
    enabled: true,
    autoPlay: false,
    
    // 模式: 'preset' 使用预设角色, 'clone' 使用即时克隆
    mode: 'preset',
    
    // 预设角色设置
    selectedSpeaker: '',
    speakers: [],
    
    // 引号设置
    quotationStyle: 'japanese',
    customQuotationLeft: '「',
    customQuotationRight: '」',
    extractQuotesOnly: true,
    
    // 克隆预设管理
    clonePresets: [],
    currentClonePresetIndex: -1,
    
    // 即时克隆临时数据
    tempPromptText: '',
    tempPromptAudioBase64: '',
    tempPromptAudioName: '',
    
    // 指令控制
    ttsMode: '零样本复制',
    instruction: '',
    
    // 并行生成设置
    preloadCount: 3, // 预加载数量
};

// ==================== 运行时变量 ====================
let isPlaying = false;
let isPaused = false;
let isGenerating = false;
let currentAudio = null;
let playbackQueue = [];
let currentPlaybackIndex = 0;
let audioCache = new Map(); // 音频缓存
let generationPromises = new Map(); // 正在生成的Promise

// ==================== 引号配置 ====================
const QUOTATION_STYLES = {
    japanese: { left: '「', right: '」', name: '日式「」' },
    western: { left: '"', right: '"', name: '西式""' },
    chinese: { left: '"', right: '"', name: '中式""' },
    french: { left: '«', right: '»', name: '法式«»' },
    single: { left: "'", right: "'", name: "单引号''" },
    guillemet: { left: '『', right: '』', name: '双角『』' },
    custom: { left: '', right: '', name: '自定义' }
};

// ==================== 工具函数 ====================

function log(message, type = 'info') {
    const prefix = '[CosyVoice TTS]';
    switch (type) {
        case 'error': console.error(`${prefix} ❌ ${message}`); break;
        case 'warn': console.warn(`${prefix} ⚠️ ${message}`); break;
        case 'success': console.log(`${prefix} ✅ ${message}`); break;
        default: console.log(`${prefix} ${message}`);
    }
}

function showNotification(message, type = 'info', duration = 3000) {
    if (typeof toastr !== 'undefined') {
        switch (type) {
            case 'error': toastr.error(message, 'CosyVoice TTS'); break;
            case 'warning': toastr.warning(message, 'CosyVoice TTS'); break;
            case 'success': toastr.success(message, 'CosyVoice TTS'); break;
            default: toastr.info(message, 'CosyVoice TTS');
        }
        return;
    }
    
    let container = document.getElementById('cosyvoice-notification-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'cosyvoice-notification-container';
        document.body.appendChild(container);
    }
    
    const notification = document.createElement('div');
    notification.className = `cosyvoice-notification ${type}`;
    notification.textContent = message;
    container.appendChild(notification);
    
    setTimeout(() => notification.classList.add('show'), 10);
    setTimeout(() => {
        notification.classList.remove('show');
        setTimeout(() => notification.remove(), 300);
    }, duration);
}

// ==================== 设置管理 ====================

function loadSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = {};
    }
    
    const settings = extension_settings[extensionName];
    for (const key in defaultSettings) {
        if (settings[key] === undefined) {
            settings[key] = defaultSettings[key];
        }
    }
    
    return settings;
}

function getSettings() {
    return extension_settings[extensionName] || loadSettings();
}

function saveSettings() {
    saveSettingsDebounced();
}

function updateSetting(key, value) {
    const settings = getSettings();
    settings[key] = value;
    saveSettings();
}

// ==================== 引号处理 ====================

function getQuotationMarks() {
    const settings = getSettings();
    if (settings.quotationStyle === 'custom') {
        return {
            left: settings.customQuotationLeft || '「',
            right: settings.customQuotationRight || '」'
        };
    }
    return QUOTATION_STYLES[settings.quotationStyle] || QUOTATION_STYLES.japanese;
}

function extractQuotedText(text) {
    const settings = getSettings();
    if (!settings.extractQuotesOnly) {
        return [text.trim()].filter(t => t);
    }
    
    const { left, right } = getQuotationMarks();
    const results = [];
    
    const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`${escapeRegex(left)}([^${escapeRegex(right)}]+)${escapeRegex(right)}`, 'g');
    
    let match;
    while ((match = regex.exec(text)) !== null) {
        const content = match[1].trim();
        if (content) {
            results.push(content);
        }
    }
    
    if (results.length === 0) {
        return [text.trim()].filter(t => t);
    }
    
    return results;
}

// ==================== 克隆预设管理 ====================

function getClonePresets() {
    return getSettings().clonePresets || [];
}

function getCurrentClonePreset() {
    const settings = getSettings();
    const index = settings.currentClonePresetIndex;
    if (index >= 0 && index < settings.clonePresets.length) {
        return settings.clonePresets[index];
    }
    return null;
}

function addClonePreset(preset) {
    const settings = getSettings();
    if (!settings.clonePresets) {
        settings.clonePresets = [];
    }
    settings.clonePresets.push({
        id: Date.now().toString(),
        name: preset.name || `预设 ${settings.clonePresets.length + 1}`,
        promptText: preset.promptText || '',
        promptAudioBase64: preset.promptAudioBase64 || '',
        promptAudioName: preset.promptAudioName || '',
        createdAt: new Date().toISOString()
    });
    saveSettings();
    return settings.clonePresets[settings.clonePresets.length - 1];
}

function updateClonePreset(index, updates) {
    const settings = getSettings();
    if (index >= 0 && index < settings.clonePresets.length) {
        settings.clonePresets[index] = { ...settings.clonePresets[index], ...updates };
        saveSettings();
        return true;
    }
    return false;
}

function deleteClonePreset(index) {
    const settings = getSettings();
    if (index >= 0 && index < settings.clonePresets.length) {
        settings.clonePresets.splice(index, 1);
        if (settings.currentClonePresetIndex >= settings.clonePresets.length) {
            settings.currentClonePresetIndex = settings.clonePresets.length - 1;
        }
        if (settings.currentClonePresetIndex === index) {
            settings.currentClonePresetIndex = -1;
        } else if (settings.currentClonePresetIndex > index) {
            settings.currentClonePresetIndex--;
        }
        saveSettings();
        return true;
    }
    return false;
}

function selectClonePreset(index) {
    const settings = getSettings();
    if (index >= -1 && index < settings.clonePresets.length) {
        settings.currentClonePresetIndex = index;
        saveSettings();
        return true;
    }
    return false;
}

// ==================== 音频处理 ====================

function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const base64 = reader.result.split(',')[1];
            resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// ==================== API 调用 ====================

async function testConnection() {
    const settings = getSettings();
    try {
        const response = await fetch(`${settings.apiBaseUrl}/api/health`, {
            method: 'GET',
        });
        
        if (response.ok) {
            const data = await response.json();
            log(`连接成功: ${JSON.stringify(data)}`, 'success');
            return { success: true, data };
        } else {
            throw new Error(`HTTP ${response.status}`);
        }
    } catch (error) {
        log(`连接失败: ${error.message}`, 'error');
        return { success: false, error: error.message };
    }
}

async function fetchSpeakers() {
    const settings = getSettings();
    try {
        const response = await fetch(`${settings.apiBaseUrl}/speakers`, {
            method: 'GET'
        });
        
        if (response.ok) {
            const speakers = await response.json();
            log(`获取到 ${speakers.length} 个角色`, 'success');
            updateSetting('speakers', speakers);
            return speakers;
        }
        return [];
    } catch (error) {
        log(`获取角色列表失败: ${error.message}`, 'error');
        return [];
    }
}

// 使用预设角色生成TTS（调用根路由 /）
async function generateTTSWithSpeaker(text, speaker, speed = 1.0) {
    const settings = getSettings();
    
    const requestBody = {
        text: text,
        speaker: speaker,
        speed: speed
    };
    
    log(`生成TTS(预设角色): "${text.substring(0, 30)}..." 角色: ${speaker}`, 'info');
    
    const response = await fetch(`${settings.apiBaseUrl}/`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
    });
    
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`TTS生成失败: ${response.status} - ${errorText}`);
    }
    
    const audioBlob = await response.blob();
    return URL.createObjectURL(audioBlob);
}

// 使用即时克隆生成TTS
async function generateTTSWithClone(text, options = {}) {
    const settings = getSettings();
    const preset = getCurrentClonePreset();
    
    let promptText = options.promptText || settings.tempPromptText || '';
    let promptAudioBase64 = options.promptAudioBase64 || settings.tempPromptAudioBase64 || '';
    
    if (preset && !options.promptText) {
        promptText = preset.promptText;
        promptAudioBase64 = preset.promptAudioBase64;
    }
    
    if (!promptText || !promptAudioBase64) {
        throw new Error('请先设置参考音频和参考文本，或选择一个克隆预设');
    }
    
    const requestBody = {
        text: text,
        prompt_text: promptText,
        prompt_wav: promptAudioBase64,
        speed: options.speed || settings.speed || 1.0,
        mode: settings.ttsMode || '零样本复制',
        instruction: settings.instruction || ''
    };
    
    log(`生成TTS(即时克隆): "${text.substring(0, 30)}..."`, 'info');
    
    const response = await fetch(`${settings.apiBaseUrl}/api/tts_zero_shot`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
    });
    
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`TTS生成失败: ${response.status} - ${errorText}`);
    }
    
    const audioBlob = await response.blob();
    return URL.createObjectURL(audioBlob);
}

// 统一的TTS生成函数
async function generateTTS(text, index = 0) {
    const settings = getSettings();
    const cacheKey = `${text}_${settings.mode}_${settings.selectedSpeaker}_${index}`;
    
    // 检查缓存
    if (audioCache.has(cacheKey)) {
        log(`使用缓存: ${text.substring(0, 20)}...`, 'info');
        return audioCache.get(cacheKey);
    }
    
    // 检查是否正在生成
    if (generationPromises.has(cacheKey)) {
        return await generationPromises.get(cacheKey);
    }
    
    const generatePromise = (async () => {
        try {
            let audioUrl;
            
            if (settings.mode === 'preset') {
                if (!settings.selectedSpeaker) {
                    throw new Error('请先选择一个角色');
                }
                audioUrl = await generateTTSWithSpeaker(text, settings.selectedSpeaker, settings.speed);
            } else {
                audioUrl = await generateTTSWithClone(text, { speed: settings.speed });
            }
            
            audioCache.set(cacheKey, audioUrl);
            return audioUrl;
        } finally {
            generationPromises.delete(cacheKey);
        }
    })();
    
    generationPromises.set(cacheKey, generatePromise);
    return await generatePromise;
}

// ==================== 并行预生成 ====================

async function preloadAudios(texts, startIndex = 0) {
    const settings = getSettings();
    const preloadCount = settings.preloadCount || 3;
    const endIndex = Math.min(startIndex + preloadCount, texts.length);
    
    const promises = [];
    for (let i = startIndex; i < endIndex; i++) {
        if (texts[i]) {
            promises.push(
                generateTTS(texts[i], i).catch(err => {
                    log(`预加载失败 [${i}]: ${err.message}`, 'warn');
                    return null;
                })
            );
        }
    }
    
    await Promise.all(promises);
    log(`预加载完成: ${startIndex} - ${endIndex - 1}`, 'info');
}

// ==================== 播放控制 ====================

function playAudio(blobUrl) {
    return new Promise((resolve, reject) => {
        if (currentAudio) {
            currentAudio.pause();
            currentAudio.src = '';
        }
        
        currentAudio = new Audio(blobUrl);
        
        currentAudio.onended = () => {
            resolve();
        };
        
        currentAudio.onerror = (e) => {
            reject(new Error('音频播放失败'));
        };
        
        if (isPaused) {
            resolve();
            return;
        }
        
        currentAudio.play().catch(reject);
    });
}

async function processPlaybackQueue() {
    if (isPaused || !isPlaying) return;
    if (currentPlaybackIndex >= playbackQueue.length) {
        stopPlayback();
        showNotification('播放完成', 'success');
        return;
    }
    
    const currentText = playbackQueue[currentPlaybackIndex];
    
    // 预加载后续音频
    preloadAudios(playbackQueue, currentPlaybackIndex + 1);
    
    try {
        isGenerating = true;
        updateButtonStates();
        
        const audioUrl = await generateTTS(currentText, currentPlaybackIndex);
        
        if (!isPlaying || isPaused) {
            isGenerating = false;
            updateButtonStates();
            return;
        }
        
        isGenerating = false;
        updateButtonStates();
        
        await playAudio(audioUrl);
        
        if (!isPlaying) return;
        
        currentPlaybackIndex++;
        
        if (isPlaying && !isPaused) {
            processPlaybackQueue();
        }
    } catch (error) {
        log(`播放失败: ${error.message}`, 'error');
        showNotification(`播放失败: ${error.message}`, 'error');
        isGenerating = false;
        stopPlayback();
    }
}

function startPlayback(texts) {
    if (!Array.isArray(texts)) {
        texts = [texts];
    }
    
    texts = texts.filter(t => t && t.trim());
    
    if (texts.length === 0) {
        showNotification('没有可播放的内容', 'warning');
        return;
    }
    
    // 检查配置
    const settings = getSettings();
    if (settings.mode === 'preset' && !settings.selectedSpeaker) {
        showNotification('请先选择一个角色', 'warning');
        openSettingsModal();
        return;
    }
    
    if (settings.mode === 'clone') {
        const preset = getCurrentClonePreset();
        if (!preset && (!settings.tempPromptText || !settings.tempPromptAudioBase64)) {
            showNotification('请先设置参考音频和参考文本', 'warning');
            openSettingsModal();
            return;
        }
    }
    
    stopPlayback();
    
    // 清理旧缓存
    audioCache.forEach((url) => URL.revokeObjectURL(url));
    audioCache.clear();
    
    playbackQueue = [...texts];
    currentPlaybackIndex = 0;
    isPlaying = true;
    isPaused = false;
    
    log(`开始播放 ${texts.length} 段文本`, 'info');
    
    // 预加载前几段
    preloadAudios(playbackQueue, 0);
    
    updateButtonStates();
    processPlaybackQueue();
}

function pausePlayback() {
    if (!isPlaying) return;
    
    isPaused = true;
    if (currentAudio) {
        currentAudio.pause();
    }
    log('播放已暂停', 'info');
    updateButtonStates();
}

function resumePlayback() {
    if (!isPlaying || !isPaused) return;
    
    isPaused = false;
    if (currentAudio && currentAudio.src) {
        currentAudio.play().catch(() => {
            processPlaybackQueue();
        });
    } else {
        processPlaybackQueue();
    }
    log('播放已恢复', 'info');
    updateButtonStates();
}

function stopPlayback() {
    isPlaying = false;
    isPaused = false;
    isGenerating = false;
    playbackQueue = [];
    currentPlaybackIndex = 0;
    
    if (currentAudio) {
        currentAudio.pause();
        currentAudio.src = '';
        currentAudio = null;
    }
    
    // 清理缓存
    audioCache.forEach((url) => URL.revokeObjectURL(url));
    audioCache.clear();
    generationPromises.clear();
    
    log('播放已停止', 'info');
    updateButtonStates();
}

function togglePlayPause() {
    if (!isPlaying) {
        playLatestMessage();
    } else if (isPaused) {
        resumePlayback();
    } else {
        pausePlayback();
    }
}

// ==================== 消息处理 ====================

function getLatestAIMessage() {
    const messages = document.querySelectorAll('div.mes[is_user="false"]');
    if (messages.length === 0) return null;
    
    const lastMessage = messages[messages.length - 1];
    const textElement = lastMessage.querySelector('.mes_text');
    if (!textElement) return null;
    
    return textElement.innerText || textElement.textContent || '';
}

function playLatestMessage() {
    const messageText = getLatestAIMessage();
    if (!messageText) {
        showNotification('没有找到AI消息', 'warning');
        return;
    }
    
    const textsToPlay = extractQuotedText(messageText);
    log(`提取到 ${textsToPlay.length} 段文本`, 'info');
    
    startPlayback(textsToPlay);
}

// ==================== UI 更新 ====================

function updateButtonStates() {
    const playBtn = document.getElementById('cosyvoice-play-btn');
    const pauseBtn = document.getElementById('cosyvoice-pause-btn');
    const stopBtn = document.getElementById('cosyvoice-stop-btn');
    
    if (playBtn) {
        const icon = playBtn.querySelector('.icon');
        const text = playBtn.querySelector('.text');
        
        if (isGenerating) {
            icon.textContent = '⏳';
            text.textContent = '生成中';
            playBtn.disabled = true;
            playBtn.classList.add('generating');
        } else if (isPlaying && !isPaused) {
            icon.textContent = '🔊';
            text.textContent = '播放中';
            playBtn.disabled = true;
            playBtn.classList.remove('generating');
        } else {
            icon.textContent = '▶';
            text.textContent = '播放';
            playBtn.disabled = false;
            playBtn.classList.remove('generating');
        }
    }
    
    if (pauseBtn) {
        const icon = pauseBtn.querySelector('.icon');
        const text = pauseBtn.querySelector('.text');
        
        if (isPaused) {
            icon.textContent = '▶';
            text.textContent = '继续';
        } else {
            icon.textContent = '⏸';
            text.textContent = '暂停';
        }
        
        pauseBtn.disabled = !isPlaying;
        pauseBtn.style.opacity = isPlaying ? '1' : '0.5';
    }
    
    if (stopBtn) {
        stopBtn.disabled = !isPlaying && !isGenerating;
        stopBtn.style.opacity = (isPlaying || isGenerating) ? '1' : '0.5';
    }
    
    updatePresetIndicator();
}

function updatePresetIndicator() {
    const indicator = document.getElementById('cosyvoice-current-preset');
    if (!indicator) return;
    
    const settings = getSettings();
    
    if (settings.mode === 'preset') {
        if (settings.selectedSpeaker) {
            indicator.textContent = `🎭 ${settings.selectedSpeaker}`;
            indicator.classList.remove('no-preset');
        } else {
            indicator.textContent = '未选择角色';
            indicator.classList.add('no-preset');
        }
    } else {
        const preset = getCurrentClonePreset();
        if (preset) {
            indicator.textContent = `🎤 ${preset.name}`;
            indicator.classList.remove('no-preset');
        } else if (settings.tempPromptAudioBase64 && settings.tempPromptText) {
            indicator.textContent = '🎤 临时设置';
            indicator.classList.remove('no-preset');
        } else {
            indicator.textContent = '未设置克隆';
            indicator.classList.add('no-preset');
        }
    }
}

function updateSpeakerSelect() {
    const select = document.getElementById('cosyvoice-speaker-select');
    if (!select) return;
    
    const settings = getSettings();
    const speakers = settings.speakers || [];
    
    select.innerHTML = '<option value="">-- 选择角色 --</option>';
    speakers.forEach(speaker => {
        const option = document.createElement('option');
        option.value = speaker.voice_id || speaker.name;
        option.textContent = speaker.name;
        if (settings.selectedSpeaker === option.value) {
            option.selected = true;
        }
        select.appendChild(option);
    });
}

function updateClonePresetList() {
    const container = document.getElementById('cosyvoice-clone-preset-list');
    if (!container) return;
    
    const presets = getClonePresets();
    const settings = getSettings();
    
    if (presets.length === 0) {
        container.innerHTML = '<div class="cosyvoice-empty-state">暂无克隆预设</div>';
        return;
    }
    
    container.innerHTML = presets.map((preset, index) => `
        <div class="cosyvoice-preset-item ${settings.currentClonePresetIndex === index ? 'active' : ''}" data-index="${index}">
            <div class="cosyvoice-preset-info">
                <span class="cosyvoice-preset-name">${escapeHtml(preset.name)}</span>
                <span class="cosyvoice-preset-audio">${escapeHtml(preset.promptAudioName || '未命名音频')}</span>
            </div>
            <div class="cosyvoice-preset-actions">
                <button class="cosyvoice-preset-select" data-index="${index}" title="选择">✓</button>
                <button class="cosyvoice-preset-edit" data-index="${index}" title="编辑">✎</button>
                <button class="cosyvoice-preset-delete" data-index="${index}" title="删除">×</button>
            </div>
        </div>
    `).join('');
    
    bindClonePresetEvents(container);
}

function bindClonePresetEvents(container) {
    const presets = getClonePresets();
    
    container.querySelectorAll('.cosyvoice-preset-select').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const index = parseInt(btn.dataset.index);
            selectClonePreset(index);
            updateClonePresetList();
            updatePresetIndicator();
            showNotification(`已选择: ${presets[index].name}`, 'success');
        });
    });
    
    container.querySelectorAll('.cosyvoice-preset-edit').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const index = parseInt(btn.dataset.index);
            const newName = prompt('编辑预设名称:', presets[index].name);
            if (newName && newName !== presets[index].name) {
                updateClonePreset(index, { name: newName });
                updateClonePresetList();
                showNotification('预设已更新', 'success');
            }
        });
    });
    
    container.querySelectorAll('.cosyvoice-preset-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const index = parseInt(btn.dataset.index);
            if (confirm(`确定要删除预设 "${presets[index].name}" 吗？`)) {
                deleteClonePreset(index);
                updateClonePresetList();
                updatePresetIndicator();
                showNotification('预设已删除', 'success');
            }
        });
    });
    
    container.querySelectorAll('.cosyvoice-preset-item').forEach(item => {
        item.addEventListener('click', () => {
            const index = parseInt(item.dataset.index);
            selectClonePreset(index);
            updateClonePresetList();
            updatePresetIndicator();
            showNotification(`已选择: ${presets[index].name}`, 'success');
        });
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ==================== 设置面板 ====================

function openSettingsModal() {
    if (document.getElementById('cosyvoice-settings-modal')) {
        document.getElementById('cosyvoice-settings-modal').remove();
        return;
    }
    
    const settings = getSettings();
    const { left, right } = getQuotationMarks();
    const speakers = settings.speakers || [];
    
    const modal = document.createElement('div');
    modal.id = 'cosyvoice-settings-modal';
    modal.className = 'cosyvoice-modal';
    modal.innerHTML = `
        <div class="cosyvoice-modal-content">
            <div class="cosyvoice-modal-header">
                <h2>🎙️ CosyVoice TTS 设置</h2>
                <button class="cosyvoice-close-btn">×</button>
            </div>
            <div class="cosyvoice-modal-body">
                <!-- API 设置 -->
                <div class="cosyvoice-section">
                    <h3>🔗 API 设置</h3>
                    <div class="cosyvoice-setting-item">
                        <label>API 地址</label>
                        <div class="cosyvoice-input-group">
                            <input type="text" id="cosyvoice-api-url" value="${settings.apiBaseUrl}" placeholder="http://localhost:9880">
                            <button id="cosyvoice-test-connection" class="cosyvoice-btn secondary">测试</button>
                        </div>
                    </div>
                    <div class="cosyvoice-setting-item">
                        <label>语速: <span id="cosyvoice-speed-value">${settings.speed.toFixed(1)}</span></label>
                        <input type="range" id="cosyvoice-speed" min="0.5" max="2.0" step="0.1" value="${settings.speed}">
                    </div>
                </div>
                
                <!-- 模式选择 -->
                <div class="cosyvoice-section">
                    <h3>🎯 TTS 模式</h3>
                    <div class="cosyvoice-mode-tabs">
                        <button class="cosyvoice-mode-tab ${settings.mode === 'preset' ? 'active' : ''}" data-mode="preset">
                            <span class="icon">🎭</span>
                            <span>预设角色</span>
                        </button>
                        <button class="cosyvoice-mode-tab ${settings.mode === 'clone' ? 'active' : ''}" data-mode="clone">
                            <span class="icon">🎤</span>
                            <span>即时克隆</span>
                        </button>
                    </div>
                    
                    <!-- 预设角色模式 -->
                    <div class="cosyvoice-mode-content ${settings.mode === 'preset' ? '' : 'hidden'}" id="cosyvoice-preset-mode">
                        <div class="cosyvoice-setting-item">
                            <label>选择角色</label>
                            <div class="cosyvoice-input-group">
                                <select id="cosyvoice-speaker-select">
                                    <option value="">-- 选择角色 --</option>
                                    ${speakers.map(s => `
                                        <option value="${s.voice_id || s.name}" ${settings.selectedSpeaker === (s.voice_id || s.name) ? 'selected' : ''}>
                                            ${s.name}
                                        </option>
                                    `).join('')}
                                </select>
                                <button id="cosyvoice-refresh-speakers" class="cosyvoice-btn secondary">刷新</button>
                            </div>
                        </div>
                        <div class="cosyvoice-speaker-info ${settings.selectedSpeaker ? '' : 'hidden'}">
                            当前角色: <strong id="cosyvoice-current-speaker">${settings.selectedSpeaker || '无'}</strong>
                        </div>
                    </div>
                    
                    <!-- 即时克隆模式 -->
                    <div class="cosyvoice-mode-content ${settings.mode === 'clone' ? '' : 'hidden'}" id="cosyvoice-clone-mode">
                        <div class="cosyvoice-setting-item">
                            <label>参考音频</label>
                            <div class="cosyvoice-file-input">
                                <input type="file" id="cosyvoice-audio-file" accept="audio/*" style="display:none;">
                                <button id="cosyvoice-upload-audio" class="cosyvoice-btn secondary full-width">
                                    <span class="icon">📁</span>
                                    <span id="cosyvoice-audio-filename">${settings.tempPromptAudioName || '选择音频文件'}</span>
                                </button>
                                ${settings.tempPromptAudioBase64 ? '<span class="cosyvoice-file-status">✓</span>' : ''}
                            </div>
                        </div>
                        <div class="cosyvoice-setting-item">
                            <label>参考文本</label>
                            <textarea id="cosyvoice-prompt-text" placeholder="输入参考音频对应的文本内容...">${settings.tempPromptText}</textarea>
                        </div>
                        <div class="cosyvoice-setting-item">
                            <label>克隆模式</label>
                            <select id="cosyvoice-tts-mode">
                                <option value="零样本复制" ${settings.ttsMode === '零样本复制' ? 'selected' : ''}>零样本复制</option>
                                <option value="指令控制" ${settings.ttsMode === '指令控制' ? 'selected' : ''}>指令控制</option>
                            </select>
                        </div>
                        <div class="cosyvoice-setting-item cosyvoice-instruction ${settings.ttsMode === '指令控制' ? '' : 'hidden'}">
                            <label>情感指令</label>
                            <input type="text" id="cosyvoice-instruction" value="${settings.instruction}" placeholder="例如：开心、悲伤、愤怒...">
                        </div>
                        <div class="cosyvoice-setting-item">
                            <button id="cosyvoice-save-clone-preset" class="cosyvoice-btn primary full-width">
                                <span class="icon">💾</span>
                                <span>保存为克隆预设</span>
                            </button>
                        </div>
                        
                        <div class="cosyvoice-subsection">
                            <h4>克隆预设</h4>
                            <div id="cosyvoice-clone-preset-list" class="cosyvoice-preset-list"></div>
                        </div>
                    </div>
                </div>
                
                <!-- 引号设置 -->
                <div class="cosyvoice-section">
                    <h3>📝 引号设置</h3>
                    <div class="cosyvoice-setting-item">
                        <label class="cosyvoice-checkbox-label">
                            <input type="checkbox" id="cosyvoice-extract-quotes" ${settings.extractQuotesOnly ? 'checked' : ''}>
                            <span>只提取引号内内容</span>
                        </label>
                    </div>
                    <div class="cosyvoice-setting-item">
                        <label>引号样式</label>
                        <div class="cosyvoice-radio-group">
                            ${Object.entries(QUOTATION_STYLES).map(([key, style]) => `
                                <label class="cosyvoice-radio-item ${settings.quotationStyle === key ? 'active' : ''}">
                                    <input type="radio" name="quotation-style" value="${key}" ${settings.quotationStyle === key ? 'checked' : ''}>
                                    <span>${style.name}</span>
                                </label>
                            `).join('')}
                        </div>
                    </div>
                    <div class="cosyvoice-setting-item cosyvoice-custom-quotes ${settings.quotationStyle === 'custom' ? '' : 'hidden'}">
                        <label>自定义引号</label>
                        <div class="cosyvoice-input-group">
                            <input type="text" id="cosyvoice-quote-left" value="${settings.customQuotationLeft}" placeholder="左" maxlength="2" style="width:60px;text-align:center;">
                            <span style="color:var(--cosyvoice-text-muted);">文本内容</span>
                            <input type="text" id="cosyvoice-quote-right" value="${settings.customQuotationRight}" placeholder="右" maxlength="2" style="width:60px;text-align:center;">
                        </div>
                    </div>
                    <div class="cosyvoice-quote-preview">
                        预览: <span id="cosyvoice-quote-preview-text">${left}这是对话内容${right}</span>
                    </div>
                </div>
                
                <!-- 功能开关 -->
                <div class="cosyvoice-section">
                    <h3>⚡ 功能开关</h3>
                    <div class="cosyvoice-switch-grid">
                        <div class="cosyvoice-switch-item">
                            <span>启用扩展</span>
                            <label class="cosyvoice-switch">
                                <input type="checkbox" id="cosyvoice-enabled" ${settings.enabled ? 'checked' : ''}>
                                <span class="cosyvoice-slider"></span>
                            </label>
                        </div>
                        <div class="cosyvoice-switch-item">
                            <span>自动播放</span>
                            <label class="cosyvoice-switch">
                                <input type="checkbox" id="cosyvoice-auto-play" ${settings.autoPlay ? 'checked' : ''}>
                                <span class="cosyvoice-slider"></span>
                            </label>
                        </div>
                    </div>
                </div>
                
                <!-- 高级设置 -->
                <div class="cosyvoice-section">
                    <h3>⚙️ 高级设置</h3>
                    <div class="cosyvoice-setting-item">
                        <label>预加载数量: <span id="cosyvoice-preload-value">${settings.preloadCount}</span></label>
                        <input type="range" id="cosyvoice-preload-count" min="1" max="10" step="1" value="${settings.preloadCount}">
                    </div>
                </div>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    bindSettingsEvents(modal);
    updateClonePresetList();
}

function bindSettingsEvents(modal) {
    const settings = getSettings();
    
    // 关闭按钮
    modal.querySelector('.cosyvoice-close-btn').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.remove();
    });
    
    // API 地址
    const apiUrlInput = modal.querySelector('#cosyvoice-api-url');
    apiUrlInput.addEventListener('change', () => {
        updateSetting('apiBaseUrl', apiUrlInput.value.replace(/\/$/, ''));
    });
    
    // 测试连接
    modal.querySelector('#cosyvoice-test-connection').addEventListener('click', async () => {
        const btn = modal.querySelector('#cosyvoice-test-connection');
        btn.disabled = true;
        btn.textContent = '测试中...';
        
        const result = await testConnection();
        
        btn.disabled = false;
        btn.textContent = '测试';
        
        if (result.success) {
            showNotification('连接成功！', 'success');
            // 自动获取角色列表
            await fetchSpeakers();
            updateSpeakerSelect();
        } else {
            showNotification(`连接失败: ${result.error}`, 'error');
        }
    });
    
    // 语速
    const speedSlider = modal.querySelector('#cosyvoice-speed');
    const speedValue = modal.querySelector('#cosyvoice-speed-value');
    speedSlider.addEventListener('input', () => {
        speedValue.textContent = parseFloat(speedSlider.value).toFixed(1);
    });
    speedSlider.addEventListener('change', () => {
        updateSetting('speed', parseFloat(speedSlider.value));
    });
    
    // 模式切换
    modal.querySelectorAll('.cosyvoice-mode-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const mode = tab.dataset.mode;
            updateSetting('mode', mode);
            
            modal.querySelectorAll('.cosyvoice-mode-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            
            modal.querySelector('#cosyvoice-preset-mode').classList.toggle('hidden', mode !== 'preset');
            modal.querySelector('#cosyvoice-clone-mode').classList.toggle('hidden', mode !== 'clone');
            
            updatePresetIndicator();
        });
    });
    
    // 角色选择
    const speakerSelect = modal.querySelector('#cosyvoice-speaker-select');
    speakerSelect.addEventListener('change', () => {
        updateSetting('selectedSpeaker', speakerSelect.value);
        modal.querySelector('#cosyvoice-current-speaker').textContent = speakerSelect.value || '无';
        modal.querySelector('.cosyvoice-speaker-info').classList.toggle('hidden', !speakerSelect.value);
        updatePresetIndicator();
    });
    
    // 刷新角色列表
    modal.querySelector('#cosyvoice-refresh-speakers').addEventListener('click', async () => {
        const btn = modal.querySelector('#cosyvoice-refresh-speakers');
        btn.disabled = true;
        btn.textContent = '刷新中...';
        
        const speakers = await fetchSpeakers();
        
        btn.disabled = false;
        btn.textContent = '刷新';
        
        if (speakers.length > 0) {
            updateSpeakerSelect();
            showNotification(`获取到 ${speakers.length} 个角色`, 'success');
        } else {
            showNotification('获取角色列表失败', 'error');
        }
    });
    
    // 音频上传
    const audioFile = modal.querySelector('#cosyvoice-audio-file');
    const uploadBtn = modal.querySelector('#cosyvoice-upload-audio');
    
    uploadBtn.addEventListener('click', () => audioFile.click());
    
    audioFile.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        try {
            uploadBtn.disabled = true;
            modal.querySelector('#cosyvoice-audio-filename').textContent = '加载中...';
            
            const base64 = await fileToBase64(file);
            updateSetting('tempPromptAudioBase64', base64);
            updateSetting('tempPromptAudioName', file.name);
            
            modal.querySelector('#cosyvoice-audio-filename').textContent = file.name;
            uploadBtn.disabled = false;
            
            let statusSpan = uploadBtn.parentNode.querySelector('.cosyvoice-file-status');
            if (!statusSpan) {
                statusSpan = document.createElement('span');
                statusSpan.className = 'cosyvoice-file-status';
                uploadBtn.parentNode.appendChild(statusSpan);
            }
            statusSpan.textContent = '✓';
            
            showNotification('音频已加载', 'success');
            updatePresetIndicator();
        } catch (error) {
            uploadBtn.disabled = false;
            modal.querySelector('#cosyvoice-audio-filename').textContent = '选择音频文件';
            showNotification(`加载音频失败: ${error.message}`, 'error');
        }
    });
    
    // 参考文本
    modal.querySelector('#cosyvoice-prompt-text').addEventListener('input', (e) => {
        updateSetting('tempPromptText', e.target.value);
        updatePresetIndicator();
    });
    
    // TTS 模式
    modal.querySelector('#cosyvoice-tts-mode').addEventListener('change', (e) => {
        updateSetting('ttsMode', e.target.value);
        modal.querySelector('.cosyvoice-instruction').classList.toggle('hidden', e.target.value !== '指令控制');
    });
    
    // 情感指令
    modal.querySelector('#cosyvoice-instruction').addEventListener('input', (e) => {
        updateSetting('instruction', e.target.value);
    });
    
    // 保存克隆预设
    modal.querySelector('#cosyvoice-save-clone-preset').addEventListener('click', () => {
        const promptText = settings.tempPromptText;
        const promptAudioBase64 = settings.tempPromptAudioBase64;
        const promptAudioName = settings.tempPromptAudioName;
        
        if (!promptText || !promptAudioBase64) {
            showNotification('请先设置参考音频和参考文本', 'warning');
            return;
        }
        
        const name = prompt('请输入预设名称:', `克隆预设 ${getClonePresets().length + 1}`);
        if (!name) return;
        
        addClonePreset({
            name,
            promptText,
            promptAudioBase64,
            promptAudioName
        });
        
        updateClonePresetList();
        showNotification('克隆预设已保存', 'success');
    });
    
    // 引号设置
    modal.querySelector('#cosyvoice-extract-quotes').addEventListener('change', (e) => {
        updateSetting('extractQuotesOnly', e.target.checked);
    });
    
    modal.querySelectorAll('input[name="quotation-style"]').forEach(radio => {
        radio.addEventListener('change', () => {
            updateSetting('quotationStyle', radio.value);
            
            modal.querySelectorAll('.cosyvoice-radio-item').forEach(item => {
                item.classList.toggle('active', item.querySelector('input').value === radio.value);
            });
            
            modal.querySelector('.cosyvoice-custom-quotes').classList.toggle('hidden', radio.value !== 'custom');
            updateQuotePreview(modal);
        });
    });
    
    ['cosyvoice-quote-left', 'cosyvoice-quote-right'].forEach(id => {
        modal.querySelector(`#${id}`).addEventListener('input', (e) => {
            updateSetting(id === 'cosyvoice-quote-left' ? 'customQuotationLeft' : 'customQuotationRight', e.target.value);
            updateQuotePreview(modal);
        });
    });
    
    // 功能开关
    modal.querySelector('#cosyvoice-enabled').addEventListener('change', (e) => {
        updateSetting('enabled', e.target.checked);
        updateFloatingPanelVisibility();
    });
    
    modal.querySelector('#cosyvoice-auto-play').addEventListener('change', (e) => {
        updateSetting('autoPlay', e.target.checked);
    });
    
    // 预加载数量
    const preloadSlider = modal.querySelector('#cosyvoice-preload-count');
    const preloadValue = modal.querySelector('#cosyvoice-preload-value');
    preloadSlider.addEventListener('input', () => {
        preloadValue.textContent = preloadSlider.value;
    });
    preloadSlider.addEventListener('change', () => {
        updateSetting('preloadCount', parseInt(preloadSlider.value));
    });
}

function updateQuotePreview(modal) {
    const { left, right } = getQuotationMarks();
    const preview = modal.querySelector('#cosyvoice-quote-preview-text');
    if (preview) {
        preview.textContent = `${left}这是对话内容${right}`;
    }
}

// ==================== 悬浮面板 ====================

function createFloatingPanel() {
    if (document.getElementById('cosyvoice-floating-panel')) return;
    
    const panel = document.createElement('div');
    panel.id = 'cosyvoice-floating-panel';
    panel.className = 'cosyvoice-panel';
    panel.innerHTML = `
        <div class="cosyvoice-controls">
            <button id="cosyvoice-play-btn" class="cosyvoice-control-btn primary" title="播放">
                <span class="icon">▶</span>
                <span class="text">播放</span>
            </button>
            <button id="cosyvoice-pause-btn" class="cosyvoice-control-btn secondary" title="暂停/继续">
                <span class="icon">⏸</span>
                <span class="text">暂停</span>
            </button>
            <button id="cosyvoice-stop-btn" class="cosyvoice-control-btn danger" title="停止">
                <span class="icon">⏹</span>
                <span class="text">停止</span>
            </button>
            <button id="cosyvoice-settings-btn" class="cosyvoice-control-btn settings" title="设置">
                <span class="icon">⚙</span>
            </button>
        </div>
        <div class="cosyvoice-preset-indicator">
            <span id="cosyvoice-current-preset">未设置</span>
        </div>
    `;
    
    document.body.appendChild(panel);
    
    // 绑定事件
    document.getElementById('cosyvoice-play-btn').addEventListener('click', () => {
        if (!isPlaying) {
            playLatestMessage();
        }
    });
    
    document.getElementById('cosyvoice-pause-btn').addEventListener('click', () => {
        if (isPaused) {
            resumePlayback();
        } else {
            pausePlayback();
        }
    });
    
    document.getElementById('cosyvoice-stop-btn').addEventListener('click', stopPlayback);
    document.getElementById('cosyvoice-settings-btn').addEventListener('click', openSettingsModal);
    
    updatePresetIndicator();
    updateButtonStates();
    makeDraggable(panel);
    updateFloatingPanelVisibility();
}

function updateFloatingPanelVisibility() {
    const panel = document.getElementById('cosyvoice-floating-panel');
    if (panel) {
        const settings = getSettings();
        panel.style.display = settings.enabled ? 'flex' : 'none';
    }
}

function makeDraggable(element) {
    let isDragging = false;
    let startX, startY, startLeft, startTop;
    
    element.addEventListener('mousedown', (e) => {
        if (e.target.closest('button')) return;
        
        isDragging = true;
        element.classList.add('dragging');
        
        const rect = element.getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;
        startLeft = rect.left;
        startTop = rect.top;
        
        e.preventDefault();
    });
    
    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        
        const newLeft = startLeft + (e.clientX - startX);
        const newTop = startTop + (e.clientY - startY);
        
        element.style.left = `${newLeft}px`;
        element.style.top = `${newTop}px`;
        element.style.right = 'auto';
        element.style.transform = 'none';
    });
    
    document.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            element.classList.remove('dragging');
        }
    });
}

// ==================== 自动播放 ====================

function setupAutoPlay() {
    let debounceTimer = null;
    let lastMessageId = null;
    
    const observer = new MutationObserver(() => {
        const settings = getSettings();
        if (!settings.enabled || !settings.autoPlay) return;
        
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            const messages = document.querySelectorAll('div.mes[is_user="false"]');
            if (messages.length === 0) return;
            
            const lastMessage = messages[messages.length - 1];
            const messageId = lastMessage.getAttribute('mesid');
            
            if (messageId && messageId !== lastMessageId && !isPlaying) {
                lastMessageId = messageId;
                
                setTimeout(() => {
                    if (!isPlaying) {
                        playLatestMessage();
                    }
                }, 500);
            }
        }, 300);
    });
    
    const waitForChat = setInterval(() => {
        const chat = document.querySelector('#chat');
        if (chat) {
            observer.observe(chat, { childList: true, subtree: true, characterData: true });
            clearInterval(waitForChat);
            log('自动播放观察器已启动', 'success');
        }
    }, 500);
}

// ==================== 初始化 ====================

jQuery(async () => {
    log('扩展加载中...', 'info');
    
    loadSettings();
    
    // 加载 CSS
    try {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = `${extensionFolderPath}style.css`;
        document.head.appendChild(link);
    } catch (e) {
        log('CSS 加载失败', 'warn');
    }
    
    // 创建悬浮面板
    createFloatingPanel();
    
    // 设置自动播放
    setupAutoPlay();
    
    // 获取角色列表
    const settings = getSettings();
    if (settings.enabled) {
        fetchSpeakers().catch(() => {});
    }
    
    // 添加到扩展设置面板
    const settingsHtml = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>🎙️ CosyVoice TTS</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="cosyvoice-extension-settings">
                    <div class="cosyvoice-setting-row">
                        <label>
                            <input type="checkbox" id="cosyvoice-ext-enabled" ${settings.enabled ? 'checked' : ''}>
                            <span>启用扩展</span>
                        </label>
                    </div>
                    <div class="cosyvoice-setting-row">
                        <button id="cosyvoice-ext-open-settings" class="menu_button">打开设置面板</button>
                    </div>
                    <div class="cosyvoice-setting-row">
                        <button id="cosyvoice-ext-reset-position" class="menu_button">重置悬浮窗位置</button>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    $('#extensions_settings2').append(settingsHtml);
    
    $('#cosyvoice-ext-enabled').on('change', function() {
        updateSetting('enabled', this.checked);
        updateFloatingPanelVisibility();
    });
    
    $('#cosyvoice-ext-open-settings').on('click', openSettingsModal);
    
    $('#cosyvoice-ext-reset-position').on('click', () => {
        const panel = document.getElementById('cosyvoice-floating-panel');
        if (panel) {
            panel.style.left = '';
            panel.style.top = '50%';
            panel.style.right = '20px';
            panel.style.transform = 'translateY(-50%)';
            showNotification('悬浮窗位置已重置', 'success');
        }
    });
    
    log('扩展加载完成', 'success');
});
