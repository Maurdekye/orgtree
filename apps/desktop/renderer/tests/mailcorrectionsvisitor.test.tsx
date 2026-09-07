import './harness'
window.history.replaceState({}, '', '/k/visitor/')
const { mailCorrections } = await import('./mailcorrections.cases')
mailCorrections('public')
