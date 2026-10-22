import { Component, type ErrorInfo, type ReactNode } from 'react'

export interface RenderBoundaryProps {
  /** Human readable section title, already localized. */
  title: string
  /** Label of the retry button, already localized. */
  retryLabel: string
  /** Short explanation shown under the title, already localized. */
  detail?: string
  children: ReactNode
}

interface RenderBoundaryState {
  error: unknown
  seen: number
}

const box: React.CSSProperties = {
  border: '1px solid var(--dsw-alias-line-warning, #d9a441)',
  borderRadius: 8,
  padding: '10px 12px',
  margin: '8px 0',
  background: 'var(--dsw-alias-fill-warning-weak, rgba(217, 164, 65, 0.12))',
  color: 'var(--dsw-alias-text-primary, inherit)',
  fontSize: 13,
}

const buttonStyle: React.CSSProperties = {
  marginTop: 6,
  padding: '2px 10px',
  fontSize: 12,
  borderRadius: 6,
  border: '1px solid currentColor',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
}

/**
 * Per-section error boundary.
 *
 * The DSH renderer does not catch component errors (one throwing section would
 * blank the whole settings page), so every section is wrapped here. Retrying
 * remounts the children by bumping a key, which is the only way to recover a
 * crashed subtree in React without a full reload.
 */
export class RenderBoundary extends Component<RenderBoundaryProps, RenderBoundaryState> {
  state: RenderBoundaryState = { error: null, seen: 0 }

  static getDerivedStateFromError(error: unknown): Partial<RenderBoundaryState> {
    return { error }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Keep the console trail: the fallback itself must stay silent for users.
    console.error(`[overleaf-sync] section "${this.props.title}" crashed`, error, info.componentStack)
  }

  private readonly retry = (): void => {
    this.setState((previous) => ({ error: null, seen: previous.seen + 1 }))
  }

  render(): ReactNode {
    if (this.state.error === null) {
      return <div key={this.state.seen}>{this.props.children}</div>
    }
    return (
      <div style={box} role="alert">
        <div style={{ fontWeight: 600 }}>{this.props.title}</div>
        {this.props.detail ? <div style={{ opacity: 0.8, marginTop: 2 }}>{this.props.detail}</div> : null}
        <div style={{ opacity: 0.7, marginTop: 4, fontFamily: 'monospace', fontSize: 11 }}>
          {this.state.error instanceof Error ? this.state.error.message : String(this.state.error)}
        </div>
        <button type="button" style={buttonStyle} onClick={this.retry}>
          {this.props.retryLabel}
        </button>
      </div>
    )
  }
}
