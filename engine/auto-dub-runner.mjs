import http from 'http';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

const PORT = Number(process.env.PORT || 4567);
const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_SPEECH_TEMPO = 1.0;
const DEFAULT_GENDER = 'male';
const DEFAULT_PITCH = 0;
const DEFAULT_LANG = 'my';
const TTS_CONCURRENCY = 8;
const TRANSLATE_CONCURRENCY = 8;

function normalizeSpeechTempo(rawSpeed) {
  const num = Number(rawSpeed);
  if (!Number.isFinite(num)) return DEFAULT_SPEECH_TEMPO;
  return Number(Math.max(0.8, Math.min(1.25, num)).toFixed(2));
}

function normalizePitchShift(rawPitch) {
  const num = Number(rawPitch);
  if (!Number.isFinite(num)) return DEFAULT_PITCH;
  return Math.max(-12, Math.min(12, Math.round(num)));
}

function normalizeLanguage(rawLang) {
  const l = String(rawLang || DEFAULT_LANG).toLowerCase().trim();
  return l === 'en' || l === 'english' ? 'en' : 'my';
}

const workspaceDir = path.resolve(process.cwd(), 'workspace');
const uploadsDir = path.join(workspaceDir, 'uploads');
const distDir = path.resolve(process.cwd(), 'dist');
fs.mkdirSync(uploadsDir, { recursive: true });

const translationCache = new Map();

function toFfmpegPath(p) {
  return path.resolve(p).replace(/\\/g, '/');
}

function getBackendOrigin(req) {
  if (process.env.PUBLIC_URL) {
    return process.env.PUBLIC_URL.replace(/\/+$/, '');
  }
  const protoHeader = (req.headers['x-forwarded-proto'] || '').toString().split(',')[0].trim();
  const hostHeader = (req.headers['x-forwarded-host'] || req.headers.host || '').toString().split(',')[0].trim();
  if (hostHeader) {
    const isLocal = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(hostHeader);
    const scheme = protoHeader || (isLocal ? 'http' : 'https');
    return `${scheme}://${hostHeader}`;
  }
  return `http://localhost:${PORT}`;
}

function cleanupOldWorkspaceFiles(maxAgeMs = 15 * 60 * 1000) {
  const now = Date.now();
  for (const dir of [workspaceDir, uploadsDir]) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir)) {
        if (entry === 'uploads') continue;
        const full = path.join(dir, entry);
        const st = fs.statSync(full);
        if (now - st.mtimeMs > maxAgeMs) {
          fs.rmSync(full, { recursive: true, force: true });
        }
      }
    } catch {
      // Ignore
    }
  }
}

setInterval(() => cleanupOldWorkspaceFiles(), 10 * 60 * 1000);

function runCmd(cmd, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 256, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || 'Command failed').trim();
        console.error('[KKH CMD ERROR]', msg.slice(-200));
        return reject(new Error(msg));
      }
      resolve({ stdout, stderr });
    });
  });
}

function writeSilentWavFallback(outWavPath, durationSec = 0.8) {
  const sampleRate = 44100;
  const numChannels = 2;
  const bitsPerSample = 16;
  const numSamples = Math.max(1000, Math.round(sampleRate * Math.max(0.3, durationSec)));
  const dataSize = numSamples * numChannels * (bitsPerSample / 8);
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28);
  buf.writeUInt16LE(numChannels * (bitsPerSample / 8), 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);

  fs.writeFileSync(outWavPath, buf);
}

async function createSafeSilentWav(outWavPath, durationSec = 0.8) {
  const safeDur = Math.max(0.4, Math.min(2.0, Number(durationSec) || 0.8));
  try {
    await runCmd(
      `ffmpeg -y -f lavfi -i "anullsrc=r=44100:cl=stereo" -t ${safeDur.toFixed(2)} -c:a pcm_s16le "${toFfmpegPath(outWavPath)}"`,
      5000
    );
    if (hasValidAudioFile(outWavPath, 200)) return;
  } catch {
    // Fall through to raw WAV writer
  }
  writeSilentWavFallback(outWavPath, safeDur);
}

function hasValidAudioFile(filePath, minBytes = 250) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).size >= minBytes;
  } catch {
    return false;
  }
}

async function hasAudioStream(filePath) {
  if (!hasValidAudioFile(filePath, 250)) return false;
  try {
    const fp = toFfmpegPath(filePath);
    const { stdout } = await runCmd(
      `ffprobe -v error -select_streams a:0 -show_entries stream=codec_type -of default=noprint_wrappers=1:nokey=1 "${fp}"`,
      3000
    );
    return stdout.trim().includes('audio');
  } catch {
    return false;
  }
}

async function getMediaDurationSec(filePath) {
  const fp = toFfmpegPath(filePath);
  try {
    const cmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${fp}"`;
    const { stdout } = await runCmd(cmd, 3000);
    const val = parseFloat(stdout.trim());
    if (!Number.isNaN(val) && val > 0.05) return val;
  } catch {
    // Fallback
  }
  return 0;
}

async function getVideoDimensions(filePath) {
  const fp = toFfmpegPath(filePath);
  try {
    const cmd = `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${fp}"`;
    const { stdout } = await runCmd(cmd, 3000);
    const parts = stdout.trim().split('x').map((n) => parseInt(n, 10));
    if (parts.length === 2 && parts[0] > 0 && parts[1] > 0) {
      return { width: parts[0], height: parts[1] };
    }
  } catch {
    // Fallback
  }
  return { width: 1280, height: 720 };
}

async function getVideoDurationSec(filePath) {
  const d = await getMediaDurationSec(filePath);
  return d > 0 ? d : 10;
}

async function probeMediaStreams(filePath) {
  const info = {
    exists: fs.existsSync(filePath),
    sizeBytes: 0,
    sizeMB: 0,
    durationSec: 0,
    width: 0,
    height: 0,
    hasVideoStream: false,
    hasAudioStream: false,
    videoCodec: '',
    audioCodec: ''
  };
  if (!info.exists) return info;

  const st = fs.statSync(filePath);
  info.sizeBytes = st.size;
  info.sizeMB = Number((st.size / (1024 * 1024)).toFixed(2));
  info.durationSec = Number((await getMediaDurationSec(filePath)).toFixed(2));

  try {
    const fp = toFfmpegPath(filePath);
    const { stdout } = await runCmd(
      `ffprobe -v error -show_entries stream=codec_type,codec_name,width,height -of json "${fp}"`,
      3000
    );
    const parsed = JSON.parse(stdout || '{}');
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    for (const s of streams) {
      if (s.codec_type === 'video' && !info.hasVideoStream) {
        info.hasVideoStream = true;
        info.videoCodec = s.codec_name || 'video';
        info.width = Number(s.width || 0);
        info.height = Number(s.height || 0);
      }
      if (s.codec_type === 'audio' && !info.hasAudioStream) {
        info.hasAudioStream = true;
        info.audioCodec = s.codec_name || 'audio';
      }
    }
  } catch {
    // Ignore
  }

  return info;
}

async function runWithConcurrency(items, limit, workerFn) {
  const results = new Array(items.length);
  let idx = 0;

  async function next() {
    const current = idx++;
    if (current >= items.length) return;
    results[current] = await workerFn(items[current], current);
    await next();
  }

  const runners = Array.from({ length: Math.min(limit, items.length) }, () => next());
  await Promise.all(runners);
  return results;
}

function makeNaturalConversationalBurmese(rawBurmese, styleMode = 'pro_recap') {
  let s = (rawBurmese || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';

  s = s
    .replace(/\bသည်\b/g, 'တယ်')
    .replace(/\bဖြစ်သည်\b/g, 'ဖြစ်တယ်')
    .replace(/\bရှိသည်\b/g, 'ရှိတယ်')
    .replace(/\bသွားသည်\b/g, 'သွားတယ်')
    .replace(/\bလာသည်\b/g, 'လာတယ်')
    .replace(/\bပြောသည်\b/g, 'ပြောတယ်')
    .replace(/\bလုပ်သည်\b/g, 'လုပ်တယ်')
    .replace(/\bမည်ဖြစ်သည်\b/g, 'မှာပါ')
    .replace(/\bမည်\b(?=$|[။၊.!?\s])/g, 'မှာ')
    .replace(/([။၊])/g, '$1 ')
    .replace(/\s+/g, ' ')
    .trim();

  if (styleMode === 'pro_recap') {
    s = s.replace(/\s*([.!?]+)\s*/g, '$1 ');
  }

  return s.trim();
}

async function translateSingleChunk(chunkText, targetLang = 'my', styleMode = 'pro_recap') {
  const clean = (chunkText || '').trim().replace(/\s+/g, ' ');
  if (!clean) return '';

  const lang = normalizeLanguage(targetLang);
  const hasMyanmar = /[\u1000-\u109F]/.test(clean);
  const isMostlyAscii = /^[A-Za-z0-9\s.,!?;:'"()\-]+$/.test(clean);

  if (lang === 'my' && hasMyanmar && !isMostlyAscii) {
    return makeNaturalConversationalBurmese(clean, styleMode);
  }
  if (lang === 'en' && isMostlyAscii && !hasMyanmar) {
    return clean;
  }

  const cacheKey = `${lang}:${styleMode}:${clean.slice(0, 1200)}`;
  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey);
  }

  const endpoints = [
    `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${lang}&dt=t&q=${encodeURIComponent(clean)}`,
    `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=${lang}&q=${encodeURIComponent(clean)}`
  ];

  for (const url of endpoints) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1400);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      if (!res.ok) continue;
      const data = await res.json();

      let translated = '';
      if (Array.isArray(data?.[0])) {
        translated = data[0]
          .map((item) => (Array.isArray(item) && typeof item[0] === 'string' ? item[0] : ''))
          .join('')
          .trim();
      } else if (Array.isArray(data)) {
        translated = data
          .map((item) => (Array.isArray(item) ? item[0] : typeof item === 'string' ? item : ''))
          .filter(Boolean)
          .join(' ')
          .trim();
      }

      if (translated) {
        const result = lang === 'my' ? makeNaturalConversationalBurmese(translated, styleMode) : translated;
        translationCache.set(cacheKey, result);
        return result;
      }
    } catch {
      // Next
    } finally {
      clearTimeout(timer);
    }
  }

  return lang === 'my' ? makeNaturalConversationalBurmese(clean, styleMode) : clean;
}

async function prepareOnTimeSegments(manualText, durationSec, targetLang = 'my', styleMode = 'pro_recap') {
  const raw = (manualText || '').trim();
  if (!raw) return [];

  const rawUnits = raw
    .split(/\r?\n|(?<=[.!?。！？။၊।])\s*/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const groupedChunks = [];
  for (const unit of rawUnits) {
    if (unit.length <= 165) {
      groupedChunks.push(unit);
    } else {
      for (let i = 0; i < unit.length; i += 155) {
        const part = unit.slice(i, i + 155).trim();
        if (part) groupedChunks.push(part);
      }
    }
  }

  const spokenLines = await runWithConcurrency(groupedChunks, TRANSLATE_CONCURRENCY, async (chunk) =>
    translateSingleChunk(chunk, targetLang, styleMode)
  );

  const total = Math.max(2, durationSec);
  const count = Math.max(1, spokenLines.length);
  const slotSec = total / count;

  return spokenLines.map((line, idx) => {
    const startSec = Number((idx * slotSec).toFixed(2));
    const endSec = Number(Math.min(total, startSec + Math.max(0.75, slotSec * 0.96)).toFixed(2));
    return {
      index: idx,
      targetStartSec: startSec,
      endSec,
      availSec: Math.max(0.65, endSec - startSec),
      spokenText: line
    };
  });
}

async function fetchGoogleTtsMp3(text, lang = 'my', outMp3Path) {
  const tl = normalizeLanguage(lang);
  const snippet = (text || '...').trim().slice(0, 195);
  const endpoints = [
    `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(snippet)}&tl=${tl}&client=tw-ob`,
    `https://translate.googleapis.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(snippet)}&tl=${tl}&client=gtx`
  ];
  for (const url of endpoints) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1400);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length >= 250) {
        fs.writeFileSync(outMp3Path, buf);
        if (await hasAudioStream(outMp3Path)) {
          return true;
        }
        fs.rmSync(outMp3Path, { force: true });
      }
    } catch {
      // Next
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}

function clampAtempoValue(val) {
  return Number(Math.max(0.5, Math.min(2.0, Number(val) || 1.0)).toFixed(4));
}

function buildVoiceFilter(voiceId, speechSpeed, pitchShift, styleMode = 'pro_recap') {
  const normalizedId = String(voiceId || DEFAULT_GENDER).toLowerCase();
  const isFemale = normalizedId === 'female' || normalizedId === 'nilar';
  const userPitch = normalizePitchShift(pitchShift);

  const baseSemitones = isFemale ? 2.5 : -3.5;
  const totalSemitones = baseSemitones + userPitch;
  const pitchFactor = Number(Math.pow(2, totalSemitones / 12).toFixed(4));
  const safePitch = Math.max(0.55, Math.min(1.6, pitchFactor));

  const tempo = normalizeSpeechTempo(
    styleMode === 'pro_recap' ? Math.min(1.25, Number(speechSpeed || 1.0) * 1.03) : speechSpeed
  );

  const shiftedRate = Math.round(24000 * safePitch);
  const tempoCorrection = clampAtempoValue(tempo / safePitch);

  const eqChain = isFemale
    ? 'highpass=f=170,equalizer=f=2600:width_type=o:w=1.3:g=3.5,acompressor=threshold=-16dB:ratio=2.4:attack=10:release=100'
    : 'highpass=f=80,equalizer=f=130:width_type=o:w=1.4:g=5.0,lowpass=f=5200,acompressor=threshold=-16dB:ratio=2.4:attack=10:release=100';

  const outputGain = isFemale ? 1.85 : 2.1;

  return `aresample=24000,asetrate=${shiftedRate},aresample=44100,atempo=${tempoCorrection},${eqChain},volume=${outputGain}`;
}

async function synthesizeSingleSegmentWav(
  seg,
  voiceId,
  targetLang,
  segDir,
  speechSpeed,
  pitchShift,
  styleMode = 'pro_recap'
) {
  const safeText = (seg.spokenText || '...')
    .replace(/"/g, "'")
    .replace(/\r?\n/g, ' ')
    .trim()
    .slice(0, 600);

  const fittedWav = path.join(segDir, 'fitted.wav');
  const fittedFfmpeg = toFfmpegPath(fittedWav);
  const maxAllowedSec = Math.max(0.65, Number(seg.availSec) || 1.2);
  const fallbackSec = Math.max(0.6, Math.min(1.2, maxAllowedSec));

  try {
    const ttsMp3 = path.join(segDir, 'tts_out.mp3');
    const okTts = await fetchGoogleTtsMp3(safeText, targetLang, ttsMp3);
    if (okTts && (await hasAudioStream(ttsMp3))) {
      const audioFilter = buildVoiceFilter(voiceId, speechSpeed, pitchShift, styleMode);
      await runCmd(
        `ffmpeg -y -i "${toFfmpegPath(ttsMp3)}" -af "${audioFilter},atrim=0:${maxAllowedSec.toFixed(2)},asetpts=PTS-STARTPTS" -ar 44100 -ac 2 "${fittedFfmpeg}"`,
        6000
      );
    } else {
      await createSafeSilentWav(fittedWav, fallbackSec);
    }
  } catch {
    await createSafeSilentWav(fittedWav, fallbackSec);
  }

  if (!hasValidAudioFile(fittedWav, 200)) {
    writeSilentWavFallback(fittedWav, fallbackSec);
  }

  const rawDurSec = await getMediaDurationSec(fittedWav);
  return { fittedWav, durMs: Math.max(250, Math.round((rawDurSec || fallbackSec) * 1000)) };
}

async function buildOnTimeTtsAudioAndSubEvents(
  segments,
  voiceId,
  targetLang,
  durationSec,
  tempDir,
  finalMp3Path,
  speechSpeed = DEFAULT_SPEECH_TEMPO,
  pitchShift = DEFAULT_PITCH,
  styleMode = 'pro_recap'
) {
  const totalSec = Math.max(2, Math.ceil(durationSec));
  const segRoot = path.join(tempDir, 'segments');
  fs.mkdirSync(segRoot, { recursive: true });

  const allSegments = segments || [];
  const synthResults = await runWithConcurrency(allSegments, TTS_CONCURRENCY, async (seg, i) => {
    const segDir = path.join(segRoot, `s_${i}`);
    fs.mkdirSync(segDir, { recursive: true });
    return synthesizeSingleSegmentWav(seg, voiceId, targetLang, segDir, speechSpeed, pitchShift, styleMode);
  });

  const syncedSubEvents = [];
  const concatEntries = [];
  let cursorMs = 0;

  for (let i = 0; i < allSegments.length; i++) {
    const seg = allSegments[i];
    const item = synthResults[i];
    if (!item || !hasValidAudioFile(item.fittedWav, 200)) continue;

    const targetStartMs = Math.max(0, Math.round((seg.targetStartSec || 0) * 1000));
    if (targetStartMs > cursorMs) {
      cursorMs = targetStartMs;
    }

    const startSecVal = Number((cursorMs / 1000).toFixed(2));
    cursorMs += item.durMs;
    const endSecVal = Number((cursorMs / 1000).toFixed(2));

    concatEntries.push(item.fittedWav);
    syncedSubEvents.push({
      startSec: startSecVal,
      endSec: endSecVal,
      spokenText: seg.spokenText
    });
  }

  const finalMp3Ffmpeg = toFfmpegPath(finalMp3Path);

  if (concatEntries.length > 0) {
    const listPath = path.join(tempDir, 'concat_audio.txt');
    const listContent = concatEntries
      .map((p) => `file '${toFfmpegPath(p).replace(/'/g, "'\\''")}'`)
      .join('\n');
    fs.writeFileSync(listPath, listContent, 'utf-8');

    try {
      await runCmd(
        `ffmpeg -y -f concat -safe 0 -i "${toFfmpegPath(listPath)}" -af "apad=whole_dur=${totalSec}" -t ${totalSec} -c:a libmp3lame -q:a 9 "${finalMp3Ffmpeg}"`,
        25000
      );
      if (hasValidAudioFile(finalMp3Path, 200)) {
        return { syncedSubEvents, effectiveTotalSec: totalSec };
      }
    } catch {
      // Fallback to single merged silent WAV -> MP3
    }
  }

  const fallbackWav = path.join(tempDir, 'fallback_full.wav');
  await createSafeSilentWav(fallbackWav, Math.min(totalSec, 15));
  await runCmd(
    `ffmpeg -y -stream_loop -1 -i "${toFfmpegPath(fallbackWav)}" -t ${totalSec} -c:a libmp3lame -q:a 9 "${finalMp3Ffmpeg}"`,
    15000
  );
  return { syncedSubEvents, effectiveTotalSec: totalSec };
}

function findFontFile(targetLang = 'my') {
  const myCandidates = [
    'C:/Windows/Fonts/Pyidaungsu-2.5.3_Regular.ttf',
    'C:/Windows/Fonts/mmrtext.ttf',
    'C:/Windows/Fonts/NotoSansMyanmar-Regular.ttf',
    'C:/Windows/Fonts/padauk.ttf',
    '/usr/share/fonts/truetype/noto/NotoSansMyanmar-Regular.ttf',
    '/usr/share/fonts/truetype/padauk/Padauk.ttf'
  ];
  const enCandidates = [
    'C:/Windows/Fonts/arial.ttf',
    'C:/Windows/Fonts/segoeui.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
  ];
  const candidates = normalizeLanguage(targetLang) === 'en' ? [...enCandidates, ...myCandidates] : myCandidates;
  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).size > 10000) return p;
    } catch {
      // Ignore
    }
  }
  return '';
}

function escapeFilterPath(filePath) {
  return toFfmpegPath(filePath).replace(/:/g, '\\:').replace(/'/g, "'\\''");
}

function formatSrtTime(sec) {
  const safe = Math.max(0, Number(sec) || 0);
  const hours = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${pad(hours)}:${pad(mins)}:${pad(secs)},${pad(ms, 3)}`;
}

function writeSrtFile(syncedSubEvents, srtPath) {
  const blocks = [];
  let idx = 1;
  for (const ev of syncedSubEvents || []) {
    const text = (ev.spokenText || '').replace(/\r?\n/g, ' ').trim();
    if (!text) continue;
    const s = formatSrtTime(ev.startSec);
    const e = formatSrtTime(Math.max((Number(ev.startSec) || 0) + 0.5, Number(ev.endSec) || 1.2));
    blocks.push(`${idx}\n${s} --> ${e}\n${text}\n`);
    idx += 1;
  }
  fs.writeFileSync(srtPath, blocks.join('\n'), 'utf-8');
}

function buildFastVideoFilter(
  srtPath,
  videoWidth,
  videoHeight,
  blurOriginalSub,
  blurArea,
  targetLang = 'my',
  burnSubtitles = true
) {
  const w = Math.max(360, videoWidth || 1280);
  const h = Math.max(360, videoHeight || 720);
  const isPortrait = h > w;
  const rawFont = findFontFile(targetLang);

  const filters = [];
  if (w > 960) {
    filters.push('scale=960:-2');
  }

  if (blurOriginalSub) {
    const bandH = Math.max(36, Math.round(h * 0.11));
    const bandW = Math.max(180, Math.min(w, Math.round(w * 0.86)));
    const bandX = Math.max(0, Math.round((w - bandW) / 2));
    const bottomY = Math.max(0, Math.min(h - bandH, h - bandH - Math.round(h * 0.02)));
    const topY = Math.max(0, Math.min(h - bandH, Math.round(h * 0.04)));

    if (blurArea === 'top' || blurArea === 'both') {
      filters.push(`drawbox=x=${bandX}:y=${topY}:w=${bandW}:h=${bandH}:color=black@0.65:t=fill`);
    }
    if (blurArea === 'bottom' || blurArea === 'both' || !blurArea) {
      filters.push(`drawbox=x=${bandX}:y=${bottomY}:w=${bandW}:h=${bandH}:color=black@0.65:t=fill`);
    }
  }

  if (burnSubtitles && srtPath && fs.existsSync(srtPath)) {
    const subFontSize = isPortrait ? 18 : 22;
    const marginV = 24;
    const escapedSrt = escapeFilterPath(srtPath);
    const fontName =
      normalizeLanguage(targetLang) === 'en'
        ? 'Arial'
        : rawFont.toLowerCase().includes('pyidaungsu')
        ? 'Pyidaungsu'
        : rawFont.toLowerCase().includes('mmrtext')
        ? 'Myanmar Text'
        : 'Noto Sans Myanmar';
    filters.push(
      `subtitles='${escapedSrt}':force_style='FontName=${fontName},FontSize=${subFontSize},PrimaryColour=&H00FFFFFF,OutlineColour=&H99000000,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=${marginV}'`
    );
  }

  filters.push('format=yuv420p');
  return filters.join(',');
}

async function muxPlayableMp4Fast(
  inputPath,
  voiceMp3,
  srtPath,
  width,
  height,
  totalDurationSec,
  blurOriginalSub,
  blurArea,
  targetLang,
  burnSubtitles,
  outputPath
) {
  const dur = Math.max(1, Number(totalDurationSec) || 10);
  const inFfmpeg = toFfmpegPath(inputPath);
  const audFfmpeg = toFfmpegPath(voiceMp3);
  const outFfmpeg = toFfmpegPath(outputPath);
  const warnings = [];

  const hasSubsFile = Boolean(srtPath && fs.existsSync(srtPath) && fs.statSync(srtPath).size > 10);
  const shouldBurn = Boolean(burnSubtitles) && hasSubsFile;

  if (!blurOriginalSub && !shouldBurn) {
    try {
      await runCmd(
        `ffmpeg -y -i "${inFfmpeg}" -i "${audFfmpeg}" -map 0:v:0 -map 1:a:0 -t ${dur} -c:v copy -c:a aac -b:a 96k -ar 44100 -ac 2 -movflags +faststart "${outFfmpeg}"`,
        25000
      );
      const checkFast = await probeMediaStreams(outputPath);
      if (checkFast.hasVideoStream && checkFast.hasAudioStream && checkFast.sizeBytes > 1024) {
        return { subBurned: false, blurApplied: false, streamCopied: true, warnings };
      }
    } catch (err) {
      warnings.push(`Copy fallback: ${err.message.slice(-120)}`);
    }
  }

  try {
    const vfFull = buildFastVideoFilter(
      srtPath,
      width,
      height,
      blurOriginalSub,
      blurArea,
      targetLang,
      shouldBurn
    );
    await runCmd(
      `ffmpeg -y -i "${inFfmpeg}" -i "${audFfmpeg}" -vf "${vfFull}" -map 0:v:0 -map 1:a:0 -t ${dur} -c:v libx264 -preset ultrafast -crf 35 -threads 0 -c:a aac -b:a 96k -ar 44100 -ac 2 -movflags +faststart "${outFfmpeg}"`,
      35000
    );
    const check1 = await probeMediaStreams(outputPath);
    if (check1.hasVideoStream && check1.hasAudioStream && check1.sizeBytes > 1024) {
      return { subBurned: shouldBurn, blurApplied: Boolean(blurOriginalSub), streamCopied: false, warnings };
    }
  } catch (err) {
    warnings.push(`Fast filter fallback: ${err.message.slice(-120)}`);
  }

  await runCmd(
    `ffmpeg -y -i "${inFfmpeg}" -i "${audFfmpeg}" -map 0:v:0 -map 1:a:0 -t ${dur} -c:v copy -c:a aac -b:a 96k -ar 44100 -ac 2 -movflags +faststart "${outFfmpeg}"`,
    25000
  );
  return { subBurned: false, blurApplied: false, streamCopied: true, warnings };
}

const server = http.createServer((req, res) => {
  server.requestTimeout = 0;
  server.headersTimeout = 0;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-File-Name, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Disposition');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const reqPath = (req.url || '/').split('?')[0];

  if (req.method === 'GET' && (reqPath === '/health' || reqPath === '/api/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, studio: 'KKH AI STUDIO', status: 'READY' }));
  }

  if (req.method === 'GET' && req.url && (req.url.startsWith('/output/') || req.url.startsWith('/api/output/'))) {
    const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
    const rawFile = reqUrl.searchParams.get('file') || req.url.replace(/^\/(api\/)?output\//, '');
    const safeName = path.basename(decodeURIComponent(rawFile));
    const filePath = path.join(workspaceDir, safeName);

    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Output file not found' }));
    }

    const stat = fs.statSync(filePath);
    const asDownload = reqUrl.searchParams.get('download') === '1';
    const headers = {
      'Content-Type': 'video/mp4',
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store'
    };
    if (asDownload) {
      headers['Content-Disposition'] = `attachment; filename="${safeName}"`;
    }

    const range = req.headers.range;
    if (range && !asDownload) {
      const match = range.match(/bytes=(\d*)-(\d*)/);
      const start = match && match[1] ? parseInt(match[1], 10) : 0;
      const end = match && match[2] ? Math.min(parseInt(match[2], 10), stat.size - 1) : stat.size - 1;
      if (start > end || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }
      const chunkSize = end - start + 1;
      res.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': chunkSize
      });
      fs.createReadStream(filePath, { start, end, highWaterMark: 2 * 1024 * 1024 }).pipe(res);
    } else {
      res.writeHead(200, headers);
      fs.createReadStream(filePath, { highWaterMark: 2 * 1024 * 1024 }).pipe(res);
    }
    return;
  }

  if (req.method === 'POST' && (reqPath === '/upload-video' || reqPath === '/api/upload-video')) {
    const rawName = decodeURIComponent(req.headers['x-file-name'] || 'uploaded_video.mp4');
    const safeName = path.basename(rawName).replace(/[^a-zA-Z0-9._-]/g, '_');
    const destPath = path.join(uploadsDir, safeName);
    const writeStream = fs.createWriteStream(destPath, { highWaterMark: 8 * 1024 * 1024 });
    let totalBytes = 0;
    let aborted = false;

    req.on('data', (chunk) => {
      if (aborted) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_VIDEO_BYTES) {
        aborted = true;
        writeStream.destroy();
        fs.rm(destPath, { force: true }, () => {});
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Video size 2GB ထက် ကျော်နေပါသည်။' }));
        req.destroy();
        return;
      }
      if (!writeStream.write(chunk)) {
        req.pause();
        writeStream.once('drain', () => {
          if (!aborted) req.resume();
        });
      }
    });

    req.on('end', () => {
      if (aborted) return;
      writeStream.end(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, fileName: safeName, sizeMB: Number((totalBytes / (1024 * 1024)).toFixed(2)) }));
      });
    });

    writeStream.on('error', (err) => {
      if (aborted) return;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    });
    return;
  }

  if (req.method === 'POST' && (reqPath === '/dub-full-video' || reqPath === '/api/dub-full-video')) {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const {
          videoFile = 'input.mp4',
          gender = DEFAULT_GENDER,
          voiceProfile = '',
          voiceStyle = 'pro_recap',
          language = DEFAULT_LANG,
          manualText = '',
          burnSubtitles = false,
          blurOriginalSub = false,
          blurArea = 'bottom',
          voiceSpeed = DEFAULT_SPEECH_TEMPO,
          pitchShift = DEFAULT_PITCH
        } = JSON.parse(body || '{}');

        const safeName = path.basename(videoFile);
        const uploadCandidate = path.join(uploadsDir, safeName);
        const workspaceCandidate = path.join(workspaceDir, safeName);
        const inputPath = fs.existsSync(uploadCandidate) ? uploadCandidate : workspaceCandidate;

        if (!fs.existsSync(inputPath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: `Video ဖိုင် မတွေ့ပါ: ${safeName}` }));
        }

        const inputAudit = await probeMediaStreams(inputPath);
        if (inputAudit.sizeBytes > MAX_VIDEO_BYTES) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'Video size 2GB ထက် ကျော်နေပါသည်။' }));
        }
        if (!inputAudit.hasVideoStream || inputAudit.sizeBytes < 512) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            ok: false,
            error: 'တင်ထားသော Video ဖိုင်ထဲတွင် Video stream မတွေ့ပါ သို့မဟုတ် ဖိုင်ပျက်နေပါသည်။'
          }));
        }

        const rawVoiceChoice = String(voiceProfile || gender || DEFAULT_GENDER).toLowerCase();
        const chosenGender = rawVoiceChoice === 'female' || rawVoiceChoice === 'nilar' ? 'female' : 'male';
        const voiceNameTag = chosenGender === 'female' ? 'NILAR' : 'THIHA';
        const appliedStyle = String(voiceStyle || 'pro_recap').toLowerCase() === 'pro_recap' ? 'pro_recap' : 'conversational';
        const appliedLang = normalizeLanguage(language);
        const appliedTempo = normalizeSpeechTempo(voiceSpeed);
        const appliedPitch = normalizePitchShift(pitchShift);
        const shouldBurnSubtitles = Boolean(burnSubtitles);

        const videoDur = await getVideoDurationSec(inputPath);
        const durationSec = Math.max(3, videoDur);

        const { width, height } = await getVideoDimensions(inputPath);
        const tempDir = fs.mkdtempSync(path.join(workspaceDir, 'tmp_dub_'));

        const timedSegments = await prepareOnTimeSegments(manualText, durationSec, appliedLang, appliedStyle);
        const voiceMp3 = path.join(tempDir, `synced_tts_${appliedLang}.mp3`);

        const built = await buildOnTimeTtsAudioAndSubEvents(
          timedSegments,
          chosenGender,
          appliedLang,
          durationSec,
          tempDir,
          voiceMp3,
          appliedTempo,
          appliedPitch,
          appliedStyle
        );
        const syncedSubEvents = built.syncedSubEvents;
        const finalDurationSec = Math.max(durationSec, built.effectiveTotalSec);

        const srtPath = path.join(tempDir, 'synced_subs.srt');
        writeSrtFile(syncedSubEvents, srtPath);

        const fullScriptOutput = syncedSubEvents.map((s) => `[${s.startSec}s-${s.endSec}s] ${s.spokenText}`).join('\n');
        const base = safeName.replace(/\.[^/.]+$/, '');
        const outputFileName = `${base}_KKH_${voiceNameTag}_${appliedLang.toUpperCase()}_${Date.now()}.mp4`;
        const outputPath = path.join(workspaceDir, outputFileName);

        const { subBurned, blurApplied, streamCopied, warnings } = await muxPlayableMp4Fast(
          inputPath,
          voiceMp3,
          srtPath,
          width,
          height,
          finalDurationSec,
          blurOriginalSub,
          blurArea,
          appliedLang,
          shouldBurnSubtitles,
          outputPath
        );
        const outAudit = await probeMediaStreams(outputPath);
        fs.rmSync(tempDir, { recursive: true, force: true });

        if (!outAudit.exists || outAudit.sizeBytes < 1024 || !outAudit.hasVideoStream) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            ok: false,
            error: 'ထွက်လာသော Video ဖိုင် ပျက်နေပါသည်။ ထပ်စမ်းကြည့်ပါ။',
            warnings
          }));
        }

        const origin = getBackendOrigin(req);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({
          ok: true,
          outputFileName,
          hasAudio: outAudit.hasAudioStream,
          subBurned,
          blurApplied,
          streamCopied,
          burnSubtitles: shouldBurnSubtitles,
          language: appliedLang,
          voiceStyle: appliedStyle,
          speechSpeed: appliedTempo,
          pitchShift: appliedPitch,
          streamUrl: `${origin}/output/${encodeURIComponent(outputFileName)}`,
          downloadUrl: `${origin}/output/${encodeURIComponent(outputFileName)}?download=1`,
          burmeseText: fullScriptOutput,
          segmentsCount: syncedSubEvents.length,
          voiceName: voiceNameTag,
          gender: chosenGender,
          audit: {
            ...outAudit,
            subBurned,
            blurApplied,
            streamCopied,
            burnSubtitles: shouldBurnSubtitles,
            language: appliedLang,
            voiceStyle: appliedStyle,
            speechSpeed: appliedTempo,
            pitchShift: appliedPitch,
            voiceName: voiceNameTag
          },
          warnings
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'GET' && fs.existsSync(distDir)) {
    const cleanUrl = (req.url || '/').split('?')[0];
    const relPath = cleanUrl === '/' ? 'index.html' : cleanUrl.replace(/^\/+/, '');
    const candidateFile = path.resolve(distDir, relPath);
    const indexFile = path.join(distDir, 'index.html');
    const targetFile =
      candidateFile.startsWith(distDir) && fs.existsSync(candidateFile) && fs.statSync(candidateFile).isFile()
        ? candidateFile
        : indexFile;

    if (fs.existsSync(targetFile)) {
      const ext = path.extname(targetFile).toLowerCase();
      const mimeMap = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.json': 'application/json; charset=utf-8'
      };
      res.writeHead(200, { 'Content-Type': mimeMap[ext] || 'application/octet-stream' });
      return fs.createReadStream(targetFile).pipe(res);
    }
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`[KKH AI STUDIO] Running on http://localhost:${PORT}`);
});