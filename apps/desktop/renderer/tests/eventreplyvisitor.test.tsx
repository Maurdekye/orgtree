import './harness'
window.history.replaceState({}, '', '/k/visitor/')
const { replyCases } = await import('./eventreply.cases')
replyCases('public')
