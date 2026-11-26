import React, { useEffect, useRef, useState } from "react";

const API = "";

type SubPosition = "bottom" | "top" | "both";
type VoiceChoice = "female" | "male" | "custom";

async function parseJsonSafely(res: Response) {
  const raw = await res.text();
  if (!raw || !raw.trim()) {
    return { ok: false, error: `Empty response (HTTP ${res.status})` };
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {
      ok: false,
      error: `Invalid JSON (HTTP ${res.status}): ${raw.slice(0, 120)}`,
    };
  }
}

async function fetchWithRouteFallback(
  paths: string[],
  init?: RequestInit
): Promise<{ res: Response; data: any; usedPath: string }> {
  let lastRes: Response | null = null;
  let lastData: any = null;
  let lastPath = paths[0] || "";

  for (const p of paths) {
    lastPath = p;
    const res = await fetch(`${API}${p}`, init);
    const data = await parseJsonSafely(res);
    lastRes = res;
    lastData = data;
    if (res.status !== 404) {
      return { res, data, usedPath: p };
    }
  }

  return {
    res: lastRes!,
    data: lastData,
    usedPath: lastPath,
  };
}

export default function App() {
  const [videoFile, setVideoFile] = useState<string>("");
  const [blurEnabled, setBlurEnabled] = useState<boolean>(true);
  const [subPosition, setSubPosition] = useState<SubPosition>("bottom");
  const [voiceChoice, setVoiceChoice] = useState<VoiceChoice>("male");
  const [voiceSpeed, setVoiceSpeed] = useState<number>(1.0);
  const [customVoiceFile, setCustomVoiceFile] = useState<string>("");
  const [voiceLabel, setVoiceLabel] = useState<string>("");
  const [scriptText, setScriptText] = useState<string>("");

  const [statusText, setStatusText] = useState<string>("");
  const [isError, setIsError] = useState<boolean>(false);
  const [runnerOnline, setRunnerOnline] = useState<boolean | null>(null);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [isUploadingVoice, setIsUploadingVoice] = useState<boolean>(false);
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [outputUrl, setOutputUrl] = useState<string>("");
  const [downloadUrl, setDownloadUrl] = useState<string>("");
  const [subtitleText, setSubtitleText] = useState<string>("");

  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const voiceInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let active = true;
    const checkHealth = async () => {
      try {
        const { res, data } = await fetchWithRouteFallback([
          "/health",
          "/api/health",
        ]);
        if (!active) return;
        if (res.ok && data?.ok) {
          setRunnerOnline(true);
        } else {
          setRunnerOnline(false);
          setIsError(true);
          setStatusText(
            `Runner မပွင့်သေးပါ။ npm start ကို run ပါ။ (${
              data?.error || `HTTP ${res.status}`
            })`
          );
        }
      } catch (err: any) {
        if (!active) return;
        setRunnerOnline(false);
        setIsError(true);
        setStatusText(
          `Runner မပွင့်သေးပါ။ npm start ကို run ပါ။ (${
            err?.message || "Failed to fetch"
          })`
        );
      }
    };
    checkHealth();
    return () => {
      active = false;
    };
  }, []);

  const handleFilePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    setIsError(false);
    setStatusText("Video တင်နေပါသည်...");

    try {
      const { res, data: d, usedPath } = await fetchWithRouteFallback(
        ["/upload-video", "/api/upload-video"],
        {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "x-file-name": encodeURIComponent(file.name),
          },
          body: file,
        }
      );

      if (res.ok && d?.ok) {
        const sizeMb =
          typeof d.sizeMB === "number"
            ? d.sizeMB.toFixed(1)
            : (file.size / (1024 * 1024)).toFixed(1);
        setVideoFile(d.fileName || file.name);
        setRunnerOnline(true);
        setIsError(false);
        setStatusText(
          `Video Ready (${sizeMb} MB)။ အခု ထုတ်မည် ခလုတ်ကို နှိပ်ပါ။`
        );
      } else {
        setIsError(true);
        setStatusText(
          `${d?.error || "Video တင်မရပါ။"} [${usedPath} -> HTTP ${res.status}]`
        );
      }
    } catch (err: any) {
      setRunnerOnline(false);
      setIsError(true);
      setStatusText(
        `Runner မပွင့်သေးပါ။ npm start ကို run ပါ။ (${
          err?.message || "Failed to fetch"
        })`
      );
    } finally {
      setIsUploading(false);
    }
  };

  const handleVoicePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const mb = (file.size / (1024 * 1024)).toFixed(1);
    setVoiceLabel(`${file.name} (${mb} MB)`);
    setIsError(false);
    setIsUploadingVoice(true);
    setStatusText(`ကိုယ်ပိုင်အသံ ဖိုင်တင်နေပါသည် (${mb} MB)...`);

    try {
      const { res, data: d, usedPath } = await fetchWithRouteFallback(
        ["/upload-voice", "/api/upload-voice"],
        {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "x-file-name": encodeURIComponent(file.name),
          },
          body: file,
        }
      );

      if (res.ok && d?.ok) {
        setCustomVoiceFile(d.fileName || file.name);
        setRunnerOnline(true);
        setIsError(false);
        setStatusText(`ကိုယ်ပိုင်အသံ Ready (${file.name})`);
      } else {
        setIsError(true);
        setStatusText(
          `${d?.error || "အသံဖိုင် တင်မရပါ။"} [${usedPath} -> HTTP ${
            res.status
          }]`
        );
      }
    } catch (err: any) {
      setRunnerOnline(false);
      setIsError(true);
      setStatusText(
        `Runner မပွင့်သေးပါ။ npm start ကို run ပါ။ (${
          err?.message || "Failed to fetch"
        })`
      );
    } finally {
      setIsUploadingVoice(false);
    }
  };

  const handleGenerate = async () => {
    setIsGenerating(true);
    setIsError(false);
    setOutputUrl("");
    setDownloadUrl("");
    setSubtitleText("");
    setStatusText("မြန်မာပြန် + အသံ + စာတန်း ထုတ်နေပါသည်...");

    try {
      const { res, data: d, usedPath } = await fetchWithRouteFallback(
        ["/dub-full-video", "/api/dub-full-video"],
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            videoFile: videoFile || "input.mp4",
            gender: voiceChoice === "female" ? "female" : "male",
            manualText: scriptText.trim(),
            customVoiceFile,
            blurOriginalSub: blurEnabled,
            blurArea: subPosition,
            voiceSpeed,
          }),
        }
      );

      if (res.ok && d?.ok) {
        setRunnerOnline(true);
        setIsError(false);
        setStatusText("ပြီးပါပြီ။ အသံနှင့် စာတန်း ထွက်လာပါပြီ။");
        const rawUrl =
          d.streamUrl || d.outputUrl || d.videoUrl || d.audioUrl || "";
        if (rawUrl) {
          setOutputUrl(rawUrl.startsWith("http") ? rawUrl : `${API}${rawUrl}`);
        }
        const rawDl = d.downloadUrl || "";
        if (rawDl) {
          setDownloadUrl(rawDl.startsWith("http") ? rawDl : `${API}${rawDl}`);
        }
        if (d.burmeseText || d.subtitle || d.srt || d.text) {
          setSubtitleText(d.burmeseText || d.subtitle || d.srt || d.text);
        }
      } else {
        setIsError(true);
        setStatusText(
          `${d?.error || "အသံ/စာတန်း ထုတ်မရပါ။"} [${usedPath} -> HTTP ${
            res.status
          }]`
        );
      }
    } catch (err: any) {
      setRunnerOnline(false);
      setIsError(true);
      setStatusText(
        `Runner မပွင့်သေးပါ။ npm start ကို run ပါ။ (${
          err?.message || "Failed to fetch"
        })`
      );
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="min-h-screen bg-[radial-gradient(ellipse_at_top,_#251348_0%,_#0d0818_55%,_#07040e_100%)] text-[#F6F3FF] px-4 py-7 flex justify-center selection:bg-fuchsia-500/30">
      <div className="w-full max-w-md space-y-4">
        <header className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-[#231342]/90 via-[#170d2e]/90 to-[#110922]/90 border border-violet-400/25 p-4 shadow-[0_12px_35px_-10px_rgba(139,92,246,0.45)] backdrop-blur-xl">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-violet-300/90 bg-violet-500/15 border border-violet-400/25 px-2.5 py-0.5 rounded-full mb-1.5">
                <span
                  className={`w-2 h-2 rounded-full ${
                    runnerOnline === true
                      ? "bg-emerald-400 shadow-[0_0_8px_#34d399]"
                      : runnerOnline === false
                      ? "bg-rose-400 shadow-[0_0_8px_#fb7185]"
                      : "bg-amber-300 animate-pulse"
                  }`}
                />
                <span>
                  {runnerOnline === true
                    ? "Runner Online"
                    : runnerOnline === false
                    ? "Runner Offline"
                    : "Checking..."}
                </span>
              </div>
              <h1 className="text-xl font-extrabold tracking-tight bg-gradient-to-r from-white via-violet-200 to-fuchsia-300 bg-clip-text text-transparent">
                KKH AI STUDIO
              </h1>
              <p className="text-xs text-violet-200/75 mt-0.5">
                30m Video + မူလစာတန်းဝါး + မြန်မာပြန် + စာအကြိုက်ထည့်
              </p>
            </div>
            <span className="shrink-0 text-[11px] font-bold px-2.5 py-1 rounded-lg bg-violet-500/20 text-violet-200 border border-violet-400/30">
              KKH
            </span>
          </div>
        </header>

        <section className="rounded-2xl bg-[#160d29]/85 border border-violet-500/20 p-4 space-y-2.5 shadow-lg backdrop-blur-md">
          <div className="flex items-center justify-between">
            <label className="text-sm font-semibold text-violet-100 flex items-center gap-2">
              <span className="w-5 h-5 rounded-md bg-violet-500/25 border border-violet-400/30 text-[11px] font-bold flex items-center justify-center text-violet-200">
                1
              </span>
              <span>Video ထည့်ရန် (30m+)</span>
            </label>
            <span className="text-[11px] text-violet-300/70">Max 2GB</span>
          </div>

          <input
            ref={videoInputRef}
            type="file"
            accept="video/*"
            onChange={handleFilePick}
            className="hidden"
          />

          <button
            type="button"
            onClick={() => videoInputRef.current?.click()}
            disabled={isUploading}
            className="w-full group py-3.5 px-4 rounded-xl border border-dashed border-violet-400/45 bg-[#20123b]/80 hover:bg-[#2a174f] hover:border-fuchsia-400/60 disabled:opacity-60 text-left transition-all duration-200"
          >
            {isUploading ? (
              <div className="text-sm font-semibold text-fuchsia-300 animate-pulse">
                Video ဖိုင် တင်နေပါသည်...
              </div>
            ) : videoFile ? (
              <div className="space-y-0.5">
                <div className="text-sm font-bold text-emerald-300 truncate">
                  ✓ {videoFile}
                </div>
                <div className="text-[11px] text-violet-300/75">
                  ပြောင်းလဲလိုလျှင် ထပ်နှိပ်၍ Video အသစ်ရွေးပါ
                </div>
              </div>
            ) : (
              <div className="space-y-1">
                <div className="text-sm font-semibold text-violet-100 group-hover:text-white">
                  + Video ဖိုင် ရွေးရန် နှိပ်ပါ
                </div>
                <div className="text-[11px] text-violet-300/65">
                  မူလစာတန်းဝါးခြင်း + အောက်ခြေမြန်မာစာတန်း ထည့်သွင်းမည်
                </div>
              </div>
            )}
          </button>
        </section>

        <section className="rounded-2xl bg-[#160d29]/85 border border-violet-500/20 p-4 space-y-3 shadow-lg backdrop-blur-md">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-violet-100 flex items-center gap-2">
              <span className="w-5 h-5 rounded-md bg-violet-500/25 border border-violet-400/30 text-[11px] font-bold flex items-center justify-center text-violet-200">
                2
              </span>
              <span>မူလစာတန်း ဝါးပေးရန်</span>
            </span>

            <button
              type="button"
              role="switch"
              aria-checked={blurEnabled}
              onClick={() => setBlurEnabled(!blurEnabled)}
              className={`w-11 h-6 rounded-full p-0.5 transition-colors duration-200 ${
                blurEnabled
                  ? "bg-gradient-to-r from-violet-500 to-fuchsia-500"
                  : "bg-slate-700/80"
              }`}
            >
              <span
                className={`block w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${
                  blurEnabled ? "translate-x-5" : "translate-x-0"
                }`}
              />
            </button>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {(
              [
                ["bottom", "အောက်ခြေဝါး"],
                ["top", "အပေါ်ပိုင်းဝါး"],
                ["both", "အပေါ်/အောက်ဝါး"],
              ] as const
            ).map(([pos, label]) => (
              <button
                key={pos}
                type="button"
                onClick={() => setSubPosition(pos)}
                className={`py-2 px-2 rounded-xl text-xs font-semibold border transition-all ${
                  subPosition === pos
                    ? "bg-gradient-to-r from-violet-600 to-fuchsia-600 border-fuchsia-300/50 text-white shadow-[0_4px_14px_rgba(168,85,247,0.4)]"
                    : "bg-[#20123b]/70 border-violet-500/20 text-violet-200/75 hover:bg-[#29174c]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </section>

        <section className="rounded-2xl bg-[#160d29]/85 border border-violet-500/20 p-4 space-y-3.5 shadow-lg backdrop-blur-md">
          <div className="text-sm font-semibold text-violet-100 flex items-center gap-2">
            <span className="w-5 h-5 rounded-md bg-violet-500/25 border border-violet-400/30 text-[11px] font-bold flex items-center justify-center text-violet-200">
              3
            </span>
            <span>အသံ ရွေးချယ်ရန်</span>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {(
              [
                ["female", "မိန်းကလေး"],
                ["male", "ယောက်ျားလေး"],
                ["custom", "ကိုယ်ပိုင်အသံ"],
              ] as const
            ).map(([val, label]) => (
              <button
                key={val}
                type="button"
                onClick={() => {
                  setVoiceChoice(val);
                  if (val === "custom") {
                    voiceInputRef.current?.click();
                  }
                }}
                className={`py-2.5 px-2 rounded-xl text-xs font-semibold border transition-all ${
                  voiceChoice === val
                    ? "bg-gradient-to-r from-violet-600 to-fuchsia-600 border-fuchsia-300/50 text-white shadow-[0_4px_14px_rgba(168,85,247,0.4)]"
                    : "bg-[#20123b]/70 border-violet-500/20 text-violet-200/75 hover:bg-[#29174c]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <input
            ref={voiceInputRef}
            type="file"
            accept="audio/*"
            onChange={handleVoicePick}
            className="hidden"
          />

          {voiceChoice === "custom" && (
            <div className="rounded-xl bg-[#20123b]/90 border border-violet-400/25 px-3 py-2 text-xs text-violet-200">
              {isUploadingVoice
                ? "အသံဖိုင် တင်နေပါသည်..."
                : voiceLabel || "အသံဖိုင် ရွေးရန် နှိပ်ပါ"}
            </div>
          )}

          <div className="pt-2 border-t border-violet-500/15 space-y-2.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-violet-200">
                အသံ Speed (တင်ရန် / လျှော့ရန်)
              </span>
              <span className="px-2 py-0.5 rounded-md bg-violet-500/20 text-fuchsia-200 font-bold border border-violet-400/25">
                {voiceSpeed.toFixed(2)}x
              </span>
            </div>

            <input
              type="range"
              min={0.7}
              max={1.4}
              step={0.01}
              value={voiceSpeed}
              onChange={(e) => setVoiceSpeed(parseFloat(e.target.value))}
              className="w-full accent-fuchsia-400 cursor-pointer"
            />

            <div className="grid grid-cols-3 gap-2 text-xs">
              <button
                type="button"
                onClick={() => setVoiceSpeed(0.85)}
                className="py-1.5 rounded-lg border font-medium transition bg-[#20123b]/70 border-violet-500/20 text-violet-200/80 hover:bg-[#29174c]"
              >
                နှေး (0.85x)
              </button>
              <button
                type="button"
                onClick={() => setVoiceSpeed(1.0)}
                className="py-1.5 rounded-lg border font-medium transition bg-[#20123b]/70 border-violet-500/20 text-violet-200/80 hover:bg-[#29174c]"
              >
                ပုံမှန် (1.00x)
              </button>
              <button
                type="button"
                onClick={() => setVoiceSpeed(1.2)}
                className="py-1.5 rounded-lg border font-medium transition bg-[#20123b]/70 border-violet-500/20 text-violet-200/80 hover:bg-[#29174c]"
              >
                မြန် (1.20x)
              </button>
            </div>
          </div>
        </section>

        <section className="rounded-2xl bg-[#160d29]/85 border border-violet-500/20 p-4 space-y-2.5 shadow-lg backdrop-blur-md">
          <div className="flex items-center justify-between">
            <label className="text-sm font-semibold text-violet-100 flex items-center gap-2">
              <span className="w-5 h-5 rounded-md bg-violet-500/25 border border-violet-400/30 text-[11px] font-bold flex items-center justify-center text-violet-200">
                4
              </span>
              <span>ရိုက်ထည့်သော စာသား (အကြိုက်ထည့်)</span>
            </label>
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded-md border bg-violet-500/15 text-violet-200/80 border-violet-400/20">
              {scriptText.length.toLocaleString()} လုံး
            </span>
          </div>
          <p className="text-[11px] text-violet-300/65">
            မည်သည့်ဘာသာမဆို မြန်မာပြန်ပေးပြီး အသံထွက် + စာတန်း ထိုးပေးမည်
          </p>
          <textarea
            rows={5}
            value={scriptText}
            onChange={(e) => setScriptText(e.target.value)}
            placeholder="ဇာတ်လမ်း သို့မဟုတ် ဇာတ်ညွှန်းစာသားကို အကြိုက် ရိုက်ထည့်ပါ..."
            className="w-full rounded-xl bg-[#100820]/90 border border-violet-500/25 p-3 text-sm text-white placeholder:text-violet-300/35 focus:outline-none focus:border-fuchsia-400/70 transition"
          />
        </section>

        <button
          type="button"
          onClick={handleGenerate}
          disabled={isGenerating || isUploading}
          className="w-full py-3.5 px-5 rounded-2xl bg-gradient-to-r from-violet-600 via-purple-600 to-fuchsia-600 hover:brightness-110 active:scale-[0.99] disabled:opacity-50 font-bold text-sm text-white shadow-[0_10px_30px_-6px_rgba(192,38,211,0.55)] transition-all"
        >
          {isGenerating ? "⚡ ထုတ်နေပါသည်..." : "▶ အသံ + စာတန်း ထုတ်မည်"}
        </button>

        {statusText && (
          <div
            className={`rounded-2xl px-4 py-3 text-xs font-medium border backdrop-blur-md ${
              isError
                ? "bg-rose-950/75 border-rose-500/45 text-rose-200 shadow-[0_6px_20px_rgba(244,63,94,0.18)]"
                : "bg-emerald-950/65 border-emerald-400/40 text-emerald-200 shadow-[0_6px_20px_rgba(16,185,129,0.16)]"
            }`}
          >
            {statusText}
          </div>
        )}

        {outputUrl && (
          <section className="rounded-2xl bg-[#160d29]/90 border border-violet-400/30 p-4 space-y-3 shadow-xl backdrop-blur-md">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-violet-200">
                ထွက်လာသော Video ဖိုင်
              </span>
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-400/30">
                Ready
              </span>
            </div>
            <video
              controls
              src={outputUrl}
              className="w-full rounded-xl border border-violet-500/20 bg-black"
            />
            {downloadUrl && (
              <a
                href={downloadUrl}
                download
                className="block w-full text-center py-2.5 px-4 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:brightness-110 text-xs font-bold text-white shadow transition"
              >
                ⬇ Download MP4 ဖိုင်ဆွဲယူရန်
              </a>
            )}
          </section>
        )}

        {subtitleText && (
          <section className="rounded-2xl bg-[#160d29]/90 border border-violet-500/25 p-4 space-y-2 shadow-lg backdrop-blur-md">
            <div className="text-xs font-bold uppercase tracking-wider text-violet-200">
              မြန်မာစာတန်း (Subtitles)
            </div>
            <pre className="whitespace-pre-wrap text-xs leading-relaxed text-violet-100/90 font-sans bg-[#100820]/80 rounded-xl p-3 border border-violet-500/15">
              {subtitleText}
            </pre>
          </section>
        )}
      </div>
    </div>
  );
}