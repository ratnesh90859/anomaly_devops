import { useState, useRef, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const CHAT_API = import.meta.env.VITE_CHAT_API_URL || '/api'

const QUICK_ACTIONS = [
  { label: '🧠 Why did memory spike?', msg: 'Why did memory spike in the last hour?' },
  { label: '💳 Payment failure cause?', msg: 'What caused the payment failures in the last 30 minutes?' },
  { label: '⚡ Last hour summary?', msg: 'Give me a full summary of what happened in the last hour.' },
  { label: '🚦 Traffic spike at 12PM?', msg: 'Why was there a traffic spike at 12PM?' },
  { label: '🐢 Why is latency high?', msg: 'Why is the P95 latency high right now?' },
  { label: '📊 System health now?', msg: 'What is the current system health? Are there any anomalies?' },
]

function formatTime(date) {
  return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
}

function TypingIndicator() {
  const [step, setStep] = useState(0)
  const steps = ['Parsing your question...', 'Running PromQL queries...', 'Analyzing logs...', 'Generating RCA with Gemini...']

  useEffect(() => {
    const interval = setInterval(() => {
      setStep(s => (s + 1) % steps.length)
    }, 2000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="message ai">
      <div className="avatar">🤖</div>
      <div className="bubble">
        <div className="typing">
          <div className="typing-dot" />
          <div className="typing-dot" />
          <div className="typing-dot" />
          <span className="thinking-text">{steps[step]}</span>
        </div>
      </div>
    </div>
  )
}

function UserMessage({ text, time }) {
  return (
    <div className="message user">
      <div className="avatar">👤</div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
        <div className="bubble">{text}</div>
        <div className="timestamp">{formatTime(time)}</div>
      </div>
    </div>
  )
}

function AIMessage({ data, time }) {
  if (data.error) {
    return (
      <div className="message ai">
        <div className="avatar">🤖</div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div className="error-bubble">❌ {data.error}</div>
          <div className="timestamp">{formatTime(time)}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="message ai">
      <div className="avatar">🤖</div>
      <div style={{ display: 'flex', flexDirection: 'column', maxWidth: '80%' }}>
        <div className="bubble">
          {data.intent && (
            <div className="intent-badge">
              🎯 {data.intent}
            </div>
          )}
          {data.time_range && (
            <div className="time-range-pill">
              <span className="pill">FROM {new Date(data.time_range.from).toLocaleTimeString('en-IN')}</span>
              <span className="pill">TO {new Date(data.time_range.to).toLocaleTimeString('en-IN')}</span>
            </div>
          )}
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {data.answer}
          </ReactMarkdown>
        </div>
        <div className="timestamp">{formatTime(time)}</div>
      </div>
    </div>
  )
}

export default function App() {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const messagesEndRef = useRef(null)
  const textareaRef = useRef(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  const sendMessage = useCallback(async (text) => {
    const trimmed = (text || input).trim()
    if (!trimmed || loading) return

    const now = new Date()
    setMessages(prev => [...prev, { type: 'user', text: trimmed, time: now }])
    setInput('')
    setLoading(true)

    // Auto-resize textarea back
    if (textareaRef.current) textareaRef.current.style.height = 'auto'

    try {
      const res = await fetch(`${CHAT_API}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed }),
      })
      const data = await res.json()
      setMessages(prev => [...prev, { type: 'ai', data, time: new Date() }])
    } catch (err) {
      setMessages(prev => [...prev, {
        type: 'ai',
        data: { error: `Could not reach the AIOps backend. Is the server running? (${err.message})` },
        time: new Date()
      }])
    } finally {
      setLoading(false)
    }
  }, [input, loading])

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const handleTextareaChange = (e) => {
    setInput(e.target.value)
    // Auto-grow
    e.target.style.height = 'auto'
    e.target.style.height = Math.min(e.target.scrollHeight, 140) + 'px'
  }

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <div className="header-icon">🔬</div>
        <div className="header-text">
          <h1>AIOps Assistant</h1>
          <p>Powered by Prometheus · Gemini AI · Real-time Logs</p>
        </div>
        <div className="status-dot">
          <span />
          Live
        </div>
      </header>

      {/* Messages */}
      <div className="messages">
        {messages.length === 0 && !loading && (
          <div className="welcome">
            <div className="welcome-icon">🤖</div>
            <h2>Ask me anything about your infrastructure</h2>
            <p>
              I can query Prometheus in real-time, analyze application logs, and use Gemini AI
              to explain exactly what went wrong, when, and how to fix it.
            </p>
            <div className="quick-actions">
              {QUICK_ACTIONS.map((a) => (
                <button
                  key={a.msg}
                  className="quick-btn"
                  onClick={() => sendMessage(a.msg)}
                  disabled={loading}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) =>
          m.type === 'user'
            ? <UserMessage key={i} text={m.text} time={m.time} />
            : <AIMessage key={i} data={m.data} time={m.time} />
        )}

        {loading && <TypingIndicator />}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="input-area">
        <div className="input-row">
          <div className="input-wrapper">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleTextareaChange}
              onKeyDown={handleKeyDown}
              placeholder="Ask: Why did memory spike at 12PM? What caused the payment failures?"
              disabled={loading}
              rows={1}
            />
          </div>
          <button
            className="send-btn"
            onClick={() => sendMessage()}
            disabled={loading || !input.trim()}
            title="Send (Enter)"
          >
            {loading ? '⏳' : '➤'}
          </button>
        </div>
        <div className="footer-links">
          <div className="input-hint">Press Enter to send · Shift+Enter for new line</div>
          <span className="footer-sep">·</span>
          <a href="http://35.225.212.77:4000" target="_blank" rel="noreferrer" className="footer-link">📊 Grafana</a>
          <span className="footer-sep">·</span>
          <a href="http://35.225.212.77:9090" target="_blank" rel="noreferrer" className="footer-link">🔥 Prometheus</a>
          <span className="footer-sep">·</span>
          <a href="http://35.225.212.77:3000/anomalies" target="_blank" rel="noreferrer" className="footer-link">🚨 Anomalies</a>
        </div>
      </div>
    </div>
  )
}
