import React from 'react'

class ChartErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error, info) {
    console.error('Chart render error:', error, info)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="historyEmpty">
          Unable to render price chart. Try a different time window or run a manual price check.
        </div>
      )
    }

    return this.props.children
  }
}

export default ChartErrorBoundary
