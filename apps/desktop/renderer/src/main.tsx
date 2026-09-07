import React from 'react'
import { createRoot } from 'react-dom/client'
import './style.css'

createRoot(document.getElementById('root')!).render(<React.StrictMode>
  <main><h1>Orgtree</h1><p>Desktop foundation</p>
    <p role="status">The organization engine is not connected yet.</p>
    <p>No agent or harness has been started.</p></main>
</React.StrictMode>)
