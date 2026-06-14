import type { StatusResponse, UploadResponse, Voice } from '../types';

// Upload via XHR so we can observe upload progress events. fetch() can't.
// Resolves with the parsed JSON body on 2xx, rejects with an Error otherwise.
export function uploadFileWithProgress(
  file: File,
  onProgress: (fraction: number) => void,
): Promise<UploadResponse> {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('file', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/upload');
    xhr.responseType = 'json';

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) {
        onProgress(Math.min(1, e.loaded / e.total));
      }
    };
    xhr.upload.onload = () => onProgress(1);

    xhr.onload = () => {
      const body: unknown = xhr.response;
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as UploadResponse);
      } else {
        const errMsg =
          (body && typeof body === 'object' && 'error' in body
            ? String((body as { error: unknown }).error)
            : null) ?? `upload failed (${xhr.status})`;
        reject(new Error(errMsg));
      }
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.onabort = () => reject(new Error('Upload aborted'));

    xhr.send(fd);
  });
}

export async function fetchStatus(jobId: string): Promise<StatusResponse> {
  const res = await fetch(`/status/${jobId}`);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()) as StatusResponse;
}

export function voiceDownloadUrl(jobId: string, voice: Voice): string {
  return `/download/${jobId}/${voice}`;
}

export function zipDownloadUrl(jobId: string): string {
  return `/download/${jobId}/all`;
}
