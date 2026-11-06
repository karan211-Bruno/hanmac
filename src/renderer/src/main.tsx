import { createRoot } from 'react-dom/client'
import App from './App'
import { ensureHanMacBridge } from './lib/webBridge'
import './styles.css'

ensureHanMacBridge()

const container = document.getElementById('root')

if (!container) {
  throw new Error('React root element를 찾을 수 없습니다.')
}

createRoot(container).render(<App />)
