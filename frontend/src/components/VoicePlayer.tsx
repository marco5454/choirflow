import { voiceDownloadUrl } from '../lib/api';
import type { Voice } from '../types';

export function VoicePlayer({ jobId, voice }: { jobId: string; voice: Voice }) {
  const src = voiceDownloadUrl(jobId, voice);
  const label = voice.charAt(0).toUpperCase() + voice.slice(1);
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium text-slate-800">{label}</span>
        <a
          href={src}
          download={`${voice}.mp3`}
          className="text-xs font-medium text-indigo-600 hover:text-indigo-500"
        >
          Download
        </a>
      </div>
      <audio controls preload="metadata" src={src} className="w-full">
        Your browser does not support the audio element.
      </audio>
    </div>
  );
}
