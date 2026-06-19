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

// ---------- Estado global ----------
let audioCtx = null;
let mediaType = null;      // 'audio' | 'video'
let originalBuffer = null; // AudioBuffer original (decodificado)
let workingBuffer = null;  // AudioBuffer tras reversa, etc.
let originalVideoFile = null; // File original si se cargó un video (para exportar con ffmpeg)
let sourceNode = null;
let isPlaying = false;
let isReversed = false;
let pitchLockOn = false;
let loopEnabled = false;
let trimMode = false;
let trimStart = 0;   // segundos (audio original)
let trimEnd = 0;     // segundos
let rafId = null;

let pitchSemis = 0;     // -48..48
let speedRate = 1.0;    // 0.05..10

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
  pitchSemis = state.pitchSemis;
  speedRate = state.speedRate;
  pitchLockOn = state.pitchLockOn;
  isReversed = state.isReversed;
  pitchSlider.value = pitchSemis;
  pitchValue.value = pitchSemis.toFixed(3);
  speedSlider.value = speedRate;
  speedValue.value = speedRate.toFixed(3);
  btnPitchLock.classList.toggle('active', pitchLockOn);
  restartPlaybackIfPlaying();
  updatePitchLockHint();
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

  const url = URL.createObjectURL(file);

  if(isVideo){
    videoEl.src = url;
    videoEl.classList.remove('hidden');
    waveCanvas.classList.add('hidden');
    placeholderText.classList.add('hidden');
    videoEl.onloadedmetadata = ()=>{
      previewControls.classList.remove('hidden');
      timeLabel.textContent = `0:00 / ${fmtTime(videoEl.duration)}`;
    };
  } else {
    videoEl.classList.add('hidden');
    waveCanvas.classList.remove('hidden');
    placeholderText.classList.add('hidden');
    previewControls.classList.remove('hidden');
  }

  // Decodificar audio (de video o audio) para procesar pitch/speed
  try{
    const arrayBuf = await file.arrayBuffer();
    const ctx = ensureAudioCtx();
    originalBuffer = await ctx.decodeAudioData(arrayBuf.slice(0));
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
      videoEl.classList.add('hidden');
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

  // dibujar la onda acumulada, desplazándose tipo "rolling" en el preview y timeline
  drawRollingWave(waveCanvas, previewBox, recWaveform);
  drawRollingWave(tlCanvas, timeline, recWaveform, true);

  // actualizar contador de tiempo
  const elapsed = (performance.now() - recStartTime)/1000;
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
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--white').trim() || '#fdf3e3';

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
$('btnClearAll').addEventListener('click', ()=>{
  if(!workingBuffer && !originalBuffer){ setStatus('No hay nada que limpiar', 1500); return; }
  $('confirmClearDialog').classList.remove('hidden');
});

$('confirmClearNo').addEventListener('click', ()=>{
  $('confirmClearDialog').classList.add('hidden');
});
$('confirmClearYes').addEventListener('click', ()=>{
  $('confirmClearDialog').classList.add('hidden');
  doClearAll();
});
$('confirmClearDialog').addEventListener('click', (e)=>{
  if(e.target.id === 'confirmClearDialog') $('confirmClearDialog').classList.add('hidden');
});

function doClearAll(){
  stopPlayback();
  originalBuffer = null;
  workingBuffer = null;
  originalVideoFile = null;
  reversedCache = null; reversedCacheSrc = null;
  mediaType = null;
  isReversed = false;
  pitchLockOn = false;
  loopEnabled = false;
  trimMode = false;
  pitchSemis = 0;
  speedRate = 1.0;
  playStartOffset = 0;
  history = []; historyIndex = -1;
  updateUndoRedoButtons();

  pitchSlider.value = 0; pitchValue.value = '0.000';
  speedSlider.value = 1; speedValue.value = '1.000';
  btnReverse.classList.remove('active');
  btnPitchLock.classList.remove('active');
  btnLoop.classList.remove('active');
  btnTrim.classList.remove('active');
  trimPanel.classList.add('hidden');
  clearTrimMarkers();

  videoEl.src = '';
  videoEl.classList.add('hidden');
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
  ctx.fillStyle = '#fdf3e3';
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

function stopPlayback(){
  if(sourceNode){
    try{ sourceNode.stop(); }catch(e){}
    sourceNode.disconnect();
    sourceNode = null;
  }
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
    if(pitchLockOn && workingBuffer){
      // video solo muestra imagen (sin sonido), a la velocidad pura de speedRate
      videoEl.muted = true;
      videoEl.playbackRate = Math.min(16, Math.max(0.0625, speedRate));
      try{ if(playStartOffset>0 && Math.abs(videoEl.currentTime-playStartOffset)>0.1) videoEl.currentTime = playStartOffset; }catch(e){}

      // audio procesado en paralelo (pitch fijo, tempo = speedRate)
      const buf = buildPlaybackBufferForVideo();
      sourceNode = ctx.createBufferSource();
      sourceNode.buffer = buf;
      sourceNode.playbackRate.value = 1.0; // el pitch y tempo ya están en el buffer
      sourceNode.connect(ctx.destination);
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
      videoEl.play();
      isPlaying = true;
      btnPlayPause.textContent = '❚❚';
      updateAppaAnimation();
      tickVideo();
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
  sourceNode.connect(ctx.destination);
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
    if(mediaType==='audio'){
      // guardamos offset actual
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
});

speedSlider.addEventListener('input', ()=>{
  speedRate = parseFloat(speedSlider.value);
  speedValue.value = speedRate.toFixed(3);
  if(!pitchLockOn) updatePlaybackRateLive();
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
  });
});

$('pitchZeroBtn').addEventListener('click', ()=>{
  pitchSemis = 0;
  pitchValue.value = '0.000';
  pitchSlider.value = 0;
  restartPlaybackIfPlaying();
  pushHistory();
  updatePitchLockHint();
});

$('speedZeroBtn').addEventListener('click', ()=>{
  speedRate = 1;
  speedValue.value = '1.000';
  speedSlider.value = 1;
  restartPlaybackIfPlaying();
  pushHistory();
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
  restartPlaybackIfPlaying();
  pushHistory();
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

// Exporta el VIDEO completo con el audio ya procesado (pitch/velocidad/reversa)
// reemplazando su pista de audio original. Si el video tiene reversa activada,
// también se invierten los frames de video (operación más pesada).
async function exportVideoWithFfmpeg(){
  if(!originalVideoFile){ setStatus('Esto requiere haber subido un video', 2500); return; }
  $('exportDialog').classList.add('hidden');
  showFfmpegProgress(true, 'Cargando motor de video (puede tardar la primera vez)…');
  setStatus('Preparando exportación de video…');

  try{
    const ff = await getFfmpeg();

    // 1) renderizar el audio procesado con pitch independiente (igual que la reproducción de video)
    showFfmpegProgress(true, 'Procesando audio…');
    const renderedAudio = await renderToBufferForVideo();
    const wavBlob = bufferToWav(renderedAudio);
    const wavData = new Uint8Array(await wavBlob.arrayBuffer());

    // 2) escribir el video original y el audio nuevo al sistema de archivos virtual
    const videoData = new Uint8Array(await originalVideoFile.arrayBuffer());
    const inName = 'input_video.' + (originalVideoFile.name.split('.').pop() || 'mp4');
    await ff.writeFile(inName, videoData);
    await ff.writeFile('new_audio.wav', wavData);

    // 3) filtros de video: reversa si aplica, y ajuste de velocidad visual.
    // El audio nuevo ya dura (duración_original / speedRate) porque se procesó con
    // tempo=speedRate, así que el video debe acelerarse/desacelerarse por speedRate.
    const videoFilters = [];
    if(isReversed) videoFilters.push('reverse');
    if(Math.abs(speedRate - 1) > 0.01){
      // setpts=PTS/speedRate: speedRate=2 => video al doble de rápido
      videoFilters.push(`setpts=PTS/${speedRate}`);
    }
    const vf = videoFilters.length ? videoFilters.join(',') : null;

    showFfmpegProgress(true, 'Recodificando video (esto puede tardar varios minutos)…');
    const args = ['-i', inName, '-i', 'new_audio.wav'];
    if(vf) args.push('-vf', vf);
    args.push('-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '192k', '-shortest', 'output.mp4');
    await ff.exec(args);

    const data = await ff.readFile('output.mp4');
    const blob = new Blob([data.buffer], {type:'video/mp4'});
    const filename = `appa_video_${Date.now()}.mp4`;
    triggerDownload(blob, filename);
    addToExportLog(filename, 'MP4 (video + audio editado)', renderedAudio.duration);
    renderExportLog();
    setStatus('Video exportado ✓', 2500);

    await ff.deleteFile(inName).catch(()=>{});
    await ff.deleteFile('new_audio.wav').catch(()=>{});
    await ff.deleteFile('output.mp4').catch(()=>{});
  }catch(err){
    console.error(err);
    setStatus('Error al exportar video. Revisa la consola.');
  } finally {
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

  const noteCounts = {};
  const detectedFreqs = [];
  let analyzed = 0;

  for(let start=0; start + windowSize < data.length; start += step){
    const slice = data.slice(start, start + windowSize);
    const freq = autoCorrelate(slice, sr);
    if(freq > 40 && freq < 2000 && isFinite(freq)){
      detectedFreqs.push(freq);
      const {name, octave} = freqToNote(freq);
      const key = name + octave;
      noteCounts[key] = (noteCounts[key]||0) + 1;
      analyzed++;
    }
  }

  if(analyzed === 0){
    tunerNote.textContent = '—';
    tunerFreq.textContent = 'Sin tono claro';
    tunerStatus.textContent = 'No se detectó una nota definida (¿voz/ruido?)';
    tunerNeedle.style.left = '50%';
    stringsRow.innerHTML = '';
    return;
  }

  // nota predominante
  let topNote = null, topCount = 0;
  for(const k in noteCounts){ if(noteCounts[k] > topCount){ topCount = noteCounts[k]; topNote = k; } }

  // frecuencia mediana de las detecciones (más robusta que el promedio)
  detectedFreqs.sort((a,b)=>a-b);
  const medianFreq = detectedFreqs[Math.floor(detectedFreqs.length/2)];
  const {name, octave, cents} = freqToNote(medianFreq);

  tunerNote.textContent = topNote;
  tunerFreq.textContent = `${medianFreq.toFixed(1)} Hz (mediana)`;
  tunerStatus.textContent = `Nota predominante en el audio · ${analyzed} muestras`;

  // posición de la aguja según afinación de la nota mediana
  const pct = clamp(50 + cents/50*50, 0, 100);
  tunerNeedle.style.left = pct + '%';
  tunerNeedle.style.background = Math.abs(cents)<15 ? 'var(--green)' : 'var(--white)';

  // mostrar top 3 notas detectadas como chips
  const sorted = Object.entries(noteCounts).sort((a,b)=>b[1]-a[1]).slice(0,3);
  stringsRow.innerHTML = '';
  sorted.forEach(([note,count])=>{
    const pctg = Math.round(count/analyzed*100);
    const chip = document.createElement('div');
    chip.className = 'string-chip';
    chip.innerHTML = `${note}<small>${pctg}%</small>`;
    stringsRow.appendChild(chip);
  });
}

// ============================================================
// Afinador EN TIEMPO REAL con micrófono (botón "Afinador")
// ============================================================
function syncTunerBtn(){
  const open = !tunerPanel.classList.contains('hidden') && tunerMode !== 'audiofile';
  btnTunerToggle.classList.toggle('active', open);
  btnTunerToggle.innerHTML = open ? 'Afinador &#9650;' : 'Afinador &#9660;';
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

const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
function freqToNote(freq){
  const noteNum = 12*(Math.log2(freq/440)) + 69;
  const rounded = Math.round(noteNum);
  const name = NOTE_NAMES[((rounded%12)+12)%12];
  const octave = Math.floor(rounded/12)-1;
  const exactFreq = 440*Math.pow(2,(rounded-69)/12);
  const cents = 1200*Math.log2(freq/exactFreq);
  return {name, octave, cents, exactFreq};
}

function loopTuner(){
  if(!tunerActive) return;
  const buf = new Float32Array(tunerAnalyser.fftSize);
  tunerAnalyser.getFloatTimeDomainData(buf);
  const freq = autoCorrelate(buf, tunerAudioCtx.sampleRate);

  if(freq===-1 || !isFinite(freq) || freq<40 || freq>1500){
    tunerStatus.textContent = 'Esperando sonido…';
  } else {
    const {name, octave, cents} = freqToNote(freq);
    tunerNote.textContent = `${name}${octave}`;
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
  ctx.fillStyle = '#fdf3e3';
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

  // velo semitransparente sobre la parte ya reproducida (izquierda del centro)
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(0, 0, centerX, h);
}

let tlRaf = null;
function tlAnimate(){
  // sincroniza TL.pos con la reproducción real
  if(isPlaying && !TL.dragging){
    if(mediaType==='video'){
      TL.pos = videoEl.currentTime;
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
    if(TL.pos > dur) TL.pos = dur;
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

  const map = {
    '--cream': creamHex, '--cream-2': cream2,
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

$('appaMenuBtn').addEventListener('click', ()=>{
  applyColors(colorBrown, colorCream); // sincroniza swatches/pickers con el estado actual
  renderExportLog();
  appaMenu.classList.remove('hidden');
});
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
  const newLen = endSample - startSample;
  if(newLen <= 0){ setStatus('Rango de recorte inválido'); return; }

  const ctx = ensureAudioCtx();
  const trimmed = ctx.createBuffer(src.numberOfChannels, newLen, sr);
  for(let ch=0; ch<src.numberOfChannels; ch++){
    const from = src.getChannelData(ch).subarray(startSample, endSample);
    trimmed.getChannelData(ch).set(from);
  }
  // el recorte se vuelve el nuevo audio base
  originalBuffer = trimmed;
  workingBuffer = trimmed;
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
  setStatus('Audio recortado ✓', 2000);
  pushHistory();
});

function drawTrimMarkers(){
  clearTrimMarkers();
  if(!trimMode) return;
  const dur = getEffectiveBuffer().duration;
  const rect = timeline.getBoundingClientRect();
  const w = rect.width;
  const centerX = w/2;
  // Los marcadores se posicionan relativos a la ventana visible centrada en TL.pos.
  // Como el timeline hace scroll, los dibujamos como overlay fijo proporcional simple:
  // marca de inicio y fin como porcentaje del total, en una mini-barra superpuesta.
  const startPct = (trimStart/dur)*100;
  const endPct = (trimEnd/dur)*100;
  const region = document.createElement('div');
  region.className = 'trim-region';
  region.style.left = startPct + '%';
  region.style.width = (endPct-startPct) + '%';
  region.dataset.trim = '1';
  timeline.appendChild(region);
  ['start','end'].forEach((which)=>{
    const m = document.createElement('div');
    m.className = 'trim-marker';
    m.style.left = (which==='start'?startPct:endPct) + '%';
    m.dataset.trim = '1';
    timeline.appendChild(m);
  });
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
        const freq = autoCorrelate(slice, sr);
        if(freq > 40 && freq < 2000 && isFinite(freq)){
          const {name, octave, cents} = freqToNote(freq);
          tunerNote.textContent = name + octave;
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

  // Mic: solo banneramos si está explícitamente denegado
  try{
    const perm = await navigator.permissions.query({name:'microphone'});
    if(perm.state === 'denied') needsMic = true;
    // Escuchar cambios futuros (ej: el usuario revoca el permiso desde ajustes)
    perm.onchange = ()=> checkAndShowPermBanner();
  }catch(e){ /* Safari no soporta permissions.query para mic, ignorar */ }

  // Audio/parlante: AudioContext suspendido con audio cargado = no puede reproducir
  if(audioCtx && audioCtx.state === 'suspended' && workingBuffer) needsAudio = true;

  permBanner.classList.toggle('hidden', !(needsMic || needsAudio));
}

$('btnActivatePerm').addEventListener('click', async ()=>{
  try{
    // Reanudar AudioContext (parlante)
    if(audioCtx && audioCtx.state === 'suspended') await audioCtx.resume();
    // Pedir acceso al micrófono
    const stream = await navigator.mediaDevices.getUserMedia({audio:true});
    stream.getTracks().forEach(t=> t.stop()); // solo queríamos el permiso
    // Éxito: ocultar banner y explotar caritas en toda la pantalla
    permBanner.classList.add('hidden');
    triggerAppaExplosionScreen();
  }catch(err){
    setStatus('No se pudo obtener acceso. Revisá los permisos del dispositivo.', 3500);
  }
});

function triggerAppaExplosionScreen(){
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;
  const count = 22;
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

// Revisar si hay una sesión guardada de una visita anterior
checkForSavedSession();
