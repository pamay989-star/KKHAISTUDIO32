import React, { useState, useEffect, useRef } from 'react';
import {
  Sparkles,
  Play,
  Pause,
  CheckCircle2,
  AlertCircle,
  UploadCloud,
  Download,
  Film,
  User,
  UserCheck,
  ExternalLink,
  Volume2,
  VolumeX,
  ShieldCheck,
  Gauge
} from 'lucide-react';

const MAX_1GB_BYTES = 1024 * 1024 * 1024;

function getApiBase() {
  const envApi = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_API_URL;
  if (envApi && envApi.trim()) {
    return envApi.trim().replace(/\/+$/, '');
  }
  if (typeof window !== 'undefined') {
    const { origin, hostname, port } = window.location;
    if (port === '5173') {
      return `http://${hostname || 'localhost'}:4567`;
    }
    return origin;
  }
  return 'http://localhost:4567';
}

function formatPreviewScript(rawText: string): string {
  if (!rawText) return '';
  return rawText
    .replace(/\\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\\n/g, '').trim())
    .filter(Boolean)
    .join('\n');
}

interface VideoAudit {
  exists: boolean;
  sizeBytes: number;
  sizeMB: number;
  durationSec: number;
  width: number;
  height: number;
  hasVideoStream: boolean;
  hasAudioStream: boolean;
  videoCodec: string;
  audioCodec: string;
  subBurned: boolean;
  blurApplied?: boolean;
  speechSpeed?: number;
}

export default function App() {
  const API = getApiBase();
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [runnerOnline, setRunnerOnline] = useState<boolean | null>(null);
  const [videoFile, setVideoFile] = useState('input.mp4');
  const [fileLabel, setFileLabel] = useState('Video ရွေးပါ (1GB အထိ)');
  const [gender, setGender] = useState<'female' | 'male' | 'custom'>('male');
  const [customVoiceFile, setCustomVoiceFile] = useState('');
  const [voiceLabel, setVoiceLabel] = useState('အသံဖိုင် ရွေးပါ (.mp3 / .wav / .m4a)');
  const [uploadingVoice, setUploadingVoice] = useState(false);
  const [manualText, setManualText] = useState('');
  const [blurOriginalSub, setBlurOriginalSub] = useState(true);
  const [blurArea, setBlurArea] = useState<'bottom' | 'top' | 'both'>('bottom');
  const [voiceSpeed, setVoiceSpeed] = useState(0.94);

  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [isError, setIsError] = useState(false);
  const [statusText, setStatusText] = useState('Video ရွေးပြီး စာသားထည့်ကာ ထုတ်ခလုတ်ကို နှိပ်ပါ');
  const [burmesePreview, setBurmesePreview] = useState('');
  const [audit, setAudit] = useState<VideoAudit | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const [streamUrl, setStreamUrl] = useState('');
  const [downloadUrl, setDownloadUrl] = useState('');
  const [outputName, setOutputName] = useState('');
  const [playerError, setPlayerError] = useState('');
  const [downloading, setDownloading] = useState(false);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(1.0);

  useEffect(() => {
    let active = true;
    const checkHealth = async () => {
      try {
        const res = await fetch(`${API}/health`, { cache: 'no-store' });
        if (active) setRunnerOnline(res.ok);
      } catch {
        if (active) setRunnerOnline(false);
      }
    };
    checkHealth();
    const timer = setInterval(checkHealth, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [API]);

  useEffect(() => {
    if (!streamUrl || !videoRef.current) return;
    const v = videoRef.current;
    v.muted = false;
    v.volume = 1.0;
    setIsMuted(false);
    setVolume(1.0);
    v.load();
    const playPromise = v.play();
    if (playPromise !== undefined) {
      playPromise
        .then(() => {
          setIsPlaying(true);
          setPlayerError('');
        })
        .catch(() => {
          setIsPlaying(false);
        });
    }
  }, [streamUrl]);

  const handleTogglePlayPause = async () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      v.muted = false;
      setIsMuted(false);
      await v.play().catch(() => {});
      setIsPlaying(true);
    } else {
      v.pause();
      setIsPlaying(false);
    }
  };

  const handleToggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    const nextMuted = !isMuted;
    v.muted = nextMuted;
    if (!nextMuted && v.volume === 0) {
      v.volume = 1.0;
      setVolume(1.0);
    }
    setIsMuted(nextMuted);
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setVolume(val);
    const v = videoRef.current;
    if (v) {
      v.volume = val;
      v.muted = val === 0;
      setIsMuted(val === 0);
    }
  };

  const handleFilePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > MAX_1GB_BYTES) {
      setIsError(true);
      setStatusText('1GB (1024MB) ထက် ကျော်နေပါသည်။ 1GB အောက် Video ကို ရွေးပါ။');
      return;
    }

    const mb = (file.size / (1024 * 1024)).toFixed(1);
    setFileLabel(`${file.name} (${mb} MB)`);
    setVideoFile(file.name);
    setIsError(false);
    setAudit(null);
    setWarnings([]);
    setUploading(true);
    setStatusText(`Video တင်နေပါသည် (${mb} MB)...`);

    try {
      const res = await fetch(`${API}/upload-video`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-File-Name': encodeURIComponent(file.name)
        },
        body: file
      });
      const d = await res.json();
      if (d.ok) {
        setVideoFile(d.fileName);
        setStatusText(`Video Ready (${d.sizeMB} MB)။ အခု ထုတ်မည် ခလုတ်ကို နှိပ်ပါ။`);
      } else {
        setIsError(true);
        setStatusText(d.error || 'Video တင်မရပါ။');
      }
    } catch {
      setIsError(true);
      setStatusText('Runner မပွင့်သေးပါ။ npm start ကို run ပါ။');
    } finally {
      setUploading(false);
    }
  };

  const handleVoicePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    setVoiceLabel(`${file.name} (${mb} MB)`);
    setIsError(false);
    setUploadingVoice(true);
    setStatusText(`ကိုယ်ပိုင်အသံ ဖိုင်တင်နေပါသည် (${mb} MB)...`);

    try {
      const res = await fetch(`${API}/upload-voice`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-File-Name': encodeURIComponent(file.name)
        },
        body: file
      });
      const d = await res.json();
      if (d.ok) {
        setCustomVoiceFile(d.fileName);
        setGender('custom');
        setStatusText(`ကိုယ်ပိုင်အသံ Ready (${d.fileName})။ အခု ထုတ်မည် ခလုတ်ကို နှိပ်ပါ။`);
      } else {
        setIsError(true);
        setStatusText(d.error || 'အသံဖိုင် တင်မရပါ။');
      }
    } catch {
      setIsError(true);
      setStatusText('Runner မပွင့်သေးပါ။ npm start ကို run ပါ။');
    } finally {
      setUploadingVoice(false);
    }
  };

  const handleDubFullVideo = async () => {
    setLoading(true);
    setIsError(false);
    setPlayerError('');
    setStreamUrl('');
    setDownloadUrl('');
    setAudit(null);
    setWarnings([]);
    setIsPlaying(false);
    setStatusText(
      `မူလစာတန်း ဝါးခြင်း + အသံနှုန်း (${voiceSpeed.toFixed(2)}x) + မြန်မာစာတန်း အစအဆုံး ထုတ်လုပ်နေပါသည်...`
    );

    try {
      const res = await fetch(`${API}/dub-full-video`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoFile,
          gender,
          manualText,
          customVoiceFile: gender === 'custom' ? customVoiceFile : '',
          blurOriginalSub,
          blurArea,
          voiceSpeed
        })
      });
      const d = await res.json();
      if (d.ok) {
        setStreamUrl(d.streamUrl || '');
        setDownloadUrl(d.downloadUrl || '');
        setOutputName(d.outputFileName || '');
        setBurmesePreview(formatPreviewScript(d.burmeseText || ''));
        setAudit(d.audit || null);
        setWarnings(Array.isArray(d.warnings) ? d.warnings : []);
        const voiceTitle =
          gender === 'male' ? 'ယောက်ျားလေးအသံ' : gender === 'female' ? 'မိန်းကလေးအသံ' : 'ကိုယ်ပိုင်အသံ';
        const usedSpeed = Number(d.speechSpeed || voiceSpeed);
        setStatusText(
          `ပြီးပါပြီ! ${voiceTitle} (${usedSpeed.toFixed(2)}x) • စာတန်း (${d.segmentsCount || 1}) ကြောင်း • အောက်ပါ Player တွင် စစ်ဆေးနိုင်ပါပြီ။`
        );
      } else {
        setIsError(true);
        setWarnings(Array.isArray(d.warnings) ? d.warnings : []);
        setStatusText(d.error || 'လုပ်ဆောင်မှု မအောင်မြင်ပါ။');
      }
    } catch {
      setIsError(true);
      setStatusText('Runner မပွင့်သေးပါ။ npm start ကို run ပါ။');
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadClick = async (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!downloadUrl) return;
    setDownloading(true);
    try {
      e.preventDefault();
      const resp = await fetch(downloadUrl);
      if (!resp.ok) throw new Error('Download failed');
      const blob = await resp.blob();
      if (blob.size < 1024) throw new Error('Empty output file');
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = outputName || 'KKH_AI_DUB.mp4';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      setIsError(false);
      setStatusText(`Download ပြီးပါပြီ: ${outputName || 'KKH_AI_DUB.mp4'} (${(blob.size / (1024 * 1024)).toFixed(2)} MB)`);
    } catch {
      window.open(downloadUrl, '_blank');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="min-h-screen bg-kkh-bg text-purple-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-3xl bg-kkh-card border border-purple-500/30 shadow-2xl shadow-purple-950/60 p-5 space-y-4">
        <div className="flex items-center justify-between border-b border-purple-500/20 pb-3.5">
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-purple-600 to-violet-500 flex items-center justify-center shadow-lg shadow-purple-600/30">
              <Sparkles className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-base font-extrabold tracking-wide text-white">KKH AI STUDIO</h1>
              <p className="text-[11px] text-purple-300/80">
                မူလစာတန်း ဝါးခြင်း • ယောက်ျားလေး/မိန်းကလေး အသံ • မြန်မာစာတန်း
              </p>
            </div>
          </div>
          <span
            className={`px-2.5 py-1 rounded-full border text-[10px] font-bold ${
              runnerOnline === true
                ? 'bg-emerald-950/70 border-emerald-500/40 text-emerald-200'
                : runnerOnline === false
                ? 'bg-rose-950/70 border-rose-500/40 text-rose-200'
                : 'bg-purple-950 border-purple-500/30 text-purple-200'
            }`}
          >
            {runnerOnline === true ? 'RUNNER ON' : runnerOnline === false ? 'RUNNER OFF' : 'CHECKING'}
          </span>
        </div>

        <div className="space-y-1.5 text-xs">
          <label className="block text-purple-200 font-medium">Video ထည့်ရန် (1GB အထိ)</label>
          <label className="w-full p-3.5 rounded-2xl bg-kkh-panel/70 hover:bg-kkh-panel border border-dashed border-purple-400/50 cursor-pointer flex items-center gap-2.5 transition">
            <UploadCloud className="w-5 h-5 text-purple-300 shrink-0" />
            <div className="truncate">
              <div className="font-semibold text-white truncate">{fileLabel}</div>
              <div className="text-[10px] text-purple-300/80">မူလစာတန်းဝါးခြင်း + အောက်ခြေမြန်မာစာတန်း + KKH TOOL</div>
            </div>
            <input type="file" accept="video/*" onChange={handleFilePick} className="hidden" />
          </label>
        </div>

        <div className="p-3 rounded-2xl bg-kkh-panel/60 border border-purple-500/25 space-y-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-purple-100 font-semibold">မူလစာတန်း ဝါးပေးရန် (Blur Original Sub)</span>
            <input
              type="checkbox"
              checked={blurOriginalSub}
              onChange={(e) => setBlurOriginalSub(e.target.checked)}
              className="w-4 h-4 accent-purple-500 rounded cursor-pointer"
            />
          </div>
          {blurOriginalSub && (
            <div className="grid grid-cols-3 gap-1.5 pt-1">
              <button
                type="button"
                onClick={() => setBlurArea('bottom')}
                className={`py-1.5 px-2 rounded-lg border text-[11px] font-semibold ${
                  blurArea === 'bottom'
                    ? 'bg-purple-600 border-purple-300 text-white'
                    : 'bg-kkh-bg border-purple-500/20 text-purple-200'
                }`}
              >
                အောက်ခြေဝါး
              </button>
              <button
                type="button"
                onClick={() => setBlurArea('top')}
                className={`py-1.5 px-2 rounded-lg border text-[11px] font-semibold ${
                  blurArea === 'top'
                    ? 'bg-purple-600 border-purple-300 text-white'
                    : 'bg-kkh-bg border-purple-500/20 text-purple-200'
                }`}
              >
                အပေါ်ပိုင်းဝါး
              </button>
              <button
                type="button"
                onClick={() => setBlurArea('both')}
                className={`py-1.5 px-2 rounded-lg border text-[11px] font-semibold ${
                  blurArea === 'both'
                    ? 'bg-purple-600 border-purple-300 text-white'
                    : 'bg-kkh-bg border-purple-500/20 text-purple-200'
                }`}
              >
                အပေါ်/အောက်ဝါး
              </button>
            </div>
          )}
        </div>

        <div className="space-y-1.5 text-xs">
          <label className="block text-purple-200 font-medium">အသံ ရွေးရန်</label>
          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={() => setGender('female')}
              className={`py-2.5 px-2 rounded-xl border font-semibold flex items-center justify-center gap-1 transition ${
                gender === 'female'
                  ? 'bg-purple-600 border-purple-300 text-white'
                  : 'bg-kkh-bg border-purple-500/25 text-purple-200'
              }`}
            >
              <User className="w-4 h-4 shrink-0" />
              <span>မိန်းကလေး</span>
            </button>
            <button
              type="button"
              onClick={() => setGender('male')}
              className={`py-2.5 px-2 rounded-xl border font-semibold flex items-center justify-center gap-1 transition ${
                gender === 'male'
                  ? 'bg-purple-600 border-purple-300 text-white'
                  : 'bg-kkh-bg border-purple-500/25 text-purple-200'
              }`}
            >
              <UserCheck className="w-4 h-4 shrink-0" />
              <span>ယောက်ျားလေး</span>
            </button>
            <button
              type="button"
              onClick={() => setGender('custom')}
              className={`py-2.5 px-2 rounded-xl border font-semibold flex items-center justify-center gap-1 transition ${
                gender === 'custom'
                  ? 'bg-purple-600 border-purple-300 text-white'
                  : 'bg-kkh-bg border-purple-500/25 text-purple-200'
              }`}
            >
              <Volume2 className="w-4 h-4 shrink-0" />
              <span>ကိုယ်ပိုင်အသံ</span>
            </button>
          </div>

          <div className="p-3 rounded-2xl bg-kkh-panel/60 border border-purple-500/25 space-y-2 mt-2">
            <div className="flex items-center justify-between">
              <span className="text-purple-100 font-semibold flex items-center gap-1.5">
                <Gauge className="w-4 h-4 text-purple-300" />
                <span>အသံ Speed (တင်ရန် / လျှော့ရန်)</span>
              </span>
              <span className="font-mono text-xs font-bold text-purple-200">{voiceSpeed.toFixed(2)}x</span>
            </div>
            <input
              type="range"
              min={0.7}
              max={1.35}
              step={0.05}
              value={voiceSpeed}
              onChange={(e) => setVoiceSpeed(parseFloat(e.target.value))}
              className="w-full accent-purple-500 cursor-pointer"
            />
            <div className="flex items-center justify-between text-[10px] text-purple-300">
              <button
                type="button"
                onClick={() => setVoiceSpeed(0.8)}
                className="px-2 py-0.5 rounded bg-kkh-bg border border-purple-500/25 hover:border-purple-400"
              >
                နှေး (0.80x)
              </button>
              <button
                type="button"
                onClick={() => setVoiceSpeed(0.94)}
                className="px-2 py-0.5 rounded bg-kkh-bg border border-purple-500/25 hover:border-purple-400"
              >
                ပုံမှန် (0.94x)
              </button>
              <button
                type="button"
                onClick={() => setVoiceSpeed(1.15)}
                className="px-2 py-0.5 rounded bg-kkh-bg border border-purple-500/25 hover:border-purple-400"
              >
                မြန် (1.15x)
              </button>
            </div>
          </div>

          {gender === 'custom' && (
            <label className="w-full p-2.5 rounded-xl bg-kkh-panel/70 hover:bg-kkh-panel border border-dashed border-purple-400/50 cursor-pointer flex items-center gap-2 transition mt-1.5">
              <UploadCloud className="w-4 h-4 text-purple-300 shrink-0" />
              <div className="truncate text-[11px] text-purple-100">{voiceLabel}</div>
              <input type="file" accept="audio/*" onChange={handleVoicePick} className="hidden" />
            </label>
          )}
        </div>

        <div className="text-xs">
          <label className="block text-purple-200 font-medium mb-1">
            ရိုက်ထည့်သော စာသား (မည်သည့်ဘာသာမဆို မြန်မာပြန်ပေးမည်)
          </label>
          <textarea
            rows={3}
            value={manualText}
            onChange={(e) => setManualText(e.target.value)}
            placeholder="ရိုက်ထည့်လိုက်တဲ့ စာသားကို မြန်မာလို ပြန်ဆိုပြီး အစအဆုံး အသံထွက် + အောက်ခြေမြန်မာစာတန်း ထိုးပေးမည်..."
            className="w-full px-3 py-2 rounded-xl bg-kkh-bg border border-purple-500/30 text-white focus:outline-none focus:border-purple-400"
          />
        </div>

        <button
          type="button"
          onClick={handleDubFullVideo}
          disabled={loading || uploading || uploadingVoice}
          className="w-full py-3 rounded-2xl bg-gradient-to-r from-purple-600 to-violet-500 hover:from-purple-500 hover:to-violet-400 disabled:opacity-50 text-white font-bold text-sm flex items-center justify-center gap-2 shadow-lg shadow-purple-700/40 active:scale-[0.99] transition"
        >
          <Play className="w-4 h-4 fill-current" />
          <span>
            {uploading || uploadingVoice
              ? 'ဖိုင်တင်နေသည်...'
              : loading
              ? 'မူလစာတန်းဝါးပြီး ထုတ်လုပ်နေသည်...'
              : 'အသံ + စာတန်း ထုတ်မည်'}
          </span>
        </button>

        {streamUrl && (
          <div className="p-3 rounded-2xl bg-kkh-panel/90 border border-purple-400/40 space-y-2.5">
            <div className="flex items-center justify-between text-xs font-semibold text-purple-100">
              <span className="flex items-center gap-1.5 truncate">
                <Film className="w-4 h-4 text-purple-300 shrink-0" />
                <span className="truncate">{outputName}</span>
              </span>
              <a
                href={streamUrl}
                target="_blank"
                rel="noreferrer"
                className="text-[10px] text-purple-200 hover:text-white inline-flex items-center gap-1 shrink-0"
              >
                <span>Browser ဖြင့်ဖွင့်ရန်</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>

            <video
              ref={videoRef}
              key={streamUrl}
              src={streamUrl}
              crossOrigin="anonymous"
              controls
              playsInline
              preload="metadata"
              onLoadedMetadata={() => setPlayerError('')}
              onPlay={() => {
                setIsPlaying(true);
                setPlayerError('');
              }}
              onPause={() => setIsPlaying(false)}
              onVolumeChange={(e) => {
                const el = e.currentTarget;
                setIsMuted(el.muted);
                setVolume(el.volume);
              }}
              onError={() =>
                setPlayerError(
                  'ဒီ Player ထဲမှာ ဖွင့်မရရင် "Browser ဖြင့်ဖွင့်ရန်" ကို နှိပ်ပါ သို့မဟုတ် Download ဆွဲပြီး VLC နဲ့ ဖွင့်ပါ။'
                )
              }
              className="w-full rounded-xl bg-black border border-purple-500/30 max-h-60"
            />

            <div className="p-2.5 rounded-xl bg-kkh-bg/90 border border-purple-500/35 space-y-2">
              <div className="flex items-center gap-2 text-[11px] text-purple-200">
                <button
                  type="button"
                  onClick={handleTogglePlayPause}
                  className="py-1.5 px-3 rounded-lg bg-purple-700 hover:bg-purple-600 text-white font-semibold text-xs flex items-center justify-center gap-1 transition"
                >
                  {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                  <span>{isPlaying ? 'ရပ်' : 'ဖွင့်'}</span>
                </button>
                <button
                  type="button"
                  onClick={handleToggleMute}
                  className="p-1.5 rounded-lg bg-kkh-panel hover:bg-purple-800/60 border border-purple-500/30 text-white"
                  title={isMuted ? 'အသံဖွင့်ရန်' : 'အသံပိတ်ရန်'}
                >
                  {isMuted || volume === 0 ? (
                    <VolumeX className="w-4 h-4 text-rose-400" />
                  ) : (
                    <Volume2 className="w-4 h-4 text-emerald-400" />
                  )}
                </button>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={isMuted ? 0 : volume}
                  onChange={handleVolumeChange}
                  className="flex-1 accent-purple-400 cursor-pointer"
                />
                <span className="w-10 text-right font-mono text-[10px]">
                  {isMuted ? 'MUTE' : `${Math.round(volume * 100)}%`}
                </span>
              </div>
            </div>

            {audit && (
              <div className="p-2.5 rounded-xl bg-kkh-bg/85 border border-purple-500/25 text-[11px] text-purple-100 space-y-1">
                <div className="flex items-center gap-1.5 font-semibold text-emerald-300">
                  <ShieldCheck className="w-4 h-4 shrink-0" />
                  <span>Video စစ်ဆေးချက် (Verified)</span>
                </div>
                <div className="grid grid-cols-2 gap-1 text-[10px] text-purple-200">
                  <span>Size: {audit.sizeMB} MB</span>
                  <span>Duration: {audit.durationSec}s</span>
                  <span>
                    Video: {audit.hasVideoStream ? `${audit.videoCodec} (${audit.width}x${audit.height})` : 'No'}
                  </span>
                  <span>
                    Audio: {audit.hasAudioStream ? `${audit.audioCodec} (${Number(audit.speechSpeed || voiceSpeed).toFixed(2)}x)` : 'No'}
                  </span>
                </div>
                <div className="text-[10px] text-purple-300">
                  မူလစာတန်းဝါး: {audit.blurApplied ? 'ဝါးပြီး' : 'မဝါးပါ'} • အောက်ခြေစာတန်း: {audit.subBurned ? 'ထည့်ပြီး' : 'Tag/Base'}
                </div>
              </div>
            )}

            {warnings.length > 0 && (
              <div className="p-2 rounded-lg bg-amber-950/50 border border-amber-500/30 text-[11px] text-amber-200 space-y-0.5">
                {warnings.map((w, i) => (
                  <p key={i}>• {w}</p>
                ))}
              </div>
            )}

            {playerError && (
              <p className="text-[11px] text-amber-200 bg-amber-950/50 border border-amber-500/30 p-2 rounded-lg">
                {playerError}
              </p>
            )}

            <a
              href={downloadUrl}
              download={outputName || 'KKH_AI_DUB.mp4'}
              onClick={handleDownloadClick}
              className="w-full py-2.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-bold text-xs flex items-center justify-center gap-2 transition"
            >
              <Download className="w-4 h-4" />
              <span>{downloading ? 'Download ဆွဲနေသည်...' : 'Download (.mp4)'}</span>
            </a>
          </div>
        )}

        <div
          className={`p-3 rounded-2xl border text-xs flex items-start gap-2 ${
            isError
              ? 'bg-rose-950/50 border-rose-500/40 text-rose-200'
              : 'bg-kkh-panel/80 border-purple-500/25 text-purple-100'
          }`}
        >
          {isError ? (
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          ) : (
            <CheckCircle2 className="w-4 h-4 text-purple-300 shrink-0 mt-0.5" />
          )}
          <div className="space-y-1 break-words">
            <p>{statusText}</p>
            {burmesePreview && (
              <pre className="text-[11px] whitespace-pre-wrap text-purple-200 bg-kkh-bg/80 p-2 rounded-lg border border-purple-500/20 max-h-48 overflow-y-auto">
                {burmesePreview}
              </pre>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
