/**
 * @vitest-environment jsdom
 */
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';

import CameraCaptureModal from '@/components/UI/CameraCaptureModal';

import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stopTrack = vi.fn();

function makeStream() {
  return {
    getTracks: () => [{ stop: stopTrack }],
  } as unknown as MediaStream;
}

function stubMediaDevices(
  devices: { kind: string; deviceId: string; label: string }[],
  getUserMedia = vi.fn(async () => makeStream()),
) {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      enumerateDevices: vi.fn(async () => devices),
      getUserMedia,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
  return getUserMedia;
}

const CAMERA = {
  kind: 'videoinput',
  deviceId: 'cam-1',
  label: 'Built-in Webcam',
};

describe('CameraCaptureModal', () => {
  beforeEach(() => {
    // jsdom implements neither MediaStream nor canvas encoding.
    (globalThis as any).MediaStream = class {};
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      drawImage: vi.fn(),
    })) as unknown as HTMLCanvasElement['getContext'];
    HTMLCanvasElement.prototype.toBlob = vi.fn((cb: BlobCallback) => {
      cb(new Blob(['frame'], { type: 'image/png' }));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    stopTrack.mockClear();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: undefined,
    });
  });

  it('opens a single stream for the first camera and shows its label', async () => {
    const getUserMedia = stubMediaDevices([CAMERA]);

    render(<CameraCaptureModal isOpen onClose={vi.fn()} onCapture={vi.fn()} />);

    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    expect(getUserMedia).toHaveBeenCalledWith({
      video: { deviceId: 'cam-1' },
    });
    expect(await screen.findByText('Built-in Webcam')).toBeInTheDocument();
  });

  it('hands the captured frame to onCapture as a File and closes', async () => {
    stubMediaDevices([CAMERA]);
    const onCapture = vi.fn();
    const onClose = vi.fn();

    render(
      <CameraCaptureModal isOpen onClose={onClose} onCapture={onCapture} />,
    );
    await screen.findByText('Built-in Webcam');

    await userEvent.click(screen.getByRole('button', { name: /take photo/i }));

    await waitFor(() => expect(onCapture).toHaveBeenCalledTimes(1));
    const file = onCapture.mock.calls[0][0] as File;
    expect(file).toBeInstanceOf(File);
    expect(file.type).toBe('image/png');
    expect(onClose).toHaveBeenCalled();
  });

  it('offers a picker when more than one camera is present', async () => {
    stubMediaDevices([
      CAMERA,
      { kind: 'videoinput', deviceId: 'cam-2', label: 'USB Camera' },
      { kind: 'audioinput', deviceId: 'mic-1', label: 'Mic' },
    ]);

    render(<CameraCaptureModal isOpen onClose={vi.fn()} onCapture={vi.fn()} />);

    const select = await screen.findByRole('combobox');
    expect(select).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(2);
  });

  it('shows an inline error instead of alerting when access is denied', async () => {
    stubMediaDevices(
      [CAMERA],
      vi.fn(async () => {
        throw new Error('NotAllowedError');
      }),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

    render(<CameraCaptureModal isOpen onClose={vi.fn()} onCapture={vi.fn()} />);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(alertSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /take photo/i })).toBeDisabled();
  });

  it('does not touch the camera while closed', async () => {
    const getUserMedia = stubMediaDevices([CAMERA]);

    render(
      <CameraCaptureModal
        isOpen={false}
        onClose={vi.fn()}
        onCapture={vi.fn()}
      />,
    );

    await waitFor(() => expect(getUserMedia).not.toHaveBeenCalled());
  });
});
