import React from 'react';
import { AlertTriangle, RefreshCw, RotateCcw, Copy, Check } from 'lucide-react';

interface Props {
  children: React.ReactNode;
  fallback?: (state: ErrorState, reset: () => void) => React.ReactNode;
  onReset?: () => void;
}

interface ErrorState {
  error: Error | null;
  componentStack: string | null;
}

interface State extends ErrorState {
  copied: boolean;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, componentStack: null, copied: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, errorInfo);
    this.setState({ componentStack: errorInfo.componentStack ?? null });
  }

  reset = () => {
    this.setState({ error: null, componentStack: null, copied: false });
    this.props.onReset?.();
  };

  reload = () => {
    window.location.reload();
  };

  copyError = async () => {
    const { error, componentStack } = this.state;
    if (!error) return;
    const text = [
      `message: ${error.message}`,
      '',
      'stack:',
      error.stack ?? '(no stack)',
      '',
      'componentStack:',
      componentStack ?? '(no componentStack)',
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      this.setState({ copied: true });
      setTimeout(() => this.setState({ copied: false }), 1500);
    } catch (e) {
      console.error('[ErrorBoundary] clipboard write failed', e);
    }
  };

  render() {
    const { error, componentStack, copied } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) {
      return this.props.fallback({ error, componentStack }, this.reset);
    }

    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-zinc-950 text-zinc-100">
        <div className="w-full max-w-2xl rounded-xl border border-zinc-800 bg-zinc-900 shadow-xl">
          <div className="flex items-center gap-2 px-5 py-4 border-b border-zinc-800">
            <AlertTriangle className="w-5 h-5 text-amber-400" />
            <h2 className="text-base font-semibold">문제가 발생했어요</h2>
          </div>
          <div className="px-5 py-4 space-y-3">
            <p className="text-sm text-zinc-300">
              화면 렌더링 중 에러가 발생했어요. 콘솔(F12 → Console)을 열고 로그를 캡처해서 공유해 주세요.
            </p>
            <div className="rounded-md border border-zinc-800 bg-zinc-950">
              <div className="px-3 py-2 border-b border-zinc-800 text-xs font-medium text-zinc-400">
                error.message
              </div>
              <pre className="px-3 py-2 text-xs text-rose-300 overflow-x-auto whitespace-pre-wrap break-words">
                {error.message || '(no message)'}
              </pre>
            </div>
            <details className="rounded-md border border-zinc-800 bg-zinc-950">
              <summary className="px-3 py-2 text-xs font-medium text-zinc-400 cursor-pointer select-none">
                stack trace
              </summary>
              <pre className="px-3 py-2 text-[11px] text-zinc-300 overflow-x-auto whitespace-pre">
                {error.stack ?? '(no stack)'}
              </pre>
            </details>
            <details className="rounded-md border border-zinc-800 bg-zinc-950">
              <summary className="px-3 py-2 text-xs font-medium text-zinc-400 cursor-pointer select-none">
                component stack
              </summary>
              <pre className="px-3 py-2 text-[11px] text-zinc-300 overflow-x-auto whitespace-pre">
                {componentStack ?? '(no componentStack)'}
              </pre>
            </details>
          </div>
          <div className="px-5 py-3 border-t border-zinc-800 flex flex-wrap items-center gap-2 justify-end">
            <button
              type="button"
              onClick={this.copyError}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-zinc-700 hover:bg-zinc-800 transition-colors"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? '복사됨' : '에러 복사'}
            </button>
            <button
              type="button"
              onClick={this.reset}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-zinc-700 hover:bg-zinc-800 transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              다시 시도
            </button>
            <button
              type="button"
              onClick={this.reload}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-zinc-100 text-zinc-900 hover:bg-white transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              새로고침
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
