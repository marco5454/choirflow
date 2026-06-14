import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = {
  children: ReactNode;
};

type State = {
  error: Error | null;
};

/**
 * Top-level error boundary. Catches render-time errors from any descendant
 * and shows a minimal fallback UI with a reload button. Without this, an
 * uncaught render error blanks the page.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // No telemetry endpoint yet; log to the console so it surfaces in devtools.
    console.error('Unhandled render error:', error, info);
  }

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="min-h-screen bg-slate-50 text-slate-900">
        <div className="mx-auto max-w-2xl px-4 py-10">
          <div className="rounded-lg border border-red-200 bg-red-50 p-6">
            <h1 className="text-xl font-semibold text-red-900">
              Something went wrong
            </h1>
            <p className="mt-2 text-sm text-red-800">
              The page hit an unexpected error and can't continue. Reload to
              start over.
            </p>
            <pre className="mt-4 overflow-x-auto rounded bg-white p-3 text-xs text-red-900">
              {error.name}: {error.message}
            </pre>
            <button
              type="button"
              onClick={this.handleReload}
              className="mt-4 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
            >
              Reload page
            </button>
          </div>
        </div>
      </div>
    );
  }
}
