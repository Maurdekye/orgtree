import { createRoot } from 'react-dom/client'
import { AccountsPanel } from '../src/canvas/accounts'
import { feedbackService } from './feedback-fixture'
feedbackService()
createRoot(document.getElementById('root')!).render(
  <AccountsPanel toast={() => {}} close={() => {}} initialTab="runtime" />)
