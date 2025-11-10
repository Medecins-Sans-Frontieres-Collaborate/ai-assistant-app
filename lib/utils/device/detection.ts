/**
 * Detects if the current device is a mobile device based on user agent
 *
 * @returns True if the device is mobile, false otherwise
 *
 * @example
 * if (isMobileDevice()) {
 *   // Apply mobile-specific behavior
 * }
 */
export const isMobileDevice = (): boolean => {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false;
  }

  const userAgent = navigator.userAgent;
  const mobileRegex =
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile|CriOS/i;

  return mobileRegex.test(userAgent);
};

/**
 * Checks if the device has camera support
 *
 * @returns Promise that resolves to true if camera is available, false otherwise
 *
 * @example
 * const hasCamera = await checkCameraSupport();
 * if (hasCamera) {
 *   // Show camera button
 * }
 */
export const checkCameraSupport = async (): Promise<boolean> => {
  if (typeof navigator === 'undefined') {
    return false;
  }

  try {
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const hasCamera = devices.some((device) => device.kind === 'videoinput');
      return hasCamera;
    }

    console.error('MediaDevices API not supported');
    return false;
  } catch (error) {
    console.error('Error checking camera support:', error);
    return false;
  }
};

/**
 * Checks if the device has microphone support
 *
 * @returns Promise that resolves to true if microphone is available, false otherwise
 */
export const checkMicrophoneSupport = async (): Promise<boolean> => {
  if (typeof navigator === 'undefined') {
    return false;
  }

  try {
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const hasMicrophone = devices.some(
        (device) => device.kind === 'audioinput',
      );
      return hasMicrophone;
    }

    return false;
  } catch (error) {
    console.error('Error checking microphone support:', error);
    return false;
  }
};

/**
 * Detects if the browser supports clipboard API
 *
 * @returns True if clipboard API is available
 */
export const hasClipboardSupport = (): boolean => {
  return typeof navigator !== 'undefined' && !!navigator.clipboard;
};

/**
 * Detects if the device is likely a touch-enabled device
 *
 * @returns True if touch is supported
 */
export const isTouchDevice = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  return (
    'ontouchstart' in window ||
    navigator.maxTouchPoints > 0 ||
    // @ts-ignore - msMaxTouchPoints is IE-specific
    navigator.msMaxTouchPoints > 0
  );
};
