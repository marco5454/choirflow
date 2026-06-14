import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UploadForm } from './UploadForm';
import { MAX_UPLOAD_BYTES } from '../lib/validate';

function makeFile(name: string, size: number, type = 'application/octet-stream'): File {
  return new File([new Uint8Array(size)], name, { type });
}

function renderForm(overrides: Partial<Parameters<typeof UploadForm>[0]> = {}) {
  const props = {
    jobInProgress: false,
    showReset: false,
    onUploaded: vi.fn(),
    onReset: vi.fn(),
    ...overrides,
  };
  const result = render(<UploadForm {...props} />);
  // Disable user-event's `accept` filtering so we can drive the component's
  // own validateFile() logic (it must reject unsupported files even if the
  // browser would have, since drag-and-drop bypasses the accept attribute).
  const user = userEvent.setup({ applyAccept: false });
  return { ...result, props, user };
}

// The file <input> is rendered as `hidden` (display:none via Tailwind),
// so we grab it by type rather than by role.
function getFileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="file"]');
  if (!input) throw new Error('file input not found');
  return input as HTMLInputElement;
}

describe('<UploadForm />', () => {
  it('disables Upload until a valid file is selected', async () => {
    const { container, user } = renderForm();
    const submit = screen.getByRole('button', { name: /upload/i });
    expect(submit).toBeDisabled();

    await user.upload(getFileInput(container), makeFile('score.xml', 100));

    expect(submit).toBeEnabled();
    expect(screen.getByText('score.xml')).toBeInTheDocument();
  });

  it('shows an error and clears selection when an unsupported file is chosen', async () => {
    const { container, user } = renderForm();

    await user.upload(getFileInput(container), makeFile('song.midi', 100));

    expect(screen.getByRole('alert')).toHaveTextContent(/Unsupported file type/);
    expect(screen.queryByText('song.midi')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /upload/i })).toBeDisabled();
  });

  it('shows the size-limit error when an oversize file is chosen', async () => {
    const { container, user } = renderForm();

    await user.upload(
      getFileInput(container),
      makeFile('big.pdf', MAX_UPLOAD_BYTES + 1, 'application/pdf'),
    );

    expect(screen.getByRole('alert')).toHaveTextContent(/exceeds the 50 MB limit/);
    expect(screen.getByRole('button', { name: /upload/i })).toBeDisabled();
  });

  it('clears the selected file when the remove (×) button is clicked', async () => {
    const { container, user } = renderForm();
    await user.upload(getFileInput(container), makeFile('score.xml', 100));

    expect(screen.getByText('score.xml')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /remove selected file/i }));

    expect(screen.queryByText('score.xml')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /upload/i })).toBeDisabled();
  });

  it('calls onReset and clears state when Reset is clicked', async () => {
    const { container, props, user } = renderForm();
    await user.upload(getFileInput(container), makeFile('score.xml', 100));

    // Reset is rendered because a file is selected.
    await user.click(screen.getByRole('button', { name: /reset/i }));

    expect(props.onReset).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('score.xml')).not.toBeInTheDocument();
  });

  it('disables the form while a job is in progress', () => {
    const { container } = renderForm({ jobInProgress: true });
    expect(screen.getByRole('button', { name: /upload/i })).toBeDisabled();
    expect(getFileInput(container)).toBeDisabled();
  });
});
