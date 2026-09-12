import { JSDOM, VirtualConsole } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

const GLOBALS = ['window', 'document', 'navigator', 'location', 'localStorage',
  'MutationObserver', 'ResizeObserver', 'HTMLElement', 'Node', 'Event',
  'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'IS_REACT_ACT_ENVIRONMENT']

function setGlobal(name, value) {
  Object.defineProperty(globalThis, name, {
    configurable: true, writable: true, value,
  })
}

/**
 * Create an isolated main document and a second document for portal/popout
 * content. The returned fixture owns both documents and restores every global
 * it replaces. Use `withPortalFixture` when a test must remain safe after a
 * failed assertion.
 */
export function createPortalFixture({ mainHtml = '<div id="app"></div>',
  portalHtml = '<div id="portal"></div>' } = {}) {
  const problems = []
  const consoleMain = new VirtualConsole()
  const consolePortal = new VirtualConsole()
  const report = (error) => problems.push(error)
  consoleMain.on('jsdomError', report)
  consolePortal.on('jsdomError', report)
  const main = new JSDOM(`<!doctype html><html><body>${mainHtml}</body></html>`, {
    url: 'http://localhost/', virtualConsole: consoleMain,
  })
  const portal = new JSDOM(`<!doctype html><html><body>${portalHtml}</body></html>`, {
    url: 'http://localhost/popout', virtualConsole: consolePortal,
  })
  const mainWindow = main.window
  const portalWindow = portal.window
  const previous = new Map(GLOBALS.map(name => [name, {
    present: Object.prototype.hasOwnProperty.call(globalThis, name),
    value: globalThis[name],
  }]))
  const host = mainWindow.document.createElement('div')
  host.dataset.portalFixture = 'true'
  const mainMount = mainWindow.document.getElementById('app') ?? mainWindow.document.body
  const portalMount = portalWindow.document.getElementById('portal') ?? portalWindow.document.body
  mainMount.append(host)
  let root
  let activeDocument = mainWindow.document
  let closed = false

  const install = (doc) => {
    activeDocument = doc
    const view = doc.defaultView
    setGlobal('window', view)
    setGlobal('document', doc)
    setGlobal('navigator', view.navigator)
    setGlobal('location', view.location)
    setGlobal('localStorage', view.localStorage)
    setGlobal('MutationObserver', view.MutationObserver)
    setGlobal('ResizeObserver', view.ResizeObserver ?? class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    setGlobal('HTMLElement', view.HTMLElement)
    setGlobal('Node', view.Node)
    setGlobal('Event', view.Event)
    setGlobal('MouseEvent', view.MouseEvent)
    setGlobal('KeyboardEvent', view.KeyboardEvent)
    setGlobal('getComputedStyle', view.getComputedStyle.bind(view))
    setGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  }

  const mount = async (element) => {
    if (closed) throw new Error('portal fixture is already torn down')
    install(activeDocument)
    root ??= createRoot(host)
    await act(async () => root.render(element))
  }

  const moveToPortal = () => {
    if (closed) throw new Error('portal fixture is already torn down')
    portalMount.append(host)
    install(portalWindow.document)
  }

  const returnToMain = () => {
    if (closed) throw new Error('portal fixture is already torn down')
    mainMount.append(host)
    install(mainWindow.document)
  }

  const teardown = async () => {
    if (closed) return
    closed = true
    // React owns the portal subtree. Put it back in the document whose root
    // was created before unmount; otherwise React reports a cross-document
    // removeChild error and can poison the next fixture in the same process.
    if (host.ownerDocument !== mainWindow.document) mainMount.append(host)
    let unmountError
    if (root) {
      try {
        install(mainWindow.document)
        await act(async () => root.unmount())
      } catch (error) {
        unmountError = error
      }
    }
    try {
      host.remove()
      portalWindow.close()
      mainWindow.close()
    } finally {
      for (const name of GLOBALS) {
        const old = previous.get(name)
        if (old?.present) setGlobal(name, old.value)
        else delete globalThis[name]
      }
    }
    if (unmountError) problems.push(unmountError)
    if (problems.length) throw new AggregateError(problems, 'portal fixture reported DOM errors')
  }

  return {
    main: mainWindow,
    portal: portalWindow,
    host,
    get document() { return activeDocument },
    get closed() { return closed },
    get problems() { return [...problems] },
    mount,
    moveToPortal,
    returnToMain,
    teardown,
  }
}

export async function withPortalFixture(callback, options) {
  const fixture = createPortalFixture(options)
  let result
  let failure
  try {
    result = await callback(fixture)
  } catch (error) {
    failure = error
  }
  try {
    await fixture.teardown()
  } catch (error) {
    failure ??= error
  }
  if (failure) throw failure
  return result
}
