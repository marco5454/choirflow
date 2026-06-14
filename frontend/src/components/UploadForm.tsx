import { useRef, useState } from 'react';
import { uploadFileWithProgress } from '../lib/api';
import { humanSize } from '../lib/format';
import { ACCEPTED_EXTENSIONS, validateFile } from '../lib/validate';
import type { UploadResponse } from '../types';
import { FormatHelp } from './FormatHelp';

type Props = {
  /** True while a job is currently in progress (post-upload, pre-terminal). */
  jobInProgress: boolean;
  /** True when the user has results visible and a Reset button should appear. */
  showReset: boolean;
  /** Called with the upload response on success. */
  onUploaded: (data: UploadResponse, fallbackName: string) => void;
  /** Called when the user clicks Reset. Parent should clear job state. */
  onReset: () => void;
};

export function UploadForm({ jobInProgress, showReset, onUploaded, onReset }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const formDisabled = submitting || jobInProgress;

  const acceptFile = (f: File | null) => {
    if (!f) {
      setFile(null);
      setSelectionError(null);
      return;
    }
    const err = validateFile(f);
    if (err) {
      setFile(null);
      setSelectionError(err);
      return;
    }
    setFile(f);
    setSelectionError(null);
  };

  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    if (formDisabled) return;
    setDragOver(true);
  };
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (formDisabled) return;
    setDragOver(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (formDisabled) return;
    const f = e.dataTransfer.files?.[0] ?? null;
    acceptFile(f);
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || submitting) return;
    setSubmitting(true);
    setUploadError(null);
    setUploadProgress(0);

    try {
      const data = await uploadFileWithProgress(file, setUploadProgress);
      onUploaded(data, file.name);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
      setUploadProgress(null);
    }
  };

  const reset = () => {
    setFile(null);
    setSelectionError(null);
    setUploadError(null);
    setUploadProgress(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    onReset();
  };

  const clearFile = () => {
    setFile(null);
    setSelectionError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <>
      <form
        onSubmit={onSubmit}
        className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm"
      >
        <span className="block text-sm font-medium text-slate-700">Sheet music file</span>

        <div
          onDragEnter={onDragEnter}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onClick={() => !formDisabled && fileInputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (formDisabled) return;
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              fileInputRef.current?.click();
            }
          }}
          className={
            'mt-2 cursor-pointer rounded-md border-2 border-dashed px-4 py-8 text-center transition-colors ' +
            (formDisabled
              ? 'cursor-not-allowed border-slate-200 bg-slate-50 opacity-60'
              : dragOver
              ? 'border-indigo-500 bg-indigo-50'
              : 'border-slate-300 bg-white hover:border-slate-400')
          }
        >
          <p className="text-sm text-slate-700">
            <span className="font-medium text-indigo-600">Click to browse</span> or drag a file here
          </p>
          <p className="mt-1 text-xs text-slate-500">
            .xml, .musicxml, .mxl, .pdf &middot; max 50 MB
          </p>
        </div>

        <FormatHelp />

        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_EXTENSIONS}
          onChange={(e) => acceptFile(e.target.files?.[0] ?? null)}
          disabled={formDisabled}
          className="hidden"
        />

        {file && (
          <div className="mt-3 flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-slate-800">{file.name}</p>
              <p className="text-xs text-slate-500">{humanSize(file.size)}</p>
            </div>
            <button
              type="button"
              onClick={clearFile}
              disabled={formDisabled}
              aria-label="Remove selected file"
              className="ml-3 inline-flex h-7 w-7 flex-none items-center justify-center rounded-full text-slate-500 hover:bg-slate-200 hover:text-slate-700 disabled:opacity-50"
            >
              &times;
            </button>
          </div>
        )}

        {selectionError && (
          <p role="alert" className="mt-2 text-xs text-red-600">
            {selectionError}
          </p>
        )}

        <div className="mt-4 flex gap-3">
          <button
            type="submit"
            disabled={!file || formDisabled}
            className="inline-flex items-center rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Uploading…' : 'Upload'}
          </button>
          {(showReset || uploadError || file) && (
            <button
              type="button"
              onClick={reset}
              disabled={submitting}
              className="inline-flex items-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              Reset
            </button>
          )}
        </div>

        {submitting && uploadProgress !== null && (
          <div className="mt-4">
            <div
              className="h-2 w-full overflow-hidden rounded-full bg-slate-200"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(uploadProgress * 100)}
              aria-label="Upload progress"
            >
              <div
                className="h-full bg-indigo-500 transition-[width] duration-150"
                style={{ width: `${Math.round(uploadProgress * 100)}%` }}
              />
            </div>
            <p className="mt-1 text-xs text-slate-500">
              {uploadProgress < 1
                ? `Uploading… ${Math.round(uploadProgress * 100)}%`
                : 'Upload complete, starting job…'}
            </p>
          </div>
        )}
      </form>

      {uploadError && (
        <div
          role="alert"
          className="mt-6 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800"
        >
          <div className="font-semibold">Upload rejected</div>
          <p className="mt-1 whitespace-pre-wrap break-words">{uploadError}</p>
        </div>
      )}
    </>
  );
}
