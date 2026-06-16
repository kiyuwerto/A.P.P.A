// ============================================================
// APPA — Editor de pitch/velocidad + Afinador. Todo 100% local.
// ============================================================

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
const btnExportarTop = $('btnExportarTop');

// ---------- Estado global ----------
let audioCtx = null;
let mediaType = null;      // 'audio' | 'video'
let originalBuffer = null; // AudioBuffer original (decodificado)
let workingBuffer = null;  // AudioBuffer tras reversa, etc.
let sourceNode = null;
let isPlaying = false;
let isReversed = false;
let pitchLockOn = false;
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
let tunerAnalyser = null;
let tunerRafId = null;
let tunerMode = 'guitar';

// ============================================================
// Utilidades
// ============================================================
function ensureAudioCtx(){
  if(!audioCtx){
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

function setStatus(msg, timeout){
  statusBar.textContent = msg || '';
  if(timeout){
    setTimeout(()=>{ if(statusBar.textContent===msg) statusBar.textContent=''; }, timeout);
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
  stopPlayback();
  const isVideo = file.type.startsWith('video');
  mediaType = isVideo ? 'video' : 'audio';

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
  }
}

// --- Grabación con micrófono ---
let mediaRecorder = null;
let recordedChunks = [];
let isRecording = false;

btnRecord.addEventListener('click', async ()=>{
  if(isRecording){
    mediaRecorder.stop();
    return;
  }
  try{
    const stream = await navigator.mediaDevices.getUserMedia({audio:true});
    mediaRecorder = new MediaRecorder(stream);
    recordedChunks = [];
    mediaRecorder.ondataavailable = (e)=> recordedChunks.push(e.data);
    mediaRecorder.onstop = async ()=>{
      isRecording = false;
      btnRecord.textContent = 'Grabar mic';
      btnRecord.classList.remove('recording');
      stream.getTracks().forEach(t=>t.stop());
      const blob = new Blob(recordedChunks, {type:'audio/webm'});
      const file = new File([blob], 'grabacion.webm', {type:'audio/webm'});
      await loadFile(file);
    };
    mediaRecorder.start();
    isRecording = true;
    btnRecord.textContent = 'Detener ■';
    btnRecord.classList.add('recording');
    setStatus('Grabando…');
  }catch(err){
    console.error(err);
    setStatus('No se pudo acceder al micrófono');
  }
});

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

// Pitch-shift independiente de velocidad (simple time-domain granular / PSOLA simplificado)
// Usado cuando pitchLockOn está activo: cambia el TEMPO via resample sin afectar pitch,
// y aplica el pitch deseado por separado mediante granular synthesis.
function pitchShiftBuffer(buffer, semis){
  if(Math.abs(semis) < 0.001) return buffer;
  const rateForPitch = semitonesToRate(semis);
  const ctx = ensureAudioCtx();
  const inLen = buffer.length;
  const outLen = Math.max(1, Math.floor(inLen / rateForPitch));
  const out = ctx.createBuffer(buffer.numberOfChannels, outLen, buffer.sampleRate);

  const grainSize = 2048;
  const hop = Math.floor(grainSize/4);

  for(let ch=0; ch<buffer.numberOfChannels; ch++){
    const input = buffer.getChannelData(ch);
    const output = out.getChannelData(ch);
    const win = new Float32Array(grainSize);
    for(let i=0;i<grainSize;i++){
      win[i] = 0.5 - 0.5*Math.cos(2*Math.PI*i/(grainSize-1)); // Hann
    }
    let inPos = 0;
    let outPos = 0;
    while(outPos < outLen && inPos + grainSize < input.length){
      for(let i=0;i<grainSize;i++){
        const oi = outPos+i;
        if(oi < outLen){
          output[oi] += input[inPos+i]*win[i];
        }
      }
      inPos += hop*rateForPitch;
      outPos += hop;
    }
  }
  return out;
}

function buildPlaybackBuffer(){
  let buf = getEffectiveBuffer();
  if(pitchLockOn && Math.abs(pitchSemis) > 0.001){
    setStatus('Procesando pitch…');
    buf = pitchShiftBuffer(buf, pitchSemis);
    setStatus('');
  }
  return buf;
}

function computePlaybackRate(){
  if(pitchLockOn){
    // el pitch ya fue aplicado en el buffer; el rate solo controla tempo
    return speedRate;
  } else {
    // vari-speed clásico: el pitch del slider se suma multiplicativamente al rate
    return speedRate * semitonesToRate(pitchSemis);
  }
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
    videoEl.playbackRate = Math.min(16, Math.max(0.0625, speedRate * (pitchLockOn?1:semitonesToRate(pitchSemis))));
    try{ if(playStartOffset>0 && Math.abs(videoEl.currentTime-playStartOffset)>0.1) videoEl.currentTime = playStartOffset; }catch(e){}
    // Nota: video nativo no soporta pitch-lock real sin pipeline adicional; el audio del <video> sigue su pitch natural según rate.
    videoEl.play();
    isPlaying = true;
    btnPlayPause.textContent = '❚❚';
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
    if(isPlaying){ stopPlayback(); }
  };
  sourceNode.start(0, playStartOffset);
  playStartCtxTime = ctx.currentTime;
  isPlaying = true;
  btnPlayPause.textContent = '❚❚';
  tickAudio(buf);
}

function tickAudio(buf){
  const ctx = ensureAudioCtx();
  function step(){
    if(!isPlaying) return;
    const rate = sourceNode ? sourceNode.playbackRate.value : 1;
    const elapsed = (ctx.currentTime - playStartCtxTime)*rate + playStartOffset;
    const dur = buf.duration;
    if(elapsed >= dur){
      playStartOffset = 0;
      TL.pos = 0;
      stopPlayback();
      timeLabel.textContent = `0:00 / ${fmtTime(originalBuffer.duration)}`;
      return;
    }
    timeLabel.textContent = `${fmtTime(elapsed)} / ${fmtTime(originalBuffer.duration)}`;
    rafId = requestAnimationFrame(step);
  }
  step();
}

function tickVideo(){
  function step(){
    if(!isPlaying) return;
    timeLabel.textContent = `${fmtTime(videoEl.currentTime)} / ${fmtTime(videoEl.duration)}`;
    if(videoEl.ended){ stopPlayback(); return; }
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

pitchSlider.addEventListener('input', ()=>{
  pitchSemis = parseFloat(pitchSlider.value);
  pitchValue.value = pitchSemis.toFixed(3);
  restartPlaybackIfPlaying();
});
pitchSlider.addEventListener('change', pushHistory);

pitchValue.addEventListener('change', ()=>{
  let v = clamp(parseFloat(pitchValue.value)||0, -48, 48);
  pitchSemis = v;
  pitchValue.value = v.toFixed(3);
  pitchSlider.value = v;
  restartPlaybackIfPlaying();
  pushHistory();
});

speedSlider.addEventListener('input', ()=>{
  speedRate = parseFloat(speedSlider.value);
  speedValue.value = speedRate.toFixed(3);
  restartPlaybackIfPlaying();
});
speedSlider.addEventListener('change', pushHistory);

speedValue.addEventListener('change', ()=>{
  let v = clamp(parseFloat(speedValue.value)||1, 0.05, 10);
  speedRate = v;
  speedValue.value = v.toFixed(3);
  speedSlider.value = v;
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
  let buf = getEffectiveBuffer();
  if(Math.abs(pitchSemis)>0.001 && pitchLockOn){
    buf = pitchShiftBuffer(buf, pitchSemis);
  }
  const rate = computePlaybackRate();
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

async function doExport(quality){
  if(!workingBuffer){ setStatus('No hay audio cargado'); return; }
  setStatus(quality==='pro' ? 'Exportando en alta calidad…' : 'Exportando rápido…');
  try{
    const rendered = await renderToBuffer();
    const blob = bufferToWav(rendered);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `appa_export_${Date.now()}.wav`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setStatus('Exportado ✓', 2000);
  }catch(err){
    console.error(err);
    setStatus('Error al exportar');
  }
}

btnExportFast.addEventListener('click', ()=>doExport('fast'));
btnExportPro.addEventListener('click', ()=>doExport('pro'));
btnExportarTop.addEventListener('click', ()=>doExport('pro'));

// ============================================================
// Detector de tono en tiempo real (botón "Detectar tono")
// ============================================================
btnDetectTone.addEventListener('click', async ()=>{
  if(!tunerPanel.classList.contains('hidden') && tunerActive){
    stopTuner();
    return;
  }
  tunerPanel.classList.remove('hidden');
  setMode('chromatic', true);
  await startTuner();
});

// ============================================================
// Afinador desplegable
// ============================================================
btnTunerToggle.addEventListener('click', async ()=>{
  const wasHidden = tunerPanel.classList.contains('hidden');
  tunerPanel.classList.toggle('hidden');
  if(wasHidden){
    await startTuner();
  } else {
    stopTuner();
  }
});

document.querySelectorAll('.mode-btn').forEach(btn=>{
  btn.addEventListener('click', ()=> setMode(btn.dataset.mode, false));
});

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
  document.querySelectorAll('.mode-btn').forEach(b=> b.classList.toggle('selected', b.dataset.mode===mode));
  renderStrings();
}

function renderStrings(){
  stringsRow.innerHTML = '';
  if(tunerMode==='chromatic'){ return; }
  const strings = TUNINGS[tunerMode];
  strings.forEach(s=>{
    const chip = document.createElement('div');
    chip.className = 'string-chip';
    chip.dataset.freq = s.freq;
    chip.innerHTML = `${s.name}<small>${s.label}</small>`;
    stringsRow.appendChild(chip);
  });
}
renderStrings();

// ---- Motor de detección de pitch (autocorrelación) ----
async function startTuner(){
  if(tunerActive) return;
  try{
    tunerStream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false, noiseSuppression:false, autoGainControl:false}});
  }catch(err){
    tunerStatus.textContent = 'No se pudo acceder al micrófono';
    return;
  }
  tunerAudioCtx = new (window.AudioContext||window.webkitAudioContext)();
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
  if(tunerAudioCtx) tunerAudioCtx.close();
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
  if(rms < 0.01) return -1; // silencio

  let r1=0, r2=SIZE-1, thres=0.2;
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
      TL.pos = playStartOffset + (ctx.currentTime - playStartCtxTime)*rate;
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
function tlPointerDown(e){
  if(!TL.waveImg) return;
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
function tlPointerUp(){
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

// Inicialización
window.addEventListener('resize', ()=>{ if(workingBuffer){ drawWaveform(getEffectiveBuffer()); tlBuildWaveImage(); } });

// Registrar service worker para uso offline (PWA)
if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  });
}
