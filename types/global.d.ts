// Global type declarations

declare global {
  interface Window {
    monaco: typeof import('monaco-editor');
  }
}

export {};
