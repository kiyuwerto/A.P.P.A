// ============================================================
// APPA — Editor de pitch/velocidad + Afinador. Todo 100% local.
// ============================================================
import { SoundTouch, SimpleFilter, WebAudioBufferSource } from './soundtouch.js';

const $ = (id) => document.getElementById(id);

// ---------- Elementos ----------
const fileInput = $('fileInput');
const btnUpload = $('btnUpload');
const btnRecord = $('btnRecord');
const previewBox = $('previewBox');
const placeholderText = $('placeholderText');
const videoSection = $('videoSection');
const videoEl = $('videoEl');
const waveCanvas = $('waveCanvas');
const previewControls = $('previewControls');
const btnPlayPause = $('btnPlayPause');
const timeLabel = $('timeLabel');
const statusBar = $('statusBar');

const timeline = $('timeline');
const tlCanvas = $('tlCanvas');
const tlEmpty = $('tlEmpty');

const pitchSlider = $('pitchSlider');
const pitchValue = $('pitchValue');
const speedSlider = $('speedSlider');
const speedValue = $('speedValue');

const btnPitchLock = $('btnPitchLock');
const btnDetectTone = $('btnDetectTone');
const btnReverse = $('btnReverse');
const btnExportFast = $('btnExportFast');
const btnExportPro = $('btnExportPro');
const btnTunerToggle = $('btnTunerToggle');
const tunerPanel = $('tunerPanel');
const tunerNote = $('tunerNote');
const tunerFreq = $('tunerFreq');
const tunerNeedle = $('tunerNeedle');
const tunerStatus = $('tunerStatus');
const stringsRow = $('stringsRow');
const btnUndo = $('btnUndo');
const btnRedo = $('btnRedo');
const reverseCanvas = $('videoReverseCanvas');
const reverseCanvasCtx = reverseCanvas ? reverseCanvas.getContext('2d') : null;

// ---------- Estado global ----------
let audioCtx = null;
let mediaType = null;      // 'audio' | 'video'
let originalBuffer = null; // AudioBuffer original (decodificado)
let workingBuffer = null;  // AudioBuffer tras reversa, etc.
let originalVideoFile = null; // File original si se cargó un video (para exportar con ffmpeg)
let videoObjectUrl = null;    // blob URL del video original (para restaurar src)
let reversedVideoUrl = null;  // blob URL del video revertido por FFmpeg (caché)
let sourceNode = null;
let isPlaying = false;
let isReversed = false;
let pitchLockOn = false;
let loopEnabled = false;
let trimMode = false;
let trimStart = 0;   // segundos (audio original)
let trimEnd = 0;     // segundos
let trimAction = 'keep'; // 'keep' conserva selección, 'cut' elimina trozo del medio
let videoMediaSource = null; // MediaElementAudioSourceNode (creado una sola vez, reutilizado)
let activeEffectNodes = []; // nodos de efectos activos, para desconectar al parar
let rafId = null;

let pitchSemis = 0;     // -48..48
let speedRate = 1.0;    // 0.05..10
let videoCollapsed = false;

// historial simple para undo/redo (guarda snapshots de estado de controles)
let history = [];
let historyIndex = -1;

// tuner
let tunerActive = false;
let tunerStream = null;
let tunerAudioCtx = null;
let liveToneRaf = null; // seguimiento de tono en vivo durante reproducción
let tunerAnalyser = null;
let tunerRafId = null;
let tunerMode = 'guitar';
let toneDisplayMode = 'original'; // 'original' | 'modified' para chips de detectar tono
let lastNoteCountsOrig = null;
let lastNoteCountsMod = null;
let lastNoteAnalyzed = 0;

// ============================================================
// Utilidades
// ============================================================
function ensureAudioCtx(){
  if(!audioCtx){
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.addEventListener('statechange', ()=> checkAndShowPermBanner());
  }
  return audioCtx;
}

function setStatus(msg, timeout){
  statusBar.textContent = msg || '';
  if(timeout){
    setTimeout(()=>{ if(statusBar.textContent===msg) statusBar.textContent=''; }, timeout);
  }
}

// ============================================================
// Panel de carga inline (Appa girando) — aparece entre las perillas y los
// botones, empujando el contenido de abajo, durante cualquier operación que
// tome tiempo: subir archivo, decodificar audio, exportar, grabar, etc.
// Usa un contador por si hay llamadas anidadas, para no ocultar antes de tiempo.
// ============================================================
let loadingDepth = 0;
function showLoading(text){
  loadingDepth++;
  const panel = $('inlineLoading');
  $('inlineLoadingText').textContent = text || 'Cargando…';
  panel.classList.remove('hidden');
}
function hideLoading(){
  loadingDepth = Math.max(0, loadingDepth-1);
  if(loadingDepth === 0){
    $('inlineLoading').classList.add('hidden');
  }
}
function setLoadingText(text){
  $('inlineLoadingText').textContent = text || 'Cargando…';
}

function fmtTime(s){
  if(!isFinite(s)) return '0:00';
  const m = Math.floor(s/60);
  const sec = Math.floor(s%60).toString().padStart(2,'0');
  return `${m}:${sec}`;
}

function semitonesToRate(semis){
  return Math.pow(2, semis/12);
}

function pushHistory(){
  // recorta futuro si estabamos en medio
  history = history.slice(0, historyIndex+1);
  history.push({ pitchSemis, speedRate, pitchLockOn, isReversed });
  historyIndex = history.length-1;
  updateUndoRedoButtons();
  scheduleSaveSession();
}

function updateUndoRedoButtons(){
  btnUndo.disabled = historyIndex<=0;
  btnRedo.disabled = historyIndex>=history.length-1;
}

function applyHistoryState(state){
  if(state._workingBuffer){
    // Restaurar audio (deshacer un "Limpiar pista")
    workingBuffer = state._workingBuffer;
    originalBuffer = state._originalBuffer || state._workingBuffer;
    mediaType = state._mediaType || 'audio';
    drawWaveform(workingBuffer);
    tlInit();
    playStartOffset = 0;
    waveCanvas.classList.remove('hidden');
    placeholderText.classList.add('hidden');
    previewControls.classList.remove('hidden');
    tlEmpty.classList.add('hidden');
    timeLabel.textContent = `0:00 / ${fmtTime(workingBuffer.duration)}`;
  } else if(state._clearTrack){
    // Rehacer el "Limpiar pista"
    workingBuffer = null; originalBuffer = null; mediaType = null;
    waveCanvas.classList.add('hidden');
    placeholderText.classList.remove('hidden');
    previewControls.classList.add('hidden');
    tlEmpty.classList.remove('hidden');
    TL.waveImg = null; TL.pos = 0;
    tlCanvas.getContext('2d').clearRect(0,0,tlCanvas.width,tlCanvas.height);
    waveCanvas.getContext('2d').clearRect(0,0,waveCanvas.width,waveCanvas.height);
    timeLabel.textContent = '0:00 / 0:00';
    stopPlayback();
  }
  pitchSemis = state.pitchSemis;
  speedRate = state.speedRate;
  pitchLockOn = state.pitchLockOn;
  isReversed = state.isReversed;
  pitchSlider.value = pitchSemis;
  pitchValue.value = pitchSemis.toFixed(3);
  speedSlider.value = speedRate;
  speedValue.value = speedRate.toFixed(3);
  btnPitchLock.classList.toggle('active', pitchLockOn);
  btnReverse.classList.toggle('active', isReversed);
  if(!state._clearTrack) restartPlaybackIfPlaying();
  updatePitchLockHint();
  updateReanalyzeShimmer();
}

function updatePitchLockHint(){
  const hint = $('pitchLockHint');
  if(!pitchLockOn){ hint.classList.add('hidden'); return; }
  const equiv = Math.pow(2, pitchSemis / 12);
  hint.textContent = `Este pitch se corresponde con la velocidad ${equiv.toFixed(2)}x`;
  hint.classList.remove('hidden');
}

// ============================================================
// Carga de archivo (audio o video) + grabación de mic
// ============================================================
btnUpload.addEventListener('click', ()=> fileInput.click());

fileInput.addEventListener('change', async (e)=>{
  const file = e.target.files[0];
  if(!file) return;
  await loadFile(file);
});

async function loadFile(file){
  setStatus('Cargando archivo…');
  showLoading('Cargando archivo…');
  stopPlayback();
  const isVideo = file.type.startsWith('video');
  mediaType = isVideo ? 'video' : 'audio';
  originalVideoFile = isVideo ? file : null;

  // Revocar URLs anteriores y guardar la nueva
  if(videoObjectUrl){ URL.revokeObjectURL(videoObjectUrl); videoObjectUrl = null; }
  if(reversedVideoUrl){ URL.revokeObjectURL(reversedVideoUrl); reversedVideoUrl = null; }
  showReverseCanvas(false);
  const url = URL.createObjectURL(file);
  if(isVideo) videoObjectUrl = url;

  if(isVideo){
    videoEl.src = url;
    videoSection.classList.remove('hidden');
    videoCollapsed = false;
    const prevInner = $('videoPrevInner');
    if(prevInner) prevInner.style.display = '';
    const vToggle = $('btnVideoToggle');
    if(vToggle) vToggle.textContent = '▲ Ocultar video';
    waveCanvas.classList.remove('hidden');
    placeholderText.classList.add('hidden');
    videoEl.onloadedmetadata = ()=>{
      previewControls.classList.remove('hidden');
      timeLabel.textContent = `0:00 / ${fmtTime(videoEl.duration)}`;
    };
  } else {
    videoSection.classList.add('hidden');
    waveCanvas.classList.remove('hidden');
    placeholderText.classList.add('hidden');
    previewControls.classList.remove('hidden');
  }

  // Decodificar audio para pitch/velocidad/edición
  try{
    const arrayBuf = await file.arrayBuffer();
    const ctx = ensureAudioCtx();
    let decoded = null;
    try{
      // Intento directo: funciona para audio puro y muchos videos en Chrome
      decoded = await ctx.decodeAudioData(arrayBuf.slice(0));
    }catch(decErr){
      if(!isVideo) throw decErr;
      // Safari/iOS: decodeAudioData no soporta contenedores de video (MP4/MOV).
      // Extraer audio con FFmpeg en BACKGROUND — el video ya es reproducible
      // mientras tanto, y la onda/edición aparecen cuando termina.
      // (finally de afuera llama hideLoading al salir con return)
      extractVideoAudioBackground(arrayBuf, ctx);
      return;
    }
    originalBuffer = decoded;
    workingBuffer = originalBuffer;
    isReversed = false;
    drawWaveform(workingBuffer);
    tlInit();
    playStartOffset = 0;
    timeLabel.textContent = `0:00 / ${fmtTime(originalBuffer.duration)}`;
    setStatus('Listo ✓', 1500);
    pushHistory();
  }catch(err){
    console.error(err);
    setStatus('No se pudo decodificar el audio de este archivo');
  } finally {
    hideLoading();
  }
}

async function extractVideoAudioBackground(arrayBuf, audioCtx){
  setStatus('Extrayendo audio del video… (si es la primera vez puede tardar)');
  try{
    showFfmpegProgress(true, 'Cargando motor… (primera vez descarga ~25 MB)');
    const ff = await getFfmpeg();
    showFfmpegProgress(true, 'Extrayendo pista de audio…');
    await ff.writeFile('appa_vin', new Uint8Array(arrayBuf));
    await ff.exec(['-i','appa_vin','-vn','-acodec','pcm_s16le','-ar','44100','appa_vout.wav']);
    const wavData = await ff.readFile('appa_vout.wav');
    ff.deleteFile('appa_vin').catch(()=>{});
    ff.deleteFile('appa_vout.wav').catch(()=>{});
    const decoded = await audioCtx.decodeAudioData(wavData.buffer.slice(0));
    originalBuffer = decoded;
    workingBuffer = decoded;
    isReversed = false;
    drawWaveform(workingBuffer);
    tlInit();
    playStartOffset = 0;
    if(videoEl && !videoEl.classList.contains('hidden'))
      timeLabel.textContent = `0:00 / ${fmtTime(videoEl.duration || originalBuffer.duration)}`;
    setStatus('Audio extraído ✓ — ya podés editar el audio', 3000);
    pushHistory();
  }catch(err){
    console.error('Extracción de audio de video falló:', err);
    setStatus('No se pudo extraer el audio. El video se puede reproducir, pero no editar.');
  } finally {
    showFfmpegProgress(false);
  }
}

// --- Grabación con micrófono ---
let mediaRecorder = null;
let recordedChunks = [];
let isRecording = false;
let recAudioCtx = null;
let recAnalyser = null;
let recStream = null;
let recRafId = null;
let recWaveform = [];   // amplitudes acumuladas durante la grabación
let recStartTime = 0;
let isOverdub = false;
let overdubStartSec = 0;

async function beginRecording(overdub){
  if(isRecording){ mediaRecorder.stop(); return; }
  if(overdub && !workingBuffer){ setStatus('Primero necesitas un audio cargado para grabar encima', 2500); return; }

  isOverdub = overdub;
  overdubStartSec = overdub ? TL.pos : 0;

  try{
    const stream = await navigator.mediaDevices.getUserMedia({audio:true});
    recStream = stream;
    mediaRecorder = new MediaRecorder(stream);
    recordedChunks = [];
    recWaveform = [];
    mediaRecorder.ondataavailable = (e)=> recordedChunks.push(e.data);
    mediaRecorder.onstop = async ()=>{
      isRecording = false;
      updateAppaAnimation();
      btnRecord.textContent = 'Grabar mic';
      btnRecord.classList.remove('recording');
      btnOverdub.textContent = 'Grabar encima';
      btnOverdub.classList.remove('recording');
      stopRecVisualization();
      stream.getTracks().forEach(t=>t.stop());
      const blob = new Blob(recordedChunks, {type:'audio/webm'});
      const file = new File([blob], 'grabacion.webm', {type:'audio/webm'});

      if(isOverdub){
        await applyOverdub(file);
      } else {
        await loadFile(file);
      }
    };

    // --- visualización en vivo ---
    // Reutilizamos el AudioContext compartido (no crear uno nuevo): Safari/iOS limita
    // a muy pocas instancias de AudioContext por página, y crear/cerrar varios deja
    // el audio de toda la app roto tras unos pocos usos.
    recAudioCtx = ensureAudioCtx();
    const src = recAudioCtx.createMediaStreamSource(stream);
    recAnalyser = recAudioCtx.createAnalyser();
    recAnalyser.fftSize = 1024;
    src.connect(recAnalyser);

    if(!overdub){
      // preparar el timeline para mostrar la grabación en curso desde cero
      mediaType = 'audio';
      videoSection.classList.add('hidden');
      waveCanvas.classList.remove('hidden');
      placeholderText.classList.add('hidden');
      previewControls.classList.add('hidden');
      tlEmpty.classList.add('hidden');
    }
    recStartTime = performance.now();

    mediaRecorder.start();
    isRecording = true;
    updateAppaAnimation();
    if(overdub){
      btnOverdub.textContent = 'Detener ■';
      btnOverdub.classList.add('recording');
      setStatus('Grabando encima desde ' + fmtTime(overdubStartSec) + '…');
    } else {
      btnRecord.textContent = 'Detener ■';
      btnRecord.classList.add('recording');
      setStatus('Grabando…');
    }
    drawRecVisualization();
  }catch(err){
    console.error(err);
    setStatus('No se pudo acceder al micrófono');
  }
}

btnRecord.addEventListener('click', ()=> beginRecording(false));
const btnOverdub = $('btnOverdub');
btnOverdub.addEventListener('click', ()=> beginRecording(true));

// Mezcla la nueva grabación sobre el audio existente, reemplazando el tramo
// que va desde overdubStartSec hasta donde alcance la nueva grabación.
async function applyOverdub(file){
  setStatus('Procesando grabación…');
  showLoading('Procesando grabación…');
  try{
    const arrayBuf = await file.arrayBuffer();
    const ctx = ensureAudioCtx();
    const newClip = await ctx.decodeAudioData(arrayBuf);

    const base = originalBuffer;
    const sr = base.sampleRate;
    const startSample = Math.floor(overdubStartSec * sr);
    const newClipLen = newClip.length;
    const endSample = startSample + newClipLen;
    const totalLen = Math.max(base.length, endSample);

    const merged = ctx.createBuffer(base.numberOfChannels, totalLen, sr);
    for(let ch=0; ch<base.numberOfChannels; ch++){
      const baseData = base.getChannelData(ch);
      const outData = merged.getChannelData(ch);
      // copiar el audio base completo primero
      outData.set(baseData, 0);
      // pisar el tramo con la grabación nueva (usa canal 0 si la nueva es mono)
      const newData = newClip.getChannelData(Math.min(ch, newClip.numberOfChannels-1));
      outData.set(newData, startSample);
    }

    originalBuffer = merged;
    workingBuffer = merged;
    reversedCache = null; reversedCacheSrc = null;
    isReversed = false;
    btnReverse.classList.remove('active');
    drawWaveform(workingBuffer);
    tlInit();
    timeLabel.textContent = `0:00 / ${fmtTime(originalBuffer.duration)}`;
    setStatus('Grabación añadida ✓', 2000);
    pushHistory();
  }catch(err){
    console.error(err);
    setStatus('Error al procesar la grabación encima');
  } finally {
    hideLoading();
  }
}

function stopRecVisualization(){
  if(recRafId) cancelAnimationFrame(recRafId);
  recRafId = null;
  // NO cerramos recAudioCtx: es el contexto compartido de toda la app (ensureAudioCtx).
  // Cerrarlo aquí dejaría sin audio al resto de la app (reproducción, etc.).
  recAudioCtx = null;
  recAnalyser = null;
}

function drawRecVisualization(){
  if(!isRecording || !recAnalyser) return;
  const buf = new Float32Array(recAnalyser.fftSize);
  recAnalyser.getFloatTimeDomainData(buf);
  // amplitud RMS de este frame
  let sum = 0;
  for(let i=0;i<buf.length;i++) sum += buf[i]*buf[i];
  const rms = Math.sqrt(sum/buf.length);
  recWaveform.push(rms);

  // dibujar la onda acumulada en el canvas de preview (oculto)
  drawRollingWave(waveCanvas, previewBox, recWaveform);

  const elapsed = (performance.now() - recStartTime)/1000;

  if(isOverdub){
    // Avanzar el playhead según el tiempo grabado para que tlDraw muestre el progreso
    TL.pos = overdubStartSec + elapsed;
    // tlDraw() dibuja el waveform original + barras rojas superpuestas (vía tlAnimate)
  } else {
    // Grabación nueva: dibujar rolling wave directamente en el timeline
    drawRollingWave(tlCanvas, timeline, recWaveform, true);
  }

  setStatus('Grabando… ' + fmtTime(elapsed));

  recRafId = requestAnimationFrame(drawRecVisualization);
}

// Dibuja una forma de onda tipo barras a partir de un array de amplitudes,
// mostrando las más recientes a la derecha (efecto de avance).
function drawRollingWave(canvas, container, amps, centerLine){
  const dpr = window.devicePixelRatio || 1;
  const rect = container.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  if(canvas.width !== w*dpr || canvas.height !== h*dpr){
    canvas.width = w*dpr; canvas.height = h*dpr;
    canvas.style.width = w+'px'; canvas.style.height = h+'px';
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,w,h);

  const barW = 3, gap = 1;
  const totalBars = Math.floor(w/(barW+gap));
  const slice = amps.slice(-totalBars); // las más recientes
  const mid = h/2;
  const cs = getComputedStyle(document.documentElement);
  ctx.fillStyle = cs.getPropertyValue('--brown').trim() || '#7a4a26';

  for(let i=0;i<slice.length;i++){
    const amp = Math.min(1, slice[i]*4); // escalar para que se vea
    const barH = Math.max(2, amp*h*0.85);
    const x = i*(barW+gap);
    ctx.fillRect(x, mid - barH/2, barW, barH);
  }

  if(centerLine){
    // línea de playhead al centro como en el timeline normal
    const phColor = getComputedStyle(document.documentElement).getPropertyValue('--white').trim() || '#fff';
  }
}

// ============================================================
// LIMPIAR TODO el campo de trabajo
// ============================================================
$('btnClearTrack').addEventListener('click', ()=>{
  if(!workingBuffer && !originalBuffer){ setStatus('No hay nada que limpiar', 1500); return; }
  $('confirmClearText').textContent = originalVideoFile
    ? 'Se borrará el video cargado. Al ser un video, esta acción no se puede deshacer.'
    : 'Se borrará el audio cargado. Puedes deshacerlo con ↩ después si quieres.';
  $('confirmClearDialog').classList.remove('hidden');
});

$('btnResetMods').addEventListener('click', ()=>{
  doResetMods();
});

$('confirmClearNo').addEventListener('click', ()=>{
  $('confirmClearDialog').classList.add('hidden');
});
$('confirmClearYes').addEventListener('click', ()=>{
  $('confirmClearDialog').classList.add('hidden');
  // Para audio (no video) guardamos el estado en el historial para que se pueda deshacer
  if(workingBuffer && !originalVideoFile){
    history = history.slice(0, historyIndex+1);
    history.push({ pitchSemis, speedRate, pitchLockOn, isReversed,
      _workingBuffer: workingBuffer, _originalBuffer: originalBuffer, _mediaType: mediaType });
    doClearAll(true); // preserveHistory=true: no resetea el array de historial
    history.push({ pitchSemis:0, speedRate:1, pitchLockOn:false, isReversed:false, _clearTrack:true });
    historyIndex = history.length-1;
    updateUndoRedoButtons();
  } else {
    doClearAll();
  }
});
$('confirmClearDialog').addEventListener('click', (e)=>{
  if(e.target.id === 'confirmClearDialog') $('confirmClearDialog').classList.add('hidden');
});

function doResetMods(){
  stopPlayback();
  pitchSemis = 0; pitchSlider.value = 0; pitchValue.value = '0.000';
  speedRate = 1.0; speedSlider.value = 1; speedValue.value = '1.000';
  isReversed = false; btnReverse.classList.remove('active');
  pitchLockOn = false; btnPitchLock.classList.remove('active');
  loopEnabled = false; btnLoop.classList.remove('active');
  trimMode = false; btnTrim.classList.remove('active');
  trimPanel.classList.add('hidden'); clearTrimMarkers();
  updateReanalyzeShimmer();

  liveReverbWet=null; liveReverbDry=null; liveDistShaper=null;
  liveComp=null; liveDelayNode=null; liveDelayFb=null; liveEqFilters=[];
  // Apagar efectos
  reverbOn = false;
  $('reverbToggle').textContent='OFF'; $('reverbToggle').classList.remove('active'); $('reverbCtrl').classList.add('hidden');
  distortionOn = false;
  $('distortionToggle').textContent='OFF'; $('distortionToggle').classList.remove('active'); $('distortionCtrl').classList.add('hidden');
  compOn = false;
  $('compToggle').textContent='OFF'; $('compToggle').classList.remove('active'); $('compCtrl').classList.add('hidden');
  delayOn = false;
  $('delayToggle').textContent='OFF'; $('delayToggle').classList.remove('active'); $('delayCtrl').classList.add('hidden');
  eqOn = false;
  $('eqToggle').textContent='OFF'; $('eqToggle').classList.remove('active'); $('eqCtrl').classList.add('hidden');

  // Cerrar paneles
  efectosPanel.classList.add('hidden'); btnEfectos.classList.remove('active','efx-glow');
  $('acordesPanel').classList.add('hidden'); $('btnAcordes').classList.remove('active');
  if(!tunerPanel.classList.contains('hidden')){ tunerPanel.classList.add('hidden'); }
  btnTunerToggle.classList.remove('active');

  setStatus('Modificaciones reseteadas ✓', 2000);
}

function doClearAll(preserveHistory = false){
  stopPlayback();
  originalBuffer = null;
  workingBuffer = null;
  originalVideoFile = null;
  if(videoObjectUrl){ URL.revokeObjectURL(videoObjectUrl); videoObjectUrl = null; }
  if(reversedVideoUrl){ URL.revokeObjectURL(reversedVideoUrl); reversedVideoUrl = null; }
  showReverseCanvas(false);
  reversedCache = null; reversedCacheSrc = null;
  mediaType = null;
  isReversed = false;
  pitchLockOn = false;
  loopEnabled = false;
  trimMode = false;
  pitchSemis = 0;
  speedRate = 1.0;
  playStartOffset = 0;
  if(!preserveHistory){ history = []; historyIndex = -1; updateUndoRedoButtons(); }

  pitchSlider.value = 0; pitchValue.value = '0.000';
  speedSlider.value = 1; speedValue.value = '1.000';
  updateReanalyzeShimmer();
  btnReverse.classList.remove('active');
  btnPitchLock.classList.remove('active');
  btnLoop.classList.remove('active');
  btnTrim.classList.remove('active');
  trimPanel.classList.add('hidden');
  clearTrimMarkers();

  videoEl.src = '';
  videoSection.classList.add('hidden');
  waveCanvas.classList.add('hidden');
  placeholderText.classList.remove('hidden');
  previewControls.classList.add('hidden');
  tlEmpty.classList.remove('hidden');
  TL.waveImg = null; TL.pos = 0;
  const tlCtx = tlCanvas.getContext('2d');
  tlCtx.clearRect(0,0,tlCanvas.width,tlCanvas.height);
  const wCtx = waveCanvas.getContext('2d');
  wCtx.clearRect(0,0,waveCanvas.width,waveCanvas.height);
  timeLabel.textContent = '0:00 / 0:00';

  clearSavedSession(); // ya no hay nada que restaurar
  setStatus('Campo de trabajo limpiado ✓', 2000);
}

// ============================================================
// Waveform
// ============================================================
function drawWaveform(buffer){
  const dpr = window.devicePixelRatio || 1;
  const rect = previewBox.getBoundingClientRect();
  waveCanvas.width = rect.width*dpr;
  waveCanvas.height = rect.height*dpr;
  waveCanvas.style.width = rect.width+'px';
  waveCanvas.style.height = rect.height+'px';
  const ctx = waveCanvas.getContext('2d');
  ctx.scale(dpr,dpr);
  ctx.clearRect(0,0,rect.width,rect.height);

  const data = buffer.getChannelData(0);
  const w = rect.width, h = rect.height;
  const step = Math.ceil(data.length/w);
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--brown').trim() || '#7a4a26';
  ctx.beginPath();
  for(let x=0; x<w; x++){
    let min=1, max=-1;
    for(let j=0;j<step;j++){
      const idx = x*step+j;
      if(idx>=data.length) break;
      const v = data[idx];
      if(v<min) min=v;
      if(v>max) max=v;
    }
    const y1 = (1+min)*h/2;
    const y2 = (1+max)*h/2;
    ctx.fillRect(x, Math.min(y1,y2), 1, Math.max(2,Math.abs(y2-y1)));
  }
}

// ============================================================
// Reproducción con pitch + velocidad
// Estrategia:
//  - Sin pitch-lock: usamos playbackRate combinado -> el pitch sube/baja con la velocidad,
//    y el slider de pitch agrega un shift extra multiplicando el rate (como un "vari-speed" clásico).
//  - Con pitch-lock: la velocidad cambia el tempo SIN afectar el pitch real (time-stretch),
//    usando un OfflineAudioContext con granular simple para preview/exportación.
// Para preview en vivo usamos siempre AudioBufferSourceNode.playbackRate (rápido, sin glitches),
// y el pitch-lock se resuelve recalculando el buffer (pre-procesado) cuando está activo.
// ============================================================

let processedBuffer = null; // buffer ya con pitch-lock aplicado (si corresponde), listo para reproducir a velocidad "rate puro"

function getEffectiveBuffer(){
  return isReversed ? getReversedBuffer(workingBuffer) : workingBuffer;
}

let reversedCache = null;
let reversedCacheSrc = null;
function getReversedBuffer(buffer){
  if(reversedCacheSrc===buffer && reversedCache) return reversedCache;
  const ctx = ensureAudioCtx();
  const rev = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  for(let ch=0; ch<buffer.numberOfChannels; ch++){
    const src = buffer.getChannelData(ch);
    const dst = rev.getChannelData(ch);
    for(let i=0;i<src.length;i++){
      dst[i] = src[src.length-1-i];
    }
  }
  reversedCache = rev;
  reversedCacheSrc = buffer;
  return rev;
}

// ============================================================
// Motor de procesamiento con SoundTouch (WSOLA, calidad profesional)
// pitch: factor multiplicativo del tono (1 = igual)
// tempo: factor de velocidad sin afectar tono (1 = igual)
// Procesa un AudioBuffer completo y devuelve uno nuevo.
// ============================================================
function processWithSoundTouch(buffer, pitchFactor, tempoFactor){
  const ctx = ensureAudioCtx();
  const numCh = buffer.numberOfChannels;
  const inLen = buffer.length;
  const sr = buffer.sampleRate;

  // Padding de silencio al final para drenar la latencia interna de SoundTouch
  // (su buffer de historia es ~22050 muestras). Así no se corta el final del audio.
  const padFrames = 24000;
  const paddedLen = inLen + padFrames;
  const padded = ctx.createBuffer(numCh, paddedLen, sr);
  for(let ch=0; ch<numCh; ch++){
    padded.getChannelData(ch).set(buffer.getChannelData(ch), 0);
  }

  const source = new WebAudioBufferSource(padded);
  const st = new SoundTouch();
  st.pitch = pitchFactor;
  st.tempo = tempoFactor;

  const filter = new SimpleFilter(source, st);

  const BUFFER_SIZE = 4096;
  const samples = new Float32Array(BUFFER_SIZE * 2);
  const left = [];
  const right = [];
  let framesExtracted;
  do {
    framesExtracted = filter.extract(samples, BUFFER_SIZE);
    for(let i=0;i<framesExtracted;i++){
      left.push(samples[i*2]);
      right.push(samples[i*2+1]);
    }
  } while(framesExtracted > 0);

  // Recortar a la duración teórica esperada (inLen ajustado por tempo)
  const expectedLen = Math.floor(inLen / tempoFactor);
  let outLen = Math.min(left.length, expectedLen);
  if(outLen <= 0) outLen = left.length;
  if(outLen === 0) return buffer;

  const out = ctx.createBuffer(numCh, outLen, sr);
  const outL = out.getChannelData(0);
  for(let i=0;i<outLen;i++) outL[i] = left[i];
  if(numCh > 1){
    const outR = out.getChannelData(1);
    for(let i=0;i<outLen;i++) outR[i] = right[i];
  }
  return out;
}

// Construye el buffer listo para reproducir, aplicando pitch/velocidad según el modo.
function buildPlaybackBuffer(){
  let buf = getEffectiveBuffer();
  const pitchFactor = semitonesToRate(pitchSemis);

  if(pitchLockOn){
    // Pitch-lock ON: el tono lo fija el slider de pitch, la velocidad NO afecta el tono.
    const needsProcess = Math.abs(pitchSemis) > 0.001 || Math.abs(speedRate - 1) > 0.001;
    if(needsProcess){
      setStatus('Procesando…');
      buf = processWithSoundTouch(buf, pitchFactor, speedRate);
      setStatus('');
    }
  } else {
    // Pitch-lock OFF (vari-speed clásico tipo cinta): velocidad y pitch cambian juntos el rate.
    // Esto se maneja con playbackRate en computePlaybackRate(), sin procesar el buffer.
  }
  return buf;
}

function computePlaybackRate(){
  if(pitchLockOn){
    // todo ya está aplicado en el buffer; reproducir a velocidad normal
    return 1.0;
  } else {
    // vari-speed: pitch y velocidad afectan el rate (sube velocidad => sube tono)
    return speedRate * semitonesToRate(pitchSemis);
  }
}

// Para video CON pitch-lock: procesa el audio con pitch y velocidad independientes,
// porque el video se reproduce silenciado y el audio procesado suena por separado.
function buildPlaybackBufferForVideo(){
  let buf = getEffectiveBuffer();
  const pitchFactor = semitonesToRate(pitchSemis);
  setStatus('Procesando audio del video…');
  buf = processWithSoundTouch(buf, pitchFactor, speedRate);
  setStatus('');
  return buf;
}

const appaFaceWrap = $('appaFaceWrap');
function updateAppaAnimation(){
  appaFaceWrap.classList.toggle('spinning', isPlaying || isRecording);
}

// ============================================================
// REVERB (ConvolverNode con impulso sintético)
// ============================================================
let reverbOn = false;
let reverbMix = 0.30;
let reverbIR = null; // impulso en caché
// Referencias a nodos vivos del grafo de efectos (para actualizar params sin reiniciar)
let liveReverbWet = null, liveReverbDry = null;
let liveDistShaper = null;
let liveComp = null;
let liveDelayNode = null, liveDelayFb = null;
let liveEqFilters = [];

function getReverbIR(audioCtx){
  if(reverbIR) return reverbIR;
  const sr = audioCtx.sampleRate;
  const len = Math.floor(sr * 0.8);
  const buf = audioCtx.createBuffer(2, len, sr);
  for(let c=0; c<2; c++){
    const ch = buf.getChannelData(c);
    for(let i=0; i<len; i++) ch[i] = (Math.random()*2-1) * Math.pow(1-i/len, 2);
  }
  reverbIR = buf;
  return buf;
}

function createDistortionCurve(amount){
  const n = 512;
  const curve = new Float32Array(n);
  const k = amount * 200 + 1; // 1 (suave) → 201 (bestial)
  for(let i=0; i<n; i++){
    const x = (i * 2) / n - 1;
    curve[i] = Math.tanh(k * x);
  }
  return curve;
}

function connectToOutput(source, audioCtx){
  activeEffectNodes = [];
  // Limpiar refs de nodos vivos (se rellenan abajo si el efecto está activo)
  liveDistShaper = null; liveEqFilters = []; liveComp = null;
  liveDelayNode = null; liveDelayFb = null;
  liveReverbWet = null; liveReverbDry = null;
  let signal = source;

  // 1. Distorsión
  if(distortionOn){
    const ws = audioCtx.createWaveShaper();
    ws.curve = createDistortionCurve(distortionAmount);
    ws.oversample = '4x';
    liveDistShaper = ws;
    signal.connect(ws); signal = ws;
    activeEffectNodes.push(ws);
  }

  // 2. Ecualizador (5 bandas en serie)
  if(eqOn){
    for(let i = 0; i < EQ_BANDS.length; i++){
      const f = audioCtx.createBiquadFilter();
      f.type = EQ_BANDS[i].type;
      f.frequency.value = EQ_BANDS[i].freq;
      f.gain.value = eqGains[i];
      if(f.type === 'peaking') f.Q.value = 1.0;
      liveEqFilters.push(f);
      signal.connect(f); signal = f;
      activeEffectNodes.push(f);
    }
  }

  // 3. Compresor
  if(compOn){
    const comp = audioCtx.createDynamicsCompressor();
    comp.threshold.value = compThreshold;
    comp.ratio.value = compRatio;
    comp.knee.value = 10;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    liveComp = comp;
    signal.connect(comp); signal = comp;
    activeEffectNodes.push(comp);
  }

  // 4. Delay (wet + dry mezclados en un GainNode)
  if(delayOn){
    const delNode = audioCtx.createDelay(2.0);
    delNode.delayTime.value = delayTime;
    const fbGain = audioCtx.createGain();
    fbGain.gain.value = delayFeedback;
    const wetGain = audioCtx.createGain();
    wetGain.gain.value = 0.45;
    const merger = audioCtx.createGain();
    liveDelayNode = delNode; liveDelayFb = fbGain;
    signal.connect(merger);
    signal.connect(delNode);
    delNode.connect(fbGain);
    fbGain.connect(delNode);
    delNode.connect(wetGain);
    wetGain.connect(merger);
    signal = merger;
    activeEffectNodes.push(delNode, fbGain, wetGain, merger);
  }

  // 5. Reverb al final (conecta directo al destino con wet/dry)
  if(reverbOn){
    const conv = audioCtx.createConvolver();
    conv.buffer = getReverbIR(audioCtx);
    const wet = audioCtx.createGain();
    const dry = audioCtx.createGain();
    wet.gain.value = reverbMix;
    dry.gain.value = 1 - reverbMix;
    liveReverbWet = wet; liveReverbDry = dry;
    signal.connect(dry);
    signal.connect(conv);
    conv.connect(wet);
    wet.connect(audioCtx.destination);
    dry.connect(audioCtx.destination);
    activeEffectNodes.push(conv, wet, dry);
  } else {
    signal.connect(audioCtx.destination);
  }
}

// ============================================================

function showReverseCanvas(show){
  if(!reverseCanvas) return;
  reverseCanvas.style.display = show ? 'block' : 'none';
}

function setupReverseCanvas(){
  if(!reverseCanvas) return;
  reverseCanvas.width  = videoEl.videoWidth  || videoEl.clientWidth  || 480;
  reverseCanvas.height = videoEl.videoHeight || videoEl.clientHeight || 270;
}

// Reproduce el video visualmente al revés via Canvas scrubbing.
// No depende de FFmpeg: busca el frame inverso en el <video> original en cada rAF.
// rate = velocidad efectiva que ya tiene el sourceNode (variSpeedRate o speedRate).
function tickVideoReverse(rate){
  const ctx = ensureAudioCtx();
  function step(){
    if(!isPlaying) return;
    const elapsed = ctx.currentTime - playStartCtxTime;
    const audioBufferPos = playStartOffset + elapsed * rate;
    const reversePos = Math.max(0, videoEl.duration - audioBufferPos);
    try{ videoEl.currentTime = reversePos; }catch(e){}
    if(reverseCanvasCtx && videoEl.videoWidth){
      reverseCanvasCtx.drawImage(videoEl, 0, 0, reverseCanvas.width, reverseCanvas.height);
    }
    timeLabel.textContent = `${fmtTime(reversePos)} / ${fmtTime(videoEl.duration)}`;
    if(reversePos <= 0.02 || audioBufferPos >= videoEl.duration){
      stopPlayback();
      return;
    }
    rafId = requestAnimationFrame(step);
  }
  step();
}

function stopPlayback(){
  if(sourceNode){
    try{ sourceNode.stop(); }catch(e){}
    sourceNode.disconnect();
    sourceNode = null;
  }
  activeEffectNodes.forEach(n=>{ try{ n.disconnect(); }catch(e){} });
  activeEffectNodes = [];
  if(videoMediaSource){ try{ videoMediaSource.disconnect(); }catch(e){} }
  if(videoEl && !videoEl.classList.contains('hidden')){
    videoEl.pause();
  }
  isPlaying = false;
  btnPlayPause.textContent = '▶';
  if(rafId) cancelAnimationFrame(rafId);
  updateAppaAnimation();
}

function restartPlaybackIfPlaying(){
  if(isPlaying){
    stopPlayback();
    startPlayback();
  }
}

let playStartCtxTime = 0;
let playStartOffset = 0;

function startPlayback(){
  const ctx = ensureAudioCtx();
  if(ctx.state==='suspended') ctx.resume();

  if(mediaType==='video'){
    // CON pitch-lock: el <video> nativo no puede separar pitch de velocidad, así que
    // se silencia y se reproduce el audio procesado (pitch independiente) en paralelo.
    // SIN pitch-lock: vari-speed clásico, igual que el audio puro — el pitch y la
    // velocidad están acoplados, así que el <video> nativo con su playbackRate ya
    // logra el efecto correcto (acelerar = más agudo) sin necesitar SoundTouch.
    const needsEffectsChain = reverbOn || distortionOn || compOn || delayOn || eqOn;
    if((pitchLockOn || (needsEffectsChain && Math.abs(pitchSemis) > 0.001)) && workingBuffer){
      videoEl.muted = true;
      if(isReversed){
        // Canvas reverse: posicionar en el frame inicial invertido
        const revStart = Math.max(0, videoEl.duration - playStartOffset);
        try{ videoEl.currentTime = revStart; }catch(e){}
      } else {
        videoEl.playbackRate = Math.min(16, Math.max(0.0625, speedRate));
        try{ if(playStartOffset>0 && Math.abs(videoEl.currentTime-playStartOffset)>0.1) videoEl.currentTime = playStartOffset; }catch(e){}
      }

      // audio procesado en paralelo (pitch fijo, tempo = speedRate)
      const buf = buildPlaybackBufferForVideo();
      sourceNode = ctx.createBufferSource();
      sourceNode.buffer = buf;
      sourceNode.playbackRate.value = 1.0; // el pitch y tempo ya están en el buffer
      connectToOutput(sourceNode, ctx);
      sourceNode.onended = ()=>{
        if(isPlaying){
          if(loopEnabled){
            playStartOffset = 0;
            TL.pos = 0;
            stopPlayback();
            startPlayback();
          } else {
            stopPlayback();
          }
        }
      };
      let bufOffset = playStartOffset;
      if(Math.abs(speedRate-1) > 0.001) bufOffset = playStartOffset / speedRate;
      bufOffset = Math.max(0, Math.min(bufOffset, buf.duration - 0.01));
      sourceNode.start(0, bufOffset);
      playStartCtxTime = ctx.currentTime;
      if(isReversed){
        setupReverseCanvas();
        showReverseCanvas(true);
        isPlaying = true;
        btnPlayPause.textContent = '❚❚';
        updateAppaAnimation();
        tickVideoReverse(speedRate);
      } else {
        videoEl.play();
        isPlaying = true;
        btnPlayPause.textContent = '❚❚';
        updateAppaAnimation();
        tickVideo();
      }
      return;
    }

    // Reversa sin pitch-lock: audio revertido por Web Audio + canvas para los frames.
    if(isReversed && workingBuffer){
      videoEl.muted = true;
      const variSpeedRate = speedRate * semitonesToRate(pitchSemis);
      // Canvas reverse: posicionar video en el frame inicial invertido
      const revStart = Math.max(0, videoEl.duration - playStartOffset);
      try{ videoEl.currentTime = revStart; }catch(e){}
      const buf = getEffectiveBuffer(); // buffer ya revertido
      sourceNode = ctx.createBufferSource();
      sourceNode.buffer = buf;
      sourceNode.playbackRate.value = Math.min(16, Math.max(0.0625, variSpeedRate));
      connectToOutput(sourceNode, ctx);
      sourceNode.onended = ()=>{
        if(isPlaying){
          if(loopEnabled){ playStartOffset=0; TL.pos=0; stopPlayback(); startPlayback(); }
          else stopPlayback();
        }
      };
      const bufOffset = Math.max(0, Math.min(playStartOffset, buf.duration - 0.01));
      sourceNode.start(0, bufOffset);
      playStartCtxTime = ctx.currentTime;
      setupReverseCanvas();
      showReverseCanvas(true);
      isPlaying = true;
      btnPlayPause.textContent = '❚❚';
      updateAppaAnimation();
      tickVideoReverse(variSpeedRate);
      return;
    }

    // Sin pitch-lock: reproducción nativa con su propio audio, acoplando pitch+velocidad.
    // CLAVE: los navegadores por defecto activan "preservesPitch" (corrigen el tono
    // automáticamente al cambiar playbackRate, para que no suene "a ardilla"). Hay que
    // desactivarlo explícitamente para que el cambio de pitch sea audible, como se espera
    // en este modo vari-speed clásico.
    videoEl.preservesPitch = false;
    videoEl.mozPreservesPitch = false;
    videoEl.webkitPreservesPitch = false;
    videoEl.muted = false;
    const variSpeedRate = speedRate * semitonesToRate(pitchSemis);
    videoEl.playbackRate = Math.min(16, Math.max(0.0625, variSpeedRate));
    try{ if(playStartOffset>0 && Math.abs(videoEl.currentTime-playStartOffset)>0.1) videoEl.currentTime = playStartOffset; }catch(e){}
    // Si hay algún efecto activo (o ya se creó el nodo una vez), routear por WebAudio
    if(reverbOn || distortionOn || compOn || delayOn || eqOn || videoMediaSource){
      if(!videoMediaSource) videoMediaSource = ctx.createMediaElementSource(videoEl);
      else try{ videoMediaSource.disconnect(); }catch(e){}
      connectToOutput(videoMediaSource, ctx);
    }
    videoEl.play();
    isPlaying = true;
    btnPlayPause.textContent = '❚❚';
    updateAppaAnimation();
    tickVideo();
    return;
  }

  if(!workingBuffer) { setStatus('Primero sube o grabá un audio'); return; }

  const buf = buildPlaybackBuffer();
  sourceNode = ctx.createBufferSource();
  sourceNode.buffer = buf;
  sourceNode.playbackRate.value = computePlaybackRate();
  connectToOutput(sourceNode, ctx);
  sourceNode.onended = ()=>{
    if(isPlaying){
      if(loopEnabled){
        // reiniciar desde el principio en bucle
        playStartOffset = 0;
        TL.pos = 0;
        stopPlayback();
        startPlayback();
      } else {
        stopPlayback();
      }
    }
  };
  // playStartOffset está en segundos del audio ORIGINAL. Si el buffer fue
  // comprimido/estirado por pitch-lock (tempo distinto de 1), hay que escalar
  // el offset al sistema de tiempo del buffer procesado. Si no, el inicio se desfasa.
  let bufferOffset = playStartOffset;
  if(pitchLockOn && Math.abs(speedRate - 1) > 0.001){
    bufferOffset = playStartOffset / speedRate;
  }
  bufferOffset = Math.max(0, Math.min(bufferOffset, buf.duration - 0.01));
  sourceNode.start(0, bufferOffset);
  playStartCtxTime = ctx.currentTime;
  isPlaying = true;
  btnPlayPause.textContent = '❚❚';
  updateAppaAnimation();
  tickAudio(buf);
  if(tunerMode === 'audiofile' && !tunerPanel.classList.contains('hidden')){
    startLiveToneTracking();
  }
}

function tickAudio(buf){
  const ctx = ensureAudioCtx();
  const origDur = originalBuffer.duration;
  function step(){
    if(!isPlaying) return;
    const rate = sourceNode ? sourceNode.playbackRate.value : 1;
    // tiempo transcurrido en el buffer procesado desde que arrancó
    const bufElapsed = (ctx.currentTime - playStartCtxTime)*rate;
    // convertir a tiempo del audio original
    let origElapsed;
    if(pitchLockOn && Math.abs(speedRate - 1) > 0.001){
      origElapsed = playStartOffset + bufElapsed*speedRate;
    } else {
      origElapsed = playStartOffset + bufElapsed;
    }
    if(origElapsed >= origDur){
      playStartOffset = 0;
      TL.pos = 0;
      stopPlayback();
      timeLabel.textContent = `0:00 / ${fmtTime(origDur)}`;
      return;
    }
    timeLabel.textContent = `${fmtTime(origElapsed)} / ${fmtTime(origDur)}`;
    rafId = requestAnimationFrame(step);
  }
  step();
}

function tickVideo(){
  function step(){
    if(!isPlaying) return;
    timeLabel.textContent = `${fmtTime(videoEl.currentTime)} / ${fmtTime(videoEl.duration)}`;
    if(videoEl.ended){
      if(loopEnabled){
        playStartOffset = 0;
        TL.pos = 0;
        stopPlayback();
        startPlayback();
      } else {
        stopPlayback();
      }
      return;
    }
    rafId = requestAnimationFrame(step);
  }
  step();
}

btnPlayPause.addEventListener('click', ()=>{
  if(isPlaying){
    if(mediaType==='audio' || (mediaType==='video' && isReversed)){
      // guardar posición actual en el buffer de audio
      const ctx = ensureAudioCtx();
      const rate = sourceNode ? sourceNode.playbackRate.value : 1;
      playStartOffset += (ctx.currentTime - playStartCtxTime)*rate;
    }
    stopPlayback();
  } else {
    startPlayback();
  }
});

// ============================================================
// Saltar −10s / +10s
// ============================================================
let skipSec = 10; // configurable en el futuro

function seekTo(newPos){
  const dur = originalBuffer ? originalBuffer.duration : (videoEl.duration || 0);
  newPos = Math.max(0, Math.min(newPos, dur - 0.01));
  if(mediaType === 'video'){
    // En modo canvas-reverse, newPos es posición en el buffer revertido;
    // el video se posiciona en la posición original correspondiente.
    const vidPos = (isReversed) ? Math.max(0, videoEl.duration - newPos) : newPos;
    try{ videoEl.currentTime = vidPos; }catch(e){}
    playStartOffset = newPos;
    TL.pos = newPos;
    timeLabel.textContent = `${fmtTime(vidPos)} / ${fmtTime(videoEl.duration)}`;
  } else {
    playStartOffset = newPos;
    TL.pos = newPos;
    if(originalBuffer) timeLabel.textContent = `${fmtTime(newPos)} / ${fmtTime(originalBuffer.duration)}`;
  }
  if(isPlaying){ stopPlayback(); startPlayback(); }
}

function skipBy(delta){
  if(!workingBuffer && !originalBuffer) return;
  let cur = playStartOffset;
  if(isPlaying){
    if(mediaType === 'audio' && sourceNode){
      const ctx = ensureAudioCtx();
      const rate = sourceNode.playbackRate.value;
      cur = playStartOffset + (ctx.currentTime - playStartCtxTime)*rate;
    } else if(mediaType === 'video'){
      // En canvas-reverse, videoEl.currentTime es posición original; convertir a buffer revertido
      cur = isReversed ? (videoEl.duration - videoEl.currentTime) : videoEl.currentTime;
    }
  }
  seekTo(cur + delta);
}

$('btnSkipBack').addEventListener('click', ()=> skipBy(-skipSec));
$('btnSkipFwd').addEventListener('click', ()=> skipBy(+skipSec));

// Restaurar skipSec guardado
try{
  const saved = parseInt(localStorage.getItem('appa_skip_sec'));
  if([5,10,30].includes(saved)){
    skipSec = saved;
    document.querySelectorAll('.skip-sec-btn').forEach(b=>{
      b.classList.toggle('active', parseInt(b.dataset.sec)===skipSec);
    });
  }
}catch(e){}

document.querySelectorAll('.skip-sec-btn').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    skipSec = parseInt(btn.dataset.sec);
    document.querySelectorAll('.skip-sec-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    try{ localStorage.setItem('appa_skip_sec', skipSec); }catch(e){}
  });
});

// ============================================================
// Toggle video desplegable
// ============================================================
$('btnVideoToggle').addEventListener('click', ()=>{
  videoCollapsed = !videoCollapsed;
  const inner = $('videoPrevInner');
  inner.style.display = videoCollapsed ? 'none' : '';
  $('btnVideoToggle').textContent = videoCollapsed ? '▼ Mostrar video' : '▲ Ocultar video';
});

// ============================================================
// Sliders: Pitch y Velocidad (vinculados con campos numéricos)
// ============================================================
function clamp(v,min,max){ return Math.min(max, Math.max(min,v)); }

// Actualiza solo la velocidad de reproducción en caliente, sin reiniciar nada.
// Para video sin pitch-lock y audio sin pitch-lock, esto es instantáneo y fluido
// (evita el parpadeo de detener/reiniciar el <video> en cada pixel del slider).
function updatePlaybackRateLive(){
  if(!isPlaying) return;
  if(pitchLockOn) return; // con pitch-lock el cambio requiere reprocesar; se maneja aparte
  if(mediaType === 'video'){
    videoEl.preservesPitch = false;
    videoEl.mozPreservesPitch = false;
    videoEl.webkitPreservesPitch = false;
    const variSpeedRate = speedRate * semitonesToRate(pitchSemis);
    videoEl.playbackRate = Math.min(16, Math.max(0.0625, variSpeedRate));
  } else if(sourceNode){
    sourceNode.playbackRate.value = computePlaybackRate();
  }
}

pitchSlider.addEventListener('input', ()=>{
  pitchSemis = parseFloat(pitchSlider.value);
  pitchValue.value = pitchSemis.toFixed(3);
  // En vivo solo si NO hay pitch-lock: tanto audio como video usan playbackRate nativo,
  // que es instantáneo. Con pitch-lock hay que reprocesar con SoundTouch -> se hace al soltar.
  if(!pitchLockOn) updatePlaybackRateLive();
  updatePitchLockHint();
  updateReanalyzeShimmer();
});
pitchSlider.addEventListener('change', ()=>{
  if(pitchLockOn) restartPlaybackIfPlaying(); // pitch-lock reprocesa al soltar (caro)
  pushHistory();
});

pitchValue.addEventListener('change', ()=>{
  let v = clamp(parseFloat(pitchValue.value)||0, -48, 48);
  pitchSemis = v;
  pitchValue.value = v.toFixed(3);
  pitchSlider.value = v;
  restartPlaybackIfPlaying();
  pushHistory();
  updatePitchLockHint();
  updateReanalyzeShimmer();
});

speedSlider.addEventListener('input', ()=>{
  speedRate = parseFloat(speedSlider.value);
  speedValue.value = speedRate.toFixed(3);
  if(!pitchLockOn) updatePlaybackRateLive();
  updateReanalyzeShimmer();
});
speedSlider.addEventListener('change', ()=>{
  if(pitchLockOn) restartPlaybackIfPlaying();
  pushHistory();
});

speedValue.addEventListener('change', ()=>{
  let v = clamp(parseFloat(speedValue.value)||1, 0.05, 10);
  speedRate = v;
  speedValue.value = v.toFixed(3);
  speedSlider.value = v;
  restartPlaybackIfPlaying();
  pushHistory();
  updateReanalyzeShimmer();
});

// ============================================================
// Botones +1 / -1 y "0" (reset) para pitch y velocidad
// ============================================================
document.querySelectorAll('.step-btn[data-delta]').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    const delta = parseFloat(btn.dataset.delta);
    if(btn.dataset.target === 'pitch'){
      let v = clamp(pitchSemis + delta, -48, 48);
      pitchSemis = v;
      pitchValue.value = v.toFixed(3);
      pitchSlider.value = v;
      updatePitchLockHint();
    } else {
      let v = clamp(speedRate + delta, 0.05, 10);
      speedRate = v;
      speedValue.value = v.toFixed(3);
      speedSlider.value = v;
    }
    restartPlaybackIfPlaying();
    pushHistory();
    updateReanalyzeShimmer();
  });
});

$('pitchZeroBtn').addEventListener('click', ()=>{
  pitchSemis = 0;
  pitchValue.value = '0.000';
  pitchSlider.value = 0;
  restartPlaybackIfPlaying();
  pushHistory();
  updatePitchLockHint();
  updateReanalyzeShimmer();
});

$('speedZeroBtn').addEventListener('click', ()=>{
  speedRate = 1;
  speedValue.value = '1.000';
  speedSlider.value = 1;
  restartPlaybackIfPlaying();
  pushHistory();
  updateReanalyzeShimmer();
});

// ============================================================
// Pitch-lock / Reversa
// ============================================================
btnPitchLock.addEventListener('click', ()=>{
  pitchLockOn = !pitchLockOn;
  btnPitchLock.classList.toggle('active', pitchLockOn);
  setStatus(pitchLockOn ? 'Pitch-lock activado: la velocidad no cambiará el tono' : 'Pitch-lock desactivado', 2000);
  restartPlaybackIfPlaying();
  pushHistory();
  updatePitchLockHint();
});

btnReverse.addEventListener('click', ()=>{
  if(!workingBuffer){ setStatus('Primero sube o grabá un audio'); return; }
  isReversed = !isReversed;
  btnReverse.classList.toggle('active', isReversed);
  drawWaveform(getEffectiveBuffer());
  tlBuildWaveImage();
  setStatus(isReversed ? 'Reversa activada' : 'Reversa desactivada', 1500);
  pushHistory();

  if(mediaType === 'video'){
    if(isReversed){
      // Canvas scrubbing se activa automáticamente en startPlayback; solo reiniciar
      restartPlaybackIfPlaying();
    } else {
      // Reversa desactivada: ocultar canvas y volver a reproducción normal
      const wasPlaying = isPlaying;
      const origPos = videoEl.currentTime; // canvas dejó el video en posición original
      if(wasPlaying) stopPlayback();
      showReverseCanvas(false);
      playStartOffset = Math.max(0, origPos);
      TL.pos = Math.max(0, origPos);
      if(wasPlaying) startPlayback();
    }
    return;
  }

  restartPlaybackIfPlaying();
});

// ============================================================
// Undo / Redo
// ============================================================
btnUndo.addEventListener('click', ()=>{
  if(historyIndex>0){
    historyIndex--;
    applyHistoryState(history[historyIndex]);
    updateUndoRedoButtons();
  }
});
btnRedo.addEventListener('click', ()=>{
  if(historyIndex<history.length-1){
    historyIndex++;
    applyHistoryState(history[historyIndex]);
    updateUndoRedoButtons();
  }
});
updateUndoRedoButtons();

// ============================================================
// Exportación
// ============================================================
async function renderToBuffer(){
  const buf = buildPlaybackBuffer();   // ya aplica pitch-lock/stretch si corresponde
  const rate = computePlaybackRate();  // 1.0 en pitch-lock; vari-speed si no
  const outLength = Math.max(1, Math.floor(buf.length/rate));
  const offlineCtx = new OfflineAudioContext(buf.numberOfChannels, outLength, buf.sampleRate);
  const src = offlineCtx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = rate;
  src.connect(offlineCtx.destination);
  src.start(0);
  const rendered = await offlineCtx.startRendering();
  return rendered;
}

// Render del audio para exportación de VIDEO: aplica pitch independiente de la velocidad
// (el video maneja su propia velocidad visual), igual que la reproducción de video.
async function renderToBufferForVideo(){
  const buf = buildPlaybackBufferForVideo(); // pitch + tempo ya aplicados
  // el buffer ya tiene pitch y tempo (speedRate) aplicados, se reproduce a rate 1.0
  const outLength = buf.length;
  const offlineCtx = new OfflineAudioContext(buf.numberOfChannels, outLength, buf.sampleRate);
  const src = offlineCtx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = 1.0;
  src.connect(offlineCtx.destination);
  src.start(0);
  return await offlineCtx.startRendering();
}

function bufferToWav(buffer){
  const numCh = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const length = buffer.length * numCh * 2 + 44;
  const ab = new ArrayBuffer(length);
  const view = new DataView(ab);

  function writeStr(offset, str){ for(let i=0;i<str.length;i++) view.setUint8(offset+i, str.charCodeAt(i)); }

  writeStr(0,'RIFF');
  view.setUint32(4, 36 + buffer.length*numCh*2, true);
  writeStr(8,'WAVE');
  writeStr(12,'fmt ');
  view.setUint32(16,16,true);
  view.setUint16(20,1,true);
  view.setUint16(22,numCh,true);
  view.setUint32(24,sampleRate,true);
  view.setUint32(28,sampleRate*numCh*2,true);
  view.setUint16(32,numCh*2,true);
  view.setUint16(34,16,true);
  writeStr(36,'data');
  view.setUint32(40, buffer.length*numCh*2, true);

  let offset = 44;
  const chans = [];
  for(let ch=0; ch<numCh; ch++) chans.push(buffer.getChannelData(ch));
  for(let i=0;i<buffer.length;i++){
    for(let ch=0; ch<numCh; ch++){
      let sample = Math.max(-1, Math.min(1, chans[ch][i]));
      sample = sample<0 ? sample*0x8000 : sample*0x7FFF;
      view.setInt16(offset, sample, true);
      offset += 2;
    }
  }
  return new Blob([ab], {type:'audio/wav'});
}

// ---- Codificar a MP3 con lamejs ----
function bufferToMp3(buffer, kbps){
  const numCh = Math.min(2, buffer.numberOfChannels);
  const sr = buffer.sampleRate;
  const encoder = new lamejs.Mp3Encoder(numCh, sr, kbps || 192);
  const left = buffer.getChannelData(0);
  const right = numCh > 1 ? buffer.getChannelData(1) : null;

  // convertir float [-1,1] a int16
  const len = buffer.length;
  const l16 = new Int16Array(len);
  const r16 = numCh > 1 ? new Int16Array(len) : null;
  for(let i=0;i<len;i++){
    let s = Math.max(-1, Math.min(1, left[i]));
    l16[i] = s < 0 ? s*0x8000 : s*0x7FFF;
    if(r16){
      let sr2 = Math.max(-1, Math.min(1, right[i]));
      r16[i] = sr2 < 0 ? sr2*0x8000 : sr2*0x7FFF;
    }
  }

  const blockSize = 1152;
  const mp3Data = [];
  for(let i=0;i<len;i+=blockSize){
    const lChunk = l16.subarray(i, i+blockSize);
    let mp3buf;
    if(numCh > 1){
      const rChunk = r16.subarray(i, i+blockSize);
      mp3buf = encoder.encodeBuffer(lChunk, rChunk);
    } else {
      mp3buf = encoder.encodeBuffer(lChunk);
    }
    if(mp3buf.length > 0) mp3Data.push(new Int8Array(mp3buf));
  }
  const end = encoder.flush();
  if(end.length > 0) mp3Data.push(new Int8Array(end));
  return new Blob(mp3Data, {type:'audio/mp3'});
}

// ---- Registro de archivos generados (persistente con localStorage no disponible en iframe;
// usamos memoria + descarga; el registro vive mientras la app está abierta) ----
let exportLog = [];
try{
  const saved = localStorage.getItem('appa_export_log');
  if(saved) exportLog = JSON.parse(saved);
}catch(e){}

function addToExportLog(name, format, durationSec){
  exportLog.unshift({
    name, format,
    date: new Date().toLocaleString('es-CL'),
    duration: durationSec ? fmtTime(durationSec) : '—',
    pitch: pitchSemis.toFixed(2),
    speed: speedRate.toFixed(2)
  });
  if(exportLog.length > 50) exportLog = exportLog.slice(0,50);
  try{ localStorage.setItem('appa_export_log', JSON.stringify(exportLog)); }catch(e){}
}

function triggerDownload(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(()=> URL.revokeObjectURL(url), 4000);
}

async function doExport(format, kbps){
  if(!workingBuffer){ setStatus('No hay audio cargado'); return; }

  if(format === 'mp4video'){
    await exportVideoWithFfmpeg();
    return;
  }

  setStatus('Exportando…');
  showLoading('Exportando…');
  try{
    const rendered = await renderToBuffer();
    let blob, ext;
    if(format === 'mp3'){
      blob = bufferToMp3(rendered, kbps || 192);
      ext = 'mp3';
    } else if(format === 'm4a'){
      blob = await encodeWavToM4a(rendered);
      ext = 'm4a';
    } else {
      blob = bufferToWav(rendered);
      ext = 'wav';
    }
    const filename = `appa_${Date.now()}.${ext}`;
    triggerDownload(blob, filename);
    addToExportLog(filename, ext.toUpperCase() + (format==='mp3'?` ${kbps||192}k`:' (sin pérdida)'), rendered.duration);
    setStatus('Exportado ✓', 2000);
    renderExportLog();
  }catch(err){
    console.error(err);
    setStatus('Error al exportar');
  } finally {
    hideLoading();
  }
}

// ============================================================
// FFMPEG (carga diferida, solo cuando se necesita)
// ============================================================
let ffmpegInstance = null;
let ffmpegLoading = null;

async function getFfmpeg(){
  if(ffmpegInstance) return ffmpegInstance;
  if(ffmpegLoading) return ffmpegLoading;
  ffmpegLoading = (async ()=>{
    if(!window.FFmpegWASM){
      throw new Error('FFmpeg no se cargó (revisa que ffmpeg.js esté presente)');
    }
    const { FFmpeg } = window.FFmpegWASM;
    const ff = new FFmpeg();
    ff.on('progress', ({progress})=>{
      const pct = Math.round(Math.min(1, Math.max(0, progress))*100);
      const fill = $('ffmpegProgressFill');
      const label = $('ffmpegProgressLabel');
      if(fill) fill.style.width = pct + '%';
      if(label) label.textContent = `Procesando… ${pct}%`;
      if(pct > 0) setLoadingText(`Procesando video… ${pct}%`);
    });
    await ff.load({
      coreURL: 'ffmpeg-core.js',
      wasmURL: 'ffmpeg-core.wasm'
    });
    ffmpegInstance = ff;
    return ff;
  })();
  return ffmpegLoading;
}

function showFfmpegProgress(show, label){
  const panel = $('ffmpegProgress');
  panel.classList.toggle('hidden', !show);
  if(label) $('ffmpegProgressLabel').textContent = label;
  $('ffmpegProgressFill').style.width = '0%';
}

// Codifica un AudioBuffer a M4A (AAC en contenedor MP4) usando ffmpeg, vía WAV intermedio.
async function encodeWavToM4a(buffer){
  showFfmpegProgress(true, 'Cargando motor de conversión…');
  const ff = await getFfmpeg();
  const wavBlob = bufferToWav(buffer);
  const wavData = new Uint8Array(await wavBlob.arrayBuffer());
  await ff.writeFile('input.wav', wavData);
  showFfmpegProgress(true, 'Convirtiendo a MP4/AAC…');
  await ff.exec(['-i', 'input.wav', '-c:a', 'aac', '-b:a', '192k', 'output.m4a']);
  const data = await ff.readFile('output.m4a');
  await ff.deleteFile('input.wav').catch(()=>{});
  await ff.deleteFile('output.m4a').catch(()=>{});
  showFfmpegProgress(false);
  return new Blob([data.buffer], {type:'audio/mp4'});
}

// Genera un preview de video con frames invertidos para reproducción visual en la app.
// Se llama en background al activar reversa. El resultado queda en reversedVideoUrl.
async function prepareReversedVideoVisual(){
  if(reversedVideoUrl) return reversedVideoUrl;
  if(!originalVideoFile) return null;
  showFfmpegProgress(true, 'Preparando reversa visual… (puede tardar)');
  try{
    const ff = await getFfmpeg();
    const videoData = new Uint8Array(await originalVideoFile.arrayBuffer());
    const ext = originalVideoFile.name.split('.').pop() || 'mp4';
    const inName = 'rv_in.' + ext;
    await ff.writeFile(inName, videoData);
    showFfmpegProgress(true, 'Invirtiendo frames del video…');
    await ff.exec([
      '-i', inName,
      '-vf', 'reverse',
      '-an',                               // sin audio: lo maneja Web Audio
      '-c:v', 'libx264', '-preset', 'ultrafast',
      'rv_out.mp4'
    ]);
    const data = await ff.readFile('rv_out.mp4');
    ff.deleteFile(inName).catch(()=>{});
    ff.deleteFile('rv_out.mp4').catch(()=>{});
    const blob = new Blob([data.buffer], {type:'video/mp4'});
    reversedVideoUrl = URL.createObjectURL(blob);
    return reversedVideoUrl;
  }catch(err){
    console.error('Error preparando reversa visual:', err);
    setStatus('No se pudo invertir el video visualmente');
    return null;
  }finally{
    showFfmpegProgress(false);
  }
}

// Exporta el VIDEO completo con el audio ya procesado (pitch/velocidad/reversa)
// reemplazando su pista de audio original. Si el video tiene reversa activada,
// también se invierten los frames de video (operación más pesada).
async function exportVideoWithFfmpeg(){
  if(!originalVideoFile){ setStatus('Esto requiere haber subido un video', 2500); return; }
  $('exportDialog').classList.add('hidden');
  showLoading('Cargando motor de video…');
  setStatus('Cargando motor de video…');

  try{
    const ff = await getFfmpeg();

    setLoadingText('Procesando audio del video…');
    setStatus('Procesando audio del video…');
    const renderedAudio = await renderToBufferForVideo();
    const wavBlob = bufferToWav(renderedAudio);
    const wavData = new Uint8Array(await wavBlob.arrayBuffer());

    setLoadingText('Preparando archivos…');
    setStatus('Preparando archivos…');
    const videoData = new Uint8Array(await originalVideoFile.arrayBuffer());
    const inName = 'input_video.' + (originalVideoFile.name.split('.').pop() || 'mp4');
    await ff.writeFile(inName, videoData);
    await ff.writeFile('new_audio.wav', wavData);

    let videoInputFile = inName;

    if(isReversed){
      // El filtro 'reverse' de FFmpeg carga todos los frames en RAM a la vez.
      // Para videos largos esto agota la memoria del tab y crashea el browser.
      // Solución: dividir en segmentos de 3 segundos, invertir cada uno por separado,
      // y concatenarlos en orden inverso → mismo resultado, ~1/N de pico de RAM.
      const duration = videoEl.duration || 0;
      const SEG = 3;
      const numSegs = Math.max(1, Math.ceil(duration / SEG));
      const revFiles = [];

      for(let i = 0; i < numSegs; i++){
        const start = i * SEG;
        const segFile = `rv${i}.mp4`;
        setLoadingText(`Invirtiendo video… ${i + 1}/${numSegs}`);
        setStatus(`Invirtiendo video… ${i + 1}/${numSegs}`);
        await ff.exec([
          '-i', inName,
          '-vf', `trim=start=${start}:duration=${SEG},reverse,setpts=PTS-STARTPTS`,
          '-an', '-c:v', 'libx264', '-preset', 'ultrafast',
          segFile
        ]);
        revFiles.unshift(segFile); // orden inverso para el concat
      }

      setLoadingText('Uniendo segmentos invertidos…');
      setStatus('Uniendo segmentos invertidos…');
      const listTxt = revFiles.map(f => `file '${f}'`).join('\n');
      await ff.writeFile('rv_list.txt', new TextEncoder().encode(listTxt));
      await ff.exec(['-f','concat','-safe','0','-i','rv_list.txt','-c','copy','rv_full.mp4']);
      for(const f of revFiles) await ff.deleteFile(f).catch(()=>{});
      await ff.deleteFile('rv_list.txt').catch(()=>{});
      videoInputFile = 'rv_full.mp4';
    }

    const speedFilter = Math.abs(speedRate - 1) > 0.01 ? `setpts=PTS/${speedRate}` : null;
    const exportLabel = speedFilter ? 'Recodificando video… (puede tardar)' : 'Combinando video + audio editado…';
    setLoadingText(exportLabel);
    setStatus(exportLabel);
    const args = ['-i', videoInputFile, '-i', 'new_audio.wav'];
    if(speedFilter) args.push('-vf', speedFilter);
    const videoCodecArgs = speedFilter ? ['-c:v', 'libx264', '-preset', 'ultrafast'] : ['-c:v', 'copy'];
    args.push('-map', '0:v:0', '-map', '1:a:0', ...videoCodecArgs, '-c:a', 'aac', '-b:a', '192k', '-shortest', 'output.mp4');
    await ff.exec(args);

    setLoadingText('Preparando descarga…');
    const data = await ff.readFile('output.mp4');
    const blob = new Blob([data.buffer], {type:'video/mp4'});
    const filename = `appa_video_${Date.now()}.mp4`;
    triggerDownload(blob, filename);
    addToExportLog(filename, 'MP4 (video + audio editado)', renderedAudio.duration);
    renderExportLog();
    setStatus('Video exportado ✓', 2500);

    if(videoInputFile !== inName) await ff.deleteFile(videoInputFile).catch(()=>{});
    await ff.deleteFile(inName).catch(()=>{});
    await ff.deleteFile('new_audio.wav').catch(()=>{});
    await ff.deleteFile('output.mp4').catch(()=>{});
  }catch(err){
    console.error('exportVideoWithFfmpeg error:', err);
    setStatus('Error al exportar video: ' + (err.message || err), 4000);
  } finally {
    hideLoading();
    showFfmpegProgress(false);
  }
}

// Export Rápido = WAV directo. Export Pro = elegir formato/calidad.
btnExportFast.addEventListener('click', ()=> doExport('m4a'));
btnExportPro.addEventListener('click', openExportDialog);

function openExportDialog(){
  if(!workingBuffer){ setStatus('No hay audio cargado'); return; }
  // mostrar la opción de exportar video solo si se cargó un video
  const videoOpt = $('exportVideoOption');
  const videoLabel = $('videoExportLabel');
  const showVideo = !!originalVideoFile;
  videoOpt.classList.toggle('hidden', !showVideo);
  videoLabel.classList.toggle('hidden', !showVideo);
  $('exportDialog').classList.remove('hidden');
}

// ============================================================
// Detector de tono del AUDIO CARGADO (botón "Detectar tono")
// Analiza el buffer ya grabado/subido y muestra la nota predominante.
// ============================================================
btnDetectTone.addEventListener('click', async ()=>{
  // Si el panel está abierto en modo "audio", lo cerramos y limpiamos su estado
  if(!tunerPanel.classList.contains('hidden') && tunerMode === 'audiofile'){
    tunerPanel.classList.add('hidden');
    btnDetectTone.classList.remove('active');
    tunerMode = null;
    if(liveToneRaf){ cancelAnimationFrame(liveToneRaf); liveToneRaf = null; }
    syncTunerBtn();
    return;
  }
  if(!workingBuffer){
    setStatus('Primero sube o graba un audio', 2500);
    return;
  }
  if(tunerActive) stopTuner();

  tunerPanel.classList.remove('hidden');
  setModeAudioFile();
  btnDetectTone.classList.add('active');
  syncTunerBtn();
  analyzeLoadedAudioTone();
  tunerPanel.scrollIntoView({behavior:'smooth', block:'center'});
});

// Analiza el audio cargado: toma muestras a lo largo del clip, detecta la
// frecuencia en cada una, y reporta la nota más frecuente + un desglose.
function analyzeLoadedAudioTone(){
  const buffer = getEffectiveBuffer();
  if(!buffer){ return; }
  const sr = buffer.sampleRate;
  const data = buffer.getChannelData(0);
  const windowSize = 4096;
  const numWindows = 40; // cuántos puntos analizar a lo largo del audio
  const step = Math.max(windowSize, Math.floor((data.length - windowSize) / numWindows));

  const noteCountsOrig = {};
  const noteCountsMod  = {};
  const detectedFreqs = [];
  let analyzed = 0;

  const pitchFactor = semitonesToRate(pitchSemis);
  for(let start=0; start + windowSize < data.length; start += step){
    const slice = data.slice(start, start + windowSize);
    const rawFreq = autoCorrelate(slice, sr);
    if(rawFreq > 40 && rawFreq < 2000 && isFinite(rawFreq)){
      const freqMod = rawFreq * pitchFactor;
      detectedFreqs.push(freqMod);
      const o = freqToNote(rawFreq);
      const oKey = `${o.name}${o.octave}|${o.solfege}`;
      noteCountsOrig[oKey] = (noteCountsOrig[oKey]||0) + 1;
      const m = freqToNote(freqMod);
      const mKey = `${m.name}${m.octave}|${m.solfege}`;
      noteCountsMod[mKey] = (noteCountsMod[mKey]||0) + 1;
      analyzed++;
    }
  }

  if(analyzed === 0){
    tunerNote.textContent = '—';
    tunerFreq.textContent = 'Sin tono claro';
    tunerStatus.textContent = 'No se detectó una nota definida (¿voz/ruido?)';
    tunerNeedle.style.left = '50%';
    stringsRow.innerHTML = '';
    $('toneModeBtn').classList.add('hidden');
    return;
  }

  // nota predominante (en base a versión modificada para el display principal)
  let topNote = null, topCount = 0;
  for(const k in noteCountsMod){ if(noteCountsMod[k] > topCount){ topCount = noteCountsMod[k]; topNote = k; } }

  // frecuencia mediana de las detecciones (más robusta que el promedio)
  detectedFreqs.sort((a,b)=>a-b);
  const medianFreq = detectedFreqs[Math.floor(detectedFreqs.length/2)];
  const {name, solfege, octave, cents} = freqToNote(medianFreq);

  const [topLabel] = topNote.split('|');
  const topSolfege = topNote.split('|')[1] || '';
  tunerNote.textContent = `${topLabel} · ${topSolfege}`;
  tunerFreq.textContent = `${medianFreq.toFixed(1)} Hz (mediana)`;
  tunerStatus.textContent = `Nota predominante en el audio · ${analyzed} muestras`;

  // posición de la aguja según afinación de la nota mediana
  const pct = clamp(50 + cents/50*50, 0, 100);
  tunerNeedle.style.left = pct + '%';
  tunerNeedle.style.background = Math.abs(cents)<15 ? 'var(--green)' : 'var(--white)';

  // guardar ambas versiones y resetear botón a "Original"
  lastNoteCountsOrig = noteCountsOrig;
  lastNoteCountsMod  = noteCountsMod;
  lastNoteAnalyzed   = analyzed;
  toneDisplayMode = 'original';
  const toneModeBtn = $('toneModeBtn');
  toneModeBtn.textContent = 'Original';
  toneModeBtn.classList.remove('active', 'hidden');
  renderNoteChips(lastNoteCountsOrig, lastNoteAnalyzed);
}

function renderNoteChips(noteCounts, analyzed){
  const sorted = Object.entries(noteCounts).sort((a,b)=>b[1]-a[1]).slice(0,3);
  stringsRow.innerHTML = '';
  sorted.forEach(([noteKey,count])=>{
    const pctg = Math.round(count/analyzed*100);
    const [label, sol] = noteKey.split('|');
    const chip = document.createElement('div');
    chip.className = 'string-chip';
    chip.innerHTML = `${label} · ${sol}<small>${pctg}%</small>`;
    stringsRow.appendChild(chip);
  });
}

$('toneModeBtn').addEventListener('click', ()=>{
  toneDisplayMode = toneDisplayMode === 'original' ? 'modified' : 'original';
  const btn = $('toneModeBtn');
  btn.textContent = toneDisplayMode === 'original' ? 'Original' : 'Modificado';
  btn.classList.toggle('active', toneDisplayMode === 'modified');
  renderNoteChips(
    toneDisplayMode === 'original' ? lastNoteCountsOrig : lastNoteCountsMod,
    lastNoteAnalyzed
  );
});

// ============================================================
// Afinador EN TIEMPO REAL con micrófono (botón "Afinador")
// ============================================================
function syncTunerBtn(){
  const open = !tunerPanel.classList.contains('hidden') && tunerMode !== 'audiofile';
  btnTunerToggle.classList.toggle('active', open);
  const chevron = $('tunerChevron');
  if(chevron) chevron.textContent = open ? '▲' : '▼';
}

btnTunerToggle.addEventListener('click', async ()=>{
  const wasHidden = tunerPanel.classList.contains('hidden');
  const wasAudioMode = tunerMode === 'audiofile';
  if(!wasHidden && !wasAudioMode){
    // estaba abierto en modo afinador en vivo -> cerrar
    stopTuner();
    tunerPanel.classList.add('hidden');
    syncTunerBtn();
    return;
  }
  tunerPanel.classList.remove('hidden');
  btnDetectTone.classList.remove('active');
  setMode('guitar', true);
  syncTunerBtn();
  await startTuner();
  tunerPanel.scrollIntoView({behavior:'smooth', block:'center'});
});

document.querySelectorAll('.mode-btn').forEach(btn=>{
  btn.addEventListener('click', ()=> setMode(btn.dataset.mode, false));
});

$('reanalyzeBtn').addEventListener('click', analyzeLoadedAudioTone);

const TUNINGS = {
  guitar: [
    {name:'E', label:'6ª (grave)', freq:82.41},
    {name:'A', label:'5ª', freq:110.00},
    {name:'D', label:'4ª', freq:146.83},
    {name:'G', label:'3ª', freq:196.00},
    {name:'B', label:'2ª', freq:246.94},
    {name:'E', label:'1ª (aguda)', freq:329.63},
  ],
  ukulele: [
    {name:'G', label:'4ª', freq:392.00},
    {name:'C', label:'3ª', freq:261.63},
    {name:'E', label:'2ª', freq:329.63},
    {name:'A', label:'1ª (aguda)', freq:440.00},
  ],
};

function setMode(mode, keepNeedle){
  tunerMode = mode;
  // modo afinador en vivo: mostrar selector de instrumento, título Afinador
  $('tunerTitle').textContent = 'Afinador';
  $('tunerModeRow').classList.remove('hidden');
  $('tunerHint').textContent = 'Toca una cuerda y mantenla sonando. El indicador se pone verde cuando está afinada.';
  $('tunerHint').classList.remove('hidden');
  $('reanalyzeBtn').classList.add('hidden');
  $('toneModeBtn').classList.add('hidden');
  document.querySelectorAll('.mode-btn').forEach(b=> b.classList.toggle('selected', b.dataset.mode===mode));
  renderStrings();
}

function setModeAudioFile(){
  tunerMode = 'audiofile';
  $('tunerTitle').textContent = 'Tono del audio';
  $('tunerModeRow').classList.add('hidden');
  $('tunerHint').textContent = 'Análisis de la nota predominante en el audio cargado. Los chips muestran las 3 notas más frecuentes.';
  $('tunerHint').classList.remove('hidden');
  $('reanalyzeBtn').classList.remove('hidden');
}

let _toneCtx = null;
let _toneStopFn = null;

function playStringTone(freq){
  if(_toneStopFn){ _toneStopFn(); _toneStopFn = null; }
  if(!_toneCtx || _toneCtx.state === 'closed'){
    _toneCtx = new (window.AudioContext||window.webkitAudioContext)();
  }
  const ctx = _toneCtx;
  const now = ctx.currentTime;
  const dur = 2.5;

  const master = ctx.createGain();
  master.gain.setValueAtTime(0, now);
  master.gain.linearRampToValueAtTime(0.8, now + 0.008);
  master.gain.setValueAtTime(0.8, now + 0.35);
  master.gain.exponentialRampToValueAtTime(0.001, now + dur);
  master.connect(ctx.destination);

  // Síntesis aditiva: fundamental + armónicos para que los graves sean audibles
  const oscs = [];
  [[1, 1.0], [2, 0.5], [3, 0.25], [4, 0.1]].forEach(([mult, amp])=>{
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq * mult;
    const g = ctx.createGain();
    g.gain.value = amp;
    osc.connect(g);
    g.connect(master);
    osc.start(now);
    osc.stop(now + dur);
    oscs.push(osc);
  });

  _toneStopFn = ()=>{
    const t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setValueAtTime(master.gain.value, t);
    master.gain.linearRampToValueAtTime(0, t + 0.04);
    oscs.forEach(o=>{ try{ o.stop(t + 0.04); }catch(e){} });
  };
}

function renderStrings(){
  stringsRow.innerHTML = '';
  if(tunerMode==='chromatic' || tunerMode==='audiofile'){ return; }
  const strings = TUNINGS[tunerMode];
  strings.forEach(s=>{
    const chip = document.createElement('div');
    chip.className = 'string-chip';
    chip.dataset.freq = s.freq;
    chip.innerHTML = `${s.name}<small>${s.label}</small>`;
    attachStringTonePress(chip, s.freq);
    stringsRow.appendChild(chip);
  });
}
renderStrings();

// ============================================================
// Tono puro al tocar una cuerda en el afinador (guitarra/ukelele).
// Suena mientras se mantenga presionado, con un mínimo de 1 segundo aunque
// se suelte antes (lo que sea más largo entre ambos).
// ============================================================
const MIN_STRING_TONE_MS = 1000;

function attachStringTonePress(chip, freq){
  let osc = null, gainNode = null;
  let pressStartTime = 0;
  let releasedEarly = false;
  let stopTimer = null;

  let _harmonicOscs = [];

  function startTone(){
    const ctx = ensureAudioCtx();
    gainNode = ctx.createGain();
    gainNode.gain.value = 0;
    gainNode.connect(ctx.destination);
    _harmonicOscs = [];

    // Truco del fundamental faltante: los parlantes móviles no reproducen < ~150 Hz.
    // Generamos armónicos que el cerebro interpreta como el tono grave original.
    let harmonics;
    if(freq < 130){
      // E2 (82Hz), A2 (110Hz): solo armónicos audibles, el cerebro pone el bajo
      harmonics = [[2, 1.0], [3, 0.9], [4, 0.6], [5, 0.3]];
    } else if(freq < 180){
      // D3 (147Hz): mezcla fundamental tenue + armónicos fuertes
      harmonics = [[1, 0.3], [2, 1.0], [3, 0.7], [4, 0.4]];
    } else if(freq < 260){
      // G3 (196Hz): fundamental ya audible, armónicos de apoyo
      harmonics = [[1, 0.8], [2, 0.7], [3, 0.3], [4, 0.1]];
    } else {
      // B3 (247Hz), E4 (330Hz): notas agudas, síntesis normal
      harmonics = [[1, 1.0], [2, 0.5], [3, 0.2]];
    }

    harmonics.forEach(([mult, amp])=>{
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq * mult;
      const g = ctx.createGain();
      g.gain.value = amp;
      o.connect(g);
      g.connect(gainNode);
      o.start();
      _harmonicOscs.push(o);
    });
    osc = _harmonicOscs[0];
    gainNode.gain.linearRampToValueAtTime(0.9, ctx.currentTime + 0.02);
    pressStartTime = performance.now();
    releasedEarly = false;
    chip.classList.add('pressed');
  }

  function stopToneNow(){
    if(!osc) return;
    const ctx = ensureAudioCtx();
    const g = gainNode;
    const oscsToStop = [..._harmonicOscs];
    g.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.04);
    setTimeout(()=>{ oscsToStop.forEach(o=>{ try{ o.stop(); o.disconnect(); }catch(e){} }); try{ g.disconnect(); }catch(e){} }, 60);
    osc = null; gainNode = null; _harmonicOscs = [];
    chip.classList.remove('pressed');
  }

  function requestStop(){
    const elapsed = performance.now() - pressStartTime;
    if(elapsed >= MIN_STRING_TONE_MS){
      stopToneNow();
    } else {
      // todavía no llegó al segundo mínimo: programar el corte para cuando se cumpla
      releasedEarly = true;
      if(stopTimer) clearTimeout(stopTimer);
      stopTimer = setTimeout(()=>{ if(releasedEarly) stopToneNow(); }, MIN_STRING_TONE_MS - elapsed);
    }
  }

  chip.addEventListener('pointerdown', (e)=>{
    e.preventDefault();
    if(stopTimer){ clearTimeout(stopTimer); stopTimer = null; }
    if(!osc) startTone();
  });
  chip.addEventListener('pointerup', requestStop);
  chip.addEventListener('pointerleave', requestStop);
  chip.addEventListener('pointercancel', requestStop);
}

// ---- Motor de detección de pitch (autocorrelación) ----
async function startTuner(){
  if(tunerActive) return;
  try{
    tunerStream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false, noiseSuppression:false, autoGainControl:false}});
  }catch(err){
    tunerStatus.textContent = 'No se pudo acceder al micrófono';
    return;
  }
  // Reutilizamos el AudioContext compartido (ver nota en grabación: Safari/iOS limita
  // muy pocas instancias de AudioContext por página).
  tunerAudioCtx = ensureAudioCtx();
  const src = tunerAudioCtx.createMediaStreamSource(tunerStream);
  tunerAnalyser = tunerAudioCtx.createAnalyser();
  tunerAnalyser.fftSize = 2048;
  src.connect(tunerAnalyser);
  tunerActive = true;
  tunerStatus.textContent = 'Escuchando…';
  loopTuner();
}

function stopTuner(){
  tunerActive = false;
  if(tunerRafId) cancelAnimationFrame(tunerRafId);
  if(tunerStream) tunerStream.getTracks().forEach(t=>t.stop());
  // NO cerramos tunerAudioCtx: es el contexto compartido de toda la app (ensureAudioCtx).
  // Cerrarlo aquí rompería el audio del resto de la app (este era el bug reportado:
  // tras activar/desactivar el afinador o detectar tono, dejaba de sonar la reproducción).
  tunerAudioCtx = null;
  tunerNote.textContent = '—';
  tunerFreq.textContent = '0.0 Hz';
  tunerStatus.textContent = 'Detenido';
  tunerNeedle.style.left = '50%';
  tunerNeedle.style.background = 'var(--white)';
  stringsRow.querySelectorAll('.string-chip').forEach(c=>c.classList.remove('match'));
}

function autoCorrelate(buf, sampleRate){
  // basado en el algoritmo clásico de detección de pitch por autocorrelación
  let SIZE = buf.length;
  let rms = 0;
  for(let i=0;i<SIZE;i++){ rms += buf[i]*buf[i]; }
  rms = Math.sqrt(rms/SIZE);
  if(rms < 0.004) return -1; // silencio

  let r1=0, r2=SIZE-1, thres=0.1;
  for(let i=0;i<SIZE/2;i++){ if(Math.abs(buf[i])<thres){ r1=i; break; } }
  for(let i=1;i<SIZE/2;i++){ if(Math.abs(buf[SIZE-i])<thres){ r2=SIZE-i; break; } }
  buf = buf.slice(r1,r2);
  SIZE = buf.length;

  const c = new Array(SIZE).fill(0);
  for(let i=0;i<SIZE;i++){
    for(let j=0;j<SIZE-i;j++){
      c[i] += buf[j]*buf[j+i];
    }
  }
  let d=0;
  while(c[d]>c[d+1]) d++;
  let maxval=-1, maxpos=-1;
  for(let i=d;i<SIZE;i++){
    if(c[i]>maxval){ maxval=c[i]; maxpos=i; }
  }
  let T0 = maxpos;
  if(T0<=0) return -1;

  // interpolación parabólica
  const x1 = c[T0-1]||c[T0], x2=c[T0], x3=c[T0+1]||c[T0];
  const a=(x1+x3-2*x2)/2, b=(x3-x1)/2;
  if(a) T0 = T0 - b/(2*a);

  return sampleRate/T0;
}

const NOTE_NAMES    = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const SOLFEGE_NAMES = ['Do','Do#','Re','Re#','Mi','Fa','Fa#','Sol','Sol#','La','La#','Si'];
function freqToNote(freq){
  const noteNum = 12*(Math.log2(freq/440)) + 69;
  const rounded = Math.round(noteNum);
  const idx = ((rounded%12)+12)%12;
  const name = NOTE_NAMES[idx];
  const solfege = SOLFEGE_NAMES[idx];
  const octave = Math.floor(rounded/12)-1;
  const exactFreq = 440*Math.pow(2,(rounded-69)/12);
  const cents = 1200*Math.log2(freq/exactFreq);
  return {name, solfege, octave, cents, exactFreq};
}

function loopTuner(){
  if(!tunerActive) return;
  const buf = new Float32Array(tunerAnalyser.fftSize);
  tunerAnalyser.getFloatTimeDomainData(buf);
  const freq = autoCorrelate(buf, tunerAudioCtx.sampleRate);

  if(freq===-1 || !isFinite(freq) || freq<40 || freq>1500){
    tunerStatus.textContent = 'Esperando sonido…';
  } else {
    const {name, solfege, octave, cents} = freqToNote(freq);
    tunerNote.textContent = `${name}${octave} · ${solfege}`;
    tunerFreq.textContent = `${freq.toFixed(1)} Hz`;

    const pct = clamp(50 + cents/50*50, 0, 100);
    tunerNeedle.style.left = pct+'%';

    if(Math.abs(cents) < 6){
      tunerNeedle.style.background = 'var(--green)';
      tunerStatus.textContent = '✓ Afinado';
    } else if(cents < 0){
      tunerNeedle.style.background = 'var(--white)';
      tunerStatus.textContent = '▼ Muy bajo, sube el tono';
    } else {
      tunerNeedle.style.background = 'var(--white)';
      tunerStatus.textContent = '▲ Muy alto, baja el tono';
    }

    // marcar cuerda más cercana si estamos en modo guitarra/ukelele
    if(tunerMode!=='chromatic'){
      let closest=null, closestDiff=Infinity;
      stringsRow.querySelectorAll('.string-chip').forEach(chip=>{
        const f = parseFloat(chip.dataset.freq);
        const diff = Math.abs(f-freq);
        if(diff<closestDiff){ closestDiff=diff; closest=chip; }
      });
      stringsRow.querySelectorAll('.string-chip').forEach(c=>c.classList.remove('match'));
      if(closest && closestDiff < closest.dataset.freq*0.03 && Math.abs(cents)<6){
        closest.classList.add('match');
      }
    }
  }

  tunerRafId = requestAnimationFrame(loopTuner);
}

// ============================================================
// TIMELINE TIPO INSHOT
// La pista de audio se desplaza horizontalmente bajo un playhead
// central fijo. Se puede arrastrar para hacer scrubbing.
// ============================================================
const TL = {
  pxPerSec: 90,          // zoom horizontal (px por segundo de audio)
  waveImg: null,         // canvas pre-renderizado con el waveform completo
  waveDurationSec: 0,    // duración del audio dibujado
  pos: 0,                // posición actual en segundos
  dragging: false,
  dragStartX: 0,
  dragStartPos: 0,
};

function tlGetDuration(){
  const b = getEffectiveBuffer();
  return b ? b.duration : 0;
}

// Pre-renderiza el waveform completo a un canvas fuera de pantalla
function tlBuildWaveImage(){
  const buffer = getEffectiveBuffer();
  if(!buffer){ TL.waveImg=null; return; }
  const dpr = window.devicePixelRatio || 1;
  const dur = buffer.duration;
  TL.waveDurationSec = dur;
  const totalW = Math.max(1, Math.floor(dur * TL.pxPerSec));
  const h = 78;

  const off = document.createElement('canvas');
  off.width = totalW * dpr;
  off.height = h * dpr;
  const ctx = off.getContext('2d');
  ctx.scale(dpr, dpr);

  const data = buffer.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / totalW));
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--brown').trim() || '#7a4a26';
  const mid = h/2;
  for(let x=0; x<totalW; x++){
    let min=1, max=-1;
    const base = x*step;
    for(let j=0;j<step;j++){
      const idx = base+j;
      if(idx>=data.length) break;
      const v = data[idx];
      if(v<min) min=v;
      if(v>max) max=v;
    }
    const y1 = mid + min*mid*0.9;
    const y2 = mid + max*mid*0.9;
    ctx.fillRect(x, Math.min(y1,y2), 1, Math.max(2, Math.abs(y2-y1)));
  }
  TL.waveImg = off;
}

// Dibuja la ventana visible centrada en TL.pos
function tlDraw(){
  const dpr = window.devicePixelRatio || 1;
  const rect = timeline.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  if(tlCanvas.width !== w*dpr || tlCanvas.height !== h*dpr){
    tlCanvas.width = w*dpr; tlCanvas.height = h*dpr;
    tlCanvas.style.width = w+'px'; tlCanvas.style.height = h+'px';
  }
  const ctx = tlCanvas.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,w,h);

  if(!TL.waveImg){ return; }

  // el playhead está en el centro (w/2). El pixel del waveform bajo el playhead
  // corresponde a TL.pos * pxPerSec. Desplazamos la imagen para alinearlos.
  const centerX = w/2;
  const srcCenterPx = TL.pos * TL.pxPerSec;
  const drawX = centerX - srcCenterPx;

  // dibujar regiones fuera de la pista con un tono más oscuro (antes del inicio / después del fin)
  ctx.drawImage(TL.waveImg, drawX, 0, TL.waveImg.width/dpr, h);

  // velo sobre la parte ya reproducida (izquierda del centro)
  ctx.fillStyle = 'rgba(255,255,255,0.42)';
  ctx.fillRect(0, 0, centerX, h);

  // marcadores de recorte dibujados sobre el canvas (scroll-corrected)
  if(trimMode){
    const green = getComputedStyle(document.documentElement).getPropertyValue('--green').trim() || '#5d8a4a';
    const sX = (trimStart - TL.pos) * TL.pxPerSec + centerX;
    const eX = (trimEnd   - TL.pos) * TL.pxPerSec + centerX;
    // región sombreada
    const rL = Math.max(0, sX), rR = Math.min(w, eX);
    if(rR > rL){ ctx.fillStyle = 'rgba(93,138,74,0.22)'; ctx.fillRect(rL, 0, rR - rL, h); }
    // línea de inicio centrada en el px exacto
    ctx.fillStyle = green;
    if(sX >= 0 && sX <= w) ctx.fillRect(sX - 1.5, 0, 3, h);
    if(eX >= 0 && eX <= w) ctx.fillRect(eX - 1.5, 0, 3, h);
  }

  // superposición de grabación en vivo (overdub): barras rojas sobre la región grabada
  if(isRecording && isOverdub && recWaveform.length > 0){
    const startPx = (overdubStartSec - TL.pos) * TL.pxPerSec + centerX;
    const regionW = centerX - startPx;
    if(regionW > 0){
      const n = recWaveform.length;
      const barW = regionW / n;
      const mid = h / 2;
      const cs = getComputedStyle(document.documentElement);
      ctx.fillStyle = cs.getPropertyValue('--red').trim() || '#c03020';
      ctx.globalAlpha = 0.85;
      for(let i = 0; i < n; i++){
        const amp = Math.min(1, recWaveform[i] * 4);
        const bH = Math.max(2, amp * h * 0.85);
        const x = startPx + i * barW;
        if(x >= 0 && x <= w) ctx.fillRect(x, mid - bH/2, Math.max(1, barW - 0.5), bH);
      }
      ctx.globalAlpha = 1;
    }
  }
}

let tlRaf = null;
function tlAnimate(){
  // sincroniza TL.pos con la reproducción real
  if(isPlaying && !TL.dragging){
    if(mediaType==='video'){
      // En canvas-reverse, videoEl.currentTime es posición original (va hacia atrás);
      // TL.pos debe ir hacia adelante (posición en buffer revertido).
      TL.pos = isReversed ? (videoEl.duration - videoEl.currentTime) : videoEl.currentTime;
    } else if(sourceNode){
      const ctx = ensureAudioCtx();
      const rate = sourceNode.playbackRate.value;
      const bufElapsed = (ctx.currentTime - playStartCtxTime)*rate;
      if(pitchLockOn && Math.abs(speedRate - 1) > 0.001){
        TL.pos = playStartOffset + bufElapsed*speedRate;
      } else {
        TL.pos = playStartOffset + bufElapsed;
      }
    }
    const dur = tlGetDuration();
    if(!(isRecording && isOverdub) && TL.pos > dur) TL.pos = dur;
    if(TL.pos < 0) TL.pos = 0;
  }
  tlDraw();
  tlRaf = requestAnimationFrame(tlAnimate);
}

function tlInit(){
  tlEmpty.classList.add('hidden');
  tlBuildWaveImage();
  TL.pos = 0;
  if(!tlRaf) tlAnimate();
}

// --- Scrubbing: arrastrar la pista para moverse ---
// --- Zoom con pellizco (pinch) ---
TL.pinching = false;
TL.pinchStartDist = 0;
TL.pinchStartPxPerSec = TL.pxPerSec;
const TL_MIN_PXPERSEC = 12;
const TL_MAX_PXPERSEC = 800;

function touchDist(touches){
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.sqrt(dx*dx + dy*dy);
}

function tlPointerDown(e){
  if(!TL.waveImg) return;
  if(e.touches && e.touches.length === 2){
    // iniciar pellizco: cancelar cualquier drag de 1 dedo en curso
    TL.dragging = false;
    TL.pinching = true;
    TL.pinchStartDist = touchDist(e.touches);
    TL.pinchStartPxPerSec = TL.pxPerSec;
    if(e.cancelable) e.preventDefault();
    return;
  }
  TL.dragging = true;
  timeline.classList.add('dragging');
  TL.dragStartX = (e.touches ? e.touches[0].clientX : e.clientX);
  TL.dragStartPos = TL.pos;
  // si estaba reproduciendo, pausamos para hacer scrub limpio
  TL._wasPlaying = isPlaying;
  if(isPlaying){
    if(mediaType==='audio'){
      const ctx = ensureAudioCtx();
      const rate = sourceNode ? sourceNode.playbackRate.value : 1;
      playStartOffset += (ctx.currentTime - playStartCtxTime)*rate;
    }
    stopPlayback();
  }
}
function tlPointerMove(e){
  if(e.touches && e.touches.length === 2 && TL.pinching){
    const dist = touchDist(e.touches);
    const ratio = dist / Math.max(1, TL.pinchStartDist);
    let newPxPerSec = TL.pinchStartPxPerSec * ratio;
    newPxPerSec = Math.max(TL_MIN_PXPERSEC, Math.min(TL_MAX_PXPERSEC, newPxPerSec));
    TL.pxPerSec = newPxPerSec;
    // TL.pos (el playhead, centro) queda fijo: reconstruimos la imagen con throttle
    // para no saturar en audios largos durante el gesto.
    if(!TL._pinchRebuildScheduled){
      TL._pinchRebuildScheduled = true;
      requestAnimationFrame(()=>{
        tlBuildWaveImage();
        TL._pinchRebuildScheduled = false;
      });
    }
    if(e.cancelable) e.preventDefault();
    return;
  }
  if(!TL.dragging) return;
  const x = (e.touches ? e.touches[0].clientX : e.clientX);
  const dx = x - TL.dragStartX;
  // arrastrar a la derecha => retroceder en el tiempo (la pista se mueve con el dedo)
  let newPos = TL.dragStartPos - dx / TL.pxPerSec;
  const dur = tlGetDuration();
  newPos = Math.max(0, Math.min(dur, newPos));
  TL.pos = newPos;
  // actualizar el offset de reproducción y el reloj
  playStartOffset = newPos;
  if(mediaType==='video' && videoEl.readyState>=1){
    try{ videoEl.currentTime = newPos; }catch(e){}
  }
  if(originalBuffer) timeLabel.textContent = `${fmtTime(newPos)} / ${fmtTime(originalBuffer.duration)}`;
  if(e.cancelable) e.preventDefault();
}
function tlPointerUp(e){
  if(e && e.touches && e.touches.length > 0){
    // todavía queda un dedo; si estábamos en pinch, terminó
    TL.pinching = false;
    return;
  }
  TL.pinching = false;
  if(!TL.dragging) return;
  TL.dragging = false;
  timeline.classList.remove('dragging');
  if(TL._wasPlaying){
    startPlayback();
  }
}

timeline.addEventListener('mousedown', tlPointerDown);
window.addEventListener('mousemove', tlPointerMove);
window.addEventListener('mouseup', tlPointerUp);
timeline.addEventListener('touchstart', tlPointerDown, {passive:false});
timeline.addEventListener('touchmove', tlPointerMove, {passive:false});
timeline.addEventListener('touchend', tlPointerUp);
timeline.addEventListener('touchcancel', tlPointerUp);

// Inicialización
window.addEventListener('resize', ()=>{ if(workingBuffer){ drawWaveform(getEffectiveBuffer()); tlBuildWaveImage(); } });

// ============================================================
// SISTEMA DE COLOR: dos colores base (café y beige) elegidos
// libremente por el usuario; el resto de variantes (oscuro, claro,
// blanco-de-texto) se derivan automáticamente vía HSL.
// ============================================================
const DEFAULT_BROWN = '#7a4a26';
const DEFAULT_CREAM = '#fbe9cf';

let colorBrown = DEFAULT_BROWN;
let colorCream = DEFAULT_CREAM;

function hexToRgb(h){ const n=parseInt(h.slice(1),16); return [n>>16, (n>>8)&255, n&255]; }
function rgbToHex(r,g,b){ return '#'+[r,g,b].map(x=>Math.max(0,Math.min(255,Math.round(x))).toString(16).padStart(2,'0')).join(''); }

function rgbToHsl(r,g,b){
  r/=255; g/=255; b/=255;
  const max=Math.max(r,g,b), min=Math.min(r,g,b);
  let h,s,l=(max+min)/2;
  if(max===min){ h=0; s=0; }
  else{
    const d=max-min;
    s = l>0.5 ? d/(2-max-min) : d/(max+min);
    if(max===r) h=((g-b)/d + (g<b?6:0));
    else if(max===g) h=(b-r)/d+2;
    else h=(r-g)/d+4;
    h/=6;
  }
  return [h*360, s, l];
}
function hslToRgb(h,s,l){
  h/=360;
  function hue2rgb(p,q,t){
    if(t<0) t+=1; if(t>1) t-=1;
    if(t<1/6) return p+(q-p)*6*t;
    if(t<1/2) return q;
    if(t<2/3) return p+(q-p)*(2/3-t)*6;
    return p;
  }
  let r,g,b;
  if(s===0){ r=g=b=l; }
  else{
    const q = l<0.5 ? l*(1+s) : l+s-l*s;
    const p = 2*l-q;
    r=hue2rgb(p,q,h+1/3); g=hue2rgb(p,q,h); b=hue2rgb(p,q,h-1/3);
  }
  return [r*255,g*255,b*255];
}

// Genera una variante más oscura o más clara de un color, preservando su tono (hue).
function shade(hex, lightnessDelta){
  const [r,g,b] = hexToRgb(hex);
  const [h,s,l] = rgbToHsl(r,g,b);
  const newL = Math.max(0, Math.min(1, l + lightnessDelta));
  return rgbToHex(...hslToRgb(h, s, newL));
}

function applyColors(brownHex, creamHex){
  const [,, lBrown] = rgbToHsl(...hexToRgb(brownHex));
  const [,, lCream] = rgbToHsl(...hexToRgb(creamHex));

  const brownDark = shade(brownHex, -0.13);
  const brownLight = shade(brownHex, lBrown < 0.5 ? 0.18 : -0.12);
  const cream2 = shade(creamHex, lCream > 0.5 ? -0.06 : 0.08);
  // "white" es el color de texto/elementos sobre el botón café: debe contrastar con --brown,
  // así que se deriva de su luminosidad (no de la del fondo), llevándolo casi a blanco u oscuro extremo.
  const white = lBrown < 0.5 ? shade(brownHex, 0.85 - lBrown) : shade(brownHex, -(lBrown - 0.08));
  // "card" es el fondo de tarjetas: siempre más claro que el crema, empujado a ~96% luminosidad.
  const card = shade(creamHex, Math.max(0.04, 0.96 - lCream));

  const map = {
    '--cream': creamHex, '--cream-2': cream2, '--card': card,
    '--brown': brownHex, '--brown-dark': brownDark,
    '--brown-light': brownLight, '--white': white
  };
  const root = document.documentElement.style;
  for(const k in map) root.setProperty(k, map[k]);

  // actualizar color de la flecha SVG (usa fill fijo)
  const arrow = document.querySelector('.appa-arrow path');
  if(arrow) arrow.setAttribute('fill', brownHex);

  // actualizar swatches del menú
  const swB = $('swBrown'), swC = $('swCream');
  if(swB) swB.style.background = brownHex;
  if(swC) swC.style.background = creamHex;
  const pB = $('colorBrownPicker'), pC = $('colorCreamPicker');
  if(pB) pB.value = brownHex;
  if(pC) pC.value = creamHex;

  // redibujar waveform y timeline con nuevos colores
  if(workingBuffer){ drawWaveform(getEffectiveBuffer()); tlBuildWaveImage(); }

  try{
    localStorage.setItem('appa_color_brown', brownHex);
    localStorage.setItem('appa_color_cream', creamHex);
  }catch(e){}
}

function setBrown(hex){ colorBrown = hex; applyColors(colorBrown, colorCream); }
function setCream(hex){ colorCream = hex; applyColors(colorBrown, colorCream); }
function swapColors(){
  const tmp = colorBrown;
  colorBrown = colorCream;
  colorCream = tmp;
  applyColors(colorBrown, colorCream);
}
function resetColors(){
  colorBrown = DEFAULT_BROWN;
  colorCream = DEFAULT_CREAM;
  applyColors(colorBrown, colorCream);
}

function renderExportLog(){
  const list = $('exportLogList');
  if(!exportLog.length){
    list.innerHTML = '<div class="log-empty">Aún no has exportado nada.</div>';
    return;
  }
  list.innerHTML = '';
  exportLog.forEach(item=>{
    const div = document.createElement('div');
    div.className = 'log-item';
    div.innerHTML = `<div class="log-name">${item.name}</div>
      <div class="log-meta">${item.format} · ${item.duration} · pitch ${item.pitch} · vel ${item.speed}x<br>${item.date}</div>`;
    list.appendChild(div);
  });
}

// Restaurar colores guardados
try{
  const savedBrown = localStorage.getItem('appa_color_brown');
  const savedCream = localStorage.getItem('appa_color_cream');
  if(savedBrown) colorBrown = savedBrown;
  if(savedCream) colorCream = savedCream;
  if(savedBrown || savedCream) applyColors(colorBrown, colorCream);
}catch(e){}

// Handlers del menú Appa
const appaMenu = $('appaMenu');

function openAppaMenu(){
  applyColors(colorBrown, colorCream);
  renderExportLog();
  appaMenu.classList.remove('hidden');
}
$('appaMenuBtn').addEventListener('click', openAppaMenu);
$('footerBrand').addEventListener('click', openAppaMenu);
$('menuClose').addEventListener('click', ()=> appaMenu.classList.add('hidden'));
appaMenu.addEventListener('click', (e)=>{ if(e.target===appaMenu) appaMenu.classList.add('hidden'); });

$('colorBrownPicker').addEventListener('input', (e)=> setBrown(e.target.value));
$('colorCreamPicker').addEventListener('input', (e)=> setCream(e.target.value));
$('invertBtn').addEventListener('click', swapColors);
$('resetColorsBtn').addEventListener('click', resetColors);

$('clearLogBtn').addEventListener('click', ()=>{
  exportLog = [];
  try{ localStorage.removeItem('appa_export_log'); }catch(e){}
  renderExportLog();
});

// ──────────────────────────────────────────────
// APARIENCIA: Fondo especial + Fondo móvil + Transparencia
// ──────────────────────────────────────────────
let fondoEspecial = false;
let fondoMobile = false;
let fondoOrientHandler = null;
let btnOpacity = 100;

function applyFondoEspecial(on){
  fondoEspecial = on;
  document.body.classList.toggle('fondo-especial', on);
  document.documentElement.classList.toggle('fondo-especial', on);
  const btn = $('fondoEspecialBtn');
  if(btn) btn.classList.toggle('btn-active', on);
  const mobileBtn = $('fondoMobileBtn');
  if(mobileBtn) mobileBtn.classList.toggle('hidden', !on);
  if(!on && fondoMobile) applyFondoMobile(false);
  try{ localStorage.setItem('appa_fondo', on ? '1' : '0'); }catch(e){}
}

function applyFondoMobile(on){
  fondoMobile = on;
  const btn = $('fondoMobileBtn');
  if(btn) btn.classList.toggle('btn-active', on);
  const layer = $('fondoLayer');
  if(!layer) return;

  if(on){
    layer.style.inset = '-55px';
    fondoOrientHandler = function(e){
      const x = Math.max(-1, Math.min(1, (e.gamma || 0) / 25));
      const y = Math.max(-1, Math.min(1, ((e.beta || 45) - 45) / 25));
      layer.style.transform = `translate(${x*40}px,${y*40}px)`;
    };
    const start = ()=> window.addEventListener('deviceorientation', fondoOrientHandler);
    if(typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function'){
      DeviceOrientationEvent.requestPermission().then(state=>{
        if(state === 'granted') start();
        else applyFondoMobile(false);
      }).catch(()=> applyFondoMobile(false));
    } else {
      start();
    }
    try{ localStorage.setItem('appa_fondo_mobile', '1'); }catch(e){}
  } else {
    layer.style.inset = '0';
    layer.style.transform = '';
    if(fondoOrientHandler){
      window.removeEventListener('deviceorientation', fondoOrientHandler);
      fondoOrientHandler = null;
    }
    try{ localStorage.removeItem('appa_fondo_mobile'); }catch(e){}
  }
}

function applyBtnOpacity(val){
  btnOpacity = val;
  document.documentElement.style.setProperty('--btn-opacity', val / 100);
  const v = $('btnOpacityVal');
  if(v) v.textContent = val + '%';
  const s = $('btnOpacitySlider');
  if(s) s.value = val;
  try{ localStorage.setItem('appa_btn_opacity', val); }catch(e){}
}

// Restaurar ajustes de apariencia
try{
  const sf = localStorage.getItem('appa_fondo');
  if(sf === '1') applyFondoEspecial(true);
  const sm = localStorage.getItem('appa_fondo_mobile');
  if(sm === '1' && fondoEspecial) applyFondoMobile(true);
  const so = localStorage.getItem('appa_btn_opacity');
  if(so !== null) applyBtnOpacity(parseInt(so));
}catch(e){}

$('fondoEspecialBtn').addEventListener('click', ()=> applyFondoEspecial(!fondoEspecial));
$('fondoMobileBtn').addEventListener('click', ()=> applyFondoMobile(!fondoMobile));
$('btnOpacitySlider').addEventListener('input', (e)=> applyBtnOpacity(parseInt(e.target.value)));

// ============================================================
// MODO RECORTAR: conservar selección vs eliminar trozo del medio
// ============================================================
$('trimModeKeep').addEventListener('click', ()=>{
  trimAction = 'keep';
  $('trimModeKeep').classList.add('active');
  $('trimModeCut').classList.remove('active');
  $('trimApply').textContent = 'Aplicar recorte';
});
$('trimModeCut').addEventListener('click', ()=>{
  trimAction = 'cut';
  $('trimModeCut').classList.add('active');
  $('trimModeKeep').classList.remove('active');
  $('trimApply').textContent = 'Eliminar trozo';
});

// ============================================================
// EFECTOS (Reverb + Distorsión + Compresor + Delay + EQ)
// ============================================================
let distortionOn = false;
let distortionAmount = 0.5;

let compOn = false;
let compThreshold = -24;
let compRatio = 4;

let delayOn = false;
let delayTime = 0.30;
let delayFeedback = 0.40;

let eqOn = false;
const EQ_BANDS = [
  { freq: 60,    type: 'lowshelf'  },
  { freq: 230,   type: 'peaking'   },
  { freq: 910,   type: 'peaking'   },
  { freq: 3600,  type: 'peaking'   },
  { freq: 14000, type: 'highshelf' },
];
let eqGains = [0, 0, 0, 0, 0];
const EQ_PRESETS = {
  flat:   [ 0,  0,  0,  0,  0],
  bass:   [ 6,  4,  0, -2, -2],
  treble: [-2,  0,  0,  4,  6],
  vocal:  [-2, -1,  3,  4,  2],
};

const btnEfectos = $('btnEfectos');
const efectosPanel = $('efectosPanel');

function updateEfxGlow(){
  const panelOpen = !efectosPanel.classList.contains('hidden');
  btnEfectos.classList.toggle('efx-glow', (reverbOn || distortionOn || compOn || delayOn || eqOn) && !panelOpen);
}

btnEfectos.addEventListener('click', ()=>{
  const open = !efectosPanel.classList.contains('hidden');
  efectosPanel.classList.toggle('hidden', open);
  btnEfectos.classList.toggle('active', !open);
  if(!open) efectosPanel.scrollIntoView({behavior:'smooth', block:'nearest'});
  updateEfxGlow();
});

$('reverbToggle').addEventListener('click', ()=>{
  reverbOn = !reverbOn;
  const btn = $('reverbToggle');
  btn.textContent = reverbOn ? 'ON' : 'OFF';
  btn.classList.toggle('active', reverbOn);
  $('reverbCtrl').classList.toggle('hidden', !reverbOn);
  if(isPlaying){ stopPlayback(); startPlayback(); }
  updateEfxGlow();
});

$('reverbMixSlider').addEventListener('input', (e)=>{
  reverbMix = parseInt(e.target.value) / 100;
  $('reverbMixLabel').textContent = e.target.value + '%';
  if(liveReverbWet){ liveReverbWet.gain.setTargetAtTime(reverbMix, audioCtx.currentTime, 0.01); }
  if(liveReverbDry){ liveReverbDry.gain.setTargetAtTime(1-reverbMix, audioCtx.currentTime, 0.01); }
});

$('distortionToggle').addEventListener('click', ()=>{
  distortionOn = !distortionOn;
  const btn = $('distortionToggle');
  btn.textContent = distortionOn ? 'ON' : 'OFF';
  btn.classList.toggle('active', distortionOn);
  $('distortionCtrl').classList.toggle('hidden', !distortionOn);
  if(isPlaying){ stopPlayback(); startPlayback(); }
  updateEfxGlow();
});

$('distortionSlider').addEventListener('input', (e)=>{
  distortionAmount = parseInt(e.target.value) / 100;
  $('distortionLabel').textContent = e.target.value + '%';
  if(liveDistShaper){ liveDistShaper.curve = createDistortionCurve(distortionAmount); }
});

// Compresor
$('compToggle').addEventListener('click', ()=>{
  compOn = !compOn;
  const btn = $('compToggle');
  btn.textContent = compOn ? 'ON' : 'OFF';
  btn.classList.toggle('active', compOn);
  $('compCtrl').classList.toggle('hidden', !compOn);
  if(isPlaying){ stopPlayback(); startPlayback(); }
  updateEfxGlow();
});
$('compRatioSlider').addEventListener('input', (e)=>{
  compRatio = parseFloat(e.target.value);
  $('compRatioLabel').textContent = compRatio + ':1';
  if(liveComp){ liveComp.ratio.setTargetAtTime(compRatio, audioCtx.currentTime, 0.01); }
});
$('compThreshSlider').addEventListener('input', (e)=>{
  compThreshold = parseInt(e.target.value);
  $('compThreshLabel').textContent = (compThreshold >= 0 ? '' : '−') + Math.abs(compThreshold) + ' dB';
  if(liveComp){ liveComp.threshold.setTargetAtTime(compThreshold, audioCtx.currentTime, 0.01); }
});

// Delay
$('delayToggle').addEventListener('click', ()=>{
  delayOn = !delayOn;
  const btn = $('delayToggle');
  btn.textContent = delayOn ? 'ON' : 'OFF';
  btn.classList.toggle('active', delayOn);
  $('delayCtrl').classList.toggle('hidden', !delayOn);
  if(isPlaying){ stopPlayback(); startPlayback(); }
  updateEfxGlow();
});
$('delayTimeSlider').addEventListener('input', (e)=>{
  delayTime = parseInt(e.target.value) / 1000;
  $('delayTimeLabel').textContent = e.target.value + ' ms';
  if(liveDelayNode){ liveDelayNode.delayTime.setTargetAtTime(delayTime, audioCtx.currentTime, 0.01); }
});
$('delayFeedbackSlider').addEventListener('input', (e)=>{
  delayFeedback = parseInt(e.target.value) / 100;
  $('delayFeedbackLabel').textContent = e.target.value + '%';
  if(liveDelayFb){ liveDelayFb.gain.setTargetAtTime(delayFeedback, audioCtx.currentTime, 0.01); }
});

// Ecualizador
$('eqToggle').addEventListener('click', ()=>{
  eqOn = !eqOn;
  const btn = $('eqToggle');
  btn.textContent = eqOn ? 'ON' : 'OFF';
  btn.classList.toggle('active', eqOn);
  $('eqCtrl').classList.toggle('hidden', !eqOn);
  if(isPlaying){ stopPlayback(); startPlayback(); }
  updateEfxGlow();
});
for(let i = 0; i < 5; i++){
  $(`eqBand${i}`).addEventListener('input', e => {
    const band = +e.target.id.slice(-1);
    const val = +e.target.value;
    eqGains[band] = val;
    $(`eqVal${band}`).textContent = val === 0 ? '0' : (val > 0 ? '+' : '−') + Math.abs(val);
    document.querySelectorAll('.eq-preset').forEach(b => b.classList.remove('active'));
    if(liveEqFilters[band]){ liveEqFilters[band].gain.setTargetAtTime(val, audioCtx.currentTime, 0.005); }
  });
}
document.querySelectorAll('.eq-preset').forEach(btn => {
  btn.addEventListener('click', ()=>{
    const preset = EQ_PRESETS[btn.dataset.preset];
    preset.forEach((val, i) => {
      eqGains[i] = val;
      $(`eqBand${i}`).value = val;
      $(`eqVal${i}`).textContent = val === 0 ? '0' : (val > 0 ? '+' : '−') + Math.abs(val);
      if(liveEqFilters[i]){ liveEqFilters[i].gain.setTargetAtTime(val, audioCtx.currentTime, 0.005); }
    });
    document.querySelectorAll('.eq-preset').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

// Handlers del diálogo de exportación
$('exportClose').addEventListener('click', ()=> exportDialog.classList.add('hidden'));
exportDialog.addEventListener('click', (e)=>{ if(e.target===exportDialog) exportDialog.classList.add('hidden'); });
document.querySelectorAll('.modal-option').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    const fmt = btn.dataset.fmt;
    const kbps = btn.dataset.kbps ? parseInt(btn.dataset.kbps) : null;
    exportDialog.classList.add('hidden');
    doExport(fmt, kbps);
  });
});

// ============================================================
// LOOP
// ============================================================
const btnLoop = $('btnLoop');
btnLoop.addEventListener('click', ()=>{
  loopEnabled = !loopEnabled;
  btnLoop.classList.toggle('active', loopEnabled);
  setStatus(loopEnabled ? 'Bucle activado: el audio se repetirá' : 'Bucle desactivado', 2000);
});

// ============================================================
// BOTONES DE PASO DE VELOCIDAD (+/-)
// ============================================================
const SPEED_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10];

function setSpeedStep(dir){
  const cur = speedRate;
  let idx = SPEED_STEPS.findIndex(s => Math.abs(s - cur) < 0.001);
  if(idx === -1) idx = SPEED_STEPS.reduce((bi, s, i) => Math.abs(s - cur) < Math.abs(SPEED_STEPS[bi] - cur) ? i : bi, 0);
  idx = Math.max(0, Math.min(SPEED_STEPS.length - 1, idx + dir));
  const v = SPEED_STEPS[idx];
  speedRate = v;
  speedSlider.value = v;
  speedValue.value = v.toFixed(3);
  restartPlaybackIfPlaying();
  pushHistory();
}

$('btnSpeedDown').addEventListener('click', ()=> setSpeedStep(-1));
$('btnSpeedUp').addEventListener('click', ()=> setSpeedStep(1));

// ============================================================
// RECORTAR (trim)
// ============================================================
const btnTrim = $('btnTrim');
const trimPanel = $('trimPanel');
btnTrim.addEventListener('click', ()=>{
  if(!workingBuffer){ setStatus('Primero sube o graba un audio', 2500); return; }
  trimMode = !trimMode;
  btnTrim.classList.toggle('active', trimMode);
  trimPanel.classList.toggle('hidden', !trimMode);
  if(trimMode){
    trimStart = 0;
    trimEnd = getEffectiveBuffer().duration;
    // Resetear modo al abrir
    trimAction = 'keep';
    $('trimModeKeep').classList.add('active');
    $('trimModeCut').classList.remove('active');
    $('trimApply').textContent = 'Aplicar recorte';
    updateTrimLabels();
    drawTrimMarkers();
    trimPanel.scrollIntoView({behavior:'smooth', block:'center'});
  } else {
    clearTrimMarkers();
  }
});

function updateTrimLabels(){
  $('trimStartLabel').textContent = fmtTime(trimStart);
  $('trimEndLabel').textContent = fmtTime(trimEnd);
}

$('trimSetStart').addEventListener('click', ()=>{
  trimStart = Math.min(TL.pos, trimEnd - 0.1);
  trimStart = Math.max(0, trimStart);
  updateTrimLabels();
  drawTrimMarkers();
});
$('trimSetEnd').addEventListener('click', ()=>{
  trimEnd = Math.max(TL.pos, trimStart + 0.1);
  trimEnd = Math.min(getEffectiveBuffer().duration, trimEnd);
  updateTrimLabels();
  drawTrimMarkers();
});

$('trimCancel').addEventListener('click', ()=>{
  trimMode = false;
  btnTrim.classList.remove('active');
  trimPanel.classList.add('hidden');
  clearTrimMarkers();
});

$('trimApply').addEventListener('click', ()=>{
  const src = getEffectiveBuffer();
  const sr = src.sampleRate;
  const startSample = Math.floor(trimStart * sr);
  const endSample = Math.floor(trimEnd * sr);

  const audioCtx = ensureAudioCtx();
  let result;

  if(trimAction === 'cut'){
    // Eliminar trozo: concatenar [0, trimStart] + [trimEnd, fin]
    const newLen = startSample + (src.length - endSample);
    if(newLen <= 0 || src.length - endSample < 0){ setStatus('Rango inválido'); return; }
    result = audioCtx.createBuffer(src.numberOfChannels, newLen, sr);
    for(let ch=0; ch<src.numberOfChannels; ch++){
      const inp = src.getChannelData(ch);
      const out = result.getChannelData(ch);
      out.set(inp.subarray(0, startSample), 0);
      out.set(inp.subarray(endSample), startSample);
    }
  } else {
    // Conservar selección: quedarse con [trimStart, trimEnd]
    const newLen = endSample - startSample;
    if(newLen <= 0){ setStatus('Rango de recorte inválido'); return; }
    result = audioCtx.createBuffer(src.numberOfChannels, newLen, sr);
    for(let ch=0; ch<src.numberOfChannels; ch++){
      const from = src.getChannelData(ch).subarray(startSample, endSample);
      result.getChannelData(ch).set(from);
    }
  }

  originalBuffer = result;
  workingBuffer = result;
  isReversed = false;
  btnReverse.classList.remove('active');
  reversedCache = null; reversedCacheSrc = null;
  stopPlayback();
  playStartOffset = 0;
  drawWaveform(workingBuffer);
  tlInit();
  trimMode = false;
  btnTrim.classList.remove('active');
  trimPanel.classList.add('hidden');
  clearTrimMarkers();
  timeLabel.textContent = `0:00 / ${fmtTime(originalBuffer.duration)}`;
  setStatus(trimAction === 'cut' ? 'Trozo eliminado ✓' : 'Audio recortado ✓', 2000);
  pushHistory();
});

function drawTrimMarkers(){
  clearTrimMarkers(); // los marcadores ahora se dibujan en canvas en tlDraw()
}
function clearTrimMarkers(){
  timeline.querySelectorAll('[data-trim]').forEach(el=> el.remove());
}

// ============================================================
// DETECTAR TONO EN TIEMPO REAL durante la reproducción del audio
// (además del análisis estático). Mientras el audio suena en modo
// 'audiofile', mostramos la nota del instante actual.
// ============================================================
function startLiveToneTracking(){
  if(liveToneRaf) return;
  function track(){
    if(tunerMode !== 'audiofile' || !isPlaying){ liveToneRaf = null; return; }
    const buffer = getEffectiveBuffer();
    if(buffer){
      const sr = buffer.sampleRate;
      const data = buffer.getChannelData(0);
      // tomar una ventana alrededor de la posición actual de reproducción
      const center = Math.floor(TL.pos * sr);
      const winSize = 4096;
      const start = Math.max(0, center - winSize/2);
      if(start + winSize < data.length){
        const slice = data.slice(start, start+winSize);
        const rawFreq = autoCorrelate(slice, sr);
        if(rawFreq > 40 && rawFreq < 2000 && isFinite(rawFreq)){
          const freq = rawFreq * semitonesToRate(pitchSemis);
          const {name, solfege, octave, cents} = freqToNote(freq);
          tunerNote.textContent = `${name}${octave} · ${solfege}`;
          tunerFreq.textContent = freq.toFixed(1) + ' Hz';
          const pct = clamp(50 + cents/50*50, 0, 100);
          tunerNeedle.style.left = pct + '%';
          tunerNeedle.style.background = Math.abs(cents)<15 ? 'var(--green)' : 'var(--white)';
          tunerStatus.textContent = '▶ Tono en tiempo real';
        }
      }
    }
    liveToneRaf = requestAnimationFrame(track);
  }
  track();
}

// ============================================================
// Desplegable "Cómo usar la app"
// ============================================================
$('helpToggle').addEventListener('click', ()=>{
  const content = $('helpContent');
  const toggle = $('helpToggle');
  const isHidden = content.classList.contains('hidden');
  content.classList.toggle('hidden');
  toggle.classList.toggle('open', isHidden);
});
document.querySelectorAll('.help-item:not(.always-open) .help-item-header').forEach(header => {
  header.addEventListener('click', () => header.closest('.help-item').classList.toggle('open'));
});

// ============================================================
// SESIÓN GUARDADA (IndexedDB): recuerda el último audio/video cargado
// y el estado de los controles, para restaurarlo si cierras Safari.
// Usamos IndexedDB en vez de localStorage porque permite guardar archivos
// grandes (localStorage limita a ~5-10MB; IndexedDB da mucho más espacio).
// ============================================================
const SESSION_DB_NAME = 'appa-session-db';
const SESSION_STORE = 'session';
const SESSION_KEY = 'last';
let sessionDB = null;
let sessionSaveTimer = null;

function openSessionDB(){
  return new Promise((resolve, reject)=>{
    const req = indexedDB.open(SESSION_DB_NAME, 1);
    req.onupgradeneeded = ()=>{
      req.result.createObjectStore(SESSION_STORE);
    };
    req.onsuccess = ()=> resolve(req.result);
    req.onerror = ()=> reject(req.error);
  });
}

async function ensureSessionDB(){
  if(sessionDB) return sessionDB;
  // Safari/iOS tiene un bug conocido donde IndexedDB falla en el primer intento
  // de la sesión del navegador; reintentamos una vez antes de rendirnos.
  for(let attempt=0; attempt<2; attempt++){
    try{
      sessionDB = await openSessionDB();
      return sessionDB;
    }catch(e){
      console.warn('IndexedDB intento', attempt+1, 'falló', e);
    }
  }
  console.warn('IndexedDB no disponible tras reintentos; la sesión no se guardará');
  return null;
}

// Guarda el estado actual (con debounce para no escribir en cada pixel de un slider)
function scheduleSaveSession(){
  if(sessionSaveTimer) clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(saveSessionNow, 600);
}

async function saveSessionNow(){
  if(!originalVideoFile && !workingBuffer) return; // nada que guardar
  const db = await ensureSessionDB();
  if(!db) return;

  // El archivo fuente: si es video, el File original; si es audio, lo reconstruimos
  // como WAV desde el buffer (no siempre tenemos el File original, ej. tras recortar).
  let fileBlob = null;
  let fileName = 'sesion';
  try{
    if(mediaType === 'video' && originalVideoFile){
      fileBlob = originalVideoFile;
      fileName = originalVideoFile.name || 'video';
    } else if(originalBuffer){
      fileBlob = bufferToWav(originalBuffer);
      fileName = 'audio.wav';
    }
  }catch(e){ console.warn('No se pudo preparar el archivo de sesión', e); return; }
  if(!fileBlob) return;

  const state = {
    mediaType, fileName, fileBlob,
    pitchSemis, speedRate, pitchLockOn, isReversed, loopEnabled,
    savedAt: Date.now()
  };

  try{
    await new Promise((resolve, reject)=>{
      const tx = db.transaction(SESSION_STORE, 'readwrite');
      tx.objectStore(SESSION_STORE).put(state, SESSION_KEY);
      tx.oncomplete = resolve;
      tx.onerror = ()=> reject(tx.error);
    });
  }catch(e){
    console.warn('No se pudo guardar la sesión (puede que el archivo sea muy grande)', e);
  }
}

async function loadSavedSession(){
  const db = await ensureSessionDB();
  if(!db) return null;
  try{
    return await new Promise((resolve, reject)=>{
      const tx = db.transaction(SESSION_STORE, 'readonly');
      const req = tx.objectStore(SESSION_STORE).get(SESSION_KEY);
      req.onsuccess = ()=> resolve(req.result || null);
      req.onerror = ()=> reject(req.error);
    });
  }catch(e){ return null; }
}

async function clearSavedSession(){
  const db = await ensureSessionDB();
  if(!db) return;
  try{
    const tx = db.transaction(SESSION_STORE, 'readwrite');
    tx.objectStore(SESSION_STORE).delete(SESSION_KEY);
  }catch(e){}
}

// Al abrir la app: si hay una sesión guardada, ofrecer restaurarla
async function checkForSavedSession(){
  const state = await loadSavedSession();
  if(!state || !state.fileBlob) return;
  const ageMin = Math.round((Date.now() - (state.savedAt||0)) / 60000);
  const label = ageMin < 1 ? 'hace un momento' : ageMin < 60 ? `hace ${ageMin} min` : `hace ${Math.round(ageMin/60)} h`;
  showSessionRestoreBar(state, label);
}

function showSessionRestoreBar(state, label){
  const bar = document.createElement('div');
  bar.className = 'session-restore-bar';
  bar.innerHTML = `
    <span>Tienes una sesión guardada (${label}): <b>${state.fileName}</b></span>
    <div class="session-restore-btns">
      <button id="sessionRestoreYes">Restaurar</button>
      <button id="sessionRestoreNo">Descartar</button>
    </div>`;
  document.body.appendChild(bar);

  $('sessionRestoreYes') && document.getElementById('sessionRestoreYes').addEventListener('click', async ()=>{
    bar.remove();
    await restoreSession(state);
  });
  document.getElementById('sessionRestoreNo').addEventListener('click', async ()=>{
    bar.remove();
    await clearSavedSession();
  });
}

async function restoreSession(state){
  setStatus('Restaurando sesión…');
  const file = new File([state.fileBlob], state.fileName, {type: state.fileBlob.type});
  await loadFile(file);
  pitchSemis = state.pitchSemis || 0;
  speedRate = state.speedRate || 1;
  pitchLockOn = !!state.pitchLockOn;
  loopEnabled = !!state.loopEnabled;
  pitchSlider.value = pitchSemis; pitchValue.value = pitchSemis.toFixed(3);
  speedSlider.value = speedRate; speedValue.value = speedRate.toFixed(3);
  btnPitchLock.classList.toggle('active', pitchLockOn);
  btnLoop.classList.toggle('active', loopEnabled);
  if(state.isReversed){ btnReverse.click(); } // reutiliza la lógica existente de reversa
  updatePitchLockHint();
  setStatus('Sesión restaurada ✓', 2000);
}

// ============================================================
// BOTÓN ⓘ — scroll al footer + destello de A.P.P.A.
// ============================================================
$('btnInfo').addEventListener('click', ()=>{
  const brand = $('footerBrand');
  const help = $('helpToggle');
  brand.scrollIntoView({behavior:'smooth', block:'center'});
  setTimeout(()=>{
    brand.classList.remove('blinking');
    void brand.offsetWidth;
    brand.classList.add('blinking');
    brand.addEventListener('animationend', ()=>{
      brand.classList.remove('blinking');
      // un solo blink en el botón de ayuda justo después
      help.classList.remove('blinking');
      void help.offsetWidth;
      help.classList.add('blinking');
      help.addEventListener('animationend', ()=> help.classList.remove('blinking'), {once:true});
    }, {once:true});
  }, 500);
});

// ============================================================
// EXPLOSIÓN DE CARITAS al tocar la cara de Appa
// ============================================================
appaFaceWrap.addEventListener('click', ()=>{
  const rect = appaFaceWrap.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const count = 18;
  const gravity = 900; // px/s²

  for(let i = 0; i < count; i++){
    const img = document.createElement('img');
    img.src = 'appa-loading.png';
    const size = 28 + Math.random() * 54;
    img.style.cssText = `position:fixed;width:${size}px;height:${size}px;` +
      `left:${cx - size/2}px;top:${cy - size/2}px;` +
      `pointer-events:none;z-index:9999;object-fit:contain;border-radius:50%;`;
    document.body.appendChild(img);

    const angle = Math.random() * Math.PI * 2;
    const speed = 220 + Math.random() * 380;
    const vx = Math.cos(angle) * speed;
    const vy = Math.sin(angle) * speed - 200; // impulso inicial hacia arriba
    const spin = (Math.random() - 0.5) * 540;
    const dur = 1100 + Math.random() * 700;
    const steps = 24;

    const kfs = [];
    for(let s = 0; s <= steps; s++){
      const t = (s / steps) * (dur / 1000);
      const x = vx * t;
      const y = vy * t + 0.5 * gravity * t * t;
      const r = spin * (s / steps);
      const fade = s < steps * 0.6 ? 1 : 1 - (s / steps - 0.6) / 0.4;
      kfs.push({ transform: `translate(${x}px,${y}px) rotate(${r}deg)`, opacity: Math.max(0, fade) });
    }

    img.animate(kfs, { duration: dur, fill: 'forwards' })
      .addEventListener('finish', ()=> img.remove());
  }
});

// ============================================================
// DETECCIÓN DE PERMISOS (micrófono / parlante)
// ============================================================
const permBanner = $('permBanner');

async function checkAndShowPermBanner(){
  let needsMic = false;
  let needsAudio = false;

  // Mic: mostrar si no fue concedido (incluye 'prompt' = nunca pedido, y 'denied')
  try{
    const perm = await navigator.permissions.query({name:'microphone'});
    if(perm.state !== 'granted') needsMic = true;
    // Escuchar cambios futuros (ej: el usuario revoca desde ajustes del dispositivo)
    perm.addEventListener('change', ()=> checkAndShowPermBanner(), {once:true});
  }catch(e){
    // Safari no soporta permissions.query para mic; los labels solo aparecen si está concedido
    try{
      const devices = await navigator.mediaDevices.enumerateDevices();
      const hasInput = devices.some(d=> d.kind === 'audioinput');
      const granted  = devices.some(d=> d.kind === 'audioinput' && d.label !== '');
      if(hasInput && !granted) needsMic = true;
    }catch(e2){ needsMic = true; }
  }

  // Audio/parlante: AudioContext suspendido = no puede reproducir
  if(audioCtx && audioCtx.state === 'suspended') needsAudio = true;

  permBanner.classList.toggle('hidden', !(needsMic || needsAudio));
}

$('btnActivatePerm').addEventListener('click', async ()=>{
  try{
    if(audioCtx && audioCtx.state === 'suspended') await audioCtx.resume();
    const stream = await navigator.mediaDevices.getUserMedia({audio:true});
    stream.getTracks().forEach(t=> t.stop());
    permBanner.classList.add('hidden');
    triggerAppaExplosionScreen(22);
  }catch(err){
    setStatus('No se pudo obtener acceso. Revisá los permisos del dispositivo.', 3500);
  }
});

$('btnRefreshPerm').addEventListener('click', async ()=>{
  try{
    // Siempre intentar reanudar el AudioContext primero
    if(audioCtx && audioCtx.state === 'suspended') await audioCtx.resume();
    // Verificar / pedir micrófono
    const stream = await navigator.mediaDevices.getUserMedia({audio:true});
    stream.getTracks().forEach(t=> t.stop());
    // Todo OK: ocultar banner si estaba visible y celebrar con más appas
    await checkAndShowPermBanner();
    triggerAppaExplosionScreen(35);
    setStatus('Micrófono y parlante activos ✓', 2000);
  }catch(err){
    setStatus('Sin acceso al micrófono. Revisá los permisos del dispositivo.', 3500);
    await checkAndShowPermBanner();
  }
});

function triggerAppaExplosionScreen(count = 22){
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;
  const gravity = 900;
  for(let i = 0; i < count; i++){
    const img = document.createElement('img');
    img.src = 'appa-loading.png';
    const size = 28 + Math.random() * 54;
    img.style.cssText = `position:fixed;width:${size}px;height:${size}px;` +
      `left:${cx - size/2}px;top:${cy - size/2}px;` +
      `pointer-events:none;z-index:9999;object-fit:contain;border-radius:50%;`;
    document.body.appendChild(img);
    const angle = Math.random() * Math.PI * 2;
    const speed = 250 + Math.random() * 400;
    const vx = Math.cos(angle) * speed;
    const vy = Math.sin(angle) * speed - 260;
    const spin = (Math.random() - 0.5) * 540;
    const dur = 1100 + Math.random() * 700;
    const steps = 24;
    const kfs = [];
    for(let s = 0; s <= steps; s++){
      const t = (s / steps) * (dur / 1000);
      const x = vx * t;
      const y = vy * t + 0.5 * gravity * t * t;
      const r = spin * (s / steps);
      const fade = s < steps * 0.6 ? 1 : 1 - (s / steps - 0.6) / 0.4;
      kfs.push({transform:`translate(${x}px,${y}px) rotate(${r}deg)`, opacity:Math.max(0, fade)});
    }
    img.animate(kfs, {duration:dur, fill:'forwards'})
      .addEventListener('finish', ()=> img.remove());
  }
}

// Chequear al cargar y cada vez que el usuario vuelve a la app
window.addEventListener('load', ()=> setTimeout(checkAndShowPermBanner, 1000));
document.addEventListener('visibilitychange', ()=>{
  if(document.visibilityState === 'visible') checkAndShowPermBanner();
});
// Registrar service worker para uso offline (PWA)
if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  });
}

// ============================================================
// MÓDULO ACORDES — detección, nombres y diagramas
// ============================================================
function updateReanalyzeShimmer(){
  $('reanalyzeBtn').classList.toggle('altered', pitchSemis !== 0 || speedRate !== 1);
}

(function(){
  const NES = ['Do','Do#','Re','Re#','Mi','Fa','Fa#','Sol','Sol#','La','La#','Si'];
  const NEN = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const NEF = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B']; // flat names

  const N2S = {};
  NES.forEach((n,i)=>{ N2S[n.toLowerCase()]=i; });
  NEN.forEach((n,i)=>{ N2S[n.toLowerCase()]=i; });
  NEF.forEach((n,i)=>{ N2S[n.toLowerCase()]=i; });

  function noteToSemi(name){
    return N2S[name.trim().toLowerCase().replace(/sostenido/g,'#').replace(/bemol/g,'b')] ?? null;
  }

  const CT = [
    {es:'mayor',    en:'',      iv:[0,4,7]},
    {es:'menor',    en:'m',     iv:[0,3,7]},
    {es:'7',        en:'7',     iv:[0,4,7,10]},
    {es:'maj7',     en:'maj7',  iv:[0,4,7,11]},
    {es:'m7',       en:'m7',    iv:[0,3,7,10]},
    {es:'dim',      en:'dim',   iv:[0,3,6]},
    {es:'dim7',     en:'dim7',  iv:[0,3,6,9]},
    {es:'aug',      en:'aug',   iv:[0,4,8]},
    {es:'sus2',     en:'sus2',  iv:[0,2,7]},
    {es:'sus4',     en:'sus4',  iv:[0,5,7]},
    {es:'m maj7',   en:'mM7',   iv:[0,3,7,11]},
    {es:'9',        en:'9',     iv:[0,4,7,10,14]},
    {es:'m9',       en:'m9',    iv:[0,3,7,10,14]},
    {es:'maj9',     en:'maj9',  iv:[0,4,7,11,14]},
    {es:'6',        en:'6',     iv:[0,4,7,9]},
    {es:'m6',       en:'m6',    iv:[0,3,7,9]},
    {es:'add9',     en:'add9',  iv:[0,4,7,14]},
    {es:'7sus4',    en:'7sus4', iv:[0,5,7,10]},
    {es:'5',        en:'5',     iv:[0,7]},
  ];

  function detectChords(semis){
    const pcs = [...new Set(semis.map(s=>((s%12)+12)%12))];
    if(!pcs.length) return [];
    const res = [];
    for(let r=0;r<12;r++){
      for(const t of CT){
        const needed = [...new Set(t.iv.map(i=>(r+(i%12))%12))];
        if(needed.every(n=>pcs.includes(n)) && pcs.every(n=>needed.includes(n)))
          res.push({r, t, nameEs:`${NES[r]} ${t.es}`, nameEn:`${NEN[r]}${t.en}`});
      }
    }
    return res;
  }

  function parseChordName(inp){
    let s = inp.trim().replace(/sostenido/gi,'#').replace(/bemol/gi,'b');
    const esNotes = [
      ['Sol#',8],['Solb',6],['Sol',7],['Fa#',6],['Fa',5],
      ['Re#',3],['Reb',1],['Re',2],['Do#',1],['Do',0],
      ['La#',10],['Lab',8],['La',9],
      ['Mib',3],['Mi',4],
      ['Sib',10],['Si',11],
    ];
    for(const [nm,semi] of esNotes){
      if(s.toLowerCase().startsWith(nm.toLowerCase())){
        const rest = s.slice(nm.length).trim().toLowerCase();
        const type = CT.find(t=>
          rest===t.es.toLowerCase() || (rest===''&&t.es==='mayor') ||
          (rest==='disminuido'&&t.es==='dim') || (rest==='aumentado'&&t.es==='aug') ||
          (rest==='mayor 7'&&t.es==='maj7') || (rest==='menor 7'&&t.es==='m7')
        );
        if(type) return {rootSemi:semi,type};
      }
    }
    const enNotes = [
      ['C#',1],['D#',3],['F#',6],['G#',8],['A#',10],
      ['Db',1],['Eb',3],['Gb',6],['Ab',8],['Bb',10],
      ['C',0],['D',2],['E',4],['F',5],['G',7],['A',9],['B',11],
    ];
    for(const [nm,semi] of enNotes){
      if(s.startsWith(nm)){
        const rest = s.slice(nm.length).trim();
        const type = CT.find(t=>
          rest===t.en || (rest===''&&t.en==='') ||
          (rest.toLowerCase()==='minor'&&t.en==='m') ||
          (rest.toLowerCase()==='major'&&t.en==='') ||
          (rest.toLowerCase()==='min'&&t.en==='m') ||
          (rest.toLowerCase()==='maj'&&t.en==='')
        );
        if(type) return {rootSemi:semi,type};
      }
    }
    return null;
  }

  function getChordNotes(rootSemi, type){
    return [...new Set(type.iv.map(i=>(rootSemi+(i%12))%12))].map(s=>NES[s]);
  }

  // Guitar chord database [E A D G B e] strings (0=low E, 5=high e)
  // frets: -1=mute 0=open 1+= fret, pos=display start fret
  // Each chord is an array of voicings (at least 1)
  const GDB = {
    'C':    [{frets:[-1,3,2,0,1,0],   fingers:[0,3,2,0,1,0],  barre:null,            pos:0},
             {frets:[-1,3,5,5,5,3],   fingers:[0,1,3,4,2,1],  barre:{f:3,a:1,b:5},  pos:3},
             {frets:[8,10,10,9,8,8],  fingers:[1,3,4,2,1,1],  barre:{f:8,a:0,b:5},  pos:8}],
    'C#':   [{frets:[-1,4,6,6,6,4],   fingers:[0,1,3,4,2,1],  barre:{f:4,a:1,b:5},  pos:4},
             {frets:[9,11,11,10,9,9], fingers:[1,3,4,2,1,1],  barre:{f:9,a:0,b:5},  pos:9}],
    'Db':   [{frets:[-1,4,6,6,6,4],   fingers:[0,1,3,4,2,1],  barre:{f:4,a:1,b:5},  pos:4},
             {frets:[9,11,11,10,9,9], fingers:[1,3,4,2,1,1],  barre:{f:9,a:0,b:5},  pos:9}],
    'D':    [{frets:[-1,-1,0,2,3,2],  fingers:[0,0,0,1,3,2],  barre:null,            pos:0},
             {frets:[-1,5,7,7,7,5],   fingers:[0,1,3,4,2,1],  barre:{f:5,a:1,b:5},  pos:5}],
    'D#':   [{frets:[-1,6,8,8,8,6],   fingers:[0,1,3,4,2,1],  barre:{f:6,a:1,b:5},  pos:6}],
    'Eb':   [{frets:[-1,6,8,8,8,6],   fingers:[0,1,3,4,2,1],  barre:{f:6,a:1,b:5},  pos:6}],
    'E':    [{frets:[0,2,2,1,0,0],    fingers:[0,2,3,1,0,0],  barre:null,            pos:0},
             {frets:[-1,7,9,9,9,7],   fingers:[0,1,3,4,2,1],  barre:{f:7,a:1,b:5},  pos:7}],
    'F':    [{frets:[1,3,3,2,1,1],    fingers:[1,3,4,2,1,1],  barre:{f:1,a:0,b:5},  pos:1},
             {frets:[-1,8,10,10,10,8],fingers:[0,1,3,4,2,1],  barre:{f:8,a:1,b:5},  pos:8}],
    'F#':   [{frets:[2,4,4,3,2,2],    fingers:[1,3,4,2,1,1],  barre:{f:2,a:0,b:5},  pos:2},
             {frets:[-1,9,11,11,11,9],fingers:[0,1,3,4,2,1],  barre:{f:9,a:1,b:5},  pos:9}],
    'Gb':   [{frets:[2,4,4,3,2,2],    fingers:[1,3,4,2,1,1],  barre:{f:2,a:0,b:5},  pos:2},
             {frets:[-1,9,11,11,11,9],fingers:[0,1,3,4,2,1],  barre:{f:9,a:1,b:5},  pos:9}],
    'G':    [{frets:[3,2,0,0,0,3],    fingers:[3,2,0,0,0,4],  barre:null,            pos:0},
             {frets:[3,5,5,4,3,3],    fingers:[1,3,4,2,1,1],  barre:{f:3,a:0,b:5},  pos:3}],
    'G#':   [{frets:[4,6,6,5,4,4],    fingers:[1,3,4,2,1,1],  barre:{f:4,a:0,b:5},  pos:4}],
    'Ab':   [{frets:[4,6,6,5,4,4],    fingers:[1,3,4,2,1,1],  barre:{f:4,a:0,b:5},  pos:4}],
    'A':    [{frets:[-1,0,2,2,2,0],   fingers:[0,0,2,3,4,0],  barre:null,            pos:0},
             {frets:[5,7,7,6,5,5],    fingers:[1,3,4,2,1,1],  barre:{f:5,a:0,b:5},  pos:5}],
    'A#':   [{frets:[-1,1,3,3,3,1],   fingers:[0,1,3,4,2,1],  barre:{f:1,a:1,b:5},  pos:1},
             {frets:[6,8,8,7,6,6],    fingers:[1,3,4,2,1,1],  barre:{f:6,a:0,b:5},  pos:6}],
    'Bb':   [{frets:[-1,1,3,3,3,1],   fingers:[0,1,3,4,2,1],  barre:{f:1,a:1,b:5},  pos:1},
             {frets:[6,8,8,7,6,6],    fingers:[1,3,4,2,1,1],  barre:{f:6,a:0,b:5},  pos:6}],
    'B':    [{frets:[-1,2,4,4,4,2],   fingers:[0,1,3,4,2,1],  barre:{f:2,a:1,b:5},  pos:2},
             {frets:[7,9,9,8,7,7],    fingers:[1,3,4,2,1,1],  barre:{f:7,a:0,b:5},  pos:7}],
    'Cm':   [{frets:[-1,3,5,5,4,3],   fingers:[0,1,3,4,2,1],  barre:{f:3,a:1,b:5},  pos:3},
             {frets:[8,10,10,8,8,8],  fingers:[1,3,4,1,1,1],  barre:{f:8,a:0,b:5},  pos:8}],
    'C#m':  [{frets:[-1,4,6,6,5,4],   fingers:[0,1,3,4,2,1],  barre:{f:4,a:1,b:5},  pos:4},
             {frets:[9,11,11,9,9,9],  fingers:[1,3,4,1,1,1],  barre:{f:9,a:0,b:5},  pos:9}],
    'Dbm':  [{frets:[-1,4,6,6,5,4],   fingers:[0,1,3,4,2,1],  barre:{f:4,a:1,b:5},  pos:4},
             {frets:[9,11,11,9,9,9],  fingers:[1,3,4,1,1,1],  barre:{f:9,a:0,b:5},  pos:9}],
    'Dm':   [{frets:[-1,-1,0,2,3,1],  fingers:[0,0,0,2,3,1],  barre:null,            pos:0},
             {frets:[-1,5,7,7,6,5],   fingers:[0,1,3,4,2,1],  barre:{f:5,a:1,b:5},  pos:5}],
    'D#m':  [{frets:[6,8,8,6,6,6],    fingers:[1,3,4,1,1,1],  barre:{f:6,a:0,b:5},  pos:6},
             {frets:[-1,6,8,8,7,6],   fingers:[0,1,3,4,2,1],  barre:{f:6,a:1,b:5},  pos:6}],
    'Ebm':  [{frets:[6,8,8,6,6,6],    fingers:[1,3,4,1,1,1],  barre:{f:6,a:0,b:5},  pos:6},
             {frets:[-1,6,8,8,7,6],   fingers:[0,1,3,4,2,1],  barre:{f:6,a:1,b:5},  pos:6}],
    'Em':   [{frets:[0,2,2,0,0,0],    fingers:[0,2,3,0,0,0],  barre:null,            pos:0},
             {frets:[-1,7,9,9,8,7],   fingers:[0,1,3,4,2,1],  barre:{f:7,a:1,b:5},  pos:7}],
    'Fm':   [{frets:[1,3,3,1,1,1],    fingers:[1,3,4,1,1,1],  barre:{f:1,a:0,b:5},  pos:1},
             {frets:[-1,8,10,10,9,8], fingers:[0,1,3,4,2,1],  barre:{f:8,a:1,b:5},  pos:8}],
    'F#m':  [{frets:[2,4,4,2,2,2],    fingers:[1,3,4,1,1,1],  barre:{f:2,a:0,b:5},  pos:2},
             {frets:[-1,9,11,11,10,9],fingers:[0,1,3,4,2,1],  barre:{f:9,a:1,b:5},  pos:9}],
    'Gbm':  [{frets:[2,4,4,2,2,2],    fingers:[1,3,4,1,1,1],  barre:{f:2,a:0,b:5},  pos:2},
             {frets:[-1,9,11,11,10,9],fingers:[0,1,3,4,2,1],  barre:{f:9,a:1,b:5},  pos:9}],
    'Gm':   [{frets:[3,5,5,3,3,3],    fingers:[1,3,4,1,1,1],  barre:{f:3,a:0,b:5},  pos:3},
             {frets:[-1,10,12,12,11,10],fingers:[0,1,3,4,2,1],barre:{f:10,a:1,b:5}, pos:10}],
    'G#m':  [{frets:[4,6,6,4,4,4],    fingers:[1,3,4,1,1,1],  barre:{f:4,a:0,b:5},  pos:4}],
    'Abm':  [{frets:[4,6,6,4,4,4],    fingers:[1,3,4,1,1,1],  barre:{f:4,a:0,b:5},  pos:4}],
    'Am':   [{frets:[-1,0,2,2,1,0],   fingers:[0,0,2,3,1,0],  barre:null,            pos:0},
             {frets:[5,7,7,5,5,5],    fingers:[1,3,4,1,1,1],  barre:{f:5,a:0,b:5},  pos:5}],
    'A#m':  [{frets:[-1,1,3,3,2,1],   fingers:[0,1,3,4,2,1],  barre:{f:1,a:1,b:5},  pos:1},
             {frets:[6,8,8,6,6,6],    fingers:[1,3,4,1,1,1],  barre:{f:6,a:0,b:5},  pos:6}],
    'Bbm':  [{frets:[-1,1,3,3,2,1],   fingers:[0,1,3,4,2,1],  barre:{f:1,a:1,b:5},  pos:1},
             {frets:[6,8,8,6,6,6],    fingers:[1,3,4,1,1,1],  barre:{f:6,a:0,b:5},  pos:6}],
    'Bm':   [{frets:[-1,2,4,4,3,2],   fingers:[0,1,3,4,2,1],  barre:{f:2,a:1,b:5},  pos:2},
             {frets:[7,9,9,7,7,7],    fingers:[1,3,4,1,1,1],  barre:{f:7,a:0,b:5},  pos:7}],
    'C7':   [{frets:[-1,3,2,3,1,0],   fingers:[0,3,2,4,1,0],  barre:null,            pos:0},
             {frets:[-1,3,5,3,5,3],   fingers:[0,1,3,1,4,1],  barre:{f:3,a:1,b:5},  pos:3},
             {frets:[8,10,8,9,8,8],   fingers:[1,3,1,2,1,1],  barre:{f:8,a:0,b:5},  pos:8}],
    'D7':   [{frets:[-1,-1,0,2,1,2],  fingers:[0,0,0,2,1,3],  barre:null,            pos:0},
             {frets:[-1,5,7,5,7,5],   fingers:[0,1,3,1,4,1],  barre:{f:5,a:1,b:5},  pos:5},
             {frets:[10,12,10,11,10,10],fingers:[1,3,1,2,1,1],barre:{f:10,a:0,b:5}, pos:10}],
    'E7':   [{frets:[0,2,0,1,0,0],    fingers:[0,2,0,1,0,0],  barre:null,            pos:0},
             {frets:[-1,7,9,7,9,7],   fingers:[0,1,3,1,4,1],  barre:{f:7,a:1,b:5},  pos:7}],
    'G7':   [{frets:[3,2,0,0,0,1],    fingers:[3,2,0,0,0,1],  barre:null,            pos:0},
             {frets:[-1,10,12,10,12,10],fingers:[0,1,3,1,4,1],barre:{f:10,a:1,b:5}, pos:10},
             {frets:[3,5,3,4,3,3],    fingers:[1,3,1,2,1,1],  barre:{f:3,a:0,b:5},  pos:3}],
    'A7':   [{frets:[-1,0,2,0,2,0],   fingers:[0,0,2,0,3,0],  barre:null,            pos:0},
             {frets:[5,7,5,6,5,5],    fingers:[1,3,1,2,1,1],  barre:{f:5,a:0,b:5},  pos:5}],
    'B7':   [{frets:[-1,2,1,2,0,2],   fingers:[0,2,1,3,0,4],  barre:null,            pos:0},
             {frets:[-1,2,4,2,4,2],   fingers:[0,1,3,1,4,1],  barre:{f:2,a:1,b:5},  pos:2},
             {frets:[7,9,7,8,7,7],    fingers:[1,3,1,2,1,1],  barre:{f:7,a:0,b:5},  pos:7}],
    'Cmaj7':[{frets:[-1,3,2,0,0,0],   fingers:[0,3,2,0,0,0],  barre:null,            pos:0},
             {frets:[-1,3,5,4,5,3],   fingers:[0,1,3,2,4,1],  barre:{f:3,a:1,b:5},  pos:3},
             {frets:[8,10,9,9,8,8],   fingers:[1,3,2,2,1,1],  barre:{f:8,a:0,b:5},  pos:8}],
    'Dmaj7':[{frets:[-1,-1,0,2,2,2],  fingers:[0,0,0,1,2,3],  barre:null,            pos:0},
             {frets:[-1,5,7,6,7,5],   fingers:[0,1,3,2,4,1],  barre:{f:5,a:1,b:5},  pos:5},
             {frets:[10,12,11,11,10,10],fingers:[1,3,2,2,1,1],barre:{f:10,a:0,b:5}, pos:10}],
    'Emaj7':[{frets:[0,2,1,1,0,0],    fingers:[0,2,1,1,0,0],  barre:null,            pos:0},
             {frets:[-1,7,9,8,9,7],   fingers:[0,1,3,2,4,1],  barre:{f:7,a:1,b:5},  pos:7}],
    'Fmaj7':[{frets:[-1,0,3,2,1,0],   fingers:[0,0,3,2,1,0],  barre:null,            pos:0},
             {frets:[-1,8,10,9,10,8], fingers:[0,1,3,2,4,1],  barre:{f:8,a:1,b:5},  pos:8},
             {frets:[1,3,2,2,1,1],    fingers:[1,3,2,2,1,1],  barre:{f:1,a:0,b:5},  pos:1}],
    'Gmaj7':[{frets:[3,2,0,0,0,2],    fingers:[3,2,0,0,0,1],  barre:null,            pos:0},
             {frets:[-1,10,12,11,12,10],fingers:[0,1,3,2,4,1],barre:{f:10,a:1,b:5}, pos:10},
             {frets:[3,5,4,4,3,3],    fingers:[1,3,2,2,1,1],  barre:{f:3,a:0,b:5},  pos:3}],
    'Amaj7':[{frets:[-1,0,2,1,2,0],   fingers:[0,0,2,1,3,0],  barre:null,            pos:0},
             {frets:[5,7,6,6,5,5],    fingers:[1,3,2,2,1,1],  barre:{f:5,a:0,b:5},  pos:5}],
    'Am7':  [{frets:[-1,0,2,0,1,0],   fingers:[0,0,2,0,1,0],  barre:null,            pos:0},
             {frets:[5,7,5,5,5,5],   fingers:[1,3,1,1,1,1],  barre:{f:5,a:0,b:5},  pos:5}],
    'Em7':  [{frets:[0,2,0,0,0,0],    fingers:[0,2,0,0,0,0],  barre:null,            pos:0},
             {frets:[-1,7,9,7,8,7],  fingers:[0,1,3,1,2,1],  barre:{f:7,a:1,b:5},  pos:7}],
    'Dm7':  [{frets:[-1,-1,0,2,1,1],  fingers:[0,0,0,3,1,2],  barre:null,            pos:0},
             {frets:[-1,5,7,5,6,5],  fingers:[0,1,3,1,2,1],  barre:{f:5,a:1,b:5},  pos:5},
             {frets:[10,12,10,10,10,10],fingers:[1,3,1,1,1,1],barre:{f:10,a:0,b:5},pos:10}],
    'Adim': [{frets:[-1,0,1,2,1,0],   fingers:[0,0,1,3,2,0],  barre:null,            pos:0}],
    'Bdim': [{frets:[-1,2,0,0,0,1],   fingers:[0,2,0,0,0,1],  barre:null,            pos:0}],
    'Ddim': [{frets:[-1,-1,0,1,0,1],  fingers:[0,0,0,1,0,2],  barre:null,            pos:0}],
    'Edim': [{frets:[0,1,2,0,0,-1],   fingers:[0,1,2,0,0,0],  barre:null,            pos:0}],
    'Eaug': [{frets:[0,3,2,1,1,0],    fingers:[0,4,3,1,2,0],  barre:null,            pos:0}],
    'Aaug': [{frets:[-1,0,3,2,2,1],   fingers:[0,0,4,3,2,1],  barre:null,            pos:0}],
    'Caug': [{frets:[-1,3,2,1,1,0],   fingers:[0,4,3,1,2,0],  barre:null,            pos:0}],
    'Daug': [{frets:[-1,-1,0,3,3,2],  fingers:[0,0,0,2,3,1],  barre:null,            pos:0}],
    // Dominant 7th — missing roots (E7 shape + A7 shape barres)
    'C#7':   [{frets:[9,11,9,10,9,9],     fingers:[1,3,1,2,1,1],  barre:{f:9,a:0,b:5},  pos:9},
              {frets:[-1,4,6,4,6,4],      fingers:[0,1,3,1,4,1],  barre:{f:4,a:1,b:5},  pos:4}],
    'Db7':   [{frets:[9,11,9,10,9,9],     fingers:[1,3,1,2,1,1],  barre:{f:9,a:0,b:5},  pos:9},
              {frets:[-1,4,6,4,6,4],      fingers:[0,1,3,1,4,1],  barre:{f:4,a:1,b:5},  pos:4}],
    'D#7':   [{frets:[11,13,11,12,11,11], fingers:[1,3,1,2,1,1],  barre:{f:11,a:0,b:5}, pos:11},
              {frets:[-1,6,8,6,8,6],      fingers:[0,1,3,1,4,1],  barre:{f:6,a:1,b:5},  pos:6}],
    'Eb7':   [{frets:[11,13,11,12,11,11], fingers:[1,3,1,2,1,1],  barre:{f:11,a:0,b:5}, pos:11},
              {frets:[-1,6,8,6,8,6],      fingers:[0,1,3,1,4,1],  barre:{f:6,a:1,b:5},  pos:6}],
    'F7':    [{frets:[1,3,1,2,1,1],       fingers:[1,3,1,2,1,1],  barre:{f:1,a:0,b:5},  pos:1},
              {frets:[-1,8,10,8,10,8],    fingers:[0,1,3,1,4,1],  barre:{f:8,a:1,b:5},  pos:8}],
    'F#7':   [{frets:[2,4,2,3,2,2],       fingers:[1,3,1,2,1,1],  barre:{f:2,a:0,b:5},  pos:2},
              {frets:[-1,9,11,9,11,9],    fingers:[0,1,3,1,4,1],  barre:{f:9,a:1,b:5},  pos:9}],
    'Gb7':   [{frets:[2,4,2,3,2,2],       fingers:[1,3,1,2,1,1],  barre:{f:2,a:0,b:5},  pos:2},
              {frets:[-1,9,11,9,11,9],    fingers:[0,1,3,1,4,1],  barre:{f:9,a:1,b:5},  pos:9}],
    'G#7':   [{frets:[4,6,4,5,4,4],       fingers:[1,3,1,2,1,1],  barre:{f:4,a:0,b:5},  pos:4},
              {frets:[-1,11,13,11,13,11], fingers:[0,1,3,1,4,1],  barre:{f:11,a:1,b:5}, pos:11}],
    'Ab7':   [{frets:[4,6,4,5,4,4],       fingers:[1,3,1,2,1,1],  barre:{f:4,a:0,b:5},  pos:4},
              {frets:[-1,11,13,11,13,11], fingers:[0,1,3,1,4,1],  barre:{f:11,a:1,b:5}, pos:11}],
    'A#7':   [{frets:[6,8,6,7,6,6],       fingers:[1,3,1,2,1,1],  barre:{f:6,a:0,b:5},  pos:6},
              {frets:[-1,1,3,1,3,1],      fingers:[0,1,3,1,4,1],  barre:{f:1,a:1,b:5},  pos:1}],
    'Bb7':   [{frets:[6,8,6,7,6,6],       fingers:[1,3,1,2,1,1],  barre:{f:6,a:0,b:5},  pos:6},
              {frets:[-1,1,3,1,3,1],      fingers:[0,1,3,1,4,1],  barre:{f:1,a:1,b:5},  pos:1}],
    // Major 7th — missing roots (Emaj7 shape + Amaj7 shape barres)
    'C#maj7':[{frets:[9,11,10,10,9,9],    fingers:[1,3,2,2,1,1],  barre:{f:9,a:0,b:5},  pos:9},
              {frets:[-1,4,6,5,6,4],      fingers:[0,1,3,2,4,1],  barre:{f:4,a:1,b:5},  pos:4}],
    'Dbmaj7':[{frets:[9,11,10,10,9,9],    fingers:[1,3,2,2,1,1],  barre:{f:9,a:0,b:5},  pos:9},
              {frets:[-1,4,6,5,6,4],      fingers:[0,1,3,2,4,1],  barre:{f:4,a:1,b:5},  pos:4}],
    'D#maj7':[{frets:[11,13,12,12,11,11], fingers:[1,3,2,2,1,1],  barre:{f:11,a:0,b:5}, pos:11},
              {frets:[-1,6,8,7,8,6],      fingers:[0,1,3,2,4,1],  barre:{f:6,a:1,b:5},  pos:6}],
    'Ebmaj7':[{frets:[11,13,12,12,11,11], fingers:[1,3,2,2,1,1],  barre:{f:11,a:0,b:5}, pos:11},
              {frets:[-1,6,8,7,8,6],      fingers:[0,1,3,2,4,1],  barre:{f:6,a:1,b:5},  pos:6}],
    'F#maj7':[{frets:[2,4,3,3,2,2],       fingers:[1,3,2,2,1,1],  barre:{f:2,a:0,b:5},  pos:2},
              {frets:[-1,9,11,10,11,9],   fingers:[0,1,3,2,4,1],  barre:{f:9,a:1,b:5},  pos:9}],
    'Gbmaj7':[{frets:[2,4,3,3,2,2],       fingers:[1,3,2,2,1,1],  barre:{f:2,a:0,b:5},  pos:2},
              {frets:[-1,9,11,10,11,9],   fingers:[0,1,3,2,4,1],  barre:{f:9,a:1,b:5},  pos:9}],
    'G#maj7':[{frets:[4,6,5,5,4,4],       fingers:[1,3,2,2,1,1],  barre:{f:4,a:0,b:5},  pos:4},
              {frets:[-1,11,13,12,13,11], fingers:[0,1,3,2,4,1],  barre:{f:11,a:1,b:5}, pos:11}],
    'Abmaj7':[{frets:[4,6,5,5,4,4],       fingers:[1,3,2,2,1,1],  barre:{f:4,a:0,b:5},  pos:4},
              {frets:[-1,11,13,12,13,11], fingers:[0,1,3,2,4,1],  barre:{f:11,a:1,b:5}, pos:11}],
    'A#maj7':[{frets:[6,8,7,7,6,6],       fingers:[1,3,2,2,1,1],  barre:{f:6,a:0,b:5},  pos:6},
              {frets:[-1,1,3,2,3,1],      fingers:[0,1,3,2,4,1],  barre:{f:1,a:1,b:5},  pos:1}],
    'Bbmaj7':[{frets:[6,8,7,7,6,6],       fingers:[1,3,2,2,1,1],  barre:{f:6,a:0,b:5},  pos:6},
              {frets:[-1,1,3,2,3,1],      fingers:[0,1,3,2,4,1],  barre:{f:1,a:1,b:5},  pos:1}],
    'Bmaj7': [{frets:[7,9,8,8,7,7],       fingers:[1,3,2,2,1,1],  barre:{f:7,a:0,b:5},  pos:7},
              {frets:[-1,2,4,3,4,2],      fingers:[0,1,3,2,4,1],  barre:{f:2,a:1,b:5},  pos:2}],
    // Minor 7th — missing roots (Em7 shape + Am7 shape barres)
    'Cm7':   [{frets:[8,10,8,8,8,8],      fingers:[1,3,1,1,1,1],  barre:{f:8,a:0,b:5},  pos:8},
              {frets:[-1,3,5,3,4,3],      fingers:[0,1,3,1,2,1],  barre:{f:3,a:1,b:5},  pos:3}],
    'C#m7':  [{frets:[9,11,9,9,9,9],      fingers:[1,3,1,1,1,1],  barre:{f:9,a:0,b:5},  pos:9},
              {frets:[-1,4,6,4,5,4],      fingers:[0,1,3,1,2,1],  barre:{f:4,a:1,b:5},  pos:4}],
    'Dbm7':  [{frets:[9,11,9,9,9,9],      fingers:[1,3,1,1,1,1],  barre:{f:9,a:0,b:5},  pos:9},
              {frets:[-1,4,6,4,5,4],      fingers:[0,1,3,1,2,1],  barre:{f:4,a:1,b:5},  pos:4}],
    'D#m7':  [{frets:[11,13,11,11,11,11], fingers:[1,3,1,1,1,1],  barre:{f:11,a:0,b:5}, pos:11},
              {frets:[-1,6,8,6,7,6],      fingers:[0,1,3,1,2,1],  barre:{f:6,a:1,b:5},  pos:6}],
    'Ebm7':  [{frets:[11,13,11,11,11,11], fingers:[1,3,1,1,1,1],  barre:{f:11,a:0,b:5}, pos:11},
              {frets:[-1,6,8,6,7,6],      fingers:[0,1,3,1,2,1],  barre:{f:6,a:1,b:5},  pos:6}],
    'Fm7':   [{frets:[1,3,1,1,1,1],       fingers:[1,3,1,1,1,1],  barre:{f:1,a:0,b:5},  pos:1},
              {frets:[-1,8,10,8,9,8],     fingers:[0,1,3,1,2,1],  barre:{f:8,a:1,b:5},  pos:8}],
    'F#m7':  [{frets:[2,4,2,2,2,2],       fingers:[1,3,1,1,1,1],  barre:{f:2,a:0,b:5},  pos:2},
              {frets:[-1,9,11,9,10,9],    fingers:[0,1,3,1,2,1],  barre:{f:9,a:1,b:5},  pos:9}],
    'Gbm7':  [{frets:[2,4,2,2,2,2],       fingers:[1,3,1,1,1,1],  barre:{f:2,a:0,b:5},  pos:2},
              {frets:[-1,9,11,9,10,9],    fingers:[0,1,3,1,2,1],  barre:{f:9,a:1,b:5},  pos:9}],
    'Gm7':   [{frets:[3,5,3,3,3,3],       fingers:[1,3,1,1,1,1],  barre:{f:3,a:0,b:5},  pos:3},
              {frets:[-1,10,12,10,11,10], fingers:[0,1,3,1,2,1],  barre:{f:10,a:1,b:5}, pos:10}],
    'G#m7':  [{frets:[4,6,4,4,4,4],       fingers:[1,3,1,1,1,1],  barre:{f:4,a:0,b:5},  pos:4},
              {frets:[-1,11,13,11,12,11], fingers:[0,1,3,1,2,1],  barre:{f:11,a:1,b:5}, pos:11}],
    'Abm7':  [{frets:[4,6,4,4,4,4],       fingers:[1,3,1,1,1,1],  barre:{f:4,a:0,b:5},  pos:4},
              {frets:[-1,11,13,11,12,11], fingers:[0,1,3,1,2,1],  barre:{f:11,a:1,b:5}, pos:11}],
    'A#m7':  [{frets:[6,8,6,6,6,6],       fingers:[1,3,1,1,1,1],  barre:{f:6,a:0,b:5},  pos:6},
              {frets:[-1,1,3,1,2,1],      fingers:[0,1,3,1,2,1],  barre:{f:1,a:1,b:5},  pos:1}],
    'Bbm7':  [{frets:[6,8,6,6,6,6],       fingers:[1,3,1,1,1,1],  barre:{f:6,a:0,b:5},  pos:6},
              {frets:[-1,1,3,1,2,1],      fingers:[0,1,3,1,2,1],  barre:{f:1,a:1,b:5},  pos:1}],
    'Bm7':   [{frets:[7,9,7,7,7,7],       fingers:[1,3,1,1,1,1],  barre:{f:7,a:0,b:5},  pos:7},
              {frets:[-1,2,4,2,3,2],      fingers:[0,1,3,1,2,1],  barre:{f:2,a:1,b:5},  pos:2}],
    // Diminished — missing roots (shape on D string: x-x-n-n+1-n-n+1)
    'Cdim':  [{frets:[-1,-1,10,11,10,11], fingers:[0,0,1,3,2,4],  barre:null,            pos:10}],
    'C#dim': [{frets:[-1,-1,11,12,11,12], fingers:[0,0,1,3,2,4],  barre:null,            pos:11}],
    'Dbdim': [{frets:[-1,-1,11,12,11,12], fingers:[0,0,1,3,2,4],  barre:null,            pos:11}],
    'D#dim': [{frets:[-1,-1,1,2,1,2],     fingers:[0,0,1,3,2,4],  barre:null,            pos:1}],
    'Ebdim': [{frets:[-1,-1,1,2,1,2],     fingers:[0,0,1,3,2,4],  barre:null,            pos:1}],
    'Fdim':  [{frets:[-1,-1,3,4,3,4],     fingers:[0,0,1,3,2,4],  barre:null,            pos:3}],
    'F#dim': [{frets:[-1,-1,4,5,4,5],     fingers:[0,0,1,3,2,4],  barre:null,            pos:4}],
    'Gbdim': [{frets:[-1,-1,4,5,4,5],     fingers:[0,0,1,3,2,4],  barre:null,            pos:4}],
    'Gdim':  [{frets:[-1,-1,5,6,5,6],     fingers:[0,0,1,3,2,4],  barre:null,            pos:5}],
    'G#dim': [{frets:[-1,-1,6,7,6,7],     fingers:[0,0,1,3,2,4],  barre:null,            pos:6}],
    'Abdim': [{frets:[-1,-1,6,7,6,7],     fingers:[0,0,1,3,2,4],  barre:null,            pos:6}],
    'A#dim': [{frets:[-1,-1,8,9,8,9],     fingers:[0,0,1,3,2,4],  barre:null,            pos:8}],
    'Bbdim': [{frets:[-1,-1,8,9,8,9],     fingers:[0,0,1,3,2,4],  barre:null,            pos:8}],
    // Augmented — missing roots (Eaug moveable shape, root on low E)
    'C#aug': [{frets:[9,12,11,10,10,9],   fingers:[1,4,3,2,2,1],  barre:{f:9,a:0,b:5},  pos:9}],
    'Dbaug': [{frets:[9,12,11,10,10,9],   fingers:[1,4,3,2,2,1],  barre:{f:9,a:0,b:5},  pos:9}],
    'D#aug': [{frets:[11,14,13,12,12,11], fingers:[1,4,3,2,2,1],  barre:{f:11,a:0,b:5}, pos:11}],
    'Ebaug': [{frets:[11,14,13,12,12,11], fingers:[1,4,3,2,2,1],  barre:{f:11,a:0,b:5}, pos:11}],
    'Faug':  [{frets:[1,4,3,2,2,1],       fingers:[1,4,3,2,2,1],  barre:{f:1,a:0,b:5},  pos:1}],
    'F#aug': [{frets:[2,5,4,3,3,2],       fingers:[1,4,3,2,2,1],  barre:{f:2,a:0,b:5},  pos:2}],
    'Gbaug': [{frets:[2,5,4,3,3,2],       fingers:[1,4,3,2,2,1],  barre:{f:2,a:0,b:5},  pos:2}],
    'Gaug':  [{frets:[3,6,5,4,4,3],       fingers:[1,4,3,2,2,1],  barre:{f:3,a:0,b:5},  pos:3}],
    'G#aug': [{frets:[4,7,6,5,5,4],       fingers:[1,4,3,2,2,1],  barre:{f:4,a:0,b:5},  pos:4}],
    'Abaug': [{frets:[4,7,6,5,5,4],       fingers:[1,4,3,2,2,1],  barre:{f:4,a:0,b:5},  pos:4}],
    'A#aug': [{frets:[6,9,8,7,7,6],       fingers:[1,4,3,2,2,1],  barre:{f:6,a:0,b:5},  pos:6}],
    'Bbaug': [{frets:[6,9,8,7,7,6],       fingers:[1,4,3,2,2,1],  barre:{f:6,a:0,b:5},  pos:6}],
    'Baug':  [{frets:[7,10,9,8,8,7],      fingers:[1,4,3,2,2,1],  barre:{f:7,a:0,b:5},  pos:7}],
    // Diminished 7th — all roots (shape on A string: x-n-n+1-n+2-n+1-n+2)
    'Cdim7': [{frets:[-1,3,4,5,4,5],     fingers:[0,1,2,4,3,4],  barre:null,            pos:3}],
    'C#dim7':[{frets:[-1,4,5,6,5,6],     fingers:[0,1,2,4,3,4],  barre:null,            pos:4}],
    'Dbdim7':[{frets:[-1,4,5,6,5,6],     fingers:[0,1,2,4,3,4],  barre:null,            pos:4}],
    'Ddim7': [{frets:[-1,5,6,7,6,7],     fingers:[0,1,2,4,3,4],  barre:null,            pos:5}],
    'D#dim7':[{frets:[-1,6,7,8,7,8],     fingers:[0,1,2,4,3,4],  barre:null,            pos:6}],
    'Ebdim7':[{frets:[-1,6,7,8,7,8],     fingers:[0,1,2,4,3,4],  barre:null,            pos:6}],
    'Edim7': [{frets:[-1,7,8,9,8,9],     fingers:[0,1,2,4,3,4],  barre:null,            pos:7}],
    'Fdim7': [{frets:[-1,8,9,10,9,10],   fingers:[0,1,2,4,3,4],  barre:null,            pos:8}],
    'F#dim7':[{frets:[-1,9,10,11,10,11], fingers:[0,1,2,4,3,4],  barre:null,            pos:9}],
    'Gbdim7':[{frets:[-1,9,10,11,10,11], fingers:[0,1,2,4,3,4],  barre:null,            pos:9}],
    'Gdim7': [{frets:[-1,10,11,12,11,12],fingers:[0,1,2,4,3,4],  barre:null,            pos:10}],
    'G#dim7':[{frets:[-1,11,12,13,12,13],fingers:[0,1,2,4,3,4],  barre:null,            pos:11}],
    'Abdim7':[{frets:[-1,11,12,13,12,13],fingers:[0,1,2,4,3,4],  barre:null,            pos:11}],
    'Adim7': [{frets:[-1,0,1,2,1,2],     fingers:[0,0,1,3,2,4],  barre:null,            pos:0}],
    'A#dim7':[{frets:[-1,1,2,3,2,3],     fingers:[0,1,2,4,3,4],  barre:null,            pos:1}],
    'Bbdim7':[{frets:[-1,1,2,3,2,3],     fingers:[0,1,2,4,3,4],  barre:null,            pos:1}],
    'Bdim7': [{frets:[-1,2,3,4,3,4],     fingers:[0,1,2,4,3,4],  barre:null,            pos:2}],
    // sus2 — all roots (shape: x-n-n+2-n+2-n-n, root on A string)
    'Csus2': [{frets:[-1,3,5,5,3,3],     fingers:[0,1,3,4,1,1],  barre:{f:3,a:1,b:5},   pos:3}],
    'C#sus2':[{frets:[-1,4,6,6,4,4],     fingers:[0,1,3,4,1,1],  barre:{f:4,a:1,b:5},   pos:4}],
    'Dbsus2':[{frets:[-1,4,6,6,4,4],     fingers:[0,1,3,4,1,1],  barre:{f:4,a:1,b:5},   pos:4}],
    'Dsus2': [{frets:[-1,5,7,7,5,5],     fingers:[0,1,3,4,1,1],  barre:{f:5,a:1,b:5},   pos:5}],
    'D#sus2':[{frets:[-1,6,8,8,6,6],     fingers:[0,1,3,4,1,1],  barre:{f:6,a:1,b:5},   pos:6}],
    'Ebsus2':[{frets:[-1,6,8,8,6,6],     fingers:[0,1,3,4,1,1],  barre:{f:6,a:1,b:5},   pos:6}],
    'Esus2': [{frets:[-1,7,9,9,7,7],     fingers:[0,1,3,4,1,1],  barre:{f:7,a:1,b:5},   pos:7}],
    'Fsus2': [{frets:[-1,8,10,10,8,8],   fingers:[0,1,3,4,1,1],  barre:{f:8,a:1,b:5},   pos:8}],
    'F#sus2':[{frets:[-1,9,11,11,9,9],   fingers:[0,1,3,4,1,1],  barre:{f:9,a:1,b:5},   pos:9}],
    'Gbsus2':[{frets:[-1,9,11,11,9,9],   fingers:[0,1,3,4,1,1],  barre:{f:9,a:1,b:5},   pos:9}],
    'Gsus2': [{frets:[-1,10,12,12,10,10],fingers:[0,1,3,4,1,1],  barre:{f:10,a:1,b:5},  pos:10}],
    'G#sus2':[{frets:[-1,11,13,13,11,11],fingers:[0,1,3,4,1,1],  barre:{f:11,a:1,b:5},  pos:11}],
    'Absus2':[{frets:[-1,11,13,13,11,11],fingers:[0,1,3,4,1,1],  barre:{f:11,a:1,b:5},  pos:11}],
    'Asus2': [{frets:[-1,0,2,2,0,0],     fingers:[0,0,2,3,0,0],  barre:null,             pos:0}],
    'A#sus2':[{frets:[-1,1,3,3,1,1],     fingers:[0,1,3,4,1,1],  barre:{f:1,a:1,b:5},   pos:1}],
    'Bbsus2':[{frets:[-1,1,3,3,1,1],     fingers:[0,1,3,4,1,1],  barre:{f:1,a:1,b:5},   pos:1}],
    'Bsus2': [{frets:[-1,2,4,4,2,2],     fingers:[0,1,3,4,1,1],  barre:{f:2,a:1,b:5},   pos:2}],
    // sus4 — all roots (shape: n-n+2-n+2-n+2-n-n, root on low E)
    'Csus4': [{frets:[8,10,10,10,8,8],   fingers:[1,3,3,3,1,1],  barre:{f:8,a:0,b:5},   pos:8}],
    'C#sus4':[{frets:[9,11,11,11,9,9],   fingers:[1,3,3,3,1,1],  barre:{f:9,a:0,b:5},   pos:9}],
    'Dbsus4':[{frets:[9,11,11,11,9,9],   fingers:[1,3,3,3,1,1],  barre:{f:9,a:0,b:5},   pos:9}],
    'Dsus4': [{frets:[10,12,12,12,10,10],fingers:[1,3,3,3,1,1],  barre:{f:10,a:0,b:5},  pos:10}],
    'D#sus4':[{frets:[11,13,13,13,11,11],fingers:[1,3,3,3,1,1],  barre:{f:11,a:0,b:5},  pos:11}],
    'Ebsus4':[{frets:[11,13,13,13,11,11],fingers:[1,3,3,3,1,1],  barre:{f:11,a:0,b:5},  pos:11}],
    'Esus4': [{frets:[0,2,2,2,0,0],      fingers:[0,2,3,4,0,0],  barre:null,             pos:0}],
    'Fsus4': [{frets:[1,3,3,3,1,1],      fingers:[1,3,3,3,1,1],  barre:{f:1,a:0,b:5},   pos:1}],
    'F#sus4':[{frets:[2,4,4,4,2,2],      fingers:[1,3,3,3,1,1],  barre:{f:2,a:0,b:5},   pos:2}],
    'Gbsus4':[{frets:[2,4,4,4,2,2],      fingers:[1,3,3,3,1,1],  barre:{f:2,a:0,b:5},   pos:2}],
    'Gsus4': [{frets:[3,5,5,5,3,3],      fingers:[1,3,3,3,1,1],  barre:{f:3,a:0,b:5},   pos:3}],
    'G#sus4':[{frets:[4,6,6,6,4,4],      fingers:[1,3,3,3,1,1],  barre:{f:4,a:0,b:5},   pos:4}],
    'Absus4':[{frets:[4,6,6,6,4,4],      fingers:[1,3,3,3,1,1],  barre:{f:4,a:0,b:5},   pos:4}],
    'Asus4': [{frets:[-1,0,2,2,3,0],     fingers:[0,0,2,3,4,0],  barre:null,             pos:0}],
    'A#sus4':[{frets:[6,8,8,8,6,6],      fingers:[1,3,3,3,1,1],  barre:{f:6,a:0,b:5},   pos:6}],
    'Bbsus4':[{frets:[6,8,8,8,6,6],      fingers:[1,3,3,3,1,1],  barre:{f:6,a:0,b:5},   pos:6}],
    'Bsus4': [{frets:[7,9,9,9,7,7],      fingers:[1,3,3,3,1,1],  barre:{f:7,a:0,b:5},   pos:7}],
    // Minor major 7th — all roots (shape: x-n-n+2-n+1-n+1-n, root on A string)
    'CmM7':  [{frets:[-1,3,5,4,4,3],    fingers:[0,1,4,2,3,1],  barre:{f:3,a:1,b:5},   pos:3}],
    'C#mM7': [{frets:[-1,4,6,5,5,4],    fingers:[0,1,4,2,3,1],  barre:{f:4,a:1,b:5},   pos:4}],
    'DbmM7': [{frets:[-1,4,6,5,5,4],    fingers:[0,1,4,2,3,1],  barre:{f:4,a:1,b:5},   pos:4}],
    'DmM7':  [{frets:[-1,5,7,6,6,5],    fingers:[0,1,4,2,3,1],  barre:{f:5,a:1,b:5},   pos:5}],
    'D#mM7': [{frets:[-1,6,8,7,7,6],    fingers:[0,1,4,2,3,1],  barre:{f:6,a:1,b:5},   pos:6}],
    'EbmM7': [{frets:[-1,6,8,7,7,6],    fingers:[0,1,4,2,3,1],  barre:{f:6,a:1,b:5},   pos:6}],
    'EmM7':  [{frets:[-1,7,9,8,8,7],    fingers:[0,1,4,2,3,1],  barre:{f:7,a:1,b:5},   pos:7}],
    'FmM7':  [{frets:[-1,8,10,9,9,8],   fingers:[0,1,4,2,3,1],  barre:{f:8,a:1,b:5},   pos:8}],
    'F#mM7': [{frets:[-1,9,11,10,10,9], fingers:[0,1,4,2,3,1],  barre:{f:9,a:1,b:5},   pos:9}],
    'GbmM7': [{frets:[-1,9,11,10,10,9], fingers:[0,1,4,2,3,1],  barre:{f:9,a:1,b:5},   pos:9}],
    'GmM7':  [{frets:[-1,10,12,11,11,10],fingers:[0,1,4,2,3,1], barre:{f:10,a:1,b:5},  pos:10}],
    'G#mM7': [{frets:[-1,11,13,12,12,11],fingers:[0,1,4,2,3,1], barre:{f:11,a:1,b:5},  pos:11}],
    'AbmM7': [{frets:[-1,11,13,12,12,11],fingers:[0,1,4,2,3,1], barre:{f:11,a:1,b:5},  pos:11}],
    'AmM7':  [{frets:[-1,0,2,1,1,0],    fingers:[0,0,3,1,2,0],  barre:null,             pos:0}],
    'A#mM7': [{frets:[-1,1,3,2,2,1],    fingers:[0,1,4,2,3,1],  barre:{f:1,a:1,b:5},   pos:1}],
    'BbmM7': [{frets:[-1,1,3,2,2,1],    fingers:[0,1,4,2,3,1],  barre:{f:1,a:1,b:5},   pos:1}],
    'BmM7':  [{frets:[-1,2,4,3,3,2],    fingers:[0,1,4,2,3,1],  barre:{f:2,a:1,b:5},   pos:2}],
    // Power chords (5) — all roots (shape: n-n+2-n+2-x-x-x, root on low E)
    'C5':    [{frets:[8,10,10,-1,-1,-1], fingers:[1,3,4,0,0,0],  barre:null,             pos:8}],
    'C#5':   [{frets:[9,11,11,-1,-1,-1], fingers:[1,3,4,0,0,0],  barre:null,             pos:9}],
    'Db5':   [{frets:[9,11,11,-1,-1,-1], fingers:[1,3,4,0,0,0],  barre:null,             pos:9}],
    'D5':    [{frets:[10,12,12,-1,-1,-1],fingers:[1,3,4,0,0,0],  barre:null,             pos:10}],
    'D#5':   [{frets:[11,13,13,-1,-1,-1],fingers:[1,3,4,0,0,0],  barre:null,             pos:11}],
    'Eb5':   [{frets:[11,13,13,-1,-1,-1],fingers:[1,3,4,0,0,0],  barre:null,             pos:11}],
    'E5':    [{frets:[0,2,2,-1,-1,-1],   fingers:[1,3,4,0,0,0],  barre:null,             pos:0}],
    'F5':    [{frets:[1,3,3,-1,-1,-1],   fingers:[1,3,4,0,0,0],  barre:null,             pos:1}],
    'F#5':   [{frets:[2,4,4,-1,-1,-1],   fingers:[1,3,4,0,0,0],  barre:null,             pos:2}],
    'Gb5':   [{frets:[2,4,4,-1,-1,-1],   fingers:[1,3,4,0,0,0],  barre:null,             pos:2}],
    'G5':    [{frets:[3,5,5,-1,-1,-1],   fingers:[1,3,4,0,0,0],  barre:null,             pos:3}],
    'G#5':   [{frets:[4,6,6,-1,-1,-1],   fingers:[1,3,4,0,0,0],  barre:null,             pos:4}],
    'Ab5':   [{frets:[4,6,6,-1,-1,-1],   fingers:[1,3,4,0,0,0],  barre:null,             pos:4}],
    'A5':    [{frets:[5,7,7,-1,-1,-1],   fingers:[1,3,4,0,0,0],  barre:null,             pos:5}],
    'A#5':   [{frets:[6,8,8,-1,-1,-1],   fingers:[1,3,4,0,0,0],  barre:null,             pos:6}],
    'Bb5':   [{frets:[6,8,8,-1,-1,-1],   fingers:[1,3,4,0,0,0],  barre:null,             pos:6}],
    'B5':    [{frets:[7,9,9,-1,-1,-1],   fingers:[1,3,4,0,0,0],  barre:null,             pos:7}],
    // Major 6th — all roots (shape: n-n+2-n+2-n+1-n+2-n, root on low E)
    'C6':    [{frets:[8,10,10,9,10,8],  fingers:[1,3,4,2,3,1],  barre:{f:8,a:0,b:5},   pos:8}],
    'C#6':   [{frets:[9,11,11,10,11,9], fingers:[1,3,4,2,3,1],  barre:{f:9,a:0,b:5},   pos:9}],
    'Db6':   [{frets:[9,11,11,10,11,9], fingers:[1,3,4,2,3,1],  barre:{f:9,a:0,b:5},   pos:9}],
    'D6':    [{frets:[10,12,12,11,12,10],fingers:[1,3,4,2,3,1], barre:{f:10,a:0,b:5},  pos:10}],
    'D#6':   [{frets:[11,13,13,12,13,11],fingers:[1,3,4,2,3,1], barre:{f:11,a:0,b:5},  pos:11}],
    'Eb6':   [{frets:[11,13,13,12,13,11],fingers:[1,3,4,2,3,1], barre:{f:11,a:0,b:5},  pos:11}],
    'E6':    [{frets:[0,2,2,1,2,0],     fingers:[0,2,3,1,4,0],  barre:null,             pos:0}],
    'F6':    [{frets:[1,3,3,2,3,1],     fingers:[1,3,4,2,3,1],  barre:{f:1,a:0,b:5},   pos:1}],
    'F#6':   [{frets:[2,4,4,3,4,2],     fingers:[1,3,4,2,3,1],  barre:{f:2,a:0,b:5},   pos:2}],
    'Gb6':   [{frets:[2,4,4,3,4,2],     fingers:[1,3,4,2,3,1],  barre:{f:2,a:0,b:5},   pos:2}],
    'G6':    [{frets:[3,5,5,4,5,3],     fingers:[1,3,4,2,3,1],  barre:{f:3,a:0,b:5},   pos:3}],
    'G#6':   [{frets:[4,6,6,5,6,4],     fingers:[1,3,4,2,3,1],  barre:{f:4,a:0,b:5},   pos:4}],
    'Ab6':   [{frets:[4,6,6,5,6,4],     fingers:[1,3,4,2,3,1],  barre:{f:4,a:0,b:5},   pos:4}],
    'A6':    [{frets:[5,7,7,6,7,5],     fingers:[1,3,4,2,3,1],  barre:{f:5,a:0,b:5},   pos:5}],
    'A#6':   [{frets:[6,8,8,7,8,6],     fingers:[1,3,4,2,3,1],  barre:{f:6,a:0,b:5},   pos:6}],
    'Bb6':   [{frets:[6,8,8,7,8,6],     fingers:[1,3,4,2,3,1],  barre:{f:6,a:0,b:5},   pos:6}],
    'B6':    [{frets:[7,9,9,8,9,7],     fingers:[1,3,4,2,3,1],  barre:{f:7,a:0,b:5},   pos:7}],
    // Minor 6th — all roots (shape: n-n+2-n+2-n-n+2-n, root on low E)
    'Cm6':   [{frets:[8,10,10,8,10,8],  fingers:[1,3,4,1,3,1],  barre:{f:8,a:0,b:5},   pos:8}],
    'C#m6':  [{frets:[9,11,11,9,11,9],  fingers:[1,3,4,1,3,1],  barre:{f:9,a:0,b:5},   pos:9}],
    'Dbm6':  [{frets:[9,11,11,9,11,9],  fingers:[1,3,4,1,3,1],  barre:{f:9,a:0,b:5},   pos:9}],
    'Dm6':   [{frets:[10,12,12,10,12,10],fingers:[1,3,4,1,3,1], barre:{f:10,a:0,b:5},  pos:10}],
    'D#m6':  [{frets:[11,13,13,11,13,11],fingers:[1,3,4,1,3,1], barre:{f:11,a:0,b:5},  pos:11}],
    'Ebm6':  [{frets:[11,13,13,11,13,11],fingers:[1,3,4,1,3,1], barre:{f:11,a:0,b:5},  pos:11}],
    'Em6':   [{frets:[0,2,2,0,2,0],     fingers:[0,2,3,0,4,0],  barre:null,             pos:0}],
    'Fm6':   [{frets:[1,3,3,1,3,1],     fingers:[1,3,4,1,3,1],  barre:{f:1,a:0,b:5},   pos:1}],
    'F#m6':  [{frets:[2,4,4,2,4,2],     fingers:[1,3,4,1,3,1],  barre:{f:2,a:0,b:5},   pos:2}],
    'Gbm6':  [{frets:[2,4,4,2,4,2],     fingers:[1,3,4,1,3,1],  barre:{f:2,a:0,b:5},   pos:2}],
    'Gm6':   [{frets:[3,5,5,3,5,3],     fingers:[1,3,4,1,3,1],  barre:{f:3,a:0,b:5},   pos:3}],
    'G#m6':  [{frets:[4,6,6,4,6,4],     fingers:[1,3,4,1,3,1],  barre:{f:4,a:0,b:5},   pos:4}],
    'Abm6':  [{frets:[4,6,6,4,6,4],     fingers:[1,3,4,1,3,1],  barre:{f:4,a:0,b:5},   pos:4}],
    'Am6':   [{frets:[5,7,7,5,7,5],     fingers:[1,3,4,1,3,1],  barre:{f:5,a:0,b:5},   pos:5}],
    'A#m6':  [{frets:[6,8,8,6,8,6],     fingers:[1,3,4,1,3,1],  barre:{f:6,a:0,b:5},   pos:6}],
    'Bbm6':  [{frets:[6,8,8,6,8,6],     fingers:[1,3,4,1,3,1],  barre:{f:6,a:0,b:5},   pos:6}],
    'Bm6':   [{frets:[7,9,9,7,9,7],     fingers:[1,3,4,1,3,1],  barre:{f:7,a:0,b:5},   pos:7}],
    // Add9 — all roots (shape: n-n+2-n+2-n+1-n-n+2, root on low E)
    'Cadd9': [{frets:[8,10,10,9,8,10],  fingers:[1,3,4,2,1,4],  barre:{f:8,a:0,b:5},   pos:8}],
    'C#add9':[{frets:[9,11,11,10,9,11], fingers:[1,3,4,2,1,4],  barre:{f:9,a:0,b:5},   pos:9}],
    'Dbadd9':[{frets:[9,11,11,10,9,11], fingers:[1,3,4,2,1,4],  barre:{f:9,a:0,b:5},   pos:9}],
    'Dadd9': [{frets:[10,12,12,11,10,12],fingers:[1,3,4,2,1,4], barre:{f:10,a:0,b:5},  pos:10}],
    'D#add9':[{frets:[11,13,13,12,11,13],fingers:[1,3,4,2,1,4], barre:{f:11,a:0,b:5},  pos:11}],
    'Ebadd9':[{frets:[11,13,13,12,11,13],fingers:[1,3,4,2,1,4], barre:{f:11,a:0,b:5},  pos:11}],
    'Eadd9': [{frets:[0,2,2,1,0,2],     fingers:[0,2,3,1,0,4],  barre:null,             pos:0}],
    'Fadd9': [{frets:[1,3,3,2,1,3],     fingers:[1,3,4,2,1,4],  barre:{f:1,a:0,b:5},   pos:1}],
    'F#add9':[{frets:[2,4,4,3,2,4],     fingers:[1,3,4,2,1,4],  barre:{f:2,a:0,b:5},   pos:2}],
    'Gbadd9':[{frets:[2,4,4,3,2,4],     fingers:[1,3,4,2,1,4],  barre:{f:2,a:0,b:5},   pos:2}],
    'Gadd9': [{frets:[3,5,5,4,3,5],     fingers:[1,3,4,2,1,4],  barre:{f:3,a:0,b:5},   pos:3}],
    'G#add9':[{frets:[4,6,6,5,4,6],     fingers:[1,3,4,2,1,4],  barre:{f:4,a:0,b:5},   pos:4}],
    'Abadd9':[{frets:[4,6,6,5,4,6],     fingers:[1,3,4,2,1,4],  barre:{f:4,a:0,b:5},   pos:4}],
    'Aadd9': [{frets:[5,7,7,6,5,7],     fingers:[1,3,4,2,1,4],  barre:{f:5,a:0,b:5},   pos:5}],
    'A#add9':[{frets:[6,8,8,7,6,8],     fingers:[1,3,4,2,1,4],  barre:{f:6,a:0,b:5},   pos:6}],
    'Bbadd9':[{frets:[6,8,8,7,6,8],     fingers:[1,3,4,2,1,4],  barre:{f:6,a:0,b:5},   pos:6}],
    'Badd9': [{frets:[7,9,9,8,7,9],     fingers:[1,3,4,2,1,4],  barre:{f:7,a:0,b:5},   pos:7}],
    // 7sus4 — all roots (shape: n-n+2-n-n+2-n+3-n, root on low E)
    'C7sus4':[{frets:[8,10,8,10,11,8],  fingers:[1,3,1,3,4,1],  barre:{f:8,a:0,b:5},   pos:8}],
    'C#7sus4':[{frets:[9,11,9,11,12,9], fingers:[1,3,1,3,4,1],  barre:{f:9,a:0,b:5},   pos:9}],
    'Db7sus4':[{frets:[9,11,9,11,12,9], fingers:[1,3,1,3,4,1],  barre:{f:9,a:0,b:5},   pos:9}],
    'D7sus4':[{frets:[10,12,10,12,13,10],fingers:[1,3,1,3,4,1], barre:{f:10,a:0,b:5},  pos:10}],
    'D#7sus4':[{frets:[11,13,11,13,14,11],fingers:[1,3,1,3,4,1],barre:{f:11,a:0,b:5},  pos:11}],
    'Eb7sus4':[{frets:[11,13,11,13,14,11],fingers:[1,3,1,3,4,1],barre:{f:11,a:0,b:5},  pos:11}],
    'E7sus4': [{frets:[0,2,0,2,3,0],    fingers:[0,2,0,3,4,0],  barre:null,             pos:0}],
    'F7sus4': [{frets:[1,3,1,3,4,1],    fingers:[1,3,1,3,4,1],  barre:{f:1,a:0,b:5},   pos:1}],
    'F#7sus4':[{frets:[2,4,2,4,5,2],    fingers:[1,3,1,3,4,1],  barre:{f:2,a:0,b:5},   pos:2}],
    'Gb7sus4':[{frets:[2,4,2,4,5,2],    fingers:[1,3,1,3,4,1],  barre:{f:2,a:0,b:5},   pos:2}],
    'G7sus4': [{frets:[3,5,3,5,6,3],    fingers:[1,3,1,3,4,1],  barre:{f:3,a:0,b:5},   pos:3}],
    'G#7sus4':[{frets:[4,6,4,6,7,4],    fingers:[1,3,1,3,4,1],  barre:{f:4,a:0,b:5},   pos:4}],
    'Ab7sus4':[{frets:[4,6,4,6,7,4],    fingers:[1,3,1,3,4,1],  barre:{f:4,a:0,b:5},   pos:4}],
    'A7sus4': [{frets:[5,7,5,7,8,5],    fingers:[1,3,1,3,4,1],  barre:{f:5,a:0,b:5},   pos:5}],
    'A#7sus4':[{frets:[6,8,6,8,9,6],    fingers:[1,3,1,3,4,1],  barre:{f:6,a:0,b:5},   pos:6}],
    'Bb7sus4':[{frets:[6,8,6,8,9,6],    fingers:[1,3,1,3,4,1],  barre:{f:6,a:0,b:5},   pos:6}],
    'B7sus4': [{frets:[7,9,7,9,10,7],   fingers:[1,3,1,3,4,1],  barre:{f:7,a:0,b:5},   pos:7}],
    // Dominant 9th — all roots (shape: n-n+2-n-n+1-n-n+2, root on low E)
    'C9':    [{frets:[8,10,8,9,8,10],   fingers:[1,3,1,2,1,4],  barre:{f:8,a:0,b:5},   pos:8}],
    'C#9':   [{frets:[9,11,9,10,9,11],  fingers:[1,3,1,2,1,4],  barre:{f:9,a:0,b:5},   pos:9}],
    'Db9':   [{frets:[9,11,9,10,9,11],  fingers:[1,3,1,2,1,4],  barre:{f:9,a:0,b:5},   pos:9}],
    'D9':    [{frets:[10,12,10,11,10,12],fingers:[1,3,1,2,1,4], barre:{f:10,a:0,b:5},  pos:10}],
    'D#9':   [{frets:[11,13,11,12,11,13],fingers:[1,3,1,2,1,4], barre:{f:11,a:0,b:5},  pos:11}],
    'Eb9':   [{frets:[11,13,11,12,11,13],fingers:[1,3,1,2,1,4], barre:{f:11,a:0,b:5},  pos:11}],
    'E9':    [{frets:[0,2,0,1,0,2],     fingers:[0,2,0,1,0,3],  barre:null,             pos:0}],
    'F9':    [{frets:[1,3,1,2,1,3],     fingers:[1,3,1,2,1,4],  barre:{f:1,a:0,b:5},   pos:1}],
    'F#9':   [{frets:[2,4,2,3,2,4],     fingers:[1,3,1,2,1,4],  barre:{f:2,a:0,b:5},   pos:2}],
    'Gb9':   [{frets:[2,4,2,3,2,4],     fingers:[1,3,1,2,1,4],  barre:{f:2,a:0,b:5},   pos:2}],
    'G9':    [{frets:[3,5,3,4,3,5],     fingers:[1,3,1,2,1,4],  barre:{f:3,a:0,b:5},   pos:3}],
    'G#9':   [{frets:[4,6,4,5,4,6],     fingers:[1,3,1,2,1,4],  barre:{f:4,a:0,b:5},   pos:4}],
    'Ab9':   [{frets:[4,6,4,5,4,6],     fingers:[1,3,1,2,1,4],  barre:{f:4,a:0,b:5},   pos:4}],
    'A9':    [{frets:[5,7,5,6,5,7],     fingers:[1,3,1,2,1,4],  barre:{f:5,a:0,b:5},   pos:5}],
    'A#9':   [{frets:[6,8,6,7,6,8],     fingers:[1,3,1,2,1,4],  barre:{f:6,a:0,b:5},   pos:6}],
    'Bb9':   [{frets:[6,8,6,7,6,8],     fingers:[1,3,1,2,1,4],  barre:{f:6,a:0,b:5},   pos:6}],
    'B9':    [{frets:[7,9,7,8,7,9],     fingers:[1,3,1,2,1,4],  barre:{f:7,a:0,b:5},   pos:7}],
    // Minor 9th — all roots (shape: n-n+2-n-n-n-n+2, root on low E)
    'Cm9':   [{frets:[8,10,8,8,8,10],   fingers:[1,3,1,1,1,4],  barre:{f:8,a:0,b:5},   pos:8}],
    'C#m9':  [{frets:[9,11,9,9,9,11],   fingers:[1,3,1,1,1,4],  barre:{f:9,a:0,b:5},   pos:9}],
    'Dbm9':  [{frets:[9,11,9,9,9,11],   fingers:[1,3,1,1,1,4],  barre:{f:9,a:0,b:5},   pos:9}],
    'Dm9':   [{frets:[10,12,10,10,10,12],fingers:[1,3,1,1,1,4], barre:{f:10,a:0,b:5},  pos:10}],
    'D#m9':  [{frets:[11,13,11,11,11,13],fingers:[1,3,1,1,1,4], barre:{f:11,a:0,b:5},  pos:11}],
    'Ebm9':  [{frets:[11,13,11,11,11,13],fingers:[1,3,1,1,1,4], barre:{f:11,a:0,b:5},  pos:11}],
    'Em9':   [{frets:[0,2,0,0,0,2],     fingers:[0,2,0,0,0,3],  barre:null,             pos:0}],
    'Fm9':   [{frets:[1,3,1,1,1,3],     fingers:[1,3,1,1,1,4],  barre:{f:1,a:0,b:5},   pos:1}],
    'F#m9':  [{frets:[2,4,2,2,2,4],     fingers:[1,3,1,1,1,4],  barre:{f:2,a:0,b:5},   pos:2}],
    'Gbm9':  [{frets:[2,4,2,2,2,4],     fingers:[1,3,1,1,1,4],  barre:{f:2,a:0,b:5},   pos:2}],
    'Gm9':   [{frets:[3,5,3,3,3,5],     fingers:[1,3,1,1,1,4],  barre:{f:3,a:0,b:5},   pos:3}],
    'G#m9':  [{frets:[4,6,4,4,4,6],     fingers:[1,3,1,1,1,4],  barre:{f:4,a:0,b:5},   pos:4}],
    'Abm9':  [{frets:[4,6,4,4,4,6],     fingers:[1,3,1,1,1,4],  barre:{f:4,a:0,b:5},   pos:4}],
    'Am9':   [{frets:[5,7,5,5,5,7],     fingers:[1,3,1,1,1,4],  barre:{f:5,a:0,b:5},   pos:5}],
    'A#m9':  [{frets:[6,8,6,6,6,8],     fingers:[1,3,1,1,1,4],  barre:{f:6,a:0,b:5},   pos:6}],
    'Bbm9':  [{frets:[6,8,6,6,6,8],     fingers:[1,3,1,1,1,4],  barre:{f:6,a:0,b:5},   pos:6}],
    'Bm9':   [{frets:[7,9,7,7,7,9],     fingers:[1,3,1,1,1,4],  barre:{f:7,a:0,b:5},   pos:7}],
    // Major 9th — all roots (shape: n-n+2-n+1-n+1-n-n+2, root on low E)
    'Cmaj9': [{frets:[8,10,9,9,8,10],   fingers:[1,3,2,2,1,4],  barre:{f:8,a:0,b:5},   pos:8}],
    'C#maj9':[{frets:[9,11,10,10,9,11], fingers:[1,3,2,2,1,4],  barre:{f:9,a:0,b:5},   pos:9}],
    'Dbmaj9':[{frets:[9,11,10,10,9,11], fingers:[1,3,2,2,1,4],  barre:{f:9,a:0,b:5},   pos:9}],
    'Dmaj9': [{frets:[10,12,11,11,10,12],fingers:[1,3,2,2,1,4], barre:{f:10,a:0,b:5},  pos:10}],
    'D#maj9':[{frets:[11,13,12,12,11,13],fingers:[1,3,2,2,1,4], barre:{f:11,a:0,b:5},  pos:11}],
    'Ebmaj9':[{frets:[11,13,12,12,11,13],fingers:[1,3,2,2,1,4], barre:{f:11,a:0,b:5},  pos:11}],
    'Emaj9': [{frets:[0,2,1,1,0,2],     fingers:[0,2,1,1,0,3],  barre:null,             pos:0}],
    'Fmaj9': [{frets:[1,3,2,2,1,3],     fingers:[1,3,2,2,1,4],  barre:{f:1,a:0,b:5},   pos:1}],
    'F#maj9':[{frets:[2,4,3,3,2,4],     fingers:[1,3,2,2,1,4],  barre:{f:2,a:0,b:5},   pos:2}],
    'Gbmaj9':[{frets:[2,4,3,3,2,4],     fingers:[1,3,2,2,1,4],  barre:{f:2,a:0,b:5},   pos:2}],
    'Gmaj9': [{frets:[3,5,4,4,3,5],     fingers:[1,3,2,2,1,4],  barre:{f:3,a:0,b:5},   pos:3}],
    'G#maj9':[{frets:[4,6,5,5,4,6],     fingers:[1,3,2,2,1,4],  barre:{f:4,a:0,b:5},   pos:4}],
    'Abmaj9':[{frets:[4,6,5,5,4,6],     fingers:[1,3,2,2,1,4],  barre:{f:4,a:0,b:5},   pos:4}],
    'Amaj9': [{frets:[5,7,6,6,5,7],     fingers:[1,3,2,2,1,4],  barre:{f:5,a:0,b:5},   pos:5}],
    'A#maj9':[{frets:[6,8,7,7,6,8],     fingers:[1,3,2,2,1,4],  barre:{f:6,a:0,b:5},   pos:6}],
    'Bbmaj9':[{frets:[6,8,7,7,6,8],     fingers:[1,3,2,2,1,4],  barre:{f:6,a:0,b:5},   pos:6}],
    'Bmaj9': [{frets:[7,9,8,8,7,9],     fingers:[1,3,2,2,1,4],  barre:{f:7,a:0,b:5},   pos:7}],
  };
  // Ukulele chord database [G C E A] strings (reentrant tuning G4 C4 E4 A4)
  const UDB = {
    'C':    [{frets:[0,0,0,3],  fingers:[0,0,0,3],  barre:null,            pos:0},
             {frets:[5,4,3,3],  fingers:[4,3,1,1],  barre:{f:3,a:2,b:3},  pos:3}],
    'C#':   [{frets:[1,1,1,4],   fingers:[1,1,1,4],   barre:{f:1,a:0,b:2},  pos:1},
             {frets:[6,5,4,4],   fingers:[4,3,1,1],   barre:{f:4,a:2,b:3},  pos:4}],
    'Db':   [{frets:[1,1,1,4],   fingers:[1,1,1,4],   barre:{f:1,a:0,b:2},  pos:1},
             {frets:[6,5,4,4],   fingers:[4,3,1,1],   barre:{f:4,a:2,b:3},  pos:4}],
    'D':    [{frets:[2,2,2,0],   fingers:[2,3,4,0],   barre:null,            pos:0},
             {frets:[7,6,5,5],   fingers:[4,3,1,1],   barre:{f:5,a:2,b:3},  pos:5}],
    'D#':   [{frets:[3,3,3,1],   fingers:[2,3,4,1],   barre:null,            pos:1},
             {frets:[8,7,6,6],   fingers:[4,3,1,1],   barre:{f:6,a:2,b:3},  pos:6}],
    'Eb':   [{frets:[3,3,3,1],   fingers:[2,3,4,1],   barre:null,            pos:1},
             {frets:[8,7,6,6],   fingers:[4,3,1,1],   barre:{f:6,a:2,b:3},  pos:6}],
    'E':    [{frets:[4,4,4,2],   fingers:[2,3,4,1],   barre:null,            pos:2},
             {frets:[9,8,7,7],   fingers:[4,3,1,1],   barre:{f:7,a:2,b:3},  pos:7}],
    'F':    [{frets:[2,0,1,0],   fingers:[2,0,1,0],   barre:null,            pos:0},
             {frets:[10,9,8,8],  fingers:[4,3,1,1],   barre:{f:8,a:2,b:3},  pos:8}],
    'F#':   [{frets:[3,1,2,1],   fingers:[3,1,2,1],   barre:{f:1,a:1,b:3},  pos:1},
             {frets:[11,10,9,9], fingers:[4,3,1,1],   barre:{f:9,a:2,b:3},  pos:9}],
    'Gb':   [{frets:[3,1,2,1],   fingers:[3,1,2,1],   barre:{f:1,a:1,b:3},  pos:1},
             {frets:[11,10,9,9], fingers:[4,3,1,1],   barre:{f:9,a:2,b:3},  pos:9}],
    'G':    [{frets:[0,2,3,2],   fingers:[0,1,3,2],   barre:null,            pos:0},
             {frets:[4,2,3,2],   fingers:[4,1,3,2],   barre:null,            pos:2}],
    'G#':   [{frets:[5,3,4,3],   fingers:[4,1,3,2],   barre:{f:3,a:1,b:3},  pos:3},
             {frets:[1,3,4,3],   fingers:[1,2,4,3],   barre:null,            pos:1}],
    'Ab':   [{frets:[5,3,4,3],   fingers:[4,1,3,2],   barre:{f:3,a:1,b:3},  pos:3},
             {frets:[1,3,4,3],   fingers:[1,2,4,3],   barre:null,            pos:1}],
    'A':    [{frets:[2,1,0,0],   fingers:[2,1,0,0],   barre:null,            pos:0},
             {frets:[9,9,9,0],   fingers:[2,3,4,0],   barre:null,            pos:9}],
    'A#':   [{frets:[3,2,1,1],   fingers:[3,2,1,1],   barre:{f:1,a:2,b:3},  pos:1},
             {frets:[10,10,10,8],fingers:[2,3,4,1],   barre:null,            pos:8}],
    'Bb':   [{frets:[3,2,1,1],   fingers:[3,2,1,1],   barre:{f:1,a:2,b:3},  pos:1},
             {frets:[10,10,10,8],fingers:[2,3,4,1],   barre:null,            pos:8}],
    'B':    [{frets:[4,3,2,2],   fingers:[4,3,1,1],   barre:{f:2,a:2,b:3},  pos:2},
             {frets:[11,11,11,9],fingers:[2,3,4,1],   barre:null,            pos:9}],
    'Cm':   [{frets:[0,3,3,3],   fingers:[0,1,2,3],   barre:{f:3,a:1,b:3},  pos:3},
             {frets:[5,3,3,3],   fingers:[4,1,1,1],   barre:{f:3,a:1,b:3},  pos:3}],
    'C#m':  [{frets:[1,4,4,4],   fingers:[1,2,3,4],   barre:{f:4,a:1,b:3},  pos:4},
             {frets:[6,4,4,4],   fingers:[4,1,1,1],   barre:{f:4,a:1,b:3},  pos:4}],
    'Dbm':  [{frets:[1,4,4,4],   fingers:[1,2,3,4],   barre:{f:4,a:1,b:3},  pos:4},
             {frets:[6,4,4,4],   fingers:[4,1,1,1],   barre:{f:4,a:1,b:3},  pos:4}],
    'Dm':   [{frets:[2,2,1,0],   fingers:[3,2,1,0],   barre:null,            pos:0},
             {frets:[7,5,5,5],   fingers:[4,1,1,1],   barre:{f:5,a:1,b:3},  pos:5}],
    'D#m':  [{frets:[3,3,2,1],   fingers:[3,4,2,1],   barre:null,            pos:1},
             {frets:[8,6,6,6],   fingers:[4,1,1,1],   barre:{f:6,a:1,b:3},  pos:6}],
    'Ebm':  [{frets:[3,3,2,1],   fingers:[3,4,2,1],   barre:null,            pos:1},
             {frets:[8,6,6,6],   fingers:[4,1,1,1],   barre:{f:6,a:1,b:3},  pos:6}],
    'Em':   [{frets:[0,4,3,2],   fingers:[0,4,3,2],   barre:null,            pos:0},
             {frets:[9,7,7,7],   fingers:[4,1,1,1],   barre:{f:7,a:1,b:3},  pos:7}],
    'Fm':   [{frets:[1,0,1,3],   fingers:[1,0,2,4],   barre:null,            pos:0},
             {frets:[10,8,8,8],  fingers:[4,1,1,1],   barre:{f:8,a:1,b:3},  pos:8}],
    'F#m':  [{frets:[2,1,2,0],   fingers:[3,1,4,0],   barre:null,            pos:0},
             {frets:[11,9,9,9],  fingers:[4,1,1,1],   barre:{f:9,a:1,b:3},  pos:9}],
    'Gbm':  [{frets:[2,1,2,0],   fingers:[3,1,4,0],   barre:null,            pos:0},
             {frets:[11,9,9,9],  fingers:[4,1,1,1],   barre:{f:9,a:1,b:3},  pos:9}],
    'Gm':   [{frets:[0,2,3,1],   fingers:[0,2,3,1],   barre:null,            pos:0},
             {frets:[12,10,10,10],fingers:[4,1,1,1],  barre:{f:10,a:1,b:3}, pos:10}],
    'G#m':  [{frets:[4,3,4,2],   fingers:[4,2,3,1],   barre:null,            pos:2},
             {frets:[8,8,7,6],   fingers:[4,3,2,1],   barre:null,            pos:6}],
    'Abm':  [{frets:[4,3,4,2],   fingers:[4,2,3,1],   barre:null,            pos:2},
             {frets:[8,8,7,6],   fingers:[4,3,2,1],   barre:null,            pos:6}],
    'Am':   [{frets:[2,0,0,0],   fingers:[2,0,0,0],   barre:null,            pos:0},
             {frets:[9,9,8,7],   fingers:[4,3,2,1],   barre:null,            pos:7}],
    'A#m':  [{frets:[3,1,1,1],   fingers:[3,1,1,1],   barre:{f:1,a:1,b:3},  pos:1},
             {frets:[10,10,9,8], fingers:[4,3,2,1],   barre:null,            pos:8}],
    'Bbm':  [{frets:[3,1,1,1],   fingers:[3,1,1,1],   barre:{f:1,a:1,b:3},  pos:1},
             {frets:[10,10,9,8], fingers:[4,3,2,1],   barre:null,            pos:8}],
    'Bm':   [{frets:[4,2,2,2],   fingers:[4,1,1,1],   barre:{f:2,a:1,b:3},  pos:2},
             {frets:[11,11,10,9],fingers:[4,3,2,1],   barre:null,            pos:9}],
    'C7':   [{frets:[0,0,0,1],   fingers:[0,0,0,1],   barre:null,            pos:0}],
    'C#7':  [{frets:[1,1,1,2],   fingers:[1,1,1,2],   barre:{f:1,a:0,b:2},  pos:1}],
    'Db7':  [{frets:[1,1,1,2],   fingers:[1,1,1,2],   barre:{f:1,a:0,b:2},  pos:1}],
    'D7':   [{frets:[2,2,2,3],   fingers:[1,2,3,4],   barre:{f:2,a:0,b:2},  pos:2}],
    'D#7':  [{frets:[3,3,3,4],   fingers:[1,1,1,2],   barre:{f:3,a:0,b:2},  pos:3}],
    'Eb7':  [{frets:[3,3,3,4],   fingers:[1,1,1,2],   barre:{f:3,a:0,b:2},  pos:3}],
    'E7':   [{frets:[1,2,0,2],   fingers:[1,3,0,2],   barre:null,            pos:0}],
    'F7':   [{frets:[2,3,1,3],   fingers:[2,4,1,3],   barre:null,            pos:1}],
    'F#7':  [{frets:[3,4,2,4],   fingers:[2,3,1,4],   barre:null,            pos:2}],
    'Gb7':  [{frets:[3,4,2,4],   fingers:[2,3,1,4],   barre:null,            pos:2}],
    'G7':   [{frets:[0,2,1,2],   fingers:[0,2,1,3],   barre:null,            pos:0}],
    'G#7':  [{frets:[1,3,2,3],   fingers:[1,4,2,3],   barre:null,            pos:1}],
    'Ab7':  [{frets:[1,3,2,3],   fingers:[1,4,2,3],   barre:null,            pos:1}],
    'A7':   [{frets:[0,1,0,0],   fingers:[0,1,0,0],   barre:null,            pos:0}],
    'B7':   [{frets:[2,3,2,2],   fingers:[3,4,1,2],   barre:null,            pos:2}],
    'Cm7':  [{frets:[3,3,3,3],    fingers:[1,1,1,1],   barre:{f:3,a:0,b:3},  pos:3}],
    'C#m7': [{frets:[4,4,4,4],    fingers:[1,1,1,1],   barre:{f:4,a:0,b:3},  pos:4}],
    'Dbm7': [{frets:[4,4,4,4],    fingers:[1,1,1,1],   barre:{f:4,a:0,b:3},  pos:4}],
    'Dm7':  [{frets:[2,2,1,2],    fingers:[3,2,1,4],   barre:null,            pos:0}],
    'D#m7': [{frets:[6,6,6,6],    fingers:[1,1,1,1],   barre:{f:6,a:0,b:3},  pos:6}],
    'Ebm7': [{frets:[6,6,6,6],    fingers:[1,1,1,1],   barre:{f:6,a:0,b:3},  pos:6}],
    'Em7':  [{frets:[0,2,0,2],    fingers:[0,2,0,3],   barre:null,            pos:0}],
    'Fm7':  [{frets:[8,8,8,8],    fingers:[1,1,1,1],   barre:{f:8,a:0,b:3},  pos:8}],
    'F#m7': [{frets:[9,9,9,9],    fingers:[1,1,1,1],   barre:{f:9,a:0,b:3},  pos:9}],
    'Gbm7': [{frets:[9,9,9,9],    fingers:[1,1,1,1],   barre:{f:9,a:0,b:3},  pos:9}],
    'Gm7':  [{frets:[0,2,1,1],    fingers:[0,2,1,1],   barre:{f:1,a:2,b:3},  pos:0}],
    'G#m7': [{frets:[11,11,11,11],fingers:[1,1,1,1],   barre:{f:11,a:0,b:3}, pos:11}],
    'Abm7': [{frets:[11,11,11,11],fingers:[1,1,1,1],   barre:{f:11,a:0,b:3}, pos:11}],
    'Am7':  [{frets:[0,0,0,0],    fingers:[0,0,0,0],   barre:null,            pos:0}],
    'A#m7': [{frets:[1,1,1,1],    fingers:[1,1,1,1],   barre:{f:1,a:0,b:3},  pos:1}],
    'Bbm7': [{frets:[1,1,1,1],    fingers:[1,1,1,1],   barre:{f:1,a:0,b:3},  pos:1}],
    'Bm7':  [{frets:[2,2,2,2],    fingers:[1,1,1,1],   barre:{f:2,a:0,b:3},  pos:2}],
    'Cmaj7': [{frets:[0,0,0,2],   fingers:[0,0,0,2],   barre:null,            pos:0}],
    'C#maj7':[{frets:[1,1,1,3],   fingers:[1,1,1,3],   barre:{f:1,a:0,b:2},  pos:1}],
    'Dbmaj7':[{frets:[1,1,1,3],   fingers:[1,1,1,3],   barre:{f:1,a:0,b:2},  pos:1}],
    'Dmaj7': [{frets:[2,2,2,4],   fingers:[1,1,1,4],   barre:{f:2,a:0,b:2},  pos:2}],
    'D#maj7':[{frets:[3,3,3,5],   fingers:[1,1,1,4],   barre:{f:3,a:0,b:2},  pos:3}],
    'Ebmaj7':[{frets:[3,3,3,5],   fingers:[1,1,1,4],   barre:{f:3,a:0,b:2},  pos:3}],
    'Emaj7': [{frets:[4,4,4,6],   fingers:[1,1,1,4],   barre:{f:4,a:0,b:2},  pos:4}],
    'Fmaj7': [{frets:[2,4,1,3],   fingers:[2,4,1,3],   barre:null,            pos:1}],
    'F#maj7':[{frets:[6,6,6,8],   fingers:[1,1,1,4],   barre:{f:6,a:0,b:2},  pos:6}],
    'Gbmaj7':[{frets:[6,6,6,8],   fingers:[1,1,1,4],   barre:{f:6,a:0,b:2},  pos:6}],
    'Gmaj7': [{frets:[0,2,2,2],   fingers:[0,1,2,3],   barre:null,            pos:0}],
    'G#maj7':[{frets:[8,8,8,10],  fingers:[1,1,1,4],   barre:{f:8,a:0,b:2},  pos:8}],
    'Abmaj7':[{frets:[8,8,8,10],  fingers:[1,1,1,4],   barre:{f:8,a:0,b:2},  pos:8}],
    'Amaj7': [{frets:[1,1,0,0],   fingers:[1,2,0,0],   barre:null,            pos:0}],
    'A#maj7':[{frets:[10,10,10,12],fingers:[1,1,1,4],  barre:{f:10,a:0,b:2}, pos:10}],
    'Bbmaj7':[{frets:[10,10,10,12],fingers:[1,1,1,4],  barre:{f:10,a:0,b:2}, pos:10}],
    'Bmaj7': [{frets:[3,3,2,2],   fingers:[3,4,1,1],   barre:{f:2,a:2,b:3},  pos:2}],
    // === DIM ===  (3 shapes cubren los 12: [2,3,2,3] [0,1,0,1] [1,2,1,2])
    'Cdim':  [{frets:[2,3,2,3],   fingers:[1,3,2,4],   barre:null,            pos:2}],
    'C#dim': [{frets:[0,1,0,1],   fingers:[0,1,0,2],   barre:null,            pos:0}],
    'Dbdim': [{frets:[0,1,0,1],   fingers:[0,1,0,2],   barre:null,            pos:0}],
    'Ddim':  [{frets:[1,2,1,2],   fingers:[1,3,2,4],   barre:null,            pos:0}],
    'D#dim': [{frets:[2,3,2,3],   fingers:[1,3,2,4],   barre:null,            pos:2}],
    'Ebdim': [{frets:[2,3,2,3],   fingers:[1,3,2,4],   barre:null,            pos:2}],
    'Edim':  [{frets:[0,1,0,1],   fingers:[0,1,0,2],   barre:null,            pos:0}],
    'Fdim':  [{frets:[1,2,1,2],   fingers:[1,3,2,4],   barre:null,            pos:0}],
    'F#dim': [{frets:[2,3,2,3],   fingers:[1,3,2,4],   barre:null,            pos:2}],
    'Gbdim': [{frets:[2,3,2,3],   fingers:[1,3,2,4],   barre:null,            pos:2}],
    'Gdim':  [{frets:[0,1,0,1],   fingers:[0,1,0,2],   barre:null,            pos:0}],
    'G#dim': [{frets:[1,2,1,2],   fingers:[1,3,2,4],   barre:null,            pos:0}],
    'Abdim': [{frets:[1,2,1,2],   fingers:[1,3,2,4],   barre:null,            pos:0}],
    'Adim':  [{frets:[2,3,2,3],   fingers:[1,3,2,4],   barre:null,            pos:2}],
    'A#dim': [{frets:[0,1,0,1],   fingers:[0,1,0,2],   barre:null,            pos:0}],
    'Bbdim': [{frets:[0,1,0,1],   fingers:[0,1,0,2],   barre:null,            pos:0}],
    'Bdim':  [{frets:[1,2,1,2],   fingers:[1,3,2,4],   barre:null,            pos:0}],
    // === AUG ===  (4 shapes: [1,0,0,3] [2,1,1,4] [3,2,2,5] [4,3,3,6])
    'Caug':  [{frets:[1,0,0,3],   fingers:[1,0,0,3],   barre:null,            pos:0}],
    'C#aug': [{frets:[2,1,1,4],   fingers:[2,1,1,4],   barre:{f:1,a:1,b:2},  pos:1}],
    'Dbaug': [{frets:[2,1,1,4],   fingers:[2,1,1,4],   barre:{f:1,a:1,b:2},  pos:1}],
    'Daug':  [{frets:[3,2,2,5],   fingers:[2,1,1,4],   barre:{f:2,a:1,b:2},  pos:2}],
    'D#aug': [{frets:[4,3,3,6],   fingers:[2,1,1,4],   barre:{f:3,a:1,b:2},  pos:3}],
    'Ebaug': [{frets:[4,3,3,6],   fingers:[2,1,1,4],   barre:{f:3,a:1,b:2},  pos:3}],
    'Eaug':  [{frets:[1,0,0,3],   fingers:[1,0,0,3],   barre:null,            pos:0}],
    'Faug':  [{frets:[2,1,1,4],   fingers:[2,1,1,4],   barre:{f:1,a:1,b:2},  pos:1}],
    'F#aug': [{frets:[3,2,2,5],   fingers:[2,1,1,4],   barre:{f:2,a:1,b:2},  pos:2}],
    'Gbaug': [{frets:[3,2,2,5],   fingers:[2,1,1,4],   barre:{f:2,a:1,b:2},  pos:2}],
    'Gaug':  [{frets:[4,3,3,6],   fingers:[2,1,1,4],   barre:{f:3,a:1,b:2},  pos:3}],
    'G#aug': [{frets:[1,0,0,3],   fingers:[1,0,0,3],   barre:null,            pos:0}],
    'Abaug': [{frets:[1,0,0,3],   fingers:[1,0,0,3],   barre:null,            pos:0}],
    'Aaug':  [{frets:[2,1,1,4],   fingers:[2,1,1,4],   barre:{f:1,a:1,b:2},  pos:1}],
    'A#aug': [{frets:[3,2,2,5],   fingers:[2,1,1,4],   barre:{f:2,a:1,b:2},  pos:2}],
    'Bbaug': [{frets:[3,2,2,5],   fingers:[2,1,1,4],   barre:{f:2,a:1,b:2},  pos:2}],
    'Baug':  [{frets:[4,3,3,6],   fingers:[2,1,1,4],   barre:{f:3,a:1,b:2},  pos:3}],
    // === DIM7 ===
    'Cdim7': [{frets:[5,6,5,6],   fingers:[1,3,2,4],   barre:null,            pos:5}],
    'C#dim7':[{frets:[3,4,3,4],   fingers:[1,3,2,4],   barre:null,            pos:3}],
    'Dbdim7':[{frets:[3,4,3,4],   fingers:[1,3,2,4],   barre:null,            pos:3}],
    'Ddim7': [{frets:[4,5,4,5],   fingers:[1,3,2,4],   barre:null,            pos:4}],
    'D#dim7':[{frets:[5,6,5,6],   fingers:[1,3,2,4],   barre:null,            pos:5}],
    'Ebdim7':[{frets:[5,6,5,6],   fingers:[1,3,2,4],   barre:null,            pos:5}],
    'Edim7': [{frets:[3,4,3,4],   fingers:[1,3,2,4],   barre:null,            pos:3}],
    'Fdim7': [{frets:[4,5,4,5],   fingers:[1,3,2,4],   barre:null,            pos:4}],
    'F#dim7':[{frets:[5,6,5,6],   fingers:[1,3,2,4],   barre:null,            pos:5}],
    'Gbdim7':[{frets:[5,6,5,6],   fingers:[1,3,2,4],   barre:null,            pos:5}],
    'Gdim7': [{frets:[3,4,3,4],   fingers:[1,3,2,4],   barre:null,            pos:3}],
    'G#dim7':[{frets:[4,5,4,5],   fingers:[1,3,2,4],   barre:null,            pos:4}],
    'Abdim7':[{frets:[4,5,4,5],   fingers:[1,3,2,4],   barre:null,            pos:4}],
    'Adim7': [{frets:[5,6,5,6],   fingers:[1,3,2,4],   barre:null,            pos:5}],
    'A#dim7':[{frets:[3,4,3,4],   fingers:[1,3,2,4],   barre:null,            pos:3}],
    'Bbdim7':[{frets:[3,4,3,4],   fingers:[1,3,2,4],   barre:null,            pos:3}],
    'Bdim7': [{frets:[4,5,4,5],   fingers:[1,3,2,4],   barre:null,            pos:4}],
    // === SUS2 ===
    'Csus2': [{frets:[0,2,3,3],   fingers:[0,1,2,3],   barre:null,            pos:0}],
    'C#sus2':[{frets:[1,3,4,4],   fingers:[1,2,3,4],   barre:null,            pos:1}],
    'Dbsus2':[{frets:[1,3,4,4],   fingers:[1,2,3,4],   barre:null,            pos:1}],
    'Dsus2': [{frets:[2,4,5,5],   fingers:[1,2,3,4],   barre:null,            pos:2}],
    'D#sus2':[{frets:[3,5,6,6],   fingers:[1,2,3,4],   barre:null,            pos:3}],
    'Ebsus2':[{frets:[3,5,6,6],   fingers:[1,2,3,4],   barre:null,            pos:3}],
    'Esus2': [{frets:[4,6,7,7],   fingers:[1,2,3,4],   barre:null,            pos:4}],
    'Fsus2': [{frets:[0,0,1,3],   fingers:[0,0,1,3],   barre:null,            pos:0}],
    'F#sus2':[{frets:[6,8,9,9],   fingers:[1,2,3,4],   barre:null,            pos:6}],
    'Gbsus2':[{frets:[6,8,9,9],   fingers:[1,2,3,4],   barre:null,            pos:6}],
    'Gsus2': [{frets:[0,2,3,5],   fingers:[0,1,2,4],   barre:null,            pos:0}],
    'G#sus2':[{frets:[8,10,11,11],fingers:[1,2,3,4],   barre:null,            pos:8}],
    'Absus2':[{frets:[8,10,11,11],fingers:[1,2,3,4],   barre:null,            pos:8}],
    'Asus2': [{frets:[2,4,0,2],   fingers:[2,3,0,1],   barre:null,            pos:0}],
    'A#sus2':[{frets:[3,0,1,1],   fingers:[3,0,1,2],   barre:null,            pos:0}],
    'Bbsus2':[{frets:[3,0,1,1],   fingers:[3,0,1,2],   barre:null,            pos:0}],
    'Bsus2': [{frets:[4,6,2,4],   fingers:[2,4,1,3],   barre:null,            pos:2}],
    // === SUS4 ===
    'Csus4': [{frets:[0,0,1,3],   fingers:[0,0,1,3],   barre:null,            pos:0}],
    'C#sus4':[{frets:[1,1,2,4],   fingers:[1,1,2,4],   barre:{f:1,a:0,b:1},  pos:1}],
    'Dbsus4':[{frets:[1,1,2,4],   fingers:[1,1,2,4],   barre:{f:1,a:0,b:1},  pos:1}],
    'Dsus4': [{frets:[2,2,3,0],   fingers:[1,2,3,0],   barre:null,            pos:0}],
    'D#sus4':[{frets:[3,3,4,6],   fingers:[1,1,2,4],   barre:{f:3,a:0,b:1},  pos:3}],
    'Ebsus4':[{frets:[3,3,4,6],   fingers:[1,1,2,4],   barre:{f:3,a:0,b:1},  pos:3}],
    'Esus4': [{frets:[4,4,0,0],   fingers:[2,3,0,0],   barre:null,            pos:0}],
    'Fsus4': [{frets:[0,0,1,1],   fingers:[0,0,1,2],   barre:null,            pos:0}],
    'F#sus4':[{frets:[6,6,7,9],   fingers:[1,1,2,4],   barre:{f:6,a:0,b:1},  pos:6}],
    'Gbsus4':[{frets:[6,6,7,9],   fingers:[1,1,2,4],   barre:{f:6,a:0,b:1},  pos:6}],
    'Gsus4': [{frets:[0,2,3,3],   fingers:[0,1,2,3],   barre:null,            pos:0}],
    'G#sus4':[{frets:[8,8,9,11],  fingers:[1,1,2,4],   barre:{f:8,a:0,b:1},  pos:8}],
    'Absus4':[{frets:[8,8,9,11],  fingers:[1,1,2,4],   barre:{f:8,a:0,b:1},  pos:8}],
    'Asus4': [{frets:[2,2,0,0],   fingers:[1,2,0,0],   barre:null,            pos:0}],
    'A#sus4':[{frets:[3,3,1,1],   fingers:[3,4,1,1],   barre:{f:1,a:2,b:3},  pos:1}],
    'Bbsus4':[{frets:[3,3,1,1],   fingers:[3,4,1,1],   barre:{f:1,a:2,b:3},  pos:1}],
    'Bsus4': [{frets:[4,4,2,2],   fingers:[3,4,1,1],   barre:{f:2,a:2,b:3},  pos:2}],
  };

  // SVG fretboard renderer (guitar or ukulele)
  function renderFretboard(frets, fingers, barre, pos, ns){
    const W  = ns===6 ? 108 : 74;
    const H  = 128;
    const PL = ns===6 ? 18 : 14;
    const PT = 26;
    const PR = 8;
    const NF = 5;
    const strW = (W-PL-PR)/(ns-1);
    const fretH = (H-PT-8)/NF;
    const sf = pos>0 ? pos : 1;

    let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`;

    if(pos>0)
      s+=`<text x="${PL-3}" y="${PT+fretH*0.65}" font-size="8" text-anchor="end" fill="#7a4a26" font-weight="bold">${pos}fr</text>`;

    // top line: nut (thick) or upper fret
    s+=`<line x1="${PL}" y1="${PT}" x2="${PL+strW*(ns-1)}" y2="${PT}" stroke="${pos===0?'#5c3719':'#aaa'}" stroke-width="${pos===0?3:1.5}"/>`;

    // fret lines
    for(let f=1;f<=NF;f++){
      const y=PT+f*fretH;
      s+=`<line x1="${PL}" y1="${y}" x2="${PL+strW*(ns-1)}" y2="${y}" stroke="#ccc" stroke-width="1"/>`;
    }

    // string lines
    for(let i=0;i<ns;i++){
      const x=PL+i*strW;
      s+=`<line x1="${x}" y1="${PT}" x2="${x}" y2="${PT+NF*fretH}" stroke="#999" stroke-width="1.2"/>`;
    }

    // barre
    if(barre){
      const row=barre.f-sf+1;
      if(row>=1&&row<=NF){
        const by=PT+(row-0.5)*fretH;
        s+=`<line x1="${PL+barre.a*strW}" y1="${by}" x2="${PL+barre.b*strW}" y2="${by}" stroke="#3b2010" stroke-width="${fretH*0.56}" stroke-linecap="round"/>`;
      }
    }

    // dots / markers
    for(let i=0;i<ns;i++){
      const x=PL+i*strW;
      const fr=frets[i];
      if(fr<0){
        s+=`<text x="${x}" y="${PT-7}" font-size="11" text-anchor="middle" fill="#b94a3a" font-weight="bold">×</text>`;
      } else if(fr===0){
        s+=`<circle cx="${x}" cy="${PT-8}" r="4" fill="none" stroke="#5c3719" stroke-width="1.5"/>`;
      } else {
        const row=fr-sf+1;
        if(row>=1&&row<=NF){
          const cy=PT+(row-0.5)*fretH;
          const fi=fingers[i];
          const inB=barre&&fr===barre.f&&fi===1&&i>=barre.a&&i<=barre.b;
          if(!inB){
            s+=`<circle cx="${x}" cy="${cy}" r="${fretH*0.30}" fill="#3b2010"/>`;
            if(fi>1) s+=`<text x="${x}" y="${cy+3.5}" font-size="7" text-anchor="middle" fill="#fff" font-weight="bold">${fi}</text>`;
          }
        }
      }
    }
    s+='</svg>';
    return s;
  }

  // SVG piano renderer
  function renderPiano(notesSemi){
    const WW=13, WH=50, BW=8, BH=30, octs=2;
    const TW=7*octs*WW+2;
    const wOrder=[0,2,4,5,7,9,11];
    const bLayout=[{s:1,sl:0},{s:3,sl:1},{s:6,sl:3},{s:8,sl:4},{s:10,sl:5}];
    let sv=`<svg viewBox="0 0 ${TW} ${WH+2}" width="${TW}" height="${WH+2}">`;
    for(let o=0;o<octs;o++){
      for(let wi=0;wi<7;wi++){
        const semi=wOrder[wi];
        const x=(o*7+wi)*WW+1;
        const hit=notesSemi.includes(semi);
        sv+=`<rect x="${x}" y="1" width="${WW-1}" height="${WH}" rx="2" fill="${hit?'#3ab6d8':'#fff'}" stroke="#bbb" stroke-width="1"/>`;
        if(hit) sv+=`<text x="${x+(WW-1)/2}" y="${WH-5}" font-size="6.5" text-anchor="middle" fill="#fff" font-weight="bold">${NES[semi]}</text>`;
      }
    }
    for(let o=0;o<octs;o++){
      for(const bk of bLayout){
        const x=(o*7+bk.sl)*WW+WW-Math.floor(BW/2)+1;
        const hit=notesSemi.includes(bk.s);
        sv+=`<rect x="${x}" y="1" width="${BW}" height="${BH}" rx="2" fill="${hit?'#0e7a99':'#333'}"/>`;
        if(hit) sv+=`<text x="${x+BW/2}" y="${BH-3}" font-size="6" text-anchor="middle" fill="#fff" font-weight="bold">${NES[bk.s]}</text>`;
      }
    }
    sv+='</svg>';
    return sv;
  }

  // ── UI state ──
  let diagFmt = 'guitar';
  let selChord = null;
  let notaSlots = [{n:'Mi',o:'4'},{n:'Sol#',o:'4'},{n:'Si',o:'4'}];

  function renderSlots(){
    const c=$('notaSlots');
    c.innerHTML='';
    notaSlots.forEach((slot,i)=>{
      const d=document.createElement('div');
      d.className='nota-slot';

      const ns=document.createElement('select'); ns.className='nota-sel';
      NES.forEach(n=>{ const o=document.createElement('option'); o.value=n; o.textContent=n; if(n===slot.n) o.selected=true; ns.appendChild(o); });
      ns.addEventListener('change',()=>{ notaSlots[i].n=ns.value; });

      const os=document.createElement('select'); os.className='nota-oct-sel';
      for(let k=1;k<=7;k++){ const o=document.createElement('option'); o.value=String(k); o.textContent=k; if(String(k)===slot.o) o.selected=true; os.appendChild(o); }
      os.addEventListener('change',()=>{ notaSlots[i].o=os.value; });

      const rb=document.createElement('button'); rb.className='nota-rm-btn'; rb.textContent='×';
      rb.addEventListener('click',()=>{ notaSlots.splice(i,1); renderSlots(); });

      d.appendChild(ns); d.appendChild(os); d.appendChild(rb);
      c.appendChild(d);
    });
  }

  function lookupChord(rootSemi, typeEn, db){
    const keyS=NEN[rootSemi]+typeEn;
    const keyF=NEF[rootSemi]+typeEn;
    return db[keyS]||db[keyF]||null;
  }

  function voicingLabel(v){
    if(v.barre) return `Cejilla ${v.barre.f}`;
    if(v.pos===0) return 'Pos. abierta';
    return `Pos. ${v.pos}`;
  }

  function renderVoicingCard(v, ns){
    const card=document.createElement('div'); card.className='chord-diag-card';
    card.innerHTML=renderFretboard(v.frets,v.fingers,v.barre,v.pos,ns);
    const lbl=document.createElement('div'); lbl.className='chord-diag-lbl'; lbl.textContent=voicingLabel(v);
    card.appendChild(lbl);
    return card;
  }

  function showDiagrams(rootSemi, typeObj){
    selChord={rootSemi,type:typeObj};
    const notesSemi=[...new Set(typeObj.iv.map(i=>(rootSemi+(i%12))%12))];
    const wrap=$('chordDiagsWrap');
    wrap.innerHTML='';

    if(diagFmt==='piano'){
      const enKey=NEN[rootSemi]+typeObj.en;
      const card=document.createElement('div'); card.className='chord-diag-card';
      card.innerHTML=renderPiano(notesSemi);
      const lbl=document.createElement('div'); lbl.className='chord-diag-lbl'; lbl.textContent=enKey;
      card.appendChild(lbl); wrap.appendChild(card);
    } else {
      const db=diagFmt==='guitar'?GDB:UDB;
      const ns=diagFmt==='guitar'?6:4;
      const voicings=lookupChord(rootSemi,typeObj.en,db);
      if(!voicings||voicings.length===0){
        wrap.innerHTML=`<div style="color:var(--brown-light);font-size:0.8rem;padding:8px 0">Sin diagrama disponible.</div>`;
      } else {
        wrap.appendChild(renderVoicingCard(voicings[0],ns));
        if(voicings.length>1){
          const count=voicings.length-1;
          const toggleBtn=document.createElement('button');
          toggleBtn.className='voicings-toggle-btn';
          toggleBtn.textContent=`▾ ${count} ${count>1?'posiciones':'posición'} más`;
          wrap.appendChild(toggleBtn);
          const extraWrap=document.createElement('div');
          extraWrap.className='chord-extra-voicings hidden';
          for(let i=1;i<voicings.length;i++) extraWrap.appendChild(renderVoicingCard(voicings[i],ns));
          wrap.appendChild(extraWrap);
          toggleBtn.addEventListener('click',()=>{
            const hidden=extraWrap.classList.toggle('hidden');
            toggleBtn.textContent=hidden
              ?`▾ ${count} ${count>1?'posiciones':'posición'} más`
              :'▴ Ocultar posiciones';
          });
        }
      }
    }
    $('chordDiagsSection').classList.remove('hidden');
  }

  function doDetect(){
    const semis=notaSlots.map(s=>noteToSemi(s.n)).filter(s=>s!==null);
    const results=detectChords(semis);
    const chips=$('chordResultChips');
    chips.innerHTML='';
    if(!results.length){
      chips.innerHTML='<span style="color:var(--brown-light);font-size:0.8rem">No se reconoció ningún acorde.</span>';
    } else {
      results.forEach(res=>{
        const chip=document.createElement('button'); chip.className='acorde-chip';
        chip.innerHTML=`<b>${res.nameEs}</b> <span style="opacity:.65">(${res.nameEn})</span>`;
        chip.addEventListener('click',()=>{
          chips.querySelectorAll('.acorde-chip').forEach(c=>c.classList.remove('sel'));
          chip.classList.add('sel');
          showDiagrams(res.r,res.t);
        });
        chips.appendChild(chip);
      });
      chips.querySelector('.acorde-chip').click();
    }
    $('chordResultBox').classList.remove('hidden');
  }

  let builderRoot = 0;
  let builderType = CT[0];

  function doSearchByBuilder(){
    const notes=getChordNotes(builderRoot,builderType);
    $('chordNoteLabel').textContent=`${NES[builderRoot]} ${builderType.es} (${NEN[builderRoot]}${builderType.en}):`;
    $('chordNoteChips').innerHTML=notes.map(n=>`<span class="chord-note-chip">${n}</span>`).join('');
    $('chordNoteBox').classList.remove('hidden');
    showDiagrams(builderRoot,builderType);
  }

  function renderChordBuilder(){
    const rootRow=$('rootNoteRow');
    const typeRow=$('chordTypeRow');
    rootRow.innerHTML='';
    typeRow.innerHTML='';
    NES.forEach((n,i)=>{
      const b=document.createElement('button');
      b.className='chord-sel-btn'+(i===builderRoot?' sel':'');
      b.textContent=n;
      b.addEventListener('click',()=>{
        builderRoot=i;
        rootRow.querySelectorAll('.chord-sel-btn').forEach((el,j)=>el.classList.toggle('sel',j===i));
        doSearchByBuilder();
      });
      rootRow.appendChild(b);
    });
    const typeLabel=t=>t.es==='mayor'?'Mayor':t.es==='m maj7'?'mMaj7':t.es;
    CT.forEach((t,i)=>{
      const b=document.createElement('button');
      b.className='chord-sel-btn'+(t===builderType?' sel':'');
      b.textContent=typeLabel(t);
      b.addEventListener('click',()=>{
        builderType=t;
        typeRow.querySelectorAll('.chord-sel-btn').forEach((el,j)=>el.classList.toggle('sel',j===i));
        doSearchByBuilder();
      });
      typeRow.appendChild(b);
    });
  }

  // Init
  $('btnAcordes').addEventListener('click',()=>{
    const p=$('acordesPanel');
    const open=!p.classList.contains('hidden');
    p.classList.toggle('hidden',open);
    $('btnAcordes').classList.toggle('active',!open);
    if(!open) renderSlots();
  });

  $('tabNotasAcorde').addEventListener('click',()=>{
    $('tabNotasAcorde').classList.add('active'); $('tabAcordeNotas').classList.remove('active');
    $('panelNotasAcorde').classList.remove('hidden'); $('panelAcordeNotas').classList.add('hidden');
  });
  $('tabAcordeNotas').addEventListener('click',()=>{
    $('tabAcordeNotas').classList.add('active'); $('tabNotasAcorde').classList.remove('active');
    $('panelAcordeNotas').classList.remove('hidden'); $('panelNotasAcorde').classList.add('hidden');
    doSearchByBuilder();
  });

  $('addNotaBtn').addEventListener('click',()=>{
    if(notaSlots.length<8){ notaSlots.push({n:'Do',o:'4'}); renderSlots(); }
  });
  $('detectChordBtn').addEventListener('click', doDetect);

  document.querySelectorAll('.diag-fmt-tab').forEach(tab=>{
    tab.addEventListener('click',()=>{
      document.querySelectorAll('.diag-fmt-tab').forEach(t=>t.classList.remove('active'));
      tab.classList.add('active');
      diagFmt=tab.dataset.fmt;
      if(selChord) showDiagrams(selChord.rootSemi,selChord.type);
    });
  });

  renderSlots();
  renderChordBuilder();
})();

// Revisar si hay una sesión guardada de una visita anterior
checkForSavedSession();
